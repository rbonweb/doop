import { runExportJob, saveBlob } from './frameExport'
import { isDesktopShell } from './shell'
import { useStore } from './store'

/* A deck is exported as one PDF the server renders: one page per slide, each the slide's own size. Rendering takes a
   while, so the toast says what is happening, and the download itself reports its progress. */

/** A deck of a few dozen slides renders in well under this; past it the request is stuck. */
const DECK_TIMEOUT_MS = 4 * 60_000

export function deckPdfUrl(canvasId: string, pageId: string): string {
  return `/api/canvases/${encodeURIComponent(canvasId)}/pages/${encodeURIComponent(pageId)}/deck.pdf`
}

const slidesLabel = (count: number) => `${count} slide${count === 1 ? '' : 's'}`

function fileNameOf(res: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')
  return match?.[1] ?? fallback
}

async function failureOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  if (res.status === 429) return 'Too many deck exports — try again in a minute'
  return typeof error === 'string' && error ? error : 'Couldn’t export the deck'
}

/** Read the body, reporting the share received when the server said how long it is. */
async function readWithProgress(res: Response, onProgress: (share: number) => void): Promise<Blob> {
  const total = Number(res.headers.get('Content-Length')) || 0
  if (!res.body || !total) return res.blob()
  const reader = res.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array<ArrayBuffer>)
    received += value.length
    onProgress(Math.min(1, received / total))
  }
  return new Blob(chunks, { type: 'application/pdf' })
}

/** Render a page's slides to PDF and hand the file to the browser (or the desktop save panel), reporting through the canvas toast. */
export async function downloadDeckPdf(
  canvasId: string,
  pageId: string,
  pageName: string,
  slides: number,
): Promise<void> {
  const label = slidesLabel(slides)
  await runExportJob(`Exporting ${label} as PDF…`, async () => {
    try {
      const res = await fetch(deckPdfUrl(canvasId, pageId), { signal: AbortSignal.timeout(DECK_TIMEOUT_MS) })
      if (!res.ok) return await failureOf(res)
      const fileName = fileNameOf(res, `${pageName || 'deck'}.pdf`)
      const blob = await readWithProgress(res, (share) =>
        useStore.getState().pushNotice(`Downloading ${label} · ${Math.round(share * 100)}%`, { busy: true }),
      )
      saveBlob(blob, fileName)
      return isDesktopShell() ? null : `“${fileName}” is ready · ${label}`
    } catch (err) {
      return err instanceof DOMException && err.name === 'TimeoutError'
        ? 'The deck export timed out — try again'
        : 'Couldn’t export the deck'
    }
  })
}
