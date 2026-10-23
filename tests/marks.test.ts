import { describe, expect, it } from 'vitest'
import {
  computeMarks,
  isBeingViewed,
  marksSummary,
  nextMarked,
  pageMarks,
  reviewOrder,
  strongerMark,
  type Mark,
  type MarkInput,
} from '../shared/marks.ts'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

const ME = 'me'
const input = (over: Partial<MarkInput> = {}): MarkInput => ({
  viewer: { userId: ME, name: 'Me', ownsCanvas: false },
  seen: {},
  baselineAt: 100,
  ...over,
})

function frame(id: string, over: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    html: '',
    createdAt: 0,
    updatedAt: 200,
    updatedBy: 'Alice',
    updatedByUserId: 'alice',
    updatedByKind: 'user',
    ...over,
  }
}

let nextAt = 1000
function comment(over: Partial<ElementComment> & Pick<ElementComment, 'id'>): ElementComment {
  return {
    canvasId: 'c1',
    frameId: 'f1',
    selector: 'body',
    snippet: '',
    from: 'Someone',
    text: 'hi',
    at: nextAt++,
    fromKind: 'user',
    ...over,
  }
}

const thread = (agentLast: boolean): ElementComment[] => {
  const root = comment({ id: 'root', fromUserId: ME })
  const reply = comment({
    id: 'reply',
    parentId: 'root',
    from: agentLast ? 'Claude' : 'Me',
    fromKind: agentLast ? 'agent' : 'user',
    fromUserId: ME,
  })
  return [reply, root]
}

describe('new (blue)', () => {
  it('marks a frame someone else changed after the viewer last saw it', () => {
    expect(computeMarks([frame('f1')], [], input())).toEqual({ f1: 'new' })
    expect(computeMarks([frame('f1')], [], input({ seen: { f1: 150 } }))).toEqual({ f1: 'new' })
  })

  it('treats everything up to the baseline as seen, so a first visit starts clean', () => {
    expect(computeMarks([frame('f1', { updatedAt: 100 })], [], input())).toEqual({})
    expect(computeMarks([frame('f1', { updatedAt: 150 })], [], input({ baselineAt: 150 }))).toEqual({})
  })

  it('clears once the viewer has seen that version, and returns when it changes again', () => {
    const seen = { f1: 200 }
    expect(computeMarks([frame('f1')], [], input({ seen }))).toEqual({})
    expect(computeMarks([frame('f1', { updatedAt: 201 })], [], input({ seen }))).toEqual({ f1: 'new' })
  })

  it("never marks the viewer's own edit", () => {
    const mine = frame('f1', { updatedBy: 'Me', updatedByUserId: ME, updatedByKind: 'user' })
    expect(computeMarks([mine], [], input())).toEqual({})
  })

  it('compares the account id, not the display name two people can share', () => {
    const namesake = frame('f1', { updatedBy: 'Me', updatedByUserId: 'someone-else' })
    expect(computeMarks([namesake], [], input())).toEqual({ f1: 'new' })
  })

  it('falls back to the display name on frames written before editors were recorded by id', () => {
    const legacy = (updatedBy: string) =>
      frame('f1', { updatedBy, updatedByUserId: undefined, updatedByKind: undefined })
    expect(computeMarks([legacy('Me')], [], input())).toEqual({})
    expect(computeMarks([legacy('Alice')], [], input())).toEqual({ f1: 'new' })
  })

  it("counts an agent edit made with the viewer's own key as new", () => {
    const agent = frame('f1', { updatedBy: 'Claude', updatedByUserId: ME, updatedByKind: 'agent' })
    expect(computeMarks([agent], [], input())).toEqual({ f1: 'new' })
  })
})

