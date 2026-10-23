import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import * as allowance from '../server/allowance.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/* An agent acts as the account behind its key or session, so the role that
   account holds on a canvas bounds what the agent can do there. These tests
   run the real MCP server in memory against canvases whose members hold each
   role, and only stub persistence and the resident agent. */
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

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Roles',
  ownerId: 'owner',
  memberIds: ['viewer', 'commenter', 'editor'],
  memberRoles: { viewer: 'view', commenter: 'comment' },
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const ROOT: ElementComment = {
  id: 'root',
  canvasId: CANVAS.id,
  frameId: FRAME.id,
  selector: 'h1',
  snippet: '<h1>Hi</h1>',
  from: 'alice',
  text: 'thoughts?',
  at: 1,
}

async function as(userId: string) {
  const server = buildMcpServer('Someone', userId)
  const client = new Client({ name: 'roles-test', version: '1.0.0' })
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
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
  return { text, isError: !!result.isError }
}

const base = { canvas_id: CANVAS.id, agent_name: 'Claude' }

/* every tool that changes the canvas, with arguments that would succeed for an editor */
const WRITES: [string, Record<string, unknown>][] = [
  ['set_frame_html', { ...base, frame_id: FRAME.id, html: '<p>x</p>' }],
  ['append_frame_html', { ...base, frame_id: FRAME.id, html_chunk: '<p>x</p>', start: false, done: true }],
  ['edit_frame_html', { ...base, frame_id: FRAME.id, old_str: 'Hi', new_str: 'Yo' }],
  ['update_frame', { ...base, frame_id: FRAME.id, name: 'Renamed' }],
  ['delete_frame', { ...base, frame_id: FRAME.id }],
  ['create_frame', { ...base, name: 'New', html: '<p>new</p>' }],
  ['set_canvas_pages', { ...base, pages: [{ id: 'p1', name: 'One' }], expectedPages: [] }],
  ['set_guidelines', { ...base, name: 'brand', markdown: '# Brand' }],
  ['save_decision', { ...base, decision: 'Use blue' }],
  ['upload_asset', { ...base, source_url: 'https://example.com/a.png' }],
  ['generate_image', { ...base, prompt: 'a red square' }],
  ['import_webpage', { ...base, url: 'https://example.com' }],
  ['set_status', { ...base, status: 'working' }],
  ['get_feedback', base],
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === FRAME.id ? FRAME : undefined))
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, [{ ...ROOT }]]]),
    activity: new Map(),
    chat: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  } as unknown as Parameters<typeof actions.hydrateLogs>[0])
})

describe('MCP tools honour the role of the account behind the key', () => {
  it.each(['viewer', 'commenter'])('refuses every write to a %s-role key owner', async (userId) => {
    const written = vi.spyOn(actions, 'updateFrame')
    const created = vi.spyOn(actions, 'createFrame')
    const removed = vi.spyOn(actions, 'deleteFrame')
    const { client, close } = await as(userId)
    try {
      for (const [tool, args] of WRITES) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, `${tool} should be refused: ${text}`).toBe(true)
        expect(text, tool).toMatch(/needs edit access/)
      }
      expect(written).not.toHaveBeenCalled()
      expect(created).not.toHaveBeenCalled()
      expect(removed).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('tells a view-only key it can only view, and a comment key it can comment', async () => {
    const viewer = await as('viewer')
    const commenter = await as('commenter')
    try {
      expect((await call(viewer.client, 'set_frame_html', WRITES[0]![1])).text).toMatch(/only view/)
      expect((await call(commenter.client, 'set_frame_html', WRITES[0]![1])).text).toMatch(/view and comment on/)
    } finally {
      await viewer.close()
      await commenter.close()
    }
  })

  it('lets an editor key write', async () => {
    const updated = vi.spyOn(actions, 'updateFrame').mockReturnValue(FRAME)
    const { client, close } = await as('editor')
    try {
      const { isError } = await call(client, 'set_frame_html', WRITES[0]![1])
      expect(isError).toBeFalsy()
      expect(updated).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('lets every role read', async () => {
    for (const userId of ['viewer', 'commenter', 'editor', 'owner']) {
      const { client, close } = await as(userId)
      try {
        for (const [tool, args] of [
          ['get_canvas', { canvas_id: CANVAS.id }],
          ['get_frame', { frame_id: FRAME.id, agent_name: 'Claude' }],
          ['get_comments', { canvas_id: CANVAS.id }],
        ] as const) {
          const { text, isError } = await call(client, tool, args)
          expect(isError, `${userId} ${tool}: ${text}`).toBeFalsy()
        }
      } finally {
        await close()
      }
    }
  })

  it('gives a stranger the same answer as a missing canvas', async () => {
    const { client, close } = await as('stranger')
    try {
      const { text, isError } = await call(client, 'get_canvas', { canvas_id: CANVAS.id })
      expect(isError).toBe(true)
      expect(text).toMatch(/no canvas with id c1 accessible/)
    } finally {
      await close()
    }
  })

  it('lets a view-only key read comments but not reply or resolve', async () => {
    const { client, close } = await as('viewer')
    try {
      for (const [tool, args] of [
        ['reply_to_comment', { ...base, comment_id: ROOT.id, text: 'hello' }],
        ['resolve_comment', { ...base, comment_id: ROOT.id }],
      ] as const) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, tool).toBe(true)
        expect(text).toMatch(/needs comment access/)
      }
    } finally {
      await close()
    }
  })

  it('lets a comment-only key reply and resolve, keeping an @agent mention as plain text', async () => {
    const meter = vi.spyOn(allowance, 'consumeResidentTask')
    const { client, close } = await as('commenter')
    try {
      const { text, isError } = await call(client, 'reply_to_comment', {
        ...base,
        comment_id: ROOT.id,
        text: '@Doop please redo this',
      })
      expect(isError).toBeFalsy()
      expect(text).toContain('Only editors can ask agents to make changes.')
      expect(meter).not.toHaveBeenCalled()
      const stored = actions.getComments(CANVAS.id).find((c) => c.parentId === ROOT.id)
      expect(stored?.text).toBe('@Doop please redo this')
      expect(stored?.forAgent).toBeUndefined()

      const resolved = await call(client, 'resolve_comment', { ...base, comment_id: ROOT.id })
      expect(resolved.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('queues the agent for an editor key that @mentions one', async () => {
    vi.spyOn(allowance, 'consumeResidentTask').mockResolvedValue({
      ok: true,
      used: 1,
      limit: 5,
      connected: false,
      byoModel: false,
      onOwnAccount: false,
    } as Awaited<ReturnType<typeof allowance.consumeResidentTask>>)
    const { client, close } = await as('editor')
    try {
      const { text, isError } = await call(client, 'reply_to_comment', {
        ...base,
        comment_id: ROOT.id,
        text: '@Doop please redo this',
      })
      expect(isError, text).toBeFalsy()
      expect(actions.getComments(CANVAS.id).find((c) => c.parentId === ROOT.id)?.forAgent).toBe(true)
    } finally {
      await close()
    }
  })
})
