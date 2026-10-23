import type { Frame } from './types.ts'

/* Chrome rasterizes a screenshot into one surface, and a side past this many device px wraps instead of failing */
export const MAX_IMAGE_SIDE_PX = 16384

export type ImageScale = 1 | 2 | 4

/** `?scale=` as asked: 2 and 4 are honored, anything else is 1. */
export function parseImageScale(raw: unknown): ImageScale {
  return raw === '2' ? 2 : raw === '4' ? 4 : 1
}

/**
 * The scale actually rendered: the requested one, lowered until neither side of the output passes the cap.
 * Never below 1, so a frame that is already past the cap renders at its own size as it always has.
 */
export function clampImageScale(scale: number, frame: Pick<Frame, 'width' | 'height'>): number {
  if (scale <= 1) return scale
  const room = MAX_IMAGE_SIDE_PX / Math.max(1, frame.width, frame.height)
  /* floor at 3 decimals so rounding the output size can never tip a side over the cap */
  return Math.max(1, scale <= room ? scale : Math.floor(room * 1000) / 1000)
}
