import { randomBytes } from 'node:crypto'
import type { Actor } from '../shared/types.ts'
import type { PlanInfo, PlannedComponent } from '../shared/storybook/bundle.ts'
import { ComponentError } from './componentActions.ts'
import { cleanLabel, type ImportIssue, type ImportResult } from './componentBundleImport.ts'
import { detached } from './journal.ts'
import {
  checkStorybookUrl,
  storybookSlotFree,
  takeStorybookImport,
  StorybookBusyError,
  type StorybookImportDeps,
} from './storybookImport.ts'
import { failedBeforeRendering, runStorybookImport, storybookFailure } from './storybookImportRun.ts'
import { store } from './store.ts'
import { outsideBudget } from './workBudget.ts'

/**
 * A Storybook import as a job an agent starts and then reads, since the render takes minutes and an MCP client gives up on a
 * call after about a minute whatever progress it hears. Jobs live in memory: the server restarting loses them (an unknown id
 * says to start again), and a finished one is kept for JOB_KEPT_MS so the agent can read the answer. A job is never tied to
 * the request that started it: a client that disconnects does not stop it, only `cancelStorybookJob` does.
 */

/** How long a finished job can still be read. */
export const JOB_KEPT_MS = 30 * 60_000
/** The longest a start waits for the plan (the index read, seconds) before it answers without one. */
const PLAN_WAIT_MS = 10_000
/** The components a status lists: what an import takes. */
const MAX_LISTED = 60

/** `cancelling` is what a read shows between cancel_import and the run ending; a job itself is only ever running, done, failed or cancelled. */
export type JobStatus = 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled'

export interface JobPlan {
  /** renders the import will start with, and how many components the Storybook offers in all */
  renders: number
  total: number
  capped?: boolean
  components: { name: string; group: string; stories: number }[]
}

export interface JobFailure {
  code: string
  message: string
}

interface Job {
  id: string
  canvasId: string
  /** the account the job counts against and is shown to: the requesting user, else the payer */
  owner: string
  status: JobStatus
  rendered: number
  total: number
  component: string | null
  planned?: JobPlan
  result?: ImportResult
  issues?: ImportIssue[]
  renders?: number
  error?: JobFailure
  controller: AbortController
  cancelRequested: boolean
  /** the importer has begun writing components (synchronously: nothing can observe this, except the run's own error handler, which then reports a failure rather than a cancel) */
  writing: boolean
  /** the canvas is held in memory until the job ends */
  release: () => void
  startedAt: number
  finishedAt?: number
}

/** What a caller reads: the job without its controller and owner. */
export interface JobView {
  job_id: string
  status: JobStatus
  rendered: number
  total: number
  component: string | null
  planned?: JobPlan
  result?: ImportResult
  issues?: ImportIssue[]
  renders?: number
  error?: JobFailure
}

const jobs = new Map<string, Job>()

/** Finished jobs kept per account, and in all, whatever their age. */
const MAX_FINISHED_PER_OWNER = 5
const MAX_FINISHED = 500

/** The job is not this caller's to see or stop, or is on another canvas. (An id nothing holds answers `undefined`: the job is gone.) */
export class JobNotFoundError extends Error {
  constructor() {
    super('No import job with that id on this canvas.')
    this.name = 'JobNotFoundError'
  }
}

/** The account already has a job running. */
export class JobLimitError extends Error {
  constructor(readonly jobId: string) {
    super(
      `You already have a Storybook import running (job ${jobId}). Call get_import_status with it to follow it, or cancel_import to stop it, before you start another.`,
    )
    this.name = 'JobLimitError'
  }
}

function sweep(now: number) {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt >= JOB_KEPT_MS) jobs.delete(id)
  }
}

/** Drops the oldest finished jobs past the per-account and overall caps, so failures that cost nothing cannot pile up. */
function trimFinished() {
  const finished = [...jobs.values()].filter((job) => job.finishedAt !== undefined)
  finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  const perOwner = new Map<string, number>()
  for (const job of finished) perOwner.set(job.owner, (perOwner.get(job.owner) ?? 0) + 1)
  let total = finished.length
  for (const job of finished) {
    const mine = perOwner.get(job.owner) ?? 0
    if (mine <= MAX_FINISHED_PER_OWNER && total <= MAX_FINISHED) continue
    jobs.delete(job.id)
    perOwner.set(job.owner, mine - 1)
    total--
  }
}

