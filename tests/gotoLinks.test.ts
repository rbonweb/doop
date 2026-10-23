import { describe, expect, it } from 'vitest'
import { arrowBetween, canvasReadingOrder, gotoEdges, gotoTargets, resolveGoto } from '../shared/gotoLinks'
import { deckNumbers, deckOf, defaultFrameSize } from '../shared/slides'
import type { Canvas, Frame } from '../shared/types'

function frame(id: string, name: string, x: number, y: number, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c',
    name,
    x,
    y,
    width: 100,
    height: 100,
    html: '',
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 't',
    ...extra,
  }
}

const canvas = (frames: Frame[], pages?: Canvas['pages']): Canvas => ({
  id: 'c',
  name: 'C',
  createdAt: 0,
  updatedAt: 0,
  frames,
  ...(pages ? { pages } : {}),
})

describe('gotoTargets', () => {
  it('reads quoted and bare values, once each, in document order', () => {
    const html = `<a data-goto="b">x</a><button data-goto='a'>y</button><div data-goto=c></div><i data-goto="b"></i>`
    expect(gotoTargets(html)).toEqual(['b', 'a', 'c'])
  })

  it('ignores empty values and pages without links', () => {
    expect(gotoTargets('<a data-goto="">x</a><a data-goto="  ">y</a>')).toEqual([])
    expect(gotoTargets('<a href="#">x</a>')).toEqual([])
  })

  it('does not take a data-goto-like attribute for the real one', () => {
    expect(gotoTargets('<a data-goto-later="x" xdata-goto="y">z</a>')).toEqual([])
  })
})

describe('resolveGoto', () => {
  const frames = [
    frame('f-low', 'Checkout', 0, 400),
    frame('f-high', 'Checkout', 0, 0),
    frame('f-home', 'Home', 300, 0),
  ]
  const c = canvas(frames)

  it('finds a frame by id', () => {
    expect(resolveGoto(c, 'f-home')?.id).toBe('f-home')
  })

  it('falls back to the name, case-insensitively and exactly', () => {
    expect(resolveGoto(c, 'home')?.id).toBe('f-home')
    expect(resolveGoto(c, 'Hom')).toBeUndefined()
  })

  it('takes the first frame in reading order when names repeat', () => {
    expect(resolveGoto(c, 'checkout')?.id).toBe('f-high')
  })

  it('prefers an id over a name', () => {
    const tricky = canvas([frame('Home', 'Other', 0, 0), frame('f2', 'Home', 300, 0)])
    expect(resolveGoto(tricky, 'Home')?.id).toBe('Home')
  })

  it('returns nothing for a missing target', () => {
    expect(resolveGoto(c, 'nope')).toBeUndefined()
    expect(resolveGoto(c, '  ')).toBeUndefined()
  })

  it('reads the first page first when names repeat across pages', () => {
    const pages = [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ]
    const c2 = canvas(
      [frame('on-two', 'Pay', 0, 0, { pageId: 'p2' }), frame('on-one', 'Pay', 900, 900, { pageId: 'p1' })],
      pages,
    )
    expect(canvasReadingOrder(c2).map((f) => f.id)).toEqual(['on-one', 'on-two'])
    expect(resolveGoto(c2, 'pay')?.id).toBe('on-one')
  })
})

describe('gotoEdges', () => {
  it('links frames on one page, skipping self, missing and other-page targets once each', () => {
    const pages = [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ]
    const a = frame('a', 'A', 0, 0, {
      pageId: 'p1',
      html: '<a data-goto="b"></a><a data-goto="B"></a><a data-goto="a"></a>',
    })
    const b = frame('b', 'B', 300, 0, { pageId: 'p1', html: '<a data-goto="far"></a><a data-goto="ghost"></a>' })
    const far = frame('far', 'Far', 0, 0, { pageId: 'p2' })
    const c = canvas([a, b, far], pages)
    expect(gotoEdges(c, [a, b]).map((e) => `${e.from.id}>${e.to.id}`)).toEqual(['a>b'])
  })
})

describe('arrowBetween', () => {
  const from = { x: 0, y: 0, width: 100, height: 100 }

  it('leaves by the right edge toward a frame on the right and arrives at its left edge', () => {
    const a = arrowBetween(from, { x: 300, y: 0, width: 100, height: 100 })
    expect(a.start).toEqual({ x: 100, y: 50 })
    expect(a.end).toEqual({ x: 300, y: 50 })
    expect(a.path.startsWith('M 100 50')).toBe(true)
  })

  it('leaves by the left edge toward a frame on the left', () => {
    const a = arrowBetween({ ...from, x: 400 }, { x: 0, y: 0, width: 100, height: 100 })
    expect(a.start.x).toBe(400)
    expect(a.end.x).toBe(100)
  })

  it('goes bottom to top for a frame stacked below', () => {
    const a = arrowBetween(from, { x: 10, y: 300, width: 100, height: 100 })
    expect(a.start).toEqual({ x: 50, y: 100 })
    expect(a.end).toEqual({ x: 60, y: 300 })
  })

  it('spreads several links out of one frame along its edge', () => {
    const to = { x: 300, y: 0, width: 100, height: 100 }
    const ys = [0, 1, 2].map((slot) => arrowBetween(from, to, slot, 3).start.y)
    expect(new Set(ys).size).toBe(3)
    expect(ys[1]).toBe(50)
  })
})

describe('slides', () => {
  it('gives a slide the 16:9 stage and anything else the usual frame', () => {
    expect(defaultFrameSize(true)).toEqual({ width: 1280, height: 720 })
    expect(defaultFrameSize(undefined)).toEqual({ width: 640, height: 480 })
    expect(defaultFrameSize(false)).toEqual({ width: 640, height: 480 })
  })

  it('plays only the slides of a page, in reading order, and numbers them per page', () => {
    const pages = [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ]
    const frames = [
      frame('s2', 'S2', 300, 0, { slide: true, pageId: 'p1' }),
      frame('plain', 'Plain', 150, 0, { pageId: 'p1' }),
      frame('s1', 'S1', 0, 0, { slide: true, pageId: 'p1' }),
      frame('t1', 'T1', 0, 0, { slide: true, pageId: 'p2' }),
    ]
    expect(deckOf(frames.filter((f) => f.pageId === 'p1')).map((f) => f.id)).toEqual(['s1', 's2'])
    const numbers = deckNumbers(canvas(frames, pages))
    expect(Object.fromEntries(numbers)).toEqual({ s1: 1, s2: 2, t1: 1 })
  })
})
