import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({ runStorybookImport: vi.fn() }))
vi.mock('../server/storybookImportRun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/storybookImportRun.ts')>()
  return { ...actual, runStorybookImport: run.runStorybookImport }
})

import { ComponentError } from '../server/componentActions.ts'
import { StorybookIndexError, STORYBOOK_IMPORTS_PER_HOUR } from '../server/storybookImport.ts'
import {
  cancelStorybookJob,
  clearStorybookJobs,
  JOB_KEPT_MS,
  JobLimitError,
  JobNotFoundError,
  readStorybookJob,
  startStorybookJob,
} from '../server/storybookJobs.ts'
import type { Actor } from '../shared/types.ts'

/* A Storybook import as a job: started, read and stopped through its id, never tied to the request that began it. The run is a stand-in the test finishes on cue, so no read waits on a clock. */

const EMPTY = {
  created: [{ name: 'Button', id: 'c1' }],
  updated: [],
  unchanged: [],
  skipped: [],
  tokens: { created: [], skipped: [] },
  pageId: 'p1',
  issues: [],
}
const actor = { name: 'T', kind: 'agent' } as unknown as Actor

interface RunOptions {
  signal: AbortSignal
  onPlan: (components: unknown[], info: unknown) => void
  onRender: (event: { rendered: number; total: number; component: string }) => void
}

/** A run the test finishes: `finish` resolves it, `fail` rejects it; an abort rejects it with the signal's reason. */
function controlledRun() {
  const handle = {} as {
    options: RunOptions
    finish: () => Promise<void>
    fail: (error: unknown) => Promise<void>
    settled: Promise<unknown>
  }
  run.runStorybookImport.mockImplementation((options: RunOptions) => {
    handle.options = options
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    options.onPlan([{ name: 'Button', group: 'Inputs/Button', stories: 2, renders: 1 }], {
      total: 1,
      capped: false,
      importing: 1,
    })
    handle.finish = async () => {
      resolve({ result: EMPTY, issues: [{ code: 'note', message: 'm' }], renders: 3 })
      await promise
    }
    handle.fail = async (error) => {
      reject(error)
      await promise.catch(() => {})
    }
    handle.settled = promise.catch(() => {})
    return promise
  })
  return handle
}

let owners = 0
const start = (owner: string, over: Partial<Parameters<typeof startStorybookJob>[0]> = {}) =>
  startStorybookJob({
    canvasId: 'canvas-1',
    actor,
    owner,
    url: 'https://sb.test/',
    canEdit: () => true,
    ...over,
  })
const mine = (owner: string, canEdit = () => false) => ({ owner, canEdit })
const owner = () => `owner-${owners++}`

beforeEach(() => {
  run.runStorybookImport.mockReset()
  clearStorybookJobs()
})

