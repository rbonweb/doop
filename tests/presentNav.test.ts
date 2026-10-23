import { describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { backNav, formatElapsed, jumpNav, presentOrder, pruneNav, startNav, stepNav } from '../src/lib/presentNav'
import {
  idlePresenterView,
  parsePresenterMessage,
  presenterChannelName,
  reducePresenterView,
} from '../src/lib/presenterSync'

function frame(id: string, x: number, y: number, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c',
    name: id,
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

const canvas = (frames: Frame[]): Canvas => ({ id: 'c', name: 'C', createdAt: 0, updatedAt: 0, frames })
const ids = (frames: Frame[]) => frames.map((f) => f.id)

describe('presentOrder', () => {
  it('walks every frame of the page in reading order', () => {
    const frames = [frame('c', 0, 300), frame('b', 300, 0), frame('a', 0, 0)]
    expect(ids(presentOrder(canvas(frames), frames[2]!))).toEqual(['a', 'b', 'c'])
  })

  it('walks only the slides of the page when the frame is a slide', () => {
    const frames = [
      frame('s2', 300, 0, { slide: true }),
      frame('plain', 150, 0),
      frame('s1', 0, 0, { slide: true }),
      frame('elsewhere', 0, 0, { slide: true, pageId: 'p2' }),
    ]
    const c = {
      ...canvas(frames),
      pages: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' },
      ],
    }
    expect(ids(presentOrder(c, frames[2]!))).toEqual(['s1', 's2'])
    expect(ids(presentOrder(c, frames[1]!))).toEqual(['s1', 'plain', 's2'])
  })
})

describe('the walk', () => {
  const order = ['a', 'b', 'c']

  it('steps along the order and stops at either end', () => {
    let nav = startNav('a')
    nav = stepNav(nav, order, 1)
    expect(nav.currentId).toBe('b')
    nav = stepNav(stepNav(nav, order, 1), order, 1)
    expect(nav.currentId).toBe('c')
    expect(stepNav(startNav('a'), order, -1).currentId).toBe('a')
  })

  it('does not push history for arrow steps', () => {
    expect(stepNav(startNav('a'), order, 1).history).toEqual([])
  })

  it('steps from a frame outside the order to its start', () => {
    expect(stepNav(startNav('x'), order, 1).currentId).toBe('a')
    expect(stepNav(startNav('x'), order, -1).currentId).toBe('c')
    expect(stepNav(startNav('x'), [], 1).currentId).toBe('x')
  })

  it('pushes the frame it leaves on a link and pops it on Backspace', () => {
    let nav = jumpNav(startNav('a'), 'c')
    nav = jumpNav(nav, 'b')
    expect(nav).toEqual({ currentId: 'b', history: ['a', 'c'] })
    nav = backNav(nav)
    expect(nav).toEqual({ currentId: 'c', history: ['a'] })
    nav = backNav(backNav(nav))
    expect(nav).toEqual({ currentId: 'a', history: [] })
    expect(backNav(nav)).toBe(nav)
  })

  it('ignores a link to the frame already on screen', () => {
    const nav = startNav('a')
    expect(jumpNav(nav, 'a')).toBe(nav)
  })

  it('keeps the history bounded', () => {
    let nav = startNav('f0')
    for (let i = 1; i <= 300; i++) nav = jumpNav(nav, `f${i}`)
    expect(nav.history).toHaveLength(200)
    expect(nav.history.at(-1)).toBe('f299')
  })

  it('drops history for frames that are gone', () => {
    const nav = { currentId: 'c', history: ['a', 'gone', 'b'] }
    expect(pruneNav(nav, (id) => id !== 'gone').history).toEqual(['a', 'b'])
    expect(pruneNav(nav, () => true)).toBe(nav)
  })
})

describe('formatElapsed', () => {
  it('reads m:ss, then h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65_900)).toBe('1:05')
    expect(formatElapsed(3_600_000 + 61_000)).toBe('1:01:01')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})

describe('presenter sync', () => {
  const state = { type: 'state', frameId: 'f2', index: 2, total: 5, nextId: 'f3', startedAt: 1000 } as const

  it('names one channel per canvas', () => {
    expect(presenterChannelName('abc')).toBe('doop-present-abc')
  })

  it('shows the latest state it was sent', () => {
    const first = reducePresenterView(idlePresenterView, state)
    expect(first).toEqual({ live: true, frameId: 'f2', index: 2, total: 5, nextId: 'f3', startedAt: 1000 })
    const later = reducePresenterView(first, { ...state, frameId: 'f3', index: 3, nextId: null })
    expect(later).toMatchObject({ frameId: 'f3', index: 3, nextId: null, startedAt: 1000 })
  })

  it('goes idle when the show ends', () => {
    expect(reducePresenterView(reducePresenterView(idlePresenterView, state), { type: 'end' })).toEqual(
      idlePresenterView,
    )
  })

  it('leaves the view alone for messages meant for the other window', () => {
    const live = reducePresenterView(idlePresenterView, state)
    expect(reducePresenterView(live, { type: 'hello' })).toBe(live)
    expect(reducePresenterView(live, { type: 'command', command: 'next' })).toBe(live)
  })

  it('parses what it sent and refuses everything else', () => {
    expect(parsePresenterMessage({ ...state })).toEqual(state)
    expect(parsePresenterMessage({ type: 'hello' })).toEqual({ type: 'hello' })
    expect(parsePresenterMessage({ type: 'command', command: 'prev' })).toEqual({ type: 'command', command: 'prev' })
    expect(parsePresenterMessage({ type: 'command', command: 'explode' })).toBeNull()
    expect(parsePresenterMessage({ ...state, index: -1 })).toBeNull()
    expect(parsePresenterMessage({ ...state, frameId: '' })).toBeNull()
    expect(parsePresenterMessage({ ...state, nextId: 4 })).toBeNull()
    expect(parsePresenterMessage('state')).toBeNull()
    expect(parsePresenterMessage(null)).toBeNull()
    expect(parsePresenterMessage({ type: 'other' })).toBeNull()
  })
})
