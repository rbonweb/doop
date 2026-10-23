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
  saveCanvas: () => {},
  saveFrame: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')

/* The slide flag and speaker notes through the agent's tools: what create_frame stores, and what get_frame, get_canvas and update_frame say about it. */

interface FrameJson {
  id: string
  width: number
  height: number
  slide?: boolean
  speaker_notes?: string
}

let canvasId: string
let client: Client
let server: ReturnType<typeof buildMcpServer>

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown>; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: { agent_name: 'Deck Agent', ...args } })) as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* an error string, or a result with a trailing nudge: the first JSON object still leads */
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1))
  }
  return { parsed, isError: result.isError }
}

const frameOf = (parsed: Record<string, unknown>) => parsed.frame as FrameJson

beforeEach(async () => {
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
  canvasId = store.createCanvas('Deck', 'owner-1').id
  server = buildMcpServer('Test Owner', 'owner-1')
  client = new Client({ name: 'doop-slides-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
})

afterEach(async () => {
  await client.close()
  await server.close()
  vi.restoreAllMocks()
})

describe('slides over MCP', () => {
  it('offers slide and speaker_notes on create_frame and update_frame', async () => {
    const { tools } = await client.listTools()
    for (const name of ['create_frame', 'update_frame']) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown> }
      expect(schema.properties).toHaveProperty('slide')
      expect(schema.properties).toHaveProperty('speaker_notes')
    }
  })

  it('creates a slide at 1280×720 when no size is given, and keeps notes', async () => {
    const { parsed } = await call('create_frame', {
      canvas_id: canvasId,
      name: 'Opening',
      html: '',
      slide: true,
      speaker_notes: 'Start with the *customer*.',
    })
    const created = frameOf(parsed)
    expect(created).toMatchObject({ width: 1280, height: 720, slide: true })
    expect(store.getFrame(created.id)).toMatchObject({ slide: true, speakerNotes: 'Start with the *customer*.' })

    const got = (await call('get_frame', { frame_id: created.id })).parsed as unknown as FrameJson
    expect(got).toMatchObject({ slide: true, speaker_notes: 'Start with the *customer*.', width: 1280, height: 720 })
  })

  it('honours a size given for a slide and leaves ordinary frames at 640×480 without a flag', async () => {
    const slide = frameOf(
      (
        await call('create_frame', {
          canvas_id: canvasId,
          name: 'Wide',
          html: '',
          slide: true,
          width: 1920,
          height: 1080,
        })
      ).parsed,
    )
    expect(slide).toMatchObject({ width: 1920, height: 1080, slide: true })
    const plain = frameOf((await call('create_frame', { canvas_id: canvasId, name: 'Card', html: '' })).parsed)
    expect(plain).toMatchObject({ width: 640, height: 480 })
    expect(plain.slide).toBeUndefined()
    const got = (await call('get_frame', { frame_id: plain.id })).parsed as unknown as FrameJson
    expect(got.slide).toBeUndefined()
    expect(got.speaker_notes).toBeUndefined()
  })

  it('flips the flag and rewrites or clears the notes through update_frame', async () => {
    const created = frameOf((await call('create_frame', { canvas_id: canvasId, name: 'Plain', html: '' })).parsed)

    const flagged = frameOf(
      (await call('update_frame', { frame_id: created.id, slide: true, speaker_notes: 'Say hello' })).parsed,
    )
    expect(flagged.slide).toBe(true)
    expect(store.getFrame(created.id)?.speakerNotes).toBe('Say hello')

    await call('update_frame', { frame_id: created.id, speaker_notes: 'Say hello, then pause' })
    expect(store.getFrame(created.id)?.speakerNotes).toBe('Say hello, then pause')
    expect(store.getFrame(created.id)?.slide).toBe(true)

    await call('update_frame', { frame_id: created.id, speaker_notes: '' })
    expect(store.getFrame(created.id)?.speakerNotes).toBeUndefined()

    const unflagged = frameOf((await call('update_frame', { frame_id: created.id, slide: false })).parsed)
    expect(unflagged.slide).toBeUndefined()
    expect(store.getFrame(created.id)?.slide).toBeUndefined()
  })

  it('lists which frames are slides in get_canvas, without sending their notes', async () => {
    const slide = frameOf(
      (
        await call('create_frame', {
          canvas_id: canvasId,
          name: 'S',
          html: '',
          slide: true,
          speaker_notes: 'private words',
        })
      ).parsed,
    )
    await call('create_frame', { canvas_id: canvasId, name: 'Other', html: '' })
    const result = (await client.callTool({
      name: 'get_canvas',
      arguments: { canvas_id: canvasId, agent_name: 'Deck Agent' },
    })) as {
      content: Array<{ type: string; text?: string }>
    }
    const text = result.content.map((b) => b.text ?? '').join('\n')
    const canvas = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { frames: FrameJson[] }
    expect(canvas.frames.find((f) => f.id === slide.id)?.slide).toBe(true)
    expect(canvas.frames.filter((f) => f.slide)).toHaveLength(1)
    expect(text).not.toContain('private words')
  })
})
