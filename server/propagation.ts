import type { Actor } from '../shared/types.ts'
import { store } from './store.ts'
import { detached } from './journal.ts'
import { runOperation, WorkBudgetError } from './workBudget.ts'
import { env } from './env.ts'
import type { PropagationRow } from './db/persist.ts'

/**
 * Whole-canvas component work, done in the background. A change to a main (or
 * a request to detach every instance of a component) names the components it
 * concerns and returns; the frames are visited later, ONE per event-loop tick,
 * so no request ever rewrites a canvas synchronously. That synchronous sweep
 * blocked the server's one event loop for minutes on 2026-11-11.
 *
 * Work is kept per canvas and per frame: a frame waits once however many
 * components ask for it, so a burst of edits to one main (or a pull of fifty)
 * prepares each frame once. Canvases take turns, one frame each, so a large
 * canvas cannot starve the others. A canvas with work pending is loaded and
 * held (store.load / store.hold) until its queue drains.
 *
 * The queue is also kept in the database (`component_propagation_queue`, one row per frame and
 * task, written once the work is queued and deleted once the frame has had its turn), so a restart
 * resumes it (`restore`, called at boot) instead of leaving frames to catch up on their next write.
 * Frames a task says are waiting for a main's change (`waits`) are also told to the room, so the
 * editor can mark them while they catch up.
 *
 * What is done to a frame belongs to the task's handler (actions.ts registers
 * `propagate`, componentActions.ts `detach`); this file only decides which
 * frame is next and when.
 */

export type FrameTask = 'detach' | 'propagate'

/* a frame both tasks wait on is detached first, so the propagation sees the result */
const TASK_ORDER: readonly FrameTask[] = ['detach', 'propagate']

export interface TouchedFrame {
  id: string
  name: string
  approvalLost: boolean
}

export interface FrameOutcome {
  /** the frame was rewritten */
  touched?: TouchedFrame
  /** something else wrote the frame while it was being prepared: nothing was written, try again */
  requeue?: boolean
  /** the frame cannot be worked on for now (an agent is streaming into it): the request is
   *  kept, outside the queue, until `resumeFrame` says the frame is free again */
  defer?: boolean
  /** what the task counts (instances detached) */
  count?: number
}

export interface DrainReport {
  /** ids of the components the work was for, in the order they were asked for */
  components: string[]
  frames: TouchedFrame[]
  count: number
}

export interface FrameTaskHandler {
  /** Do the task on one frame. Synchronous: the read and the write share a tick. */
  frame(canvasId: string, frameId: string, componentIds: string[], actor: Actor): FrameOutcome
  /** Is this frame, still queued, showing something other than what the task will make of it?
   *  Only a task that has this is announced to the room as "catching up". */
  waits?(canvasId: string, frameId: string, componentIds: string[]): boolean
  /** The canvas has no frame left waiting for this task. */
  drained(canvasId: string, report: DrainReport, actor: Actor): void
}

interface TaskState {
  /** frames still to visit, each with the components asking for it */
  todo: Map<string, Set<string>>
  attempts: Map<string, number>
  components: Set<string>
  touched: Map<string, TouchedFrame>
  count: number
  actor: Actor
}

interface Job {
  canvasId: string
  tasks: Map<FrameTask, TaskState>
  release: () => void
  /** set while the canvas's frame HTML is being read: it takes no turn until then */
  loading: boolean
  waiters: ((reports: DrainReports) => void)[]
  /** what tasks that have already drained reported, for whoever waits on the canvas */
  reports: DrainReports
}

export type DrainReports = Partial<Record<FrameTask, DrainReport>>

/** A frame changed under its preparation this many times in a row: left for its own next write. */
const MAX_ATTEMPTS = 5

const handlers = new Map<FrameTask, FrameTaskHandler>()

/* ------------------------------------------------------------------ */
/* The queue in the database                                           */
/* ------------------------------------------------------------------ */

/** Where queue rows are kept: set once at server start; without one (unit tests) the queue is memory only. */
export interface QueueStore {
  write(upserts: PropagationRow[], removals: { frameId: string; task: string }[]): Promise<void>
  /** Is the frame's latest html still on its way to the database? A visited frame's row is kept
   *  until it is not: a kill before the write would otherwise lose both the change and the work. */
  frameWritePending?(frameId: string): boolean
  /** Call `listener` each time a frame's latest state has been stored. */
  onFrameStored?(listener: (frameId: string) => void): void
}
let queueStore: QueueStore | undefined
export function useQueueStore(next: QueueStore | undefined) {
  queueStore = next
  next?.onFrameStored?.(frameStored)
}

