// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types'

const api = vi.hoisted(() => ({
  getSeen: vi.fn(),
  postSeen: vi.fn(),
  replaceSeen: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({ api }))

const { useStore } = await import('../src/lib/store')
const { bindMarks, markAllSeen, reviewNext, useMarks } = await import('../src/lib/marks')

const BASELINE = 1000
const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id,
  canvasId: 'c1',
  pageId: 'p1',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 1,
  updatedAt: 2000,
  updatedBy: 'Claude',
  updatedByKind: 'agent',
  ...over,
})

/** An open thread whose newest message is an agent's: orange for the canvas owner. */
const askComment = (frameId: string): ElementComment =>
  ({
    id: `t-${frameId}`,
    frameId,
    at: 3000,
    from: 'Claude',
    fromKind: 'agent',
    text: 'Which one?',
  }) as ElementComment

async function open(frames: Frame[], comments: ElementComment[] = [], seen: Record<string, number> = {}) {
  api.getSeen.mockResolvedValue({ seen, baselineAt: BASELINE })
  const canvas: Canvas = {
    id: 'c1',
    name: 'C',
    ownerId: 'me',
    createdAt: 1,
    updatedAt: 1,
    pages: [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ],
    frames,
  }
  useStore.setState({ canvas, comments, selectedId: null, selectedIds: [], activePageId: 'p1', notice: null })
  const stop = bindMarks('c1', { userId: 'me', name: 'Me' })
  await vi.waitFor(() => expect(useMarks.getState().baselineAt).toBe(BASELINE))
  return stop
}

let stop: (() => void) | undefined
beforeEach(() => {
  api.getSeen.mockReset()
  api.postSeen.mockReset().mockResolvedValue({ ok: true })
  api.replaceSeen.mockReset().mockResolvedValue({ ok: true })
})
afterEach(() => {
  stop?.()
  stop = undefined
})

describe('first visit and restart', () => {
  it('shows no marks for frames that were there before the first visit', async () => {
    stop = await open([frame('a', { updatedAt: 500 }), frame('b', { updatedAt: 999 })])
    expect(useMarks.getState().marks).toEqual({})
  })

  it('shows no marks while the seen state has not loaded (a failed read is not "everything is new")', async () => {
    api.getSeen.mockRejectedValue(new Error('401'))
    useStore.setState({
      canvas: { id: 'c1', name: 'C', createdAt: 1, updatedAt: 1, frames: [frame('a')] } as Canvas,
      comments: [],
    })
    stop = bindMarks('c1', { userId: 'me', name: 'Me' })
    await vi.waitFor(() => expect(api.getSeen).toHaveBeenCalled())
    expect(useMarks.getState().baselineAt).toBeNull()
    expect(useMarks.getState().marks).toEqual({})
  })

  it('does not report anything to the server just by opening the canvas', async () => {
    stop = await open([frame('a', { updatedAt: 500 })])
    expect(api.postSeen).not.toHaveBeenCalled()
  })
})

describe('mark all as seen', () => {
  const frames = () => [
    frame('n1'),
    frame('n2', { contentUpdatedAt: 2500, updatedAt: 2600 }),
    frame('ask1'),
    frame('old', { updatedAt: 10 }),
  ]

  it('marks every new frame seen in one batched report, and leaves the needs-you marks alone', async () => {
    stop = await open(frames(), [askComment('ask1')])
    expect(useMarks.getState().marks).toEqual({ n1: 'new', n2: 'new', ask1: 'ask' })

    expect(markAllSeen()).toBe(2)

    expect(useMarks.getState().marks).toEqual({ ask1: 'ask' })
    expect(api.postSeen).toHaveBeenCalledTimes(1)
    expect(api.postSeen.mock.calls[0]![1]).toEqual({ n1: 2000, n2: 2500 })
    expect(useStore.getState().notice?.text).toBe('Marked 2 frames as seen')
    expect(useStore.getState().notice?.action?.label).toBe('Undo')
  })

  it('says "frame" for one, and says so when there is nothing new', async () => {
    stop = await open([frame('n1'), frame('ask1')], [askComment('ask1')])
    markAllSeen()
    expect(useStore.getState().notice?.text).toBe('Marked 1 frame as seen')
    expect(markAllSeen()).toBe(0)
    expect(useStore.getState().notice?.text).toBe('Nothing new to mark as seen')
    expect(api.postSeen).toHaveBeenCalledTimes(1)
  })

  it('undo brings the marks back locally and tells the server to put the previous state back, even backwards', async () => {
    stop = await open(frames(), [askComment('ask1')], { n2: 2100 })
    expect(useMarks.getState().marks.n2).toBe('new')
    markAllSeen()
    expect(useMarks.getState().seen).toMatchObject({ n1: 2000, n2: 2500 })

    useStore.getState().notice?.action?.run()

    expect(useMarks.getState().seen).toEqual({ n2: 2100 })
    expect(useMarks.getState().marks).toEqual({ n1: 'new', n2: 'new', ask1: 'ask' })
    expect(api.replaceSeen).toHaveBeenCalledTimes(1)
    expect(api.replaceSeen.mock.calls[0]).toEqual(['c1', { n1: null, n2: 2100 }])
  })

  it('undo keeps a frame that was looked at afterwards seen', async () => {
    stop = await open([frame('n1'), frame('n2')])
    markAllSeen()
    const undo = useStore.getState().notice?.action?.run
    useMarks.setState({ seen: { ...useMarks.getState().seen, n2: 5000 } })
    undo?.()
    expect(useMarks.getState().seen).toEqual({ n2: 5000 })
    expect(api.replaceSeen.mock.calls[0]![1]).toEqual({ n1: null })
  })

  it('reports a big canvas in requests the server accepts', async () => {
    stop = await open(Array.from({ length: 1200 }, (_, i) => frame(`f${i}`)))
    expect(markAllSeen()).toBe(1200)
    expect(api.postSeen.mock.calls.map((call) => Object.keys(call[1]).length)).toEqual([500, 500, 200])
  })

  it('does nothing for a guest with no marks session', () => {
    expect(markAllSeen()).toBe(0)
    expect(api.postSeen).not.toHaveBeenCalled()
  })
})

describe('jumping to the next marked frame', () => {
  it('flies to a marked frame on another page, switching the page, and marks it seen', async () => {
    stop = await open([frame('here', { updatedAt: 10 }), frame('there', { pageId: 'p2' })])
    reviewNext()
    const state = useStore.getState()
    expect(state.activePageId).toBe('p2')
    expect(state.selectedId).toBe('there')
    expect(state.flyTo).toMatchObject({ frameId: 'there' })
    expect(useMarks.getState().marks).toEqual({})
  })
})
