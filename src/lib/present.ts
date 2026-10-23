import { canvasPages, pageFrames } from '../../shared/pages'
import { readingOrder } from '../../shared/readingOrder'
import type { Canvas, Frame } from '../../shared/types'
import { useStore } from './store'

/** Where a presentation starts: the selected frame, or the first frame of the page in reading order. */
export function presentStart(
  canvas: Canvas,
  selectedId: string | null,
  activePageId: string | null,
): Frame | undefined {
  const selected = selectedId ? canvas.frames.find((f) => f.id === selectedId) : undefined
  if (selected) return selected
  const pageId = activePageId ?? canvasPages(canvas)[0]?.id
  return pageId ? readingOrder(pageFrames(canvas, pageId))[0] : undefined
}

/** Open present mode: on `frameId`, or where `presentStart` says. Says so when there is nothing to show. */
export function startPresenting(frameId?: string) {
  const s = useStore.getState()
  if (!s.canvas) return
  const start = frameId
    ? s.canvas.frames.find((f) => f.id === frameId)
    : presentStart(s.canvas, s.selectedId, s.activePageId)
  if (!start) {
    s.pushNotice('Nothing to present yet. Add a frame first.')
    return
  }
  s.setPresentFrame(start.id)
  s.setPresenting(true)
}
