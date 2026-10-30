import type { Canvas, CanvasNote, Frame } from './types.ts'
import { canvasPages, framePageId } from './pages.ts'

/** The fixed palette a sticky note picks its colour from. The client turns a
 *  name into a theme-aware tint; nothing stores a raw hex. */
export const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

export const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === 'string' && (NOTE_COLORS as readonly string[]).includes(value)
}

/** A colour the palette does not know (a legacy value) reads as the default. */
export function noteColorOf(note: Pick<CanvasNote, 'color'>): NoteColor {
  return isNoteColor(note.color) ? note.color : DEFAULT_NOTE_COLOR
}

export const MAX_NOTE_CHARS = 20_000
export const NOTE_WIDTH = { min: 160, max: 1200 } as const
export const NOTE_HEIGHT = { min: 80, max: 2000 } as const
export const NOTE_DEFAULT_SIZE = { width: 240, height: 180 } as const
/** Space between an attached note and the frame it sits beside. */
export const NOTE_ATTACH_GAP = 24

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampNoteWidth(width: number): number {
  return Math.round(clamp(width, NOTE_WIDTH.min, NOTE_WIDTH.max))
}

export function clampNoteHeight(height: number): number {
  return Math.round(clamp(height, NOTE_HEIGHT.min, NOTE_HEIGHT.max))
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** True when two rectangles share area; touching edges do not count. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Where a note attached to a frame lands when nobody picked a spot. It sits beside the frame like a margin note, and never overlaps an obstacle (every other frame and note on the page), keeping NOTE_ATTACH_GAP clear of each. */
export function attachedNotePlacement(
  frame: Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height'>,
  size: { width: number; height: number },
  obstacles: readonly Rect[] = [],
): { x: number; y: number } {
  const { width, height } = size
  const gap = NOTE_ATTACH_GAP
  /* the obstacles a note at (x, y) would crowd, judged with the gap around the note */
  const collisions = (x: number, y: number): Rect[] => {
    const padded = { x: x - gap, y: y - gap, width: width + gap * 2, height: height + gap * 2 }
    return obstacles.filter((o) => rectsOverlap(padded, o))
  }

  /* 1 and 2: a column beside the frame, sliding down past whatever is in the way while the note still starts within the frame's height */
  const maxY = Math.max(frame.y, frame.y + frame.height - height)
  const column = (x: number): { x: number; y: number } | undefined => {
    let y = frame.y
    while (y <= maxY) {
      const hits = collisions(x, y)
      if (hits.length === 0) return { x, y }
      y = Math.max(...hits.map((o) => o.y + o.height)) + gap
    }
    return undefined
  }

  /* 3: above the frame, sliding right past whatever is in the way while the note still starts within the frame's width */
  const above = (): { x: number; y: number } | undefined => {
    const y = frame.y - height - gap
    const maxX = Math.max(frame.x, frame.x + frame.width - width)
    let x = frame.x
    while (x <= maxX) {
      const hits = collisions(x, y)
      if (hits.length === 0) return { x, y }
      x = Math.max(...hits.map((o) => o.x + o.width)) + gap
    }
    return undefined
  }

  /* 4: the gutter lane, left of everything in the frame's vertical band, sliding further left past anything in the way; always ends in a free spot */
  const gutter = (): { x: number; y: number } => {
    const band = obstacles.filter((o) => o.y < frame.y + frame.height && frame.y < o.y + o.height)
    let x = Math.min(frame.x, ...band.map((o) => o.x)) - width - gap
    for (;;) {
      const hits = collisions(x, frame.y)
      if (hits.length === 0) return { x, y: frame.y }
      x = Math.min(...hits.map((o) => o.x)) - width - gap
    }
  }

  return column(frame.x - width - gap) ?? column(frame.x + frame.width + gap) ?? above() ?? gutter()
}

/** The page a note shows on: its frame's page when attached, otherwise its
 *  own, otherwise the first page (legacy notes carry none). */
export function notePageId(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>, note: CanvasNote): string {
  if (note.frameId) {
    const frame = canvas.frames.find((f) => f.id === note.frameId)
    if (frame) return framePageId(canvas, frame)
  }
  return note.pageId ?? canvasPages(canvas)[0]!.id
}

export interface NoteMove {
  id: string
  x: number
  y: number
}

/** Where every note attached to `frameId` goes when that frame moves by
 *  (dx, dy). Pure, so the server (which persists the move) and the client
 *  (which follows a drag live) agree on the arithmetic. */
export function shiftAttachedNotes(
  notes: readonly Pick<CanvasNote, 'id' | 'frameId' | 'x' | 'y'>[],
  frameId: string,
  dx: number,
  dy: number,
): NoteMove[] {
  if (dx === 0 && dy === 0) return []
  return notes.filter((n) => n.frameId === frameId).map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy }))
}

/** One line of a note for lists and agent output: markdown markers dropped,
 *  whitespace collapsed, cut at `max` characters. */
export function noteExcerpt(markdown: string, max = 160): string {
  const flat = markdown
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat
}
