import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'

/* Persistence is out of scope here: every write-through is a no-op. */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  const writes = [
    'saveCanvas',
    'saveCanvasCopy',
    'saveFrame',
    'saveNote',
    'saveActivity',
    'saveTask',
    'saveFeedback',
    'saveComment',
    'saveMember',
    'saveGuideline',
    'saveReference',
    'saveDecision',
    'saveProposal',
    'saveFrameVersion',
    'deleteCanvas',
    'deleteFrame',
    'deleteNote',
    'deleteMember',
    'deleteGuideline',
    'deleteReference',
  ]
  return Object.fromEntries(writes.map((name) => [name, noop]))
})

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { shiftAttachedNotes, attachedNotePlacement, noteExcerpt } = await import('../shared/notes.ts')

const OWNER = 'owner-1'
const human = actions.resolveActor({ name: 'Ada', kind: 'user', userId: OWNER })

let sent: ServerMessage[]
let canvasId: string
let frameId: string

beforeEach(() => {
  sent = []
  actions.wire(
    (_id, msg) => {
      sent.push(msg)
    },
    () => {},
  )
  for (const c of store.allCanvases()) store.deleteCanvas(c.id)
  canvasId = store.createCanvas('Notes', OWNER).id
  frameId = actions.createFrame(canvasId, { name: 'Hero', x: 600, y: 300, width: 400, height: 300 }, human)!.id
  sent = []
})

