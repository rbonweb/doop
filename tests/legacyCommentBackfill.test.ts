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
const { stampElementId, stampLegacyCommentElement } = await import('../server/elementIds.ts')

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

describe('an element that already wears a data-doop-id', () => {
  const html = '<table><tr data-doop-id="r10"><td>Row</td></tr><tr data-doop-id="r11"><td>Next</td></tr></table>'
  const broadcast = vi.fn()

  beforeEach(() => {
    broadcast.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Rows',
      ownerId: 'alice',
      createdAt: 0,
      updatedAt: 0,
      pages: [{ id: 'p1', name: 'Home' }],
      frames: [frame('f1', html)],
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
            comment('byId', 'f1', { anchor: anchor({ tag: 'tr', quote: 'Row' }) }),
            comment('byPath', 'f1'),
            comment('gone', 'f1', { anchor: anchor({ tag: 'tr', quote: 'Nowhere' }) }),
          ],
        ],
      ]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
  })

  it('keeps an id this format would not mint, by selector, by path and by anchor hints', () => {
    expect(stampElementId(html, '[data-doop-id="r10"]')).toEqual({ html, id: 'r10' })
    expect(stampElementId(html, 'body > table > tbody > tr:nth-of-type(2)')).toEqual({ html, id: 'r11' })
    expect(stampLegacyCommentElement(html, 'body > nothing', anchor({ tag: 'tr', quote: 'Next' }))).toEqual({
      html,
      id: 'r11',
    })
  })

  it('mints a new id only for the later of two elements sharing one', () => {
    const dupes = '<p data-doop-id="x1">One</p><p data-doop-id="x1">Two</p>'
    expect(stampElementId(dupes, 'body > p:nth-of-type(1)')).toEqual({ html: dupes, id: 'x1' })
    const second = stampElementId(dupes, 'body > p:nth-of-type(2)')
    expect(second?.id).toMatch(ID)
    expect(second?.html).toContain('<p data-doop-id="x1">One</p>')
    expect(second?.html).toMatch(new RegExp(`<p data-doop-id="${second?.id}">Two</p>`))
  })

  it('anchors the comment on the id it carries, leaves the frame untouched and keeps the old path', async () => {
    const before = store.getFrame('f1')!
    const map = new Map([
      ['byId', '[data-doop-id="r10"]'],
      ['byPath', 'body > table > tbody > tr:nth-of-type(1)'],
      ['gone', 'body > nothing'],
    ])
    expect(await actions.backfillElementIds(map)).toEqual({ stamped: 2, lost: 1, failed: 0 })

    expect(actions.findComment('byId')).toMatchObject({ elementId: 'r10', legacySelector: '[data-doop-id="r10"]' })
    expect(actions.findComment('byPath')).toMatchObject({ elementId: 'r10' })
    expect(store.getFrame('f1')!.html).toBe(html)
    expect(store.getFrame('f1')!.updatedAt).toBe(before.updatedAt)

    /* a comment that ends with no element keeps its path in the fork anchor */
    const gone = actions.findComment('gone')!
    expect(gone.elementId).toBeUndefined()
    expect(gone.anchor?.legacySelector).toBe('body > nothing')
  })

  it('changes nothing on a second boot', async () => {
    const map = new Map([['byId', '[data-doop-id="r10"]']])
    await actions.backfillElementIds(map)
    const afterFirst = JSON.stringify(actions.findComment('byId'))
    const frameAfterFirst = store.getFrame('f1')!
    broadcast.mockClear()

    await actions.backfillElementIds(map)
    expect(JSON.stringify(actions.findComment('byId'))).toBe(afterFirst)
    expect(store.getFrame('f1')).toEqual(frameAfterFirst)
    expect(broadcast).not.toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'frame:updated' }))
  })
})
