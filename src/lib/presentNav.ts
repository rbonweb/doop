import { framePageId, pageFrames } from '../../shared/pages'
import { readingOrder } from '../../shared/readingOrder'
import { deckOf } from '../../shared/slides'
import type { Canvas, Frame } from '../../shared/types'

/* How present mode moves. Arrow keys walk the reading order of the page the current frame is on (a deck, when that frame
   is a slide); a prototype link jumps and remembers where it left, and Backspace walks those jumps back. All pure, so
   the component only wires keys to it. */

/** Deep enough for any real click-through; a runaway link loop must not grow it without end. */
const HISTORY_LIMIT = 200

export interface PresentNav {
  currentId: string
  /** the frames left behind by prototype links, most recent last */
  history: readonly string[]
}

export const startNav = (currentId: string): PresentNav => ({ currentId, history: [] })

/**
 * The frames a viewer can walk from this one: the slides of its page in reading order when it is a slide, otherwise
 * every frame of its page in reading order.
 */
export function presentOrder(canvas: Canvas, current: Frame): Frame[] {
  const onPage = pageFrames(canvas, framePageId(canvas, current))
  return current.slide ? deckOf(onPage) : readingOrder(onPage)
}

/** One step through the order (+1 next, -1 previous), stopping at either end. A frame outside the order steps to its start. */
export function stepNav(nav: PresentNav, order: readonly string[], delta: 1 | -1): PresentNav {
  if (!order.length) return nav
  const at = order.indexOf(nav.currentId)
  const target = at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta))
  const id = order[target]
  return !id || id === nav.currentId ? nav : { ...nav, currentId: id }
}

/** Follow a prototype link: the frame we leave goes on the history stack. A link to the frame we are on does nothing. */
export function jumpNav(nav: PresentNav, targetId: string): PresentNav {
  if (targetId === nav.currentId) return nav
  return { currentId: targetId, history: [...nav.history, nav.currentId].slice(-HISTORY_LIMIT) }
}

/** Backspace: return to where the last link left. An empty stack does nothing. */
export function backNav(nav: PresentNav): PresentNav {
  const previous = nav.history[nav.history.length - 1]
  return previous === undefined ? nav : { currentId: previous, history: nav.history.slice(0, -1) }
}

/** Drop history entries for frames that are gone (deleted while presenting), so Backspace never lands on nothing. */
export function pruneNav(nav: PresentNav, exists: (id: string) => boolean): PresentNav {
  const history = nav.history.filter(exists)
  return history.length === nav.history.length ? nav : { ...nav, history }
}

/** "m:ss", or "h:mm:ss" past the hour; a clock that has not started reads 0:00. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
