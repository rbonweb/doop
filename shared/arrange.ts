/* The Arrange menu as geometry: align, distribute, tidy up and pack a set
   of boxes. Pure — every function takes the boxes in their current order and
   returns where each one's top-left goes, in the same order, so the caller
   decides whether they are frames on the canvas or layers in a frame. */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Spot {
  x: number
  y: number
}

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type Axis = 'x' | 'y'
export type DistributeEdge = 'start' | 'center' | 'end'

/** The box around every box. */
export function boundsOf(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Each box lined up on one edge (or centre line) of the boxes' bounds. */
export function alignBoxes(boxes: readonly Box[], edge: AlignEdge, within: Box = boundsOf(boxes)): Spot[] {
  return boxes.map((b) => {
    switch (edge) {
      case 'left':
        return { x: within.x, y: b.y }
      case 'hcenter':
        return { x: within.x + (within.width - b.width) / 2, y: b.y }
      case 'right':
        return { x: within.x + within.width - b.width, y: b.y }
      case 'top':
        return { x: b.x, y: within.y }
      case 'vcenter':
        return { x: b.x, y: within.y + (within.height - b.height) / 2 }
      case 'bottom':
        return { x: b.x, y: within.y + within.height - b.height }
    }
  })
}

const start = (b: Box, axis: Axis) => (axis === 'x' ? b.x : b.y)
const size = (b: Box, axis: Axis) => (axis === 'x' ? b.width : b.height)
const moved = (b: Box, axis: Axis, at: number): Spot => (axis === 'x' ? { x: at, y: b.y } : { x: b.x, y: at })

/** The indexes of the boxes from first to last along the axis. */
function orderAlong(boxes: readonly Box[], axis: Axis): number[] {
  return boxes.map((_, i) => i).sort((a, b) => start(boxes[a]!, axis) - start(boxes[b]!, axis) || a - b)
}

/** Equal gaps between neighbours along the axis; the first and last stay put. */
export function distributeSpacing(boxes: readonly Box[], axis: Axis): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 3) return out
  const order = orderAlong(boxes, axis)
  const bounds = boundsOf(boxes)
  const used = boxes.reduce((sum, b) => sum + size(b, axis), 0)
  const gap = (size(bounds, axis) - used) / (boxes.length - 1)
  let at = start(bounds, axis)
  for (const i of order) {
    const b = boxes[i]!
    out[i] = moved(b, axis, at)
    at += size(b, axis) + gap
  }
  return out
}

/** The boxes' left edges (or centres, or right edges) evenly spaced along
 *  the axis; the first and last stay put. */
export function distributeEdges(boxes: readonly Box[], axis: Axis, edge: DistributeEdge): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 3) return out
  const order = orderAlong(boxes, axis)
  const anchor = (b: Box) =>
    start(b, axis) + (edge === 'start' ? 0 : edge === 'center' ? size(b, axis) / 2 : size(b, axis))
  const first = anchor(boxes[order[0]!]!)
  const last = anchor(boxes[order[order.length - 1]!]!)
  const step = (last - first) / (boxes.length - 1)
  order.forEach((i, n) => {
    const b = boxes[i]!
    out[i] = moved(b, axis, start(b, axis) + first + step * n - anchor(b))
  })
  return out
}

/** The boxes side by side with no gap, in their order along the axis,
 *  starting where the first one is. */
export function packBoxes(boxes: readonly Box[], axis: Axis): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  const order = orderAlong(boxes, axis)
  if (!order.length) return out
  let at = start(boxes[order[0]!]!, axis)
  for (const i of order) {
    const b = boxes[i]!
    out[i] = moved(b, axis, at)
    at += size(b, axis)
  }
  return out
}

/** Rows as a person reads them: boxes whose vertical middles fall inside a
 *  row's band join it, rows top to bottom, each row left to right. */
