/** The rows of a long list that a scroll box shows. `offsets` holds the top of
 *  every row and, last, the height of the whole list; the slice reaches
 *  `overscan` rows past each edge so a fast scroll never shows a gap. */
export function rowWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewHeight: number,
  overscan: number,
): { start: number; end: number } {
  const count = offsets.length - 1
  if (count <= 0) return { start: 0, end: 0 }
  const first = rowAt(offsets, scrollTop)
  const last = rowAt(offsets, scrollTop + viewHeight)
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + 1 + overscan) }
}

/* the row whose span holds `y`: the last row whose top is at or above it */
function rowAt(offsets: readonly number[], y: number): number {
  let low = 0
  let high = offsets.length - 2
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((offsets[mid] ?? 0) <= y) low = mid
    else high = mid - 1
  }
  return low
}