/** Component work is not stopped by `DOOP_PROPAGATION_PAUSED` in production: it is a test switch. */
export function paused(): boolean {
  return env.DOOP_PROPAGATION_PAUSED && env.NODE_ENV !== 'production'
}

/** frame id -> tasks whose row waits for the frame's write to reach the database before it is deleted */
const heldRemovals = new Map<string, Set<FrameTask>>()

function frameStored(frameId: string) {
  const held = heldRemovals.get(frameId)
  if (!held) return
  heldRemovals.delete(frameId)
  for (const task of held) forgetRow(task, frameId, true)
}

/** Row changes not yet sent: the latest word per frame and task (a row, or null for "delete"),
 *  so a burst of edits is one write and a delete can never overtake its upsert. */
const dirtyRows = new Map<string, PropagationRow | null>()
let flushScheduled = false
const rowKey = (task: FrameTask, frameId: string) => `${task}\0${frameId}`

function rememberRow(canvasId: string, task: FrameTask, frameId: string, componentIds: Iterable<string>, actor: Actor) {
  if (!queueStore) return
  heldRemovals.get(frameId)?.delete(task)
  dirtyRows.set(rowKey(task, frameId), {
    frameId,
    task,
    canvasId,
    componentIds: [...componentIds],
    actor,
    queuedAt: Date.now(),
  })
  scheduleFlush()
}

function forgetRow(task: FrameTask, frameId: string, durable = !queueStore?.frameWritePending?.(frameId)) {
  if (!queueStore) return
  if (!durable) {
    let held = heldRemovals.get(frameId)
    if (!held) heldRemovals.set(frameId, (held = new Set()))
    held.add(task)
    return
  }
  dirtyRows.set(rowKey(task, frameId), null)
  scheduleFlush()
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(() => void flushQueueStore())
}

/** Send the row changes now; resolves once they are stored (shutdown, tests). */
export async function flushQueueStore(): Promise<void> {
  flushScheduled = false
  if (!queueStore || !dirtyRows.size) return
  const upserts: PropagationRow[] = []
  const removals: { frameId: string; task: string }[] = []
  for (const [key, row] of dirtyRows) {
    if (row) upserts.push(row)
    else removals.push({ frameId: key.slice(key.indexOf('\0') + 1), task: key.slice(0, key.indexOf('\0')) })
  }
  dirtyRows.clear()
  await queueStore.write(upserts, removals)
}

/* ------------------------------------------------------------------ */
/* Frames waiting for a main's change, as the room is told             */
/* ------------------------------------------------------------------ */

/** frame ids per canvas that are queued for a task whose handler `waits` */
const catching = new Map<string, Set<string>>()
type CatchingListener = (canvasId: string, added: string[], removed: string[]) => void
let catchingListener: CatchingListener | undefined
export function onCatchingUp(listener: CatchingListener | undefined) {
  catchingListener = listener
}

/** The frames of a canvas still waiting for a change of a main to reach them. */
export function catchingUp(canvasId: string): string[] {
  return [...(catching.get(canvasId) ?? [])]
}

function markCatching(canvasId: string, frameIds: string[]) {
  if (!frameIds.length) return
  let set = catching.get(canvasId)
  if (!set) catching.set(canvasId, (set = new Set()))
  const added = frameIds.filter((id) => !set.has(id))
  for (const id of added) set.add(id)
  if (added.length) catchingListener?.(canvasId, added, [])
}

function unmarkCatching(canvasId: string, frameIds: string[]) {
  const set = catching.get(canvasId)
  if (!set) return
  const removed = frameIds.filter((id) => set.delete(id))
  if (!set.size) catching.delete(canvasId)
  if (removed.length) catchingListener?.(canvasId, [], removed)
}

/** A frame's turn is over (visited, skipped or gone): nothing more is owed for the task. */
function release(canvasId: string, task: FrameTask, frameId: string) {
  forgetRow(task, frameId)
  if (handlers.get(task)?.waits) unmarkCatching(canvasId, [frameId])
}

/** The frame was deleted: whatever it was owed, in the queue or kept for a stream, is owed no more. */
export function frameDeleted(frameId: string) {
  heldRemovals.delete(frameId)
  const owed = deferred.get(frameId)
  deferred.delete(frameId)
  const canvasId = owed?.canvasId
  for (const task of handlers.keys()) {
    const state = [...jobs.values()].flatMap((job) => (job.tasks.get(task)?.todo.has(frameId) ? [job] : []))
    for (const job of state) job.tasks.get(task)?.todo.delete(frameId)
    if (owed?.tasks.has(task) || state.length) {
      forgetRow(task, frameId, true)
      if (handlers.get(task)?.waits) unmarkCatching(canvasId ?? state[0]!.canvasId, [frameId])
    }
  }
}

