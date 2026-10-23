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

/** Where a note attached to a frame lands when nobody picked a spot: beside
 *  the frame's left edge, level with its top. */
export function attachedNotePlacement(
  frame: Pick<Frame, 'x' | 'y'>,
  width: number = NOTE_DEFAULT_SIZE.width,
): { x: number; y: number } {
  return { x: frame.x - width - NOTE_ATTACH_GAP, y: frame.y }
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
