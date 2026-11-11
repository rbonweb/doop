import { canvasPages } from '../../shared/pages'
import { flowStartFrame } from '../../shared/prototype'
import type { Canvas } from '../../shared/types'
import { useStore } from './store'

/** The frame a presentation opens on: the selected frame (unless it is hidden), else the page's flow start (its start
 *  frame, or its topmost visible one), else nothing to present. The Play button, ⇧P and ⌘⌥↩ agree through this. */
export function presentStartFrame(
  canvas: Canvas | null,
  selectedId: string | null,
  activePageId: string | null,
): string | null {
  if (!canvas) return null
  const selected = selectedId ? canvas.frames.find((f) => f.id === selectedId) : undefined
  if (selected && !selected.hidden) return selected.id
  const pageId = activePageId ?? canvasPages(canvas)[0]?.id
  return pageId ? (flowStartFrame(canvas, pageId)?.id ?? null) : null
}

/** Open present mode: on `frameId`, or where `presentStartFrame` says. Says so when there is nothing to show. */
export function startPresenting(frameId?: string) {
  const s = useStore.getState()
  if (!s.canvas) return
  const start = frameId
    ? s.canvas.frames.find((f) => f.id === frameId && !f.hidden)?.id
    : presentStartFrame(s.canvas, s.selectedId, s.activePageId)
  if (!start) {
    s.pushNotice('Nothing to present yet. Add a frame first.')
    return
  }
  s.setPresentFrame(start)
  s.setPresenting(true)
}
