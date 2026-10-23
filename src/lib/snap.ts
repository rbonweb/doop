import { DEVICE_WIDTHS } from '../../shared/devices'
import type { Frame } from '../../shared/types'

/**
 * Alignment snapping: while a frame moves or resizes, its edges and centers
 * pull onto the matching edges/centers of the other frames on the canvas.
 * Pure math — the Stage draws the returned guides, FrameView applies the
 * snapped rect.
 */

/* how close (in screen px) an edge must be before it locks on */
const SNAP_PX = 8
/* a resize pulls onto a device width (390, 834, 1280, 1440) from this far away */
const DEVICE_SNAP_PX = 12

export interface SnapGuide {
  /** 'v': vertical line at x=`at` spanning `from`..`to` in y; 'h': the converse */
  axis: 'v' | 'h'
  at: number
  from: number
  to: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/* start / center / end of a span */
const lines = (pos: number, size: number) => [pos, pos + size / 2, pos + size]

function closest(ownOffsets: number[], base: number, others: Frame[], key: 'x' | 'y', tol: number) {
  let hit: { delta: number; at: number; other: Frame } | null = null
  for (const o of others) {
    for (const at of lines(o[key], key === 'x' ? o.width : o.height)) {
      for (const offset of ownOffsets) {
        const delta = at - (base + offset)
        if (Math.abs(delta) <= tol && (!hit || Math.abs(delta) < Math.abs(hit.delta))) hit = { delta, at, other: o }
      }
    }
  }
  return hit
}

/** Snap a dragged rect against the other frames. Moving considers the
 *  frame's start/center/end on both axes; resizing only the moving
 *  right/bottom edges. `zoom` converts the screen-px tolerance to world units. */
export function snapFrame(
  mode: 'move' | 'resize',
  rect: Rect,
  others: Frame[],
  zoom: number,
): Rect & { guides: SnapGuide[] } {
  const tol = SNAP_PX / zoom
  let { x, y, width, height } = rect
  let gx = closest(mode === 'move' ? lines(0, width) : [width], x, others, 'x', tol)
  let gy = closest(mode === 'move' ? lines(0, height) : [height], y, others, 'y', tol)
  if (mode === 'move') {
    if (gx) x += gx.delta
    if (gy) y += gy.delta
  } else {
    /* a snap that would shrink past the minimum loses to the clamp */
    if (gx && width + gx.delta >= 120) width += gx.delta
    else gx = null
    if (gy && height + gy.delta >= 80) height += gy.delta
    else gy = null
  }
  const guides: SnapGuide[] = []
  if (gx)
    guides.push({
      axis: 'v',
      at: gx.at,
      from: Math.min(y, gx.other.y),
      to: Math.max(y + height, gx.other.y + gx.other.height),
    })
  if (gy)
    guides.push({
      axis: 'h',
      at: gy.at,
      from: Math.min(x, gy.other.x),
      to: Math.max(x + width, gy.other.x + gy.other.width),
    })
  return { x, y, width, height, guides }
}

/** While resizing, pull the width onto the nearest device preset within 12 screen px. Returns the rect unchanged (and
 *  no guide) when none is close enough. */
export function snapDeviceWidth(rect: Rect, zoom: number): Rect & { guides: SnapGuide[] } {
  const tol = DEVICE_SNAP_PX / zoom
  let hit: number | null = null
  for (const width of DEVICE_WIDTHS) {
    if (
      Math.abs(width - rect.width) <= tol &&
      (hit === null || Math.abs(width - rect.width) < Math.abs(hit - rect.width))
    )
      hit = width
  }
  if (hit === null) return { ...rect, guides: [] }
  return {
    ...rect,
    width: hit,
    guides: [{ axis: 'v', at: rect.x + hit, from: rect.y, to: rect.y + rect.height }],
  }
}