function view(job: Job): JobView {
  const cancelling = job.status === 'running' && job.cancelRequested
  return {
    job_id: job.id,
    status: cancelling ? 'cancelling' : job.status,
    rendered: job.rendered,
    total: job.total,
    component: job.component,
    ...(job.planned ? { planned: job.planned } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.issues ? { issues: job.issues } : {}),
    ...(job.renders !== undefined ? { renders: job.renders } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

function planOf(components: PlannedComponent[], info: PlanInfo): JobPlan {
  return {
    renders: info.importing,
    total: info.total,
    ...(info.capped ? { capped: true } : {}),
    components: components.slice(0, Math.min(info.importing, MAX_LISTED)).map((entry) => ({
      name: cleanLabel(entry.name) || 'Component',
      group: cleanLabel(entry.group, 200),
      stories: entry.stories,
    })),
  }
}

export interface StartJobInput {
  canvasId: string
  actor: Actor
  /** the account the hour and the one-at-a-time limit are counted on */
  owner: string
  url: string
  package?: string
  include?: string[]
  /** asked again right before the importer writes */
  canEdit: () => boolean
  deps?: StorybookImportDeps
  now?: number
}

/** Starts the import and answers once the plan is known (or the import already ended), without waiting for the renders. Throws what a refusal says: a bad URL, the hour used up, one already running, the server busy; and the failure of an import that could not even read the Storybook's index. */
export async function startStorybookJob(input: StartJobInput): Promise<JobView> {
  const now = input.now ?? Date.now()
  sweep(now)
  /* the canvas is read into memory before anything is counted: the checks below and the registration then share one synchronous stretch */
  await store.load(input.canvasId)
  const checked = checkStorybookUrl(input.url, input.deps)
  if (!checked.ok) throw new ComponentError(checked.message)
  for (const job of jobs.values()) {
    if (job.owner === input.owner && job.status === 'running') throw new JobLimitError(job.id)
  }
  if (!storybookSlotFree()) throw new StorybookBusyError()
  const refund = takeStorybookImport(input.owner)

  const job: Job = {
    id: randomBytes(16).toString('base64url'),
    canvasId: input.canvasId,
    owner: input.owner,
    status: 'running',
    rendered: 0,
    total: 0,
    component: null,
    controller: new AbortController(),
    cancelRequested: false,
    writing: false,
    release: store.hold(input.canvasId),
    startedAt: now,
  }
  jobs.set(job.id, job)

  let planKnown!: () => void
  const planned = new Promise<void>((resolve) => (planKnown = resolve))
  const settle = (status: JobStatus, patch: Partial<Job>) => {
    Object.assign(job, patch, { status, finishedAt: Date.now() })
    job.release()
    trimFinished()
    planKnown()
  }
  /* outside the request that started it: no write boundary and no work budget of its own to be charged to */
  const finished = detached(() =>
    outsideBudget(() =>
      runStorybookImport({
        canvasId: input.canvasId,
        actor: input.actor,
        url: checked.url.href,
        package: input.package,
        include: input.include,
        dryRun: false,
        signal: job.controller.signal,
        canEdit: input.canEdit,
        deps: input.deps,
        onWriting: () => {
          job.writing = true
        },
        onPlan: (components, info) => {
          job.planned = planOf(components, info)
          job.total = info.importing
          planKnown()
        },
        onRender: ({ rendered, total, component }) => {
          job.rendered = rendered
          job.total = total
          job.component = cleanLabel(component) || 'Component'
        },
      }),
    ),
  )
  finished.then(
    ({ result, issues, renders }) => {
      job.rendered = Math.max(job.rendered, renders)
      settle('done', { result, issues, renders })
    },
    (error: unknown) => {
      /* cancelled only when the stop came before any write: past that, an error is a failure, with what was kept said by the importer */
      if (job.cancelRequested && !job.writing) {
        settle('cancelled', {})
        return
      }
      /* a failure before anything rendered gives the hour's slot back */
      if (failedBeforeRendering(error)) refund()
      const { code, message } = storybookFailure(error)
      settle('failed', { error: { code, message } })
    },
  )

  const timer = setTimeout(() => planKnown(), PLAN_WAIT_MS)
  timer.unref()
  await planned
  clearTimeout(timer)
  return view(job)
}

/** Whether `owner` may read or stop `job`: the account that started it, or one that may edit the canvas. */
function reachable(job: Job | undefined, canvasId: string, owner: string, canEdit: () => boolean): job is Job {
  return !!job && job.canvasId === canvasId && (job.owner === owner || canEdit())
}

/** The job as it stands, `undefined` when no such job exists (never started, expired, or lost with a restart). Throws JobNotFoundError for one that is not this caller's. */
export function readStorybookJob(
  jobId: string,
  canvasId: string,
  access: { owner: string; canEdit: () => boolean },
  now = Date.now(),
): JobView | undefined {
  sweep(now)
  const job = jobs.get(jobId)
  if (!job) return undefined
  if (!reachable(job, canvasId, access.owner, access.canEdit)) throw new JobNotFoundError()
  return view(job)
}

/** Stops a running job through its signal. A job that already ended is left as it is. */
export function cancelStorybookJob(
  jobId: string,
  canvasId: string,
  access: { owner: string; canEdit: () => boolean },
  now = Date.now(),
): JobView | undefined {
  sweep(now)
  const job = jobs.get(jobId)
  if (!job) return undefined
  if (!reachable(job, canvasId, access.owner, access.canEdit)) throw new JobNotFoundError()
  if (job.status === 'running') {
    job.cancelRequested = true
    job.controller.abort(new Error('the import was cancelled'))
  }
  return view(job)
}

/** Forget every job (tests). */
export function clearStorybookJobs() {
  for (const job of jobs.values()) job.controller.abort(new Error('cleared'))
  jobs.clear()
}
