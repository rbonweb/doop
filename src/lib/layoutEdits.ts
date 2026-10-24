import { canvasPages, pageFrames } from '../../shared/pages'
import type { Frame } from '../../shared/types'
import type { DevicePreset } from '../../shared/devices'
import { tidyLayout } from '../../shared/tidy'
import { api } from './api'
import { fitViewport } from './fit'
import { recordUpdates, trackSave } from './history'
import { useStore } from './store'

/* Bulk layout edits behind the t and 1–4/0 keys. Each one commits like a
   drag does: the local store first, then the normal frame update (so
   collaborators see it live), and a single undo entry for the whole key press. */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const rectOf = (f: Rect): Rect => ({ x: f.x, y: f.y, width: f.width, height: f.height })
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** The frames a layout key acts on: the selection, or every frame on the page when nothing is selected.
 *  Hidden frames take no part (the canvas is not drawing them) and locked frames are never moved or resized. */
export function layoutTargets(): Frame[] {
  const s = useStore.getState()
  if (!s.canvas) return []
  const onPage = pageFrames(s.canvas, s.activePageId ?? canvasPages(s.canvas)[0]!.id)
  const picked = onPage.filter((f) => s.selectedIds.includes(f.id))
  return (picked.length ? picked : onPage).filter((f) => !f.hidden && !f.locked)
}

/** Move/resize frames to `after`, as one undo step. Returns how many actually changed. */
function commitRects(changes: { frame: Frame; after: Rect }[]): number {
  const items: Parameters<typeof recordUpdates>[0] = []
  for (const { frame, after } of changes) {
    const before = rectOf(frame)
    if (sameRect(before, after)) continue
    useStore.getState().patchFrameLocal(frame.id, after)
    trackSave(api.updateFrame(frame.id, after).catch(console.error))
    items.push({ frameId: frame.id, before, after })
  }
  recordUpdates(items)
  return items.length
}

/** `t`: lay the selection (or the page) out in tidy reading-order rows. */
export function tidyFrames(frames: Frame[] = layoutTargets()): number {
  const positions = new Map(tidyLayout(frames).map((p) => [p.id, p]))
  return commitRects(
    frames.flatMap((frame) => {
      const at = positions.get(frame.id)
      return at ? [{ frame, after: { ...rectOf(frame), x: at.x, y: at.y } }] : []
    }),
  )
}

/* what each frame looked like before the first device key on a page, so 0 can put it back exactly */
const beforeDevices = new Map<string, Map<string, Rect>>()

const pageKey = () => {
  const s = useStore.getState()
  return `${s.canvas?.id}:${s.activePageId}`
}

export function clearLayoutSnapshots() {
  beforeDevices.clear()
}

/** `1`–`4`: size the selection (or the page) to a device, tidy it, and bring it into view. */
export function applyDevice(preset: DevicePreset) {
  const frames = layoutTargets()
  if (!frames.length) return
  const key = pageKey()
  const saved = beforeDevices.get(key) ?? new Map<string, Rect>()
  /* only the first device key remembers a frame — pressing 2 after 1 must still restore to the original */
  for (const f of frames) if (!saved.has(f.id)) saved.set(f.id, rectOf(f))
  beforeDevices.set(key, saved)

  const sized = frames.map((f) => ({ ...rectOf(f), id: f.id, width: preset.width, height: preset.height }))
  const positions = new Map(tidyLayout(sized).map((p) => [p.id, p]))
  commitRects(
    frames.map((frame) => {
      const at = positions.get(frame.id)
      return { frame, after: { x: at?.x ?? frame.x, y: at?.y ?? frame.y, width: preset.width, height: preset.height } }
    }),
  )
  useStore.getState().fitSelection()
}

/** `0`: put every frame the device keys touched back where and as large as it was. False when there is nothing to restore. */
export function restoreDevices(): boolean {
  const key = pageKey()
  const saved = beforeDevices.get(key)
  if (!saved?.size) return false
  beforeDevices.delete(key)
  const live = useStore.getState().canvas?.frames ?? []
  const restored = live.flatMap((frame) => {
    const after = saved.get(frame.id)
    return after ? [{ frame, after }] : []
  })
  commitRects(restored)
  const stage = useStore.getState().stageSize
  if (stage && restored.length) {
    useStore.getState().setViewport(
      fitViewport(
        restored.map((r) => ({ ...r.after })),
        stage,
      ),
    )
  }
  return true
}
