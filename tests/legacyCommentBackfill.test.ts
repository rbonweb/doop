import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CommentAnchor, ElementComment, Frame } from '../shared/types.ts'

/**
 * Fork comments from before element ids carry a structured anchor (tag, testid, id, role, label, quote and a pin
 * offset) next to their CSS path. The boot backfill re-finds the element by those hints when the path drifted,
 * and turns a frame-wide pin into a frame point. Persistence is mocked, as in elementIdBackfill.test.ts.
 */

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrame: () => {},
  saveCanvas: () => {},
  deleteFrame: () => {},
  saveFrameNow: async () => {},
  saveCommentNow: async () => {},
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { stampLegacyCommentElement } = await import('../server/elementIds.ts')

const ID = /^[a-z0-9]{6}$/
const anchor = (extra: Partial<CommentAnchor>): CommentAnchor => ({ v: 1, tag: 'button', fx: 0.25, fy: 0.5, ...extra })

const frame = (id: string, html: string): Frame => ({
  id,
  canvasId: 'c1',
  pageId: 'p1',
  name: id,
  html,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
})
const comment = (id: string, frameId: string, extra: Partial<ElementComment> = {}): ElementComment => ({
  id,
  canvasId: 'c1',
  frameId,
  snippet: '<button>',
  from: 'alice',
  text: id,
  at: 1,
  ...extra,
})

describe('stampLegacyCommentElement', () => {
  const html = '<main><button>Cancel</button><button data-testid="buy">Buy now</button></main>'

  it('is plain stampElementId when the comment has no anchor', () => {
    const stamped = stampLegacyCommentElement(html, 'body > main > button:nth-of-type(1)')
    expect(stamped?.id).toMatch(ID)
    expect(stamped?.html).toContain(`<button data-doop-id="${stamped?.id}">Cancel</button>`)
  })

  it('keeps the element at the stored path while it still fits the anchor', () => {
    const stamped = stampLegacyCommentElement(html, 'body > main > button:nth-of-type(2)', anchor({ testId: 'buy' }))
    expect(stamped?.html).toMatch(
      new RegExp(
        `data-testid="buy"[^>]*data-doop-id="${stamped?.id}"|data-doop-id="${stamped?.id}"[^>]*data-testid="buy"`,
      ),
    )
  })

  it('re-finds the element by its data-testid when the path points at a neighbour', () => {
    const stamped = stampLegacyCommentElement(html, 'body > main > button:nth-of-type(1)', anchor({ testId: 'buy' }))
    expect(stamped?.html).not.toContain(`<button data-doop-id="${stamped?.id}">Cancel</button>`)
    expect(stamped?.html).toContain(`>Buy now</button>`)
    expect(stamped?.html).toMatch(new RegExp(`<button[^>]*data-doop-id="${stamped?.id}"[^>]*>Buy now`))
  })

  it('re-finds the element by its quote when the path no longer resolves', () => {
    const stamped = stampLegacyCommentElement(html, 'body > main > section > button', anchor({ quote: 'Buy now' }))
    expect(stamped?.html).toMatch(new RegExp(`<button[^>]*data-doop-id="${stamped?.id}"[^>]*>Buy now`))
    expect(stamped?.html).not.toMatch(/Cancel<\/button>.*Cancel/)
  })

  it('finds nothing for a bare tag, so the comment is lost instead of pinned to a stranger', () => {
    expect(stampLegacyCommentElement(html, 'body > main > section > button', anchor({}))).toBeUndefined()
  })
})

describe('backfillElementIds with fork anchors', () => {
  const broadcast = vi.fn()

  beforeEach(() => {
    broadcast.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Pins',
      ownerId: 'alice',
      createdAt: 0,
      updatedAt: 0,
      pages: [{ id: 'p1', name: 'Home' }],
      frames: [frame('f1', '<main><button>Cancel</button><button data-testid="buy">Buy now</button></main>')],
    }
    store.init([canvas])
    actions.wire(broadcast, () => {})
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([
        [
          'c1',
          [
            comment('drifted', 'f1', { anchor: anchor({ testId: 'buy', quote: 'Buy now' }) }),
            comment('reply', 'f1', { parentId: 'drifted', anchor: anchor({ testId: 'buy', quote: 'Buy now' }) }),
            comment('background', 'f1', { snippet: '', anchor: anchor({ tag: 'body', fx: 0.25, fy: 0.5 }) }),
            comment('gone', 'f1', { anchor: anchor({}) }),
          ],
        ],
      ]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
  })

  it('stamps the element the hints find, turns a frame-wide pin into a frame point and spends a lost anchor', async () => {
    const counts = await actions.backfillElementIds(
      new Map([
        ['drifted', 'body > main > button:nth-of-type(1)'],
        ['reply', 'body > main > button:nth-of-type(1)'],
        ['background', 'body'],
        ['gone', 'body > main > section > button'],
      ]),
    )
    expect(counts).toEqual({ stamped: 3, lost: 1, failed: 0 })

    const drifted = actions.findComment('drifted')!
    expect(drifted.elementId).toMatch(ID)
    expect(store.getFrame('f1')!.html).toMatch(
      new RegExp(`<button[^>]*data-doop-id="${drifted.elementId}"[^>]*>Buy now`),
    )
    expect(store.getFrame('f1')!.html).toContain('<button>Cancel</button>')

    /* a reply carries its root's anchor, so it lands on the same element and shares its id */
    expect(actions.findComment('reply')!.elementId).toBe(drifted.elementId)

    const background = actions.findComment('background')!
    expect(background.elementId).toBeUndefined()
    expect(background).toMatchObject({ x: 25, y: 50 })

    expect(actions.findComment('gone')!.elementId).toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'comment', comment: drifted }))
  })
})
