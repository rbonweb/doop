import type { CSSProperties } from 'react'

/** A hairline on every design-px boundary, `width` px thick in the layer's
 *  own units; the tile size is the caller's. */
export function pixelGridLines(width: number): CSSProperties {
  const line = `rgb(128 128 128 / 0.16) ${width}px, transparent ${width}px`
  return { backgroundImage: `linear-gradient(to right, ${line}), linear-gradient(to bottom, ${line})` }
}
