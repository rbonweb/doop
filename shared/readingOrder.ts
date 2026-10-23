/** The part of a frame that reading order looks at. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function verticalOverlap(a: Box, b: Box): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
}

/** Two frames share a row when they overlap vertically by at least half of the shorter one's height. */
function sameRow(a: Box, b: Box): boolean {
  return verticalOverlap(a, b) >= Math.min(a.height, b.height) / 2
}

/**
 * Band frames into rows the way a person reads a page: rows run top to bottom, and the frames in a row left to right.
 * A frame joins the latest row when it shares a row with any frame already in it; otherwise it starts the next one.
 */
export function readingRows<T extends Box>(frames: readonly T[]): T[][] {
  const byTop = [...frames].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: T[][] = []
  for (const frame of byTop) {
    const row = rows[rows.length - 1]
    if (row?.some((member) => sameRow(member, frame))) row.push(frame)
    else rows.push([frame])
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x || a.y - b.y))
}

/** Frames flattened in reading order: row by row, left to right. */
export function readingOrder<T extends Box>(frames: readonly T[]): T[] {
  return readingRows(frames).flat()
}
