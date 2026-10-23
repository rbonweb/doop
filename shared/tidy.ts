import { readingRows, type Box } from './readingOrder.ts'

export interface TidyFrame extends Box {
  id: string
}

export interface TidyPosition {
  id: string
  x: number
  y: number
}

const MIN_GUTTER_X = 140
const MIN_GUTTER_Y = 96

/**
 * Lay frames out in reading-order rows, starting from the top-left of their current bounding box.
 * The horizontal gutter is max(140, 12% of the widest frame) and the vertical gutter max(96, 16% of the tallest).
 * Rows keep the order the frames already read in; each row's frames share a top edge.
 * Returns the new position of every frame; sizes are never touched.
 */
export function tidyLayout(frames: readonly TidyFrame[]): TidyPosition[] {
  if (!frames.length) return []
  const originX = Math.min(...frames.map((f) => f.x))
  const originY = Math.min(...frames.map((f) => f.y))
  const gutterX = Math.max(MIN_GUTTER_X, 0.12 * Math.max(...frames.map((f) => f.width)))
  const gutterY = Math.max(MIN_GUTTER_Y, 0.16 * Math.max(...frames.map((f) => f.height)))
  const positions: TidyPosition[] = []
  let y = originY
  for (const row of readingRows(frames)) {
    let x = originX
    for (const frame of row) {
      positions.push({ id: frame.id, x: Math.round(x), y: Math.round(y) })
      x += frame.width + gutterX
    }
    y += Math.max(...row.map((f) => f.height)) + gutterY
  }
  return positions
}