/** A canvas that is gone, or a job given up: its queued frames are owed nothing. */
function abandon(job: Job) {
  for (const [task, state] of job.tasks) for (const frameId of state.todo.keys()) release(job.canvasId, task, frameId)
  finish(job)
}
const jobs = new Map<string, Job>()

/** Work a frame is owed once it is free: asked for while an agent was streaming into it.
 *  Kept apart from the jobs, so a canvas with nothing else to do is idle (and let go) while
 *  the stream stays open, and no tick is spent asking whether it has closed. */
interface Deferred {
  canvasId: string
  tasks: Map<FrameTask, { componentIds: Set<string>; actor: Actor }>
}
const deferred = new Map<string, Deferred>()
/** the canvases taking turns, next first */
const ring: string[] = []
let scheduled = false
let idleWaiters: (() => void)[] = []

export function registerFrameTask(task: FrameTask, handler: FrameTaskHandler) {
  handlers.set(task, handler)
}

function jobFor(canvasId: string): Job {
  const existing = jobs.get(canvasId)
  if (existing) return existing
  const job: Job = {
    canvasId,
    tasks: new Map(),
    release: store.hold(canvasId),
    loading: false,
    waiters: [],
    reports: {},
  }
  jobs.set(canvasId, job)
  ring.push(canvasId)
  return job
}

/** Frame HTML is loaded per canvas: a job never reads a frame of one that is not. */
function ensureLoaded(job: Job): boolean {
  if (store.isLoaded(job.canvasId)) return true
  if (job.loading) return false
  job.loading = true
  store
    .load(job.canvasId)
    .catch((error: unknown) => console.error('[propagation] loading a canvas failed', job.canvasId, error))
    .finally(() => {
      job.loading = false
      /* a canvas that could not be read has nothing a job may touch */
      if (!store.isLoaded(job.canvasId)) {
        /* the rows stay for the next boot; the room is no longer told these frames are waiting */
        for (const [task, state] of job.tasks)
          if (handlers.get(task)?.waits) unmarkCatching(job.canvasId, [...state.todo.keys()])
        finish(job)
      }
      schedule()
    })
  return false
}

/**
 * Ask for `task` on every frame of the canvas, for these components. Returns at
 * once: nothing is read or written here. `exceptFrameId` is the frame whose own
 * write caused this, which is already up to date.
 */
export function enqueue(
  task: FrameTask,
  canvasId: string,
  componentIds: string[],
  actor: Actor,
  options: { exceptFrameId?: string; onlyFrameIds?: readonly string[] } = {},
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !componentIds.length) return
  const job = jobFor(canvasId)
  let state = job.tasks.get(task)
  if (!state) {
    state = { todo: new Map(), attempts: new Map(), components: new Set(), touched: new Map(), count: 0, actor }
    job.tasks.set(task, state)
  }
  state.actor = actor
  for (const id of componentIds) state.components.add(id)
  const waits = handlers.get(task)?.waits
  const newlyWaiting: string[] = []
  for (const frame of canvas.frames) {
    if (frame.id === options.exceptFrameId) continue
    if (options.onlyFrameIds && !options.onlyFrameIds.includes(frame.id)) continue
    const owed = state.todo.get(frame.id)
    if (owed) for (const id of componentIds) owed.add(id)
    else state.todo.set(frame.id, new Set(componentIds))
    const all = state.todo.get(frame.id)!
    rememberRow(canvasId, task, frame.id, all, actor)
    if (waits?.(canvasId, frame.id, [...all])) newlyWaiting.push(frame.id)
  }
  markCatching(canvasId, newlyWaiting)
  schedule()
}

/**
 * Put back work a restart interrupted: the rows `component_propagation_queue` holds for one
 * canvas, as the queue had them. Nothing is written (the rows are already stored); the frames
 * are visited in the ordinary way, and each row goes once its frame has had its turn.
 */
