import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeMarks, contentStamp, type MarkInput } from '../shared/marks.ts'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFrame: noop,
    saveGuideline: noop,
    saveMember: noop,
    saveReference: noop,
  }
})
import { store } from '../server/store.ts'

const ME: MarkInput['viewer'] = { userId: 'me', name: 'Me', ownsCanvas: false }
const AGENT = { userId: 'me', kind: 'agent' as const }
const ALICE = { userId: 'alice', kind: 'user' as const }

/** A frame as an older server wrote it: no design stamp, last touched at 200. */
const legacy = (id: string, over: Partial<Frame> = {}): Frame => ({
  id,
  canvasId: 'c1',
  pageId: 'c1:page1',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: `<p>${id}</p>`,
  createdAt: 1,
  updatedAt: 200,
  updatedBy: 'Alice',
  updatedByUserId: 'alice',
  updatedByKind: 'user',
  ...over,
})

function load(frames: Frame[]): Canvas {
  const canvas: Canvas = { id: 'c1', name: 'C', ownerId: 'owner', createdAt: 1, updatedAt: 200, frames }
  store.canvases.clear()
  store.init([canvas])
  return canvas
}

const mark = (canvas: Canvas, baselineAt = 1000) =>
  computeMarks(canvas.frames, [], { viewer: ME, seen: {}, baselineAt })

beforeEach(() => {
  vi.useRealTimers()
})

describe('booting the store', () => {
  it('leaves every frame exactly as it was stored, however many times the server restarts', () => {
    const frames = [legacy('a'), legacy('b', { updatedAt: 500, contentUpdatedAt: 450 }), legacy('c')]
    const before = structuredClone(frames)
    const canvas = load(frames)
    store.init([canvas])
    store.init([canvas])
    expect(canvas.frames).toEqual(before)
  })

  it('rehomes a frame whose page is gone without restamping it', () => {
    const canvas = load([legacy('c', { pageId: 'gone' })])
    const frame = canvas.frames[0]!
    expect(frame.pageId).toBe('c1:page1')
    expect(frame.updatedAt).toBe(200)
    expect(frame.contentUpdatedAt).toBeUndefined()
  })

  it('shows nothing new on a first visit and after a restart', () => {
    const canvas = load([legacy('a'), legacy('b', { updatedByKind: 'agent', updatedByUserId: undefined })])
    expect(mark(canvas, 1000)).toEqual({})
    store.init([canvas])
    expect(mark(canvas, 1000)).toEqual({})
  })
})

describe('what counts as a design change', () => {
  it('does not touch the design stamp or who last edited when a frame is moved, resized or sent to another page', () => {
    const canvas = load([legacy('a', { updatedAt: 500, contentUpdatedAt: 450 })])
    canvas.pages = [
      { id: 'c1:page1', name: 'Page 1' },
      { id: 'p2', name: 'Two' },
    ]
    const moved = store.updateFrame('a', { x: 40, y: 50, width: 300, pageId: 'p2' }, 'Claude', AGENT)!
    expect(moved.updatedAt).toBeGreaterThan(500)
    expect(moved.contentUpdatedAt).toBe(450)
    expect(moved.updatedBy).toBe('Alice')
    expect(moved.updatedByKind).toBe('user')
    expect(moved.updatedByUserId).toBe('alice')
  })

  it('stamps the design time on an html change, a rename, and a new frame, and records who did it', () => {
    const canvas = load([legacy('a'), legacy('b')])
    const htmlEdit = store.updateFrame('a', { html: '<p>new</p>' }, 'Claude', AGENT)!
    expect(htmlEdit.contentUpdatedAt).toBe(htmlEdit.updatedAt)
    expect(htmlEdit.updatedByKind).toBe('agent')
    const rename = store.updateFrame('b', { name: 'Hero' }, 'Alice', ALICE)!
    expect(rename.contentUpdatedAt).toBe(rename.updatedAt)
    expect(rename.updatedBy).toBe('Alice')
    const created = store.createFrame(canvas.id, { name: 'New', html: '<p></p>' }, 'Claude', AGENT)!
    expect(created.contentUpdatedAt).toBe(created.createdAt)
  })

  it('does not count a write that changes nothing in the design', () => {
    load([legacy('a', { contentUpdatedAt: 150 })])
    const same = store.updateFrame('a', { html: '<p>a</p>', name: 'a', x: 9 }, 'Claude', AGENT)!
    expect(same.contentUpdatedAt).toBe(150)
    expect(same.updatedByKind).toBe('user')
  })

  it('freezes the design time of a frame from before the stamp existed when it is first moved', () => {
    load([legacy('a', { updatedAt: 200 })])
    const moved = store.updateFrame('a', { x: 5 }, 'Claude', AGENT)!
    expect(moved.contentUpdatedAt).toBe(200)
    expect(contentStamp(moved)).toBe(200)
  })

  it('an agent tidying 277 frames after the first visit marks none of them new, but editing one marks just that one', () => {
    const baselineAt = Date.now() - 10_000
    const canvas = load(Array.from({ length: 277 }, (_, i) => legacy(`f${i}`, { updatedAt: baselineAt - 5000 })))
    for (const frame of canvas.frames) store.updateFrame(frame.id, { x: frame.x + 10, y: 20 }, 'Claude', AGENT)
    expect(canvas.frames.every((f) => f.updatedAt > baselineAt)).toBe(true)
    expect(mark(canvas, baselineAt)).toEqual({})
    store.updateFrame('f7', { html: '<p>redesigned</p>' }, 'Claude', AGENT)
    expect(mark(canvas, baselineAt)).toEqual({ f7: 'new' })
  })

  it('does not let a person moving a frame hide an agent edit from a third person', () => {
    const canvas = load([legacy('a')])
    store.updateFrame('a', { html: '<p>agent</p>' }, 'Claude', AGENT)
    store.updateFrame('a', { x: 80 }, 'Alice', ALICE)
    const viewer = { userId: 'bob', name: 'Bob', ownsCanvas: false }
    expect(computeMarks(canvas.frames, [], { viewer, seen: {}, baselineAt: 1 })).toEqual({ a: 'new' })
  })
})