function rowsOf(boxes: readonly Box[]): number[][] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.y - boxes[b]!.y || boxes[a]!.x - boxes[b]!.x)
  const rows: { top: number; bottom: number; items: number[] }[] = []
  for (const i of order) {
    const b = boxes[i]!
    const middle = b.y + b.height / 2
    const row = rows.find((r) => middle >= r.top && middle <= r.bottom)
    if (row) {
      row.items.push(i)
      row.bottom = Math.max(row.bottom, b.y + b.height)
    } else rows.push({ top: b.y, bottom: b.y + b.height, items: [i] })
  }
  return rows.map((r) => r.items.sort((a, b) => boxes[a]!.x - boxes[b]!.x))
}

/** The gap a tidy-up keeps: the average space between neighbours as they
 *  are (rounded), or `fallback` when they overlap. */
function averageGap(boxes: readonly Box[], rows: number[][], fallback: number): number {
  const gaps: number[] = []
  for (const row of rows) {
    for (let n = 1; n < row.length; n++) {
      const a = boxes[row[n - 1]!]!
      const b = boxes[row[n]!]!
      gaps.push(b.x - (a.x + a.width))
    }
  }
  for (let n = 1; n < rows.length; n++) {
    const above = Math.max(...rows[n - 1]!.map((i) => boxes[i]!.y + boxes[i]!.height))
    const below = Math.min(...rows[n]!.map((i) => boxes[i]!.y))
    gaps.push(below - above)
  }
  const mean = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : fallback
  return mean > 0 ? Math.round(mean) : fallback
}

/** Tidy up: the boxes on a grid of as many columns as their widest
 *  row has, every column as wide as its widest box and every row as tall as
 *  its tallest, an even gap between, from the boxes' top-left corner. */
export function tidyUp(boxes: readonly Box[], fallbackGap = 40): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 2) return out
  const rows = rowsOf(boxes)
  const gap = averageGap(boxes, rows, fallbackGap)
  const columns = Math.max(...rows.map((r) => r.length))
  const order = rows.flat()
  const cell = (n: number) => boxes[order[n]!]!
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(0, ...order.map((_, n) => (n % columns === c ? cell(n).width : 0))),
  )
  const rowCount = Math.ceil(order.length / columns)
  const rowHeight = Array.from({ length: rowCount }, (_, r) =>
    Math.max(0, ...order.map((_, n) => (Math.floor(n / columns) === r ? cell(n).height : 0))),
  )
  const origin = boundsOf(boxes)
  order.forEach((i, n) => {
    const c = n % columns
    const r = Math.floor(n / columns)
    out[i] = {
      x: origin.x + colWidth.slice(0, c).reduce((s, w) => s + w + gap, 0),
      y: origin.y + rowHeight.slice(0, r).reduce((s, h) => s + h + gap, 0),
    }
  })
  return out
}

/** How far apart two boxes are: 0 when they touch or their projections overlap on both axes without area, the larger of the horizontal and vertical separations otherwise, and a negative number (minus the smaller side of their intersection) when they overlap with area. */
export function gapBetween(a: Box, b: Box): number {
  const horizontal = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
  const vertical = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
  if (horizontal < 0 && vertical < 0) return -Math.min(-horizontal, -vertical)
  return Math.max(horizontal, vertical, 0)
}

/** Whether two boxes overlap with area, or sit closer than `gap` px apart (touching edges do not overlap when gap is 0). */
export function tooClose(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
  )
}

/** The first spot to the right of `source`, on its row, where a box of the source's size is at least `gap` px from every occupied box: start at source.x + source.width + gap, source.y; while the candidate is tooClose to an occupied box, jump x to that box's right edge + gap; at most occupied.length + 1 jumps. */
export function freeSpotBeside(source: Box, occupied: readonly Box[], gap: number): Spot {
  let spot: Spot = { x: source.x + source.width + gap, y: source.y }
  for (let jumps = 0; jumps <= occupied.length; jumps++) {
    const candidate: Box = { ...spot, width: source.width, height: source.height }
    const blocker = occupied.find((box) => tooClose(candidate, box, gap))
    if (!blocker) return spot
    spot = { x: blocker.x + blocker.width + gap, y: source.y }
  }
  return spot
}