export function restore(canvasId: string, rows: readonly PropagationRow[]) {
  if (!rows.length || !store.getCanvas(canvasId)) return
  const job = jobFor(canvasId)
  for (const row of rows) {
    const task = row.task as FrameTask
    if (!handlers.has(task)) continue
    let state = job.tasks.get(task)
    if (!state) {
      state = {
        todo: new Map(),
        attempts: new Map(),
        components: new Set(),
        touched: new Map(),
        count: 0,
        actor: row.actor,
      }
      job.tasks.set(task, state)
    }
    state.actor = row.actor
    for (const id of row.componentIds) state.components.add(id)
    const owed = state.todo.get(row.frameId)
    if (owed) for (const id of row.componentIds) owed.add(id)
    else state.todo.set(row.frameId, new Set(row.componentIds))
    if (handlers.get(task)?.waits?.(canvasId, row.frameId, row.componentIds)) markCatching(canvasId, [row.frameId])
  }
  if (!job.tasks.size) finish(job)
  schedule()
}

/** Start taking turns again after a pause (tests; `DOOP_PROPAGATION_PAUSED` is read on every turn). */
export function wake() {
  schedule()
}

function schedule() {
  if (scheduled || !ring.length || paused()) return
  scheduled = true
  /* detached: a tick is scheduled from inside whatever asked for work, and must never
     join that request's write boundary (server/journal.ts) */
  setImmediate(() => detached(tick))
}

/** One turn: the next canvas that can work does one frame. */
function tick() {
  scheduled = false
  /* canvases still being read are passed over; when none can work, their load reschedules */
  for (const canvasId of [...ring]) {
    const job = jobs.get(canvasId)
    if (!job) continue
    ring.splice(ring.indexOf(canvasId), 1)
    ring.push(canvasId)
    if (!store.getCanvas(canvasId)) {
      abandon(job)
      continue
    }
    if (!ensureLoaded(job)) continue
    step(job)
    schedule()
    return
  }
}

function nextWork(job: Job): { task: FrameTask; state: TaskState } | undefined {
  for (const task of TASK_ORDER) {
    const state = job.tasks.get(task)
    if (state) return { task, state }
  }
  return undefined
}

function step(job: Job) {
  const work = nextWork(job)
  if (!work) return finish(job)
  const { task, state } = work
  const [frameId, componentIds] = state.todo.entries().next().value ?? []
  if (frameId && componentIds) {
    state.todo.delete(frameId)
    visit(job, task, state, frameId, [...componentIds])
  }
  if (state.todo.size) return
  job.tasks.delete(task)
  const report: DrainReport = {
    components: [...state.components],
    frames: [...state.touched.values()],
    count: state.count,
  }
  job.reports[task] = merged(job.reports[task], report)
  guarded(`${task} drained`, job.canvasId, () => handlers.get(task)?.drained(job.canvasId, report, state.actor))
  if (!job.tasks.size) finish(job)
}

function visit(job: Job, task: FrameTask, state: TaskState, frameId: string, componentIds: string[]) {
  /* its own operation: one frame's worth of budget, a name the stall watchdog can report,
     and one write boundary, so a frame is brought up to date whole or left as it was */
  const outcome = guarded(`${task} of frame ${frameId}`, job.canvasId, () =>
    runOperation(`queue ${task} frame ${frameId}`, job.canvasId, () =>
      handlers.get(task)?.frame(job.canvasId, frameId, componentIds, state.actor),
    ),
  )
  if (!outcome) return release(job.canvasId, task, frameId)
  if (outcome.defer) return defer(job.canvasId, task, frameId, componentIds, state.actor)
  if (outcome.count) state.count += outcome.count
  if (outcome.touched) {
    const before = state.touched.get(frameId)
    state.touched.set(frameId, {
      ...outcome.touched,
      approvalLost: outcome.touched.approvalLost || !!before?.approvalLost,
    })
  }
  if (!outcome.requeue) return release(job.canvasId, task, frameId)
  const attempts = (state.attempts.get(frameId) ?? 0) + 1
  if (attempts >= MAX_ATTEMPTS) {
    console.error(`[propagation] frame ${frameId} kept changing; left for its own next write`, job.canvasId)
    return release(job.canvasId, task, frameId)
  }
  state.attempts.set(frameId, attempts)
  const waiting = state.todo.get(frameId)
  if (waiting) for (const id of componentIds) waiting.add(id)
  else state.todo.set(frameId, new Set(componentIds))
}

function defer(canvasId: string, task: FrameTask, frameId: string, componentIds: string[], actor: Actor) {
  let owed = deferred.get(frameId)
  if (!owed) deferred.set(frameId, (owed = { canvasId, tasks: new Map() }))
  const waiting = owed.tasks.get(task)
  if (waiting) {
    for (const id of componentIds) waiting.componentIds.add(id)
    waiting.actor = actor
  } else owed.tasks.set(task, { componentIds: new Set(componentIds), actor })
}

