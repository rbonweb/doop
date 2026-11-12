import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeNoteDeletion, noteDeletion, rememberDeletedNote } from '../server/recentDeletions.ts'

/* Persistence is out of scope here: every write-through is a no-op. */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  const writes = [
    'saveCanvas',
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

const DAY = 24 * 60 * 60 * 1000
const OWNER = 'owner-1'
const human = actions.resolveActor({ name: 'Ada', kind: 'user', userId: OWNER })

describe('recent deletions', () => {
  it('remembers a deletion and forgets it after 24 h', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    rememberDeletedNote('remember-1', { cause: 'note', canvasId: 'c1', by: 'Ada', at: now })
    expect(noteDeletion('remember-1')).toMatchObject({ cause: 'note', canvasId: 'c1', by: 'Ada' })
    vi.spyOn(Date, 'now').mockReturnValue(now + DAY)
    expect(noteDeletion('remember-1')).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('drops the oldest entry when a 5,001st arrives', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    for (let i = 0; i < 5_001; i++)
      rememberDeletedNote(`cap-${i}`, { cause: 'note', canvasId: 'c1', by: 'Ada', at: now })
    expect(noteDeletion('cap-0')).toBeUndefined()
    expect(noteDeletion('cap-5000')).toBeDefined()
    vi.restoreAllMocks()
  })

  it('says which frame took the note, or that it was already gone', () => {
    const at = Date.UTC(2026, 10, 12, 9, 30)
    expect(
      describeNoteDeletion('n1', {
        cause: 'frame',
        canvasId: 'c1',
        frameId: 'f1',
        frameName: 'Hero',
        by: 'Ada',
        at,
      }),
    ).toBe('note n1 was deleted with its frame “Hero” (f1) by Ada at 2026-11-12T09:30:00.000Z')
    expect(describeNoteDeletion('n1', { cause: 'note', canvasId: 'c1', by: 'Ada', at })).toBe(
      'note n1 was already deleted by Ada at 2026-11-12T09:30:00.000Z',
    )
  })
})

let canvasId: string

beforeEach(() => {
  for (const c of store.allCanvases()) store.deleteCanvas(c.id)
  canvasId = store.createCanvas('Tombstones', OWNER).id
})

describe('deleting notes records why', () => {
  it('records the frame a note went with', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, human)!
    const note = actions.createNote(canvasId, { markdown: 'gone with it', frameId: frame.id }, human)
    expect(note.ok).toBe(true)
    if (!note.ok) return
    expect(actions.deleteFrame(frame.id, human)).toBeDefined()
    expect(noteDeletion(note.note.id)).toMatchObject({
      cause: 'frame',
      canvasId,
      frameId: frame.id,
      frameName: 'Hero',
      by: 'Ada',
    })
  })

  it('records a note deleted on its own', () => {
    const note = actions.createNote(canvasId, { markdown: 'plain' }, human)
    expect(note.ok).toBe(true)
    if (!note.ok) return
    expect(actions.deleteNote(note.note.id, human).ok).toBe(true)
    expect(noteDeletion(note.note.id)).toMatchObject({ cause: 'note', canvasId, by: 'Ada' })
  })
})

async function as(userId: string) {
  const server = buildMcpServer('Someone', userId)
  const client = new Client({ name: 'tombstones-test', version: '1.0.0' })
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

describe('delete_note over MCP', () => {
  it('names the frame a note was deleted with, then says it is already deleted', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, human)!
    const created = actions.createNote(canvasId, { markdown: 'and gone', frameId: frame.id }, human)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const noteId = created.note.id
    actions.deleteFrame(frame.id, human)

    const { client, close } = await as(OWNER)
    try {
      const first = await call(client, 'delete_note', { note_id: noteId, agent_name: 'Claude' })
      expect(first.isError).toBe(true)
      expect(first.text).toContain('was deleted with its frame “Hero”')
      expect(first.text).toContain(frame.id)

      const second = await call(client, 'delete_note', { note_id: noteId, agent_name: 'Claude' })
      expect(second.isError).toBe(true)
      expect(second.text).toContain('was deleted with its frame “Hero”')

      const loose = actions.createNote(canvasId, { markdown: 'on its own' }, human)
      expect(loose.ok).toBe(true)
      if (!loose.ok) return
      actions.deleteNote(loose.note.id, human)
      const already = await call(client, 'delete_note', { note_id: loose.note.id, agent_name: 'Claude' })
      expect(already.isError).toBe(true)
      expect(already.text).toContain('was already deleted')

      const updated = await call(client, 'update_note', { note_id: noteId, text: 'x', agent_name: 'Claude' })
      expect(updated.isError).toBe(true)
      expect(updated.text).toContain('was deleted with its frame “Hero”')
    } finally {
      await close()
    }
  })

  it('tells an account without access nothing about the deletion', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Secret' }, human)!
    const created = actions.createNote(canvasId, { markdown: 'private', frameId: frame.id }, human)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const noteId = created.note.id
    actions.deleteFrame(frame.id, human)

    const { client, close } = await as('stranger')
    try {
      const { text, isError } = await call(client, 'delete_note', { note_id: noteId, agent_name: 'Claude' })
      expect(isError).toBe(true)
      expect(text).toContain(`no note with id ${noteId} accessible to this account`)
      expect(text).not.toContain('Secret')
    } finally {
      await close()
    }
  })
})
