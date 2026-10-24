import { canvasPages, framePageId } from './pages.ts'
import { readingOrder } from './readingOrder.ts'
import type { Canvas, Frame } from './types.ts'

/** A slide created without a size gets the 16:9 stage most decks use. */
export const SLIDE_WIDTH = 1280
export const SLIDE_HEIGHT = 720

/** Presenter notes are markdown for a human to glance at mid-talk, not a document. */
export const MAX_SPEAKER_NOTES_CHARS = 10_000

/** Most slides one deck PDF takes: every slide is a live document in the page while it renders. */
export const MAX_DECK_SLIDES = 100

/** The size a new frame gets when the caller names none. */
export function defaultFrameSize(slide: boolean | undefined): { width: number; height: number } {
  return slide ? { width: SLIDE_WIDTH, height: SLIDE_HEIGHT } : { width: 640, height: 480 }
}

type Placed = Pick<Frame, 'x' | 'y' | 'width' | 'height'>

/** The slides of one page in the order a deck plays: reading order, slide frames only. A hidden slide is out of the
 *  deck everywhere (present mode, the PDF, the numbering), so the export never disagrees with the show. */
export function deckOf<T extends Placed & { slide?: boolean; hidden?: boolean }>(pageFrames: readonly T[]): T[] {
  return readingOrder(pageFrames.filter((f) => f.slide && !f.hidden))
}

/** Every slide's 1-based position in its page's deck, by frame id. */
export function deckNumbers(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>): Map<string, number> {
  const numbers = new Map<string, number>()
  for (const page of canvasPages(canvas)) {
    const onPage = canvas.frames.filter((f) => framePageId(canvas, f) === page.id)
    deckOf(onPage).forEach((f, i) => numbers.set(f.id, i + 1))
  }
  return numbers
}