/** The frame is free again (its stream closed, finished or abandoned): what it was owed goes
 *  back into the queue, for that frame alone. A frame deleted meanwhile is simply not there
 *  when its turn comes. */
export function resumeFrame(frameId: string) {
  const owed = deferred.get(frameId)
  if (!owed) return
  deferred.delete(frameId)
  for (const [task, { componentIds, actor }] of owed.tasks)
    enqueue(task, owed.canvasId, [...componentIds], actor, { onlyFrameIds: [frameId] })
}

/** Frames with work kept for when they are free. */
export function deferredFrames(): string[] {
  return [...deferred.keys()]
}

/** A frame that throws is skipped and said so: the queue, and the process, outlive it. One
 *  over its work budget is left as it is (still materialized, at the revision it had) and
 *  catches up on its own next write, if that fits. */
function guarded<T>(what: string, canvasId: string, run: () => T): T | undefined {
  try {
    return run()
  } catch (error) {
    if (error instanceof WorkBudgetError) console.error(`[propagation] ${what} skipped: ${error.message}`)
    else console.error(`[propagation] ${what} failed; skipped`, canvasId, error)
    return undefined
  }
}

function merged(earlier: DrainReport | undefined, later: DrainReport): DrainReport {
  if (!earlier) return later
  const frames = new Map(earlier.frames.map((frame) => [frame.id, frame]))
  for (const frame of later.frames)
    frames.set(frame.id, { ...frame, approvalLost: frame.approvalLost || !!frames.get(frame.id)?.approvalLost })
  return {
    components: [...new Set([...earlier.components, ...later.components])],
    frames: [...frames.values()],
    count: earlier.count + later.count,
  }
}

function finish(job: Job) {
  if (jobs.get(job.canvasId) !== job) return
  jobs.delete(job.canvasId)
  const at = ring.indexOf(job.canvasId)
  if (at !== -1) ring.splice(at, 1)
  job.release()
  for (const waiter of job.waiters) waiter(job.reports)
  if (jobs.size) return
  const waiting = idleWaiters
  idleWaiters = []
  for (const waiter of waiting) waiter()
}

/** Is this component waiting to be carried to frames of the canvas? */
export function isPending(canvasId: string, task: FrameTask, componentId: string): boolean {
  const state = jobs.get(canvasId)?.tasks.get(task)
  if (!state) return false
  for (const waiting of state.todo.values()) if (waiting.has(componentId)) return true
  return false
}

/** How many frames of the canvas still wait for a visit. */
export function pendingFrames(canvasId: string): number {
  let frames = 0
  for (const state of jobs.get(canvasId)?.tasks.values() ?? []) frames += state.todo.size
  return frames
}

/** Resolves when the canvas has no work pending, with what its queue did since it last was idle. */
export function whenCanvasIdle(canvasId: string): Promise<DrainReports> {
  const job = jobs.get(canvasId)
  /* a held queue (a test switch) would never answer */
  if (!job || paused()) return Promise.resolve({})
  return new Promise((resolve) => job.waiters.push(resolve))
}

/** Like whenCanvasIdle, but gives up after `ms`: false when work is still pending then. */
export function settled(canvasIds: string[], ms: number): Promise<boolean> {
  const busy = canvasIds.filter((id) => jobs.has(id))
  if (!busy.length) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void Promise.all(busy.map(whenCanvasIdle)).then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** How long a read that an agent uses to check its work waits for the canvas to settle. */
const READ_SETTLE_MS = 2000

/** Tools an agent checks a change with (a frame's HTML, a screenshot, an export): they wait
 *  a moment for queued work on their canvas, so the check sees the change it follows. */
export const SETTLING_TOOLS: ReadonlySet<string> = new Set([
  'get_frame',
  'get_frame_screenshot',
  'export_frame',
  'export_react',
  'get_frame_html',
  'inspect_frame',
  'screenshot_frame',
])

export function settleForRead(tool: string, canvasIds: string[]): Promise<boolean> {
  return SETTLING_TOOLS.has(tool) ? settled(canvasIds, READ_SETTLE_MS) : Promise.resolve(true)
}

/** Resolves when no canvas has work pending. Tests await this where they used to read a
 *  synchronous result. */
export function whenIdle(): Promise<void> {
  if (!jobs.size) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

export function stats() {
  return { canvases: jobs.size, frames: [...jobs.keys()].reduce((total, id) => total + pendingFrames(id), 0) }
}
