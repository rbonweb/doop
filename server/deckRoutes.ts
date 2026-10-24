import { Router } from 'express'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { deckOf, MAX_DECK_SLIDES } from '../shared/slides.ts'
import { env } from './env.ts'
import { requireCanvas } from './sharing.ts'

/** /api/canvases/:id/pages/:pageId/deck.pdf — a page's slides as one PDF. Lives apart from the main server file so it can be tested on its own. */
export const deckRouter = Router()

/* A deck render boots a page with every slide in it: far heavier than a frame image. The budget is per account. */
const renderHits = new Map<string, number[]>()
const DECKS_PER_MIN = env.DECK_PDFS_PER_MIN

/** Take one slot of the caller's budget; false when it is spent. */
function consumeDeckBudget(key: string, now = Date.now()): boolean {
  const hits = (renderHits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= DECKS_PER_MIN) {
    renderHits.set(key, hits)
    return false
  }
  hits.push(now)
  renderHits.set(key, hits)
  return true
}

/** For tests: forget everyone's budget. */
export function resetDeckBudget() {
  renderHits.clear()
}

/** A file name taken from the page name: plain characters only, never empty. */
export function deckFileName(pageName: string): string {
  const safe = pageName
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .slice(0, 80)
  return `${safe || 'deck'}.pdf`
}

deckRouter.get('/:id/pages/:pageId/deck.pdf', async (req, res) => {
  /* the same view gate as every read route: the role resolver, including a password link's unlock cookie */
  const canvas = requireCanvas(req, res, String(req.params.id), 'view')
  if (!canvas) return
  const pageId = String(req.params.pageId)
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  if (!page) return res.status(404).json({ error: 'page not found' })
  const slides = deckOf(pageFrames(canvas, page.id))
  if (!slides.length) return res.status(404).json({ error: 'this page has no slides' })
  if (slides.length > MAX_DECK_SLIDES) {
    return res.status(413).json({ error: `a deck PDF takes up to ${MAX_DECK_SLIDES} slides` })
  }
  if (!consumeDeckBudget(req.user?.id ?? req.ip ?? 'unknown')) {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'deck export rate limit — try again in a minute' })
  }
  try {
    const { renderDeckPdf } = await import('./deckPdf.ts')
    const pdf = await renderDeckPdf(slides)
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `attachment; filename="${deckFileName(page.name)}"`,
      'Cache-Control': 'private, no-store',
      'X-Deck-Slides': String(slides.length),
    })
    res.send(pdf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
})