describe('needs you (orange)', () => {
  it("is an open thread the viewer wrote whose newest message is an agent's", () => {
    expect(computeMarks([frame('f1', { updatedAt: 50 })], thread(true), input())).toEqual({ f1: 'ask' })
  })

  it('clears when the viewer replies, since the newest message is theirs', () => {
    expect(computeMarks([frame('f1', { updatedAt: 50 })], thread(false), input())).toEqual({})
  })

  it('ignores a resolved thread', () => {
    const resolved = thread(true).map((c) => ({ ...c, resolvedAt: 5000 }))
    expect(computeMarks([frame('f1', { updatedAt: 50 })], resolved, input())).toEqual({})
  })

  it('needs the viewer to be in the thread: the author, a replier, a mention, or the canvas owner', () => {
    const r1 = comment({ id: 'r1', fromUserId: 'bob', from: 'Bob' })
    const r2 = comment({ id: 'r2', parentId: 'r1', fromKind: 'agent', fromUserId: 'bob', from: 'Claude' })
    const stranger = [r2, r1]
    const old = frame('f1', { updatedAt: 50 })
    expect(computeMarks([old], stranger, input())).toEqual({})
    expect(computeMarks([old], stranger, input({ viewer: { userId: ME, ownsCanvas: true } }))).toEqual({ f1: 'ask' })
    const mentioned = stranger.map((c) => (c.id === 'r1' ? { ...c, mentions: [ME] } : c))
    expect(computeMarks([old], mentioned, input())).toEqual({ f1: 'ask' })
    const mine = comment({ id: 'r3', parentId: 'r1', fromUserId: ME, from: 'Me' })
    const answer = comment({ id: 'r4', parentId: 'r1', fromKind: 'agent', fromUserId: 'bob', from: 'Claude' })
    const replied = [answer, mine, r1]
    expect(computeMarks([old], replied, input())).toEqual({ f1: 'ask' })
  })

  it("does not count an agent talking through the viewer's key as the viewer writing", () => {
    const agentOnly = [
      comment({ id: 'a2', parentId: 'a1', fromKind: 'agent', fromUserId: ME, from: 'Claude' }),
      comment({ id: 'a1', fromKind: 'agent', fromUserId: ME, from: 'Claude' }),
    ]
    expect(computeMarks([frame('f1', { updatedAt: 50 })], agentOnly, input())).toEqual({})
  })

  it('beats blue on the same frame', () => {
    expect(computeMarks([frame('f1')], thread(true), input())).toEqual({ f1: 'ask' })
  })

  it('treats comments with no recorded kind as the viewer-side, so old rows never ask', () => {
    const legacy = thread(true).map((c) => ({ ...c, fromKind: undefined }))
    expect(computeMarks([frame('f1', { updatedAt: 50 })], legacy, input())).toEqual({})
  })
})

describe('no one to mark for', () => {
  it('gives no marks without input (a guest, or the seen state has not loaded)', () => {
    expect(computeMarks([frame('f1')], thread(true), undefined)).toEqual({})
  })
})

describe('summaries and page marks', () => {
  it('words the counts', () => {
    expect(marksSummary({})).toBe('')
    expect(marksSummary({ a: 'ask', b: 'new', c: 'new' })).toBe('1 needs you · 2 new')
    expect(marksSummary({ a: 'ask', b: 'ask' })).toBe('2 need you')
  })

  it('orange beats blue', () => {
    expect(strongerMark('new', 'ask')).toBe('ask')
    expect(strongerMark('ask', 'new')).toBe('ask')
    expect(strongerMark(undefined, 'new')).toBe('new')
    expect(strongerMark(undefined, undefined)).toBeUndefined()
  })

  const canvas: Pick<Canvas, 'id' | 'pages' | 'frames'> = {
    id: 'c1',
    pages: [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ],
    frames: [frame('a', { pageId: 'p1' }), frame('b', { pageId: 'p2' }), frame('c', { pageId: 'p2' })],
  }

  it('folds frame marks into the strongest mark per page, legacy frames landing on page one', () => {
    expect(pageMarks(canvas, { b: 'new', c: 'ask' })).toEqual({ p2: 'ask' })
    const legacy = { ...canvas, frames: [frame('a', { pageId: undefined })] }
    expect(pageMarks(legacy, { a: 'new' })).toEqual({ p1: 'new' })
  })
})

