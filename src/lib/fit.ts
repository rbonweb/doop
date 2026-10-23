/**
 * Camera math for fitting frames into the stage. Pure — the store's fitAll and
 * fitSelection feed it the frames and the stage size.
 */
export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 3

/* the title bar sits this far above a frame and belongs in the fitted box */
const TITLE_BAR = 30
const PAD = 80
const MAX_FIT_ZOOM = 1.25

interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

/** The camera that frames all of `frames` (and their title bars) with padding, centered; an empty list rests at the origin. */
export function fitViewport(frames: readonly Box[], stage: { width: number; height: number }): Camera {
  if (!frames.length) return { x: PAD, y: PAD, zoom: 1 }
  const minX = Math.min(...frames.map((f) => f.x))
  const minY = Math.min(...frames.map((f) => f.y - TITLE_BAR))
  const maxX = Math.max(...frames.map((f) => f.x + f.width))
  const maxY = Math.max(...frames.map((f) => f.y + f.height))
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min((stage.width - PAD * 2) / (maxX - minX), (stage.height - PAD * 2) / (maxY - minY), MAX_FIT_ZOOM),
    ),
  )
  return {
    x: (stage.width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (stage.height - (maxY - minY) * zoom) / 2 - minY * zoom,
    zoom,
  }
}

/** Zoom to `next` (clamped) keeping the stage's center fixed on screen. */
export function zoomAroundCenter(camera: Camera, next: number, stage: { width: number; height: number }): Camera {
  const cx = stage.width / 2
  const cy = stage.height / 2
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
  const scale = zoom / camera.zoom
  return { x: cx - (cx - camera.x) * scale, y: cy - (cy - camera.y) * scale, zoom }
}
