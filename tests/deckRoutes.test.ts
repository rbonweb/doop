import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Canvas, Frame } from '../shared/types.ts'

/* the renderer boots Chrome; the route is what is under test */
const renderDeckPdf = vi.fn<(slides: readonly Frame[]) => Promise<Buffer>>()
vi.mock('../server/deckPdf.ts', () => ({ renderDeckPdf: (slides: readonly Frame[]) => renderDeckPdf(slides) }))

const { store } = await import('../server/store.ts')
const { deckRouter, deckFileName, resetDeckBudget } = await import('../server/deckRoutes.ts')
const { deckDocument } = await vi.importActual<typeof import('../server/deckPdf.ts')>('../server/deckPdf.ts')

function frame(id: string, x: number, y: number, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'deck',
    name: id,
    x,
    y,
    width: 1280,
    height: 720,
    html: `<h1>${id}</h1>`,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'alice',
    ...extra,
  }
}

const PAGES = [
  { id: 'p-pitch', name: 'Q3 pitch: the “big” one' },
  { id: 'p-empty', name: 'No slides here' },
]

const CANVAS: Canvas = {
  id: 'deck',
  name: 'Deck',
  ownerId: 'owner',
  createdAt: 0,
  updatedAt: 0,
  pages: PAGES,
  frames: [
    frame('s3', 2800, 0, { slide: true, pageId: 'p-pitch' }),
    frame('notes', 1400, 0, { pageId: 'p-pitch' }),
    frame('s1', 0, 0, { slide: true, pageId: 'p-pitch' }),
    frame('s2', 1400, 0, { slide: true, pageId: 'p-pitch' }),
    frame('plain', 0, 0, { pageId: 'p-empty' }),
  ],
}

let userId: string | undefined = 'owner'
let server: Server
let origin: string

beforeAll(async () => {
  const app = express()
  app.use((req, _res, next) => {
    req.user = userId ? ({ id: userId } as typeof req.user) : undefined
    next()
  })
  app.use('/api/canvases', deckRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  userId = 'owner'
  resetDeckBudget()
  renderDeckPdf.mockReset()
  renderDeckPdf.mockResolvedValue(Buffer.from('%PDF-1.4 fake'))
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
})

const url = (canvasId: string, pageId: string) =>
  `${origin}/api/canvases/${canvasId}/pages/${encodeURIComponent(pageId)}/deck.pdf`

describe('GET /api/canvases/:id/pages/:pageId/deck.pdf', () => {
  it('sends the page’s slides, in reading order and nothing else, as an attachment named for the page', async () => {
    const res = await fetch(url('deck', 'p-pitch'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Q3 pitch the big one.pdf"')
    expect(res.headers.get('x-deck-slides')).toBe('3')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4 fake')
    expect(renderDeckPdf.mock.calls[0]![0].map((f) => f.id)).toEqual(['s1', 's2', 's3'])
  })

  it('refuses someone who cannot open the canvas, without rendering', async () => {
    userId = 'stranger'
    const res = await fetch(url('deck', 'p-pitch'))
    expect(res.status).toBe(403)
    expect(renderDeckPdf).not.toHaveBeenCalled()
  })

  it('refuses a request with no signed-in user', async () => {
    userId = undefined
    expect((await fetch(url('deck', 'p-pitch'))).status).toBe(403)
    expect(renderDeckPdf).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown canvas, an unknown page, and a page without slides', async () => {
    expect((await fetch(url('nope', 'p-pitch'))).status).toBe(404)
    expect((await fetch(url('deck', 'ghost'))).status).toBe(404)
    const noSlides = await fetch(url('deck', 'p-empty'))
    expect(noSlides.status).toBe(404)
    expect(await noSlides.json()).toEqual({ error: 'this page has no slides' })
    expect(renderDeckPdf).not.toHaveBeenCalled()
  })

  it('limits how many decks one account renders a minute', async () => {
    for (let i = 0; i < 4; i++) expect((await fetch(url('deck', 'p-pitch'))).status).toBe(200)
    const limited = await fetch(url('deck', 'p-pitch'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(renderDeckPdf).toHaveBeenCalledTimes(4)
    /* the budget is per account */
    userId = 'owner'
    resetDeckBudget()
    expect((await fetch(url('deck', 'p-pitch'))).status).toBe(200)
  })

  it('does not spend the budget on a refused request', async () => {
    userId = 'stranger'
    for (let i = 0; i < 6; i++) await fetch(url('deck', 'p-pitch'))
    userId = 'owner'
    expect((await fetch(url('deck', 'p-pitch'))).status).toBe(200)
  })

  it('reports a failed render as a 500 with its message', async () => {
    renderDeckPdf.mockRejectedValue(new Error('No Chrome/Chromium found.'))
    const res = await fetch(url('deck', 'p-pitch'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'No Chrome/Chromium found.' })
  })
})

describe('deckFileName', () => {
  it('keeps plain characters and falls back to "deck"', () => {
    expect(deckFileName('Roadmap 2026')).toBe('Roadmap 2026.pdf')
    expect(deckFileName('../../etc/passwd')).toBe('etcpasswd.pdf')
    expect(deckFileName('«»')).toBe('deck.pdf')
    expect(deckFileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.pdf`)
  })
})

describe('deckDocument', () => {
  it('lays out one section per slide at its own size, with a page size per distinct size', () => {
    const doc = deckDocument([
      frame('a', 0, 0),
      frame('b', 0, 0, { width: 1024, height: 768, html: '<b>"quoted" & more</b>' }),
      frame('c', 0, 0),
    ])
    expect(doc.match(/<section class="slide /g)).toHaveLength(3)
    expect(doc).toContain('@page s0 { size: 1280px 720px; margin: 0 }')
    expect(doc).toContain('@page s1 { size: 1024px 768px; margin: 0 }')
    expect(doc).toContain('class="slide s1" style="width:1024px;height:768px"')
    /* the slide's own markup survives inside an attribute */
    expect(doc).toContain('srcdoc="<b>&quot;quoted&quot; &amp; more</b>"')
    /* a frame with no html still prints a blank page */
    expect(deckDocument([frame('e', 0, 0, { html: '' })])).toContain('srcdoc="<!doctype html>')
  })
})
