import type { Frame } from '../../shared/types'
import { isDesktopShell } from './shell'
import { useStore } from './store'

export type FrameExportFormat = 'png' | 'jpg'

const FORMAT_LABEL: Record<FrameExportFormat, string> = { png: 'PNG', jpg: 'JPG' }

/* Blob URLs are revoked late: in the desktop shell the save panel opens
   before WebKit reads the blob, and the person may take a while to pick. */
const BLOB_URL_LIFETIME_MS = 10 * 60_000

export function frameExportUrl(frame: Frame, format: FrameExportFormat, scale: 2 | 4 = 2): string {
  return `/i/${frame.id}.${format}?scale=${scale}&download`
}

/** The server names the file after the frame; fall back to that if the
 *  header is missing or unreadable. */
function fileNameOf(res: Response, frame: Frame, format: FrameExportFormat): string {
  const header = res.headers.get('Content-Disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(header)
  return match?.[1] ?? `${frame.name || 'frame'}.${format}`
}

async function failureOf(res: Response, format: FrameExportFormat): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? error : `Couldn’t export the ${FORMAT_LABEL[format]}`
}

/* A `download` attribute is what makes this a download everywhere: the
   desktop shell's webview ignores Content-Disposition for types it can
   display (PNG and JPG) and would show the file
   in the window instead; with the attribute it opens the native save panel. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS)
}

/* An image of a busy frame renders in seconds; a request still open after
   this is stuck, and must not leave the spinner up forever. */
const EXPORT_TIMEOUT_MS = 2 * 60_000

/* Exports share the one canvas toast, so an outcome must not claim the
   spinner while another export is still rendering. */
let inFlight = 0

/** `outcome` null: nothing to say — the desktop shell's save panel is the
 *  feedback, and it may yet be cancelled, so "ready" would be a claim. */
function report(outcome: string | null) {
  const { notice, pushNotice } = useStore.getState()
  if (inFlight > 0) {
    const more = `Exporting ${inFlight} more…`
    pushNotice(outcome ? `${outcome} · ${more}` : more, { busy: true })
  } else if (outcome) {
    pushNotice(outcome)
  } else if (notice?.busy) {
    useStore.setState({ notice: null })
  }
}

export type FrameExportResult = { ok: true; fileName: string } | { ok: false; error: string }

/** Render one frame and hand it to the browser (or the desktop save panel). Never throws: the result says what happened. */
export async function saveFrameExport(frame: Frame, format: FrameExportFormat): Promise<FrameExportResult> {
  try {
    const res = await fetch(frameExportUrl(frame, format), { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, error: await failureOf(res, format) }
    const fileName = fileNameOf(res, frame, format)
    saveBlob(await res.blob(), fileName)
    return { ok: true, fileName }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof DOMException && err.name === 'TimeoutError'
          ? `The ${FORMAT_LABEL[format]} export timed out — try again`
          : `Couldn’t export the ${FORMAT_LABEL[format]}`,
    }
  }
}

async function exportOutcome(frame: Frame, format: FrameExportFormat): Promise<string | null> {
  const result = await saveFrameExport(frame, format)
  if (!result.ok) return result.error
  return isDesktopShell() ? null : `“${result.fileName}” is ready`
}

