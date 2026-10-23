import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Canvas, Frame, ServerMessage } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { commentAnchorRouter } = await import('../server/commentRoutes.ts')

const CANVAS: Canvas = { id: 'c1', name: 'Pins', ownerId: 'owner', createdAt: 0, updatedAt: 0, frames: [] }
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<button>Buy</button>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

let broadcasts: ServerMessage[] = []
let userId = 'owner'
let server: Server
let origin: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: userId } as typeof req.user
    next()
  })
  app.use('/api/comments', commentAnchorRouter)
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
  broadcasts = []
  actions.wire(
    (_canvasId, msg) => broadcasts.push(msg),
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const anchor = { v: 1, tag: 'button', quote: 'Buy', fx: 0.3, fy: 0.7 }

function seedThread() {
  const root = actions.addElementComment(
    FRAME.id,
    { selector: 'main > button', snippet: '<button>Buy</button>', text: 'Bigger?', anchor },
    'alice',
    'owner',
  )
  if (!root) throw new Error('seed failed')
  const reply = actions.replyToComment(root.id, 'Agreed', 'bob', 'owner')
  if (!reply) throw new Error('reply failed')
  return { root, reply }
}

const patch = (id: string, body: unknown) =>
  fetch(`${origin}/api/comments/${id}/anchor`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('comment anchors in the action layer', () => {
  it('stores the anchor and the actor kind, and replies inherit the root anchor', () => {
    const { root, reply } = seedThread()
    expect(root).toMatchObject({ anchor, fromKind: 'user' })
    expect(reply).toMatchObject({ anchor, fromKind: 'user', parentId: root.id })
  })

  it('ignores a malformed anchor from the client', () => {
    const c = actions.addElementComment(FRAME.id, { selector: 'p', snippet: '', text: 'hi', anchor: 'junk' }, 'alice')
    expect(c?.anchor).toBeUndefined()
  })

  it('heals the whole thread and sends one debounced broadcast per comment', () => {
    vi.useFakeTimers()
    const { root, reply } = seedThread()
    broadcasts.length = 0
    actions.healCommentSelector(reply.id, 'main > section > button')
    actions.healCommentSelector(root.id, 'main > section > button')
    actions.healCommentSelector(root.id, 'main > section:nth-of-type(2) > button')
    expect(broadcasts).toHaveLength(0)
    vi.advanceTimersByTime(500)
    const sent = broadcasts.filter((m) => m.type === 'comment')
    expect(sent).toHaveLength(2)
    expect(actions.findComment(root.id)?.selector).toBe('main > section:nth-of-type(2) > button')
    expect(actions.findComment(reply.id)?.selector).toBe('main > section:nth-of-type(2) > button')
    expect(actions.findComment(root.id)?.anchor).toEqual(anchor)
  })
})

describe('PATCH /api/comments/:id/anchor', () => {
  it('updates the selector on the root and its replies for someone with canvas access', async () => {
    const { root, reply } = seedThread()
    const res = await patch(reply.id, { selector: 'main > section > button' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, selector: 'main > section > button' })
    expect(actions.findComment(root.id)?.selector).toBe('main > section > button')
    expect(actions.findComment(reply.id)?.selector).toBe('main > section > button')
  })

  it('refuses someone without access to the canvas and leaves the selector alone', async () => {
    const { root } = seedThread()
    userId = 'stranger'
    const res = await patch(root.id, { selector: 'evil > path' })
    expect(res.status).toBe(403)
    expect(actions.findComment(root.id)?.selector).toBe('main > button')
  })

  it('rejects a missing comment and a selector that is not a usable string', async () => {
    const { root } = seedThread()
    expect((await patch('nope', { selector: 'a' })).status).toBe(404)
    expect((await patch(root.id, {})).status).toBe(400)
    expect((await patch(root.id, { selector: 42 })).status).toBe(400)
    expect((await patch(root.id, { selector: '   ' })).status).toBe(400)
    expect((await patch(root.id, { selector: 'a'.repeat(actions.MAX_SELECTOR_LENGTH + 1) })).status).toBe(400)
    expect(actions.findComment(root.id)?.selector).toBe('main > button')
  })
})
