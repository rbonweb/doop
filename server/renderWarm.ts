import { DEFAULT_EXPORT_SCALE } from '../shared/exportScale.ts'
import type { Frame } from '../shared/types.ts'
import { normalizeRenderParams, renderExt, renderParamsHash } from './renderParams.ts'
import { getStoredRender, putStoredRender } from './renderStore.ts'
import type { RenderParams } from './renderTypes.ts'
import { store } from './store.ts'
import * as thumbs from './thumbs.ts'

/**
 * Warms the render store after a save, so the first `/i/` request for a new version of a frame is a stored hit instead of a Chromium render.
 *
 * A write to a frame's html or size arms a per-frame debounce; once the frame has been quiet for `WARM_DEBOUNCE_MS` (a burst of edits, a stream's chunks) the frame joins a queue, and at most `WARM_CONCURRENCY` renders run at once. The render is the one `get_canvas`, `export_frame` and the canvas thumbnails ask for by default: a png at `DEFAULT_EXPORT_SCALE`. It is stored under the frame's version in `renderStore`, which is exactly where `getRender` looks first.
 *
 * Bounded and best-effort: a frame is queued once (a newer write replaces its entry), the queue holds `WARM_QUEUE_MAX` frames and drops the oldest beyond that, a version that was superseded while it waited or rendered is not stored, a frame that is gone (a deleted canvas) is skipped, a frame with an open stream or playback waits for it, and nothing here ever fails or delays the write that triggered it. Off until `startRenderWarm` runs, so tests do not launch Chromium on every write.
 */

/** quiet time after the last write before a frame is rendered */
export const WARM_DEBOUNCE_MS = 3000
/** renders running at once */
export const WARM_CONCURRENCY = 2
/** frames waiting for a render slot; the oldest are dropped beyond this */
export const WARM_QUEUE_MAX = 50

export interface RenderWarmOptions {
  debounceMs?: number
  concurrency?: number
  queueMax?: number
  /** true while something still writes the frame (an open stream or playback): the warm-up waits for it */
  isBusy?: (frameId: string) => boolean
  /** renders one frame at the params; defaults to the shared Chromium capture */
  render?: (frame: Frame, params: RenderParams) => Promise<Buffer>
  /** starts the shared browser when the first write arms a debounce, so its launch hides in the quiet period; on unless `render` is injected */
  prelaunch?: boolean
}

interface Running {
  debounceMs: number
  concurrency: number
  queueMax: number
  isBusy: (frameId: string) => boolean
  render: (frame: Frame, params: RenderParams) => Promise<Buffer>
  prelaunch: boolean
  stopListening: () => void
}

let running: Running | undefined
/** frames whose debounce is armed */
const timers = new Map<string, NodeJS.Timeout>()
/** frames waiting for a slot, oldest first; each holds the version it was queued at */
const queue = new Map<string, number>()
let active = 0
/** completed warm renders, for tests and logs */
let warmed = 0

/** The params a warm render uses for a frame: the default png at the default export scale. */
export function warmParams(frame: Pick<Frame, 'width' | 'height'>): RenderParams {
  return normalizeRenderParams(frame, { format: 'png', scale: DEFAULT_EXPORT_SCALE })
}

async function chromiumRender(frame: Frame, params: RenderParams): Promise<Buffer> {
  const { captureFrame } = await import('./screenshot.ts')
  const { buf } = await captureFrame(await store.renderSource(frame), {
    format: params.format,
    scale: params.scale,
    quality: params.quality,
  })
  return buf
}

/** Starts listening for frame writes. Returns the function that stops it and drops what is pending. */
export function startRenderWarm(options: RenderWarmOptions = {}): () => void {
  stopRenderWarm()
  const state: Running = {
    debounceMs: options.debounceMs ?? WARM_DEBOUNCE_MS,
    concurrency: options.concurrency ?? WARM_CONCURRENCY,
    queueMax: options.queueMax ?? WARM_QUEUE_MAX,
    isBusy: options.isBusy ?? (() => false),
    render: options.render ?? chromiumRender,
    prelaunch: options.prelaunch ?? options.render === undefined,
    stopListening: () => {},
  }
  state.stopListening = store.onFrameRenderChange((frame) => scheduleWarm(frame.id))
  running = state
  return stopRenderWarm
}

export function stopRenderWarm(): void {
  running?.stopListening()
  running = undefined
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  queue.clear()
}

/** Arms (or re-arms) the frame's debounce. A no-op until `startRenderWarm`. */
export function scheduleWarm(frameId: string): void {
  const state = running
  if (!state) return
  if (state.prelaunch) {
    state.prelaunch = false
    void import('./screenshot.ts').then(({ getBrowser }) => getBrowser()).catch(() => {})
  }
  const armed = timers.get(frameId)
  if (armed) clearTimeout(armed)
  const timer = setTimeout(() => {
    timers.delete(frameId)
    enqueue(frameId)
  }, state.debounceMs)
  timer.unref()
  timers.set(frameId, timer)
}

function enqueue(frameId: string): void {
  const state = running
  if (!state) return
  const frame = store.getFrame(frameId)
  if (!frame) return
  if (state.isBusy(frameId)) {
    /* a stream or playback still writes it: look again after another quiet period */
    scheduleWarm(frameId)
    return
  }
  queue.delete(frameId)
  queue.set(frameId, frame.updatedAt)
  while (queue.size > state.queueMax) {
    const oldest = queue.keys().next().value
    if (oldest === undefined) break
    queue.delete(oldest)
  }
  pump()
}

function pump(): void {
  const state = running
  if (!state) return
  while (active < state.concurrency) {
    const next = queue.entries().next()
    if (next.done) return
    const [frameId, version] = next.value
    queue.delete(frameId)
    active++
    void warmOne(state, frameId, version)
      .catch((error: unknown) => {
        console.error(`[render-warm] ${frameId} failed:`, error)
      })
      .finally(() => {
        active--
        pump()
      })
  }
}

async function warmOne(state: Running, frameId: string, version: number): Promise<void> {
  const frame = store.getFrame(frameId)
  /* deleted (its canvas too) or written again since it was queued: the newer write has its own timer */
  if (!frame || frame.updatedAt !== version) return
  const params = warmParams(frame)
  const hash = renderParamsHash(params)
  const ext = renderExt(params.format)
  if (await getStoredRender(frame.id, version, hash, ext)) return
  const generation = thumbs.generation(frame.id)
  const buf = await state.render(frame, params)
  const after = store.getFrame(frameId)
  /* stored only if nothing changed the frame, or a stylesheet it links, while it rendered */
  if (!after || after.updatedAt !== version || thumbs.generation(frame.id) !== generation) return
  await putStoredRender(frame.id, version, hash, ext, buf)
  warmed++
}

/** Test and log helpers: what is waiting and running. */
export function renderWarmStats(): { armed: number; queued: number; active: number; warmed: number } {
  return { armed: timers.size, queued: queue.size, active, warmed }
}