describe('a Storybook import job', () => {
  it('starts running with its plan, shows progress, and ends done with the result', async () => {
    const handle = controlledRun()
    const who = owner()
    const started = await start(who)
    expect(started).toMatchObject({
      status: 'running',
      rendered: 0,
      planned: { renders: 1, total: 1, components: [{ name: 'Button', group: 'Inputs/Button', stories: 2 }] },
    })
    expect(started.job_id).toMatch(/^[A-Za-z0-9_-]{22}$/)

    handle.options.onRender({ rendered: 2, total: 5, component: 'Button\u0000<b>' })
    expect(readStorybookJob(started.job_id, 'canvas-1', mine(who))).toMatchObject({
      status: 'running',
      rendered: 2,
      total: 5,
      component: 'Button b',
    })

    await handle.finish()
    expect(readStorybookJob(started.job_id, 'canvas-1', mine(who))).toMatchObject({
      status: 'done',
      result: EMPTY,
      issues: [{ code: 'note', message: 'm' }],
      renders: 3,
    })
  })

  it('is not tied to the caller: it runs on a signal of its own that nothing aborts at start', async () => {
    const handle = controlledRun()
    await start(owner())
    expect(handle.options.signal.aborted).toBe(false)
  })

  it('fails with the failure the import names, and gives the hour back when nothing was rendered', async () => {
    const who = owner()
    run.runStorybookImport.mockRejectedValue(new StorybookIndexError('No Storybook index.json was found'))
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR + 2; i++) {
      const job = await start(who)
      expect(job).toMatchObject({
        status: 'failed',
        error: { code: 'unreachable', message: 'No Storybook index.json was found' },
      })
    }
  })

  it('fails mid-run without refunding, and never shows an internal message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = controlledRun()
    const who = owner()
    const started = await start(who)
    await handle.fail(new Error('connect ECONNREFUSED 10.0.0.5:9222'))
    const job = readStorybookJob(started.job_id, 'canvas-1', mine(who))
    expect(job).toMatchObject({ status: 'failed', error: { message: 'The Storybook import failed' } })
    expect(JSON.stringify(job)).not.toContain('10.0.0.5')
    log.mockRestore()
  })

  it('is cancelled through its signal', async () => {
    const handle = controlledRun()
    const who = owner()
    const started = await start(who)
    expect(cancelStorybookJob(started.job_id, 'canvas-1', mine(who))?.status).toBe('running')
    expect(handle.options.signal.aborted).toBe(true)
    await handle.settled
    expect(readStorybookJob(started.job_id, 'canvas-1', mine(who))?.status).toBe('cancelled')
    /* a finished job is left as it is */
    expect(cancelStorybookJob(started.job_id, 'canvas-1', mine(who))?.status).toBe('cancelled')
  })

  it('answers a finished job to cancel without changing it', async () => {
    const handle = controlledRun()
    const who = owner()
    const started = await start(who)
    await handle.finish()
    expect(cancelStorybookJob(started.job_id, 'canvas-1', mine(who))?.status).toBe('done')
  })

  it('is found by its starter and by another editor of the canvas, and by nobody else', async () => {
    controlledRun()
    const who = owner()
    const started = await start(who)
    const id = started.job_id
    expect(readStorybookJob(id, 'canvas-1', mine(who))?.status).toBe('running')
    expect(
      readStorybookJob(
        id,
        'canvas-1',
        mine('someone-else', () => true),
      )?.status,
    ).toBe('running')
    expect(() => readStorybookJob(id, 'canvas-1', mine('a-stranger'))).toThrow(JobNotFoundError)
    expect(() => cancelStorybookJob(id, 'canvas-1', mine('a-stranger'))).toThrow(JobNotFoundError)
    /* the id on another canvas is not found either, even for an editor there */
    expect(() =>
      readStorybookJob(
        id,
        'canvas-2',
        mine(who, () => true),
      ),
    ).toThrow(JobNotFoundError)
  })

  it('answers undefined for an id it never had (a restart, or expiry)', () => {
    expect(readStorybookJob('nope', 'canvas-1', mine('x'))).toBeUndefined()
  })

  it('allows one running job per account, and another account its own', async () => {
    controlledRun()
    const who = owner()
    const first = await start(who)
    await expect(start(who)).rejects.toThrow(JobLimitError)
    await expect(start(who)).rejects.toThrow(first.job_id)
    expect(await start(owner())).toMatchObject({ status: 'running' })
  })

  it('lets the account start again once its job ended', async () => {
    const handle = controlledRun()
    const who = owner()
    await start(who)
    await handle.finish()
    expect(await start(who)).toMatchObject({ status: 'running' })
  })

  it('counts imports an hour on the account', async () => {
    const who = owner()
    run.runStorybookImport.mockResolvedValue({ result: EMPTY, issues: [], renders: 1 })
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR; i++) expect((await start(who)).status).toBe('done')
    await expect(start(who)).rejects.toThrow(/Storybook imports in the last hour/)
  })

  it('refuses a URL that could never be read, before anything starts', async () => {
    await expect(start(owner(), { url: 'ftp://sb.test/' })).rejects.toThrow(ComponentError)
    expect(run.runStorybookImport).not.toHaveBeenCalled()
  })

  it('answers without a plan when the run ends before it makes one', async () => {
    run.runStorybookImport.mockResolvedValue({ result: EMPTY, issues: [], renders: 1 })
    const job = await start(owner())
    expect(job.status).toBe('done')
    expect(job.planned).toBeUndefined()
  })

  it('keeps a finished job for 30 minutes, then forgets it; a running one is never dropped', async () => {
    const handle = controlledRun()
    const who = owner()
    const running = await start(who)
    const later = Date.now() + JOB_KEPT_MS + 1000
    expect(readStorybookJob(running.job_id, 'canvas-1', mine(who), later)?.status).toBe('running')
    await handle.finish()
    expect(readStorybookJob(running.job_id, 'canvas-1', mine(who), Date.now() + JOB_KEPT_MS - 1000)?.status).toBe(
      'done',
    )
    expect(readStorybookJob(running.job_id, 'canvas-1', mine(who), later)).toBeUndefined()
  })
})
