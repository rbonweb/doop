import { canvasPages, framePageId } from './pages.ts'
import { readingOrder } from './readingOrder.ts'
import type { Canvas, Frame } from './types.ts'

/*
 * Prototype links. Any element in a frame can carry data-goto="<frame id or frame name>". The runtime reports a click on
 * it while presenting, and an ⌥-click on the canvas; the canvas overlay draws an arrow for each link.
 */

const GOTO_ATTRIBUTE = /\bdata-goto\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi

/** The distinct data-goto values in a frame's HTML, in document order. A cheap scan: it does not parse, so a value inside a comment or script still counts. */
export function gotoTargets(html: string): string[] {
  if (!html.includes('data-goto')) return []
  const found = new Set<string>()
  for (const match of html.matchAll(GOTO_ATTRIBUTE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (value) found.add(value)
  }
  return [...found]
}

/** Every frame of the canvas in reading order: page by page in the order the pages are listed, each page by rows. */
export function canvasReadingOrder(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>): Frame[] {
  return canvasPages(canvas).flatMap((page) =>
    readingOrder(canvas.frames.filter((f) => framePageId(canvas, f) === page.id)),
  )
}

/** The frame a link points at: a frame id first, then a frame name (case-insensitive, exact) where the first in reading order wins. */
export function resolveGoto(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>, target: string): Frame | undefined {
  const wanted = target.trim()
  if (!wanted) return undefined
  const byId = canvas.frames.find((f) => f.id === wanted)
  if (byId) return byId
  const name = wanted.toLowerCase()
  return canvasReadingOrder(canvas).find((f) => f.name.trim().toLowerCase() === name)
}

export interface GotoEdge {
  from: Frame
  to: Frame
}

/**
 * The links that leave `sources`, resolved to frames on the same page: one edge per source and target pair, in the
 * sources' order. A link to a missing frame, to the frame itself, or to another page draws nothing.
 */
export function gotoEdges(
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>,
  sources: readonly Frame[],
  targetsOf: (frame: Frame) => string[] = (frame) => gotoTargets(frame.html),
): GotoEdge[] {
  const edges: GotoEdge[] = []
  for (const from of sources) {
    const seen = new Set<string>()
    for (const target of targetsOf(from)) {
      const to = resolveGoto(canvas, target)
      if (!to || to.id === from.id || seen.has(to.id)) continue
      if (framePageId(canvas, to) !== framePageId(canvas, from)) continue
      seen.add(to.id)
      edges.push({ from, to })
    }
  }
  return edges
}

export interface Arrow {
  /** SVG path in world coordinates, ending at `end` */
  path: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

type Placed = Pick<Frame, 'x' | 'y' | 'width' | 'height'>

/**
 * The curve for one link: out of the side of `from` that faces `to`, into the facing side of `to`. `slot` of `slots`
 * spreads several links that leave one frame along its edge, so they never lie on top of each other.
 */
export function arrowBetween(from: Placed, to: Placed, slot = 0, slots = 1): Arrow {
  const spread = (slot - (slots - 1) / 2) * 16
  const toRight = to.x >= from.x + from.width - 24
  const toLeft = to.x + to.width <= from.x + 24
  let start: { x: number; y: number }
  let end: { x: number; y: number }
  let path: (s: typeof start, e: typeof end) => string
  if (toRight || toLeft) {
    start = { x: toRight ? from.x + from.width : from.x, y: from.y + from.height / 2 + spread }
    end = { x: toRight ? to.x : to.x + to.width, y: to.y + Math.min(120, to.height / 2) }
    const bend = Math.max(60, Math.abs(end.x - start.x) / 3) * (toRight ? 1 : -1)
    path = (s, e) => `M ${s.x} ${s.y} C ${s.x + bend} ${s.y}, ${e.x - bend} ${e.y}, ${e.x} ${e.y}`
  } else {
    const below = to.y >= from.y
    start = { x: from.x + from.width / 2 + spread, y: below ? from.y + from.height : from.y }
    end = { x: to.x + to.width / 2, y: below ? to.y : to.y + to.height }
    const bend = Math.max(60, Math.abs(end.y - start.y) / 3) * (below ? 1 : -1)
    path = (s, e) => `M ${s.x} ${s.y} C ${s.x} ${s.y + bend}, ${e.x} ${e.y - bend}, ${e.x} ${e.y}`
  }
  return { path: path(start, end), start, end }
}