/** Save the frame's document as an .html file: the same text the raw editor shows, so a draft in progress exports as typed. Nothing to fetch, so it cannot fail the way the rendered exports can. */
export function downloadFrameHtml(frame: Frame, html = frame.html): void {
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${frame.name || 'frame'}.html`)
}

/** Render and download a frame export, reporting through the canvas toast: a spinner while the server renders (rendering can take several seconds), then the outcome. Fired from surfaces that close on click, so the toast in the store is the only place the result can land. */
export async function downloadFrameExport(frame: Frame, format: FrameExportFormat): Promise<void> {
  await runExportJob(`Exporting ${FORMAT_LABEL[format]}…`, () => exportOutcome(frame, format))
}

/** Run one export under the shared toast: `busy` while it works, then the outcome the job returns (null: nothing to say). */
export async function runExportJob(busy: string, job: () => Promise<string | null>): Promise<void> {
  inFlight += 1
  useStore.getState().pushNotice(busy, { busy: true })
  const outcome = await job()
  inFlight -= 1
  report(outcome)
}

/* Browsers ask before letting a page start many downloads at once, and the
   desktop shell opens one save panel per file; a short beat between files
   keeps both from dropping the later ones. */
export const BATCH_PAUSE_MS = 450

export interface BatchProgress {
  /** 1-based position of the frame being rendered now */
  index: number
  total: number
  frame: Frame
}

export interface BatchFailure {
  frame: Frame
  error: string
}

export interface BatchSummary {
  saved: number
  failures: BatchFailure[]
  /** the caller asked to stop before every frame was done */
  stopped: boolean
}

export interface BatchOptions {
  onProgress?: (progress: BatchProgress) => void
  /** polled before each frame — true ends the run after the current one */
  shouldStop?: () => boolean
  pauseMs?: number
  /** seams for tests */
  exportOne?: typeof saveFrameExport
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Export frames one after another, so the server renders a single image at a
 *  time and every download gets its own beat. A failed frame is recorded and
 *  the rest carry on. */
export async function exportFrames(
  frames: Frame[],
  format: FrameExportFormat,
  { onProgress, shouldStop, pauseMs = BATCH_PAUSE_MS, exportOne = saveFrameExport, wait = sleep }: BatchOptions = {},
): Promise<BatchSummary> {
  const summary: BatchSummary = { saved: 0, failures: [], stopped: false }
  for (const [i, frame] of frames.entries()) {
    if (i > 0) await wait(pauseMs)
    if (shouldStop?.()) {
      summary.stopped = true
      break
    }
    onProgress?.({ index: i + 1, total: frames.length, frame })
    const result = await exportOne(frame, format)
    if (result.ok) summary.saved += 1
    else summary.failures.push({ frame, error: result.error })
  }
  return summary
}

/** Copy a frame to the clipboard as a PNG rendered at `scale` (the menu's Copy as PNG is 2×; `i` / `⇧I` are 2× / 4×), reporting through the canvas toast like the downloads. The clipboard write gets the pending render, not a finished blob, so Safari keeps the click or key press as the user gesture; ClipboardItem gets the pending blob because WebKit allows the write only while the click's user activation is live, and the render can take seconds. */
export async function copyFramePng(frame: Frame, scale: 2 | 4 = 2): Promise<void> {
  /* no async clipboard outside a secure context (a self-hosted instance on
     plain http) or in older engines: say so before spending a render */
  if (!('clipboard' in navigator) || typeof ClipboardItem === 'undefined') {
    useStore.getState().pushNotice('This browser can’t copy images')
    return
  }
  inFlight += 1
  useStore.getState().pushNotice('Copying PNG…', { busy: true })
  /* engines differ in what the write rejects with when the blob fails, so
     the render's reason is kept here rather than read off the error */
  let failure = 'Couldn’t copy the PNG'
  const png = (async () => {
    try {
      const res = await fetch(frameExportUrl(frame, 'png', scale), { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
      if (res.ok) {
        const blob = await res.blob()
        /* an app server that answers an unknown path with its index page must not land on the clipboard as a PNG */
        if (!blob.type.startsWith('image/')) {
          failure = 'The server did not send an image'
          throw new Error(failure)
        }
        return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })
      }
      failure = await failureOf(res, 'png')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') failure = 'The PNG copy timed out — try again'
    }
    throw new Error(failure)
  })()
  /* the clipboard can refuse without ever reading it */
  png.catch(() => {})
  let outcome: string
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    outcome = 'PNG copied'
  } catch {
    outcome = failure
  }
  inFlight -= 1
  report(outcome)
}
