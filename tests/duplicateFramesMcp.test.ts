import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveMember: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Parameters<
  typeof actions.createFrame
>[2]

const open: { client: Client; server: ReturnType<typeof buildMcpServer> }[] = []

async function as(userId: string) {
  const server = buildMcpServer('Someone', userId)
  const client = new Client({ name: 'duplicate-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  open.push({ client, server })
  return client
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: 'duplicate_frames', arguments: { agent_name: 'Dup', ...args } })) as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {}
  return { raw, parsed, isError: !!result.isError }
}

let canvasId: string
let frameIds: string[]

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  const canvas = store.createCanvas('Dup', 'owner-1')
  store.addMember(canvas.id, 'viewer-1', 'owner-1', 'view')
  canvasId = canvas.id
  frameIds = ['A', 'B'].map((name) => actions.createFrame(canvasId, { name, html: `<p>${name}</p>` }, actor)!.id)
})

afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close()
    await server.close()
  }
  vi.restoreAllMocks()
})

describe('duplicate_frames over MCP', () => {
  it('copies three items in one call', async () => {
    const client = await as('owner-1')
    const { parsed, isError } = await call(client, {
      canvas_id: canvasId,
      items: [
        { frame_id: frameIds[0] },
        { frame_id: frameIds[1], name: 'B2' },
        { frame_id: frameIds[0], x: 5000, y: 0 },
      ],
    })
    expect(isError).toBe(false)
    expect(parsed.frames).toHaveLength(3)
    expect(parsed.frames[1]).toMatchObject({ name: 'B2', source_id: frameIds[1] })
    expect(parsed.frames[2]).toMatchObject({ x: 5000, y: 0 })
    const canvas = store.getCanvas(canvasId)!
    expect(canvas.frames).toHaveLength(5)
    expect(canvas.frames.find((f) => f.id === parsed.frames[0].id)!.html).toBe('<p>A</p>')
  })

  it('refuses a view-only account', async () => {
    const client = await as('viewer-1')
    const { isError } = await call(client, { canvas_id: canvasId, items: [{ frame_id: frameIds[0] }] })
    expect(isError).toBe(true)
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(2)
  })

  it('refuses a frame of another canvas and writes nothing', async () => {
    const other = store.createCanvas('Other', 'owner-1')
    const foreign = actions.createFrame(other.id, { name: 'F', html: '<p>f</p>' }, actor)!
    const client = await as('owner-1')
    const { raw, isError } = await call(client, {
      canvas_id: canvasId,
      items: [{ frame_id: frameIds[0] }, { frame_id: foreign.id }],
    })
    expect(isError).toBe(true)
    expect(raw).toContain('items[1]')
    expect(raw).toContain('stays on one canvas')
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(2)
  })

  it('refuses 51 items at the schema', async () => {
    const client = await as('owner-1')
    const { isError } = await call(client, {
      canvas_id: canvasId,
      items: Array.from({ length: 51 }, () => ({ frame_id: frameIds[0] })),
    })
    expect(isError).toBe(true)
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(2)
  })
})