describe('note validation', () => {
  it('creates a free-floating note and tells the room', () => {
    const result = actions.createNote(canvasId, { markdown: '# Hi', x: 10, y: 20 }, human)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.note).toMatchObject({ markdown: '# Hi', x: 10, y: 20, color: 'yellow', createdBy: 'Ada' })
    expect(result.note.frameId).toBeUndefined()
    expect(sent).toContainEqual({ type: 'note:upsert', note: result.note, actor: human })
    expect(actions.getActivity(canvasId)[0]?.message).toBe('added a sticky note')
  })

  it('accepts every palette colour and refuses anything else', () => {
    for (const color of ['yellow', 'pink', 'blue', 'green', 'purple', 'gray']) {
      expect(actions.createNote(canvasId, { color }, human).ok).toBe(true)
    }
    for (const color of ['red', '#fde68a', 'Yellow', 3]) {
      const result = actions.createNote(canvasId, { color }, human)
      expect(result).toMatchObject({ ok: false, status: 400 })
    }
  })

  it('limits the markdown to 20000 characters', () => {
    expect(actions.createNote(canvasId, { markdown: 'a'.repeat(20_000) }, human).ok).toBe(true)
    expect(actions.createNote(canvasId, { markdown: 'a'.repeat(20_001) }, human)).toMatchObject({ ok: false })
    expect(actions.createNote(canvasId, { markdown: 42 }, human)).toMatchObject({ ok: false })
  })

  it('clamps sizes into 160-1200 by 80-2000 instead of refusing them', () => {
    const small = actions.createNote(canvasId, { width: 10, height: 10 }, human)
    const big = actions.createNote(canvasId, { width: 99_999, height: 99_999 }, human)
    expect(small.ok && [small.note.width, small.note.height]).toEqual([160, 80])
    expect(big.ok && [big.note.width, big.note.height]).toEqual([1200, 2000])
  })

  it('refuses non-numeric and non-finite positions', () => {
    expect(actions.createNote(canvasId, { x: '5' }, human)).toMatchObject({ ok: false })
    expect(actions.createNote(canvasId, { y: Number.NaN }, human)).toMatchObject({ ok: false })
    expect(actions.createNote(canvasId, { width: Infinity }, human)).toMatchObject({ ok: false })
  })

  it('refuses a frame or page that is not on the canvas', () => {
    expect(actions.createNote(canvasId, { frameId: 'nope' }, human)).toMatchObject({ ok: false, status: 400 })
    expect(actions.createNote(canvasId, { pageId: 'nope' }, human)).toMatchObject({ ok: false, status: 400 })
    const other = store.createCanvas('Other', OWNER).id
    const foreign = actions.createFrame(other, { name: 'Elsewhere' }, human)!
    expect(actions.createNote(canvasId, { frameId: foreign.id }, human)).toMatchObject({ ok: false })
    expect(actions.createNote('missing', {}, human)).toMatchObject({ ok: false, status: 404 })
  })

  it('updates only the editable fields, validated the same way', () => {
    const { note } = actions.createNote(canvasId, { markdown: 'one' }, human) as { note: { id: string } }
    sent = []
    const edited = actions.updateNote(note.id, { markdown: 'two', color: 'blue', width: 5 }, human)
    expect(edited.ok && edited.note).toMatchObject({ markdown: 'two', color: 'blue', width: 160 })
    expect(sent).toHaveLength(2) /* the upsert and the activity line */
    expect(actions.updateNote(note.id, { color: 'teal' }, human)).toMatchObject({ ok: false })
    expect(actions.updateNote('missing', { markdown: 'x' }, human)).toMatchObject({ ok: false, status: 404 })
  })

  it('deletes a note and broadcasts the removal', () => {
    const { note } = actions.createNote(canvasId, {}, human) as { note: { id: string } }
    sent = []
    expect(actions.deleteNote(note.id, human).ok).toBe(true)
    expect(store.getNotes(canvasId)).toHaveLength(0)
    expect(sent).toContainEqual({ type: 'note:delete', id: note.id, actor: human })
    expect(actions.deleteNote(note.id, human)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('attached notes', () => {
  it('lands beside the frame when no spot is given, on the frame page', () => {
    const result = actions.createNote(canvasId, { frameId, markdown: 'why' }, human)
    expect(result.ok && result.note).toMatchObject({ frameId, x: 600 - 240 - 24, y: 300 })
    expect(attachedNotePlacement({ x: 600, y: 300 }, 300)).toEqual({ x: 276, y: 300 })
  })

  it('moves with the frame through updateFrame, whoever moves it', () => {
    const { note } = actions.createNote(canvasId, { frameId }, human) as { note: { id: string } }
    const free = actions.createNote(canvasId, { x: 5, y: 5 }, human)
    sent = []
    actions.updateFrame(frameId, { x: 700, y: 250 }, human)
    expect(store.getNotes(canvasId).find((n) => n.id === note.id)).toMatchObject({ x: 436, y: 250 })
    expect(free.ok && store.getNotes(canvasId).find((n) => n.id === free.note.id)).toMatchObject({ x: 5, y: 5 })
    expect(sent.filter((m) => m.type === 'note:upsert')).toHaveLength(1)
    /* a resize alone leaves the notes where they are */
    sent = []
    actions.updateFrame(frameId, { width: 500 }, human)
    expect(sent.filter((m) => m.type === 'note:upsert')).toHaveLength(0)
  })

  it('goes with the frame when it is deleted', () => {
    actions.createNote(canvasId, { frameId }, human)
    actions.deleteFrame(frameId, human)
    expect(store.getNotes(canvasId)).toHaveLength(0)
  })
})

describe('shiftAttachedNotes', () => {
  const notes = [
    { id: 'a', frameId: 'f1', x: 10, y: 20 },
    { id: 'b', frameId: 'f2', x: 0, y: 0 },
    { id: 'c', x: 5, y: 5 },
  ]
  it('moves only the notes attached to that frame, by the same delta', () => {
    expect(shiftAttachedNotes(notes, 'f1', 15, -5)).toEqual([{ id: 'a', x: 25, y: 15 }])
  })
  it('does nothing for a zero delta', () => {
    expect(shiftAttachedNotes(notes, 'f1', 0, 0)).toEqual([])
  })
})

describe('noteExcerpt', () => {
  it('drops markdown markers and cuts long text', () => {
    expect(noteExcerpt('# Title\n\n- **bold** [link](goto:abc) `code`')).toBe('Title bold link code')
    expect(noteExcerpt('x'.repeat(50), 10)).toBe('xxxxxxxxx…')
  })
})

describe('MCP note tools', () => {
  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const server = buildMcpServer('Owner', OWNER)
    const client = new Client({ name: 'notes-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      return await run(client)
    } finally {
      await client.close()
      await server.close()
    }
  }
  const textOf = (result: unknown) =>
    (result as { content: { type: string; text: string }[] }).content.find((c) => c.type === 'text')!.text

  it('create_note attaches left of the frame by default', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: canvasId, text: 'Why this hero', frame_id: frameId, agent_name: 'Claude' },
      })
      expect(result.isError).toBeFalsy()
      const { note } = JSON.parse(textOf(result)) as { note: { id: string; x: number; y: number; frame_id: string } }
      /* frame at (600, 300): 240 wide default note plus the 24 px gap */
      expect(note).toMatchObject({ frame_id: frameId, x: 600 - 240 - 24, y: 300 })

      const wide = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: canvasId, text: 'wide', frame_id: frameId, agent_name: 'Claude', x: 1, y: 2 },
      })
      expect(JSON.parse(textOf(wide)).note).toMatchObject({ x: 1, y: 2 })
      const stored = store.getNotes(canvasId).find((n) => n.id === note.id)
      expect(stored?.createdBy).toBe('Claude')
    })
  })

  it('create_note honours explicit coordinates and refuses a bad frame', async () => {
    await withClient(async (client) => {
      const placed = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: canvasId, text: 'free', x: 12, y: 34, color: 'pink', agent_name: 'Claude' },
      })
      expect(JSON.parse(textOf(placed)).note).toMatchObject({ x: 12, y: 34, color: 'pink' })
      const bad = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: canvasId, text: 'x', frame_id: 'nope', agent_name: 'Claude' },
      })
      expect(bad.isError).toBe(true)
      const stranger = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: 'missing', text: 'x', agent_name: 'Claude' },
      })
      expect(stranger.isError).toBe(true)
    })
  })

  it('update_note and delete_note change and remove it, and get_canvas lists it', async () => {
    await withClient(async (client) => {
      const created = await client.callTool({
        name: 'create_note',
        arguments: { canvas_id: canvasId, text: 'draft', frame_id: frameId, agent_name: 'Claude' },
      })
      const id = (JSON.parse(textOf(created)) as { note: { id: string } }).note.id

      const updated = await client.callTool({
        name: 'update_note',
        arguments: { note_id: id, text: 'final **copy**', color: 'green', agent_name: 'Claude' },
      })
      expect(JSON.parse(textOf(updated)).note).toMatchObject({ text: 'final copy', color: 'green' })
      expect(
        (await client.callTool({ name: 'update_note', arguments: { note_id: id, agent_name: 'Claude' } })).isError,
      ).toBe(true)

      const canvas = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId } })
      const listed = JSON.parse(textOf(canvas)).notes as { id: string; frame_id: string; text: string }[]
      expect(listed).toEqual([expect.objectContaining({ id, frame_id: frameId, text: 'final copy' })])

      expect(
        (await client.callTool({ name: 'delete_note', arguments: { note_id: id, agent_name: 'Claude' } })).isError,
      ).toBeFalsy()
      expect(store.getNotes(canvasId)).toHaveLength(0)
      expect(
        (await client.callTool({ name: 'delete_note', arguments: { note_id: id, agent_name: 'Claude' } })).isError,
      ).toBe(true)
    })
  })
})