describe('u: the next frame to review', () => {
  const canvas: Pick<Canvas, 'id' | 'pages' | 'frames'> = {
    id: 'c1',
    pages: [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
      { id: 'p3', name: 'Three', parentId: 'p1' },
    ],
    frames: [
      frame('p1-right', { pageId: 'p1', x: 500, y: 0 }),
      frame('p1-left', { pageId: 'p1', x: 0, y: 0 }),
      frame('p1-low', { pageId: 'p1', x: 0, y: 600 }),
      frame('p2-a', { pageId: 'p2', x: 0, y: 0 }),
      frame('p3-a', { pageId: 'p3', x: 0, y: 0 }),
    ],
  }

  it('walks pages as the page tree lists them (a subpage right after its parent), each page row by row', () => {
    expect(reviewOrder(canvas).map((f) => f.id)).toEqual(['p1-left', 'p1-right', 'p1-low', 'p3-a', 'p2-a'])
  })

  const order = reviewOrder(canvas)
  const marks = (m: Record<string, Mark>) => m

  it('goes to needs-you frames first, across pages, before any new one', () => {
    const m = marks({ 'p1-right': 'new', 'p3-a': 'ask', 'p2-a': 'ask' })
    expect(nextMarked(order, m, null)).toBe('p3-a')
    expect(nextMarked(order, m, 'p3-a')).toBe('p2-a')
  })

  it('moves on to new frames when no needs-you frame is left ahead, wrapping to the start', () => {
    const m = marks({ 'p1-right': 'new', 'p3-a': 'ask' })
    expect(nextMarked(order, m, 'p3-a')).toBe('p1-right')
    expect(nextMarked(order, marks({ 'p1-right': 'new' }), 'p2-a')).toBe('p1-right')
  })

  it('comes back to needs-you frames behind the current one when nothing new is left', () => {
    expect(nextMarked(order, marks({ 'p1-left': 'ask' }), 'p2-a')).toBe('p1-left')
  })

  it('has nowhere to go when nothing else is marked', () => {
    expect(nextMarked(order, {}, 'p1-left')).toBeUndefined()
    expect(nextMarked(order, marks({ 'p1-left': 'ask' }), 'p1-left')).toBeUndefined()
  })
})

describe('being viewed', () => {
  const stage = { width: 1000, height: 800 }
  const box = { x: 0, y: 0, width: 400, height: 300 }

  it('needs at least half of the frame on screen', () => {
    expect(isBeingViewed(box, { x: 0, y: 0, zoom: 1 }, stage)).toBe(true)
    expect(isBeingViewed(box, { x: -200, y: 0, zoom: 1 }, stage)).toBe(true)
    expect(isBeingViewed(box, { x: -201, y: 0, zoom: 1 }, stage)).toBe(false)
    expect(isBeingViewed(box, { x: 2000, y: 0, zoom: 1 }, stage)).toBe(false)
  })

  it('needs a zoom a person can read at', () => {
    expect(isBeingViewed(box, { x: 0, y: 0, zoom: 0.5 }, stage)).toBe(true)
    expect(isBeingViewed(box, { x: 0, y: 0, zoom: 0.49 }, stage)).toBe(false)
  })

  it('counts a frame bigger than the stage once it covers half of the stage', () => {
    const tall = { x: 0, y: 0, width: 800, height: 5000 }
    expect(isBeingViewed(tall, { x: 0, y: 0, zoom: 1 }, stage)).toBe(true)
    expect(isBeingViewed(tall, { x: 0, y: -4900, zoom: 1 }, stage)).toBe(false)
  })
})
