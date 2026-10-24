import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER_ID = 'owner-1'
const CANVAS: Canvas = { id: 'c1', name: 'Pins', ownerId: OWNER_ID, createdAt: 0, updatedAt: 0, frames: [] }
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<button>Start free trial</button>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const OTHER_FRAME: Frame = { ...FRAME, id: 'f2', canvasId: 'other-canvas' }

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-add-comment-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content.map((block) => block.text ?? '').join('\n')
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings are plain text */
  }
  return { parsed, raw, isError: result.isError }
}

beforeEach(() => {
  vi.restoreAllMocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, []]]),
    activity: new Map([[CANVAS.id, []]]),
    decisions: new Map([[CANVAS.id, []]]),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) =>
    id === FRAME.id ? FRAME : id === OTHER_FRAME.id ? OTHER_FRAME : undefined,
  )
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
})

describe('add_comment MCP tool', () => {
  it('is registered as a mutating tool that needs a canvas, text and agent name, with the frame optional', async () => {
    const { client, close } = await connect()
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'add_comment')
      expect(tool).toBeDefined()
      expect(tool!.annotations?.readOnlyHint).not.toBe(true)
      const schema = tool!.inputSchema as { required?: string[] }
      expect(new Set(schema.required)).toEqual(new Set(['canvas_id', 'text', 'agent_name']))
      expect(Object.keys((tool!.inputSchema as { properties: object }).properties)).toEqual(
        expect.arrayContaining(['frame_id', 'page_id', 'x', 'y']),
      )
    } finally {
      await close()
    }
  })

  it('pins a quote-only comment with a tagless anchor, attributed to the agent', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: FRAME.id,
        quote: '  Start   free trial ',
        text: 'Should this say "Try it free"?',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({
        frameId: FRAME.id,
        from: 'Claude',
        fromKind: 'agent',
        selector: '',
        anchor: { v: 1, tag: '', quote: 'Start free trial', fx: 0.5, fy: 0.5 },
      })
      expect(actions.getComments(CANVAS.id)).toHaveLength(1)
      expect(actions.getActivity(CANVAS.id)[0]).toMatchObject({ actorName: 'Claude', actorKind: 'agent' })
    } finally {
      await close()
    }
  })

  it('accepts a selector alone, without inventing an anchor', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: FRAME.id,
        selector: 'button',
        text: 'Contrast looks low',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ selector: 'button', fromKind: 'agent' })
      expect((parsed as { anchor?: unknown }).anchor).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('requires a quote or a selector, and rejects empty text', async () => {
    const { client, close } = await connect()
    try {
      const neither = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: FRAME.id,
        text: 'Where?',
        agent_name: 'Claude',
      })
      expect(neither.isError).toBe(true)
      expect(neither.raw).toContain('quote or a selector')

      const empty = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: FRAME.id,
        quote: 'Start free trial',
        text: '   ',
        agent_name: 'Claude',
      })
      expect(empty.isError).toBe(true)
      expect(actions.getComments(CANVAS.id)).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('places a canvas comment with page_id, x and y and no frame', async () => {
    const { client, close } = await connect()
    try {
      const pageId = `${CANVAS.id}:page1`
      const { parsed, isError } = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        page_id: pageId,
        x: 120,
        y: -40,
        text: 'Leave room for a footer here',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ pageId, x: 120, y: -40, from: 'Claude', fromKind: 'agent' })
      expect((parsed as { frameId?: unknown }).frameId ?? undefined).toBeUndefined()
      expect(actions.getComments(CANVAS.id)).toHaveLength(1)
      expect(actions.getActivity(CANVAS.id)[0]).toMatchObject({ actorName: 'Claude', actorKind: 'agent' })
    } finally {
      await close()
    }
  })

  it('rejects a canvas comment without a full point, on an unknown page, or mixed with a frame pin', async () => {
    const { client, close } = await connect()
    try {
      const pageId = `${CANVAS.id}:page1`
      const base = { canvas_id: CANVAS.id, text: 'Here', agent_name: 'Claude' }
      const noPoint = await call(client, 'add_comment', { ...base, page_id: pageId, x: 1 })
      expect(noPoint.isError).toBe(true)
      expect(noPoint.raw).toContain('page_id with x and y')

      const unknownPage = await call(client, 'add_comment', { ...base, page_id: 'missing', x: 1, y: 2 })
      expect(unknownPage.isError).toBe(true)
      expect(unknownPage.raw).toContain('no page with id missing')

      const quoted = await call(client, 'add_comment', {
        ...base,
        page_id: pageId,
        x: 1,
        y: 2,
        quote: 'Start free trial',
      })
      expect(quoted.isError).toBe(true)

      const both = await call(client, 'add_comment', { ...base, frame_id: FRAME.id, page_id: pageId, x: 1, y: 2 })
      expect(both.isError).toBe(true)
      expect(both.raw).toContain('not both')
      expect(actions.getComments(CANVAS.id)).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('refuses a frame that belongs to another canvas', async () => {
    const { client, close } = await connect()
    try {
      const { isError } = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: OTHER_FRAME.id,
        quote: 'Start free trial',
        text: 'Wrong canvas',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(actions.getComments(CANVAS.id)).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('lets a reply inherit the thread anchor and shows the quote through get_comments', async () => {
    const { client, close } = await connect()
    try {
      const added = await call(client, 'add_comment', {
        canvas_id: CANVAS.id,
        frame_id: FRAME.id,
        quote: 'Start free trial',
        text: 'Question',
        agent_name: 'Claude',
      })
      const rootId = (added.parsed as { id: string }).id
      await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: rootId,
        text: 'Follow-up',
        agent_name: 'Claude',
      })
      const { parsed } = await call(client, 'get_comments', { canvas_id: CANVAS.id })
      const comments = parsed as Array<{ parentId?: string; anchor?: { quote?: string }; fromKind?: string }>
      expect(comments).toHaveLength(2)
      for (const c of comments) {
        expect(c.anchor?.quote).toBe('Start free trial')
        expect(c.fromKind).toBe('agent')
      }
    } finally {
      await close()
    }
  })
})