export interface RowRule {
  minWidth?: number
  maxWidth?: number
  /** case-insensitive substring of the box's name */
  name?: string
  /** 'x' (default): by current x, then y; 'name': localeCompare with numeric: true; 'given': input order */
  order?: 'x' | 'name' | 'given'
}

export interface NamedBox extends Box {
  id: string
  name: string
}

/** Desktops (900 px and wider) in the first row, everything narrower in the next. */
export const DEFAULT_ROWS: readonly RowRule[] = [{ minWidth: 900 }, { maxWidth: 899 }]

function matchesRule(box: NamedBox, rule: RowRule): boolean {
  if (rule.minWidth !== undefined && box.width < rule.minWidth) return false
  if (rule.maxWidth !== undefined && box.width > rule.maxWidth) return false
  if (rule.name !== undefined && !box.name.toLowerCase().includes(rule.name.toLowerCase())) return false
  return true
}

/** A row's boxes in its rule's order: current x then y, by name (numeric), or as given. */
function rowOrder(boxes: readonly NamedBox[], order: RowRule['order'] = 'x'): NamedBox[] {
  const out = [...boxes]
  if (order === 'given') return out
  if (order === 'name') return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out.sort((a, b) => a.x - b.x || a.y - b.y)
}

/** Rows of boxes: each box joins the first rule it matches (minWidth <= width <= maxWidth, name substring); rows stack down from `origin` in rule order, each row's boxes left to right `gap` px apart, the next row starting `gap` px below the tallest box of the one above; an empty row takes no space. Boxes no rule matches are not placed and come back in `unmatched` (ids, input order). */
export function arrangeRows(
  boxes: readonly NamedBox[],
  rules: readonly RowRule[],
  opts: { gap: number; origin: Spot },
): { placed: Map<string, Spot>; unmatched: string[] } {
  const placed = new Map<string, Spot>()
  const unmatched: string[] = []
  let top = opts.origin.y
  for (const rule of rules) {
    const row = rowOrder(
      boxes.filter((box) => !placed.has(box.id) && matchesRule(box, rule)),
      rule.order,
    )
    if (!row.length) continue
    let left = opts.origin.x
    let tallest = 0
    for (const box of row) {
      placed.set(box.id, { x: left, y: top })
      left += box.width + opts.gap
      tallest = Math.max(tallest, box.height)
    }
    top += tallest + opts.gap
  }
  for (const box of boxes) if (!placed.has(box.id)) unmatched.push(box.id)
  return { placed, unmatched }
}

export interface LayoutItem extends Box {
  id: string
  kind: 'frame' | 'note'
  /** a note's frame: the pair is never reported */
  attachedTo?: string
}

export interface LayoutIssue {
  kind: 'overlap' | 'tight'
  a: string
  b: string
  /** gapBetween(a, b): negative for an overlap */
  gap: number
}

/** Every pair of items that overlaps, or faces each other (their projections overlap on one axis) closer than `minGap`; diagonal neighbours are ignored, and so is a note with the frame it is attached to. Pairs in input order (a before b). */
export function layoutIssues(items: readonly LayoutItem[], minGap: number): LayoutIssue[] {
  const out: LayoutIssue[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!
      const b = items[j]!
      if (a.kind === 'note' && a.attachedTo === b.id) continue
      if (b.kind === 'note' && b.attachedTo === a.id) continue
      const gap = gapBetween(a, b)
      if (gap < 0) {
        out.push({ kind: 'overlap', a: a.id, b: b.id, gap })
        continue
      }
      if (gap >= minGap) continue
      const overlapX = a.x < b.x + b.width && b.x < a.x + a.width
      const overlapY = a.y < b.y + b.height && b.y < a.y + a.height
      if (overlapX !== overlapY) out.push({ kind: 'tight', a: a.id, b: b.id, gap })
    }
  }
  return out
}
