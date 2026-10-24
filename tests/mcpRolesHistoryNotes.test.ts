import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, CanvasNote, ElementComment, Frame, FrameVersion } from '../shared/types.ts'

/* The tools the history, sticky-note, comment-anchor and slide features added, held to the same role rules as the rest:
   reads need view (version history needs edit, since an old version can hold what editors removed), commenting needs
   comment, anything that changes the design needs edit, and an account with no access at all gets the answer a
   missing canvas gets. */
const persistMock = vi.hoisted(() => ({
  listFrameVersions: vi.fn(async () => [] as unknown[]),
  getFrameVersion: vi.fn(async () => undefined as unknown),
}))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  listFrameVersions: persistMock.listFrameVersions,
  getFrameVersion: persistMock.getFrameVersion,
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const NOTE: CanvasNote = {
  id: 'n1',
  canvasId: 'c1',
  markdown: 'remember this',
  color: 'yellow',
  x: 0,
  y: 0,
  width: 240,
  height: 160,
  createdBy: 'alice',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const CANVAS: Canvas = {
  id: 'c1',
  name: 'Roles',
  ownerId: 'owner',
  memberIds: ['viewer', 'commenter', 'editor'],
  memberRoles: { viewer: 'view', commenter: 'comment' },
  createdAt: 0,
  updatedAt: 0,
  frames: [],
  notes: [NOTE],
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
const SLIDE: Frame = {
  ...FRAME,
  id: 's1',
  name: 'Opening',
  slide: true,
  speakerNotes: 'Say hello, then pause.',
  width: 1280,
  height: 720,
}
const VERSION: FrameVersion = {
  id: 'v1',
  frameId: FRAME.id,
  canvasId: CANVAS.id,
  savedAt: 1,
  savedBy: 'alice',
  reason: 'human',
  name: 'Hero',
  width: 640,
  height: 480,
  htmlBytes: 12,
  html: '<h1>Old</h1>',
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

const base = { agent_name: 'Claude' }

/* each tool that changes the design, with arguments that would succeed for an editor */
const EDITOR_ONLY: [string, Record<string, unknown>][] = [
  ['restore_frame_version', { ...base, frame_id: FRAME.id, version_id: VERSION.id }],
  ['create_note', { ...base, canvas_id: CANVAS.id, text: 'hello' }],
  ['update_note', { ...base, note_id: NOTE.id, text: 'changed' }],
  ['delete_note', { ...base, note_id: NOTE.id }],
  ['set_canvas_pages', { ...base, canvas_id: CANVAS.id, pages: [{ id: 'p1', name: 'One' }], expectedPages: [] }],
]

/* the slide flag and speaker notes are design: they change what the deck plays and says */
const SLIDE_EDITS: [string, Record<string, unknown>][] = [
  ['update_frame', { ...base, frame_id: FRAME.id, slide: true }],
  ['update_frame', { ...base, frame_id: SLIDE.id, slide: false }],
  ['update_frame', { ...base, frame_id: SLIDE.id, speaker_notes: 'rewritten' }],
  ['update_frame', { ...base, frame_id: SLIDE.id, speaker_notes: '' }],
  ['create_frame', { ...base, canvas_id: CANVAS.id, name: 'New', html: '<p>hi</p>', slide: true }],
  ['create_frame', { ...base, canvas_id: CANVAS.id, name: 'New', html: '<p>hi</p>', speaker_notes: 'sneaky' }],
]

beforeEach(() => {
  vi.restoreAllMocks()
  persistMock.listFrameVersions.mockResolvedValue([{ ...VERSION, html: undefined }])
  persistMock.getFrameVersion.mockResolvedValue(VERSION)
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) =>
    id === FRAME.id ? FRAME : id === SLIDE.id ? SLIDE : undefined,
  )
  vi.spyOn(store, 'findNote').mockImplementation((id: string) =>
    id === NOTE.id ? { note: NOTE, canvasId: CANVAS.id } : undefined,
  )
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, [] as ElementComment[]]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  } as unknown as Parameters<typeof actions.hydrateLogs>[0])
})

describe('history, notes and pages over MCP', () => {
  it.each(['viewer', 'commenter'])('refuses every design change to a %s-role key owner', async (userId) => {
    const restored = vi.spyOn(actions, 'restoreFrameVersion')
    const created = vi.spyOn(actions, 'createNote')
    const updated = vi.spyOn(actions, 'updateNote')
    const deleted = vi.spyOn(actions, 'deleteNote')
    const pages = vi.spyOn(actions, 'setCanvasPages')
    const { client, close } = await as(userId)
    try {
      for (const [tool, args] of EDITOR_ONLY) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, `${tool} should be refused: ${text}`).toBe(true)
        expect(text, tool).toMatch(/needs edit access/)
      }
      for (const spy of [restored, created, updated, deleted, pages]) expect(spy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('lets an editor key restore a version and manage notes', async () => {
    const restored = vi.spyOn(actions, 'restoreFrameVersion').mockResolvedValue({
      frame: FRAME,
      replaced: { html: FRAME.html, width: FRAME.width, height: FRAME.height },
    })
    const created = vi.spyOn(actions, 'createNote').mockReturnValue({ ok: true, note: NOTE })
    const updated = vi.spyOn(actions, 'updateNote').mockReturnValue({ ok: true, note: NOTE })
    const deleted = vi.spyOn(actions, 'deleteNote').mockReturnValue({ ok: true, note: NOTE })
    const { client, close } = await as('editor')
    try {
      for (const [tool, args] of EDITOR_ONLY.slice(0, 4)) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, `${tool}: ${text}`).toBeFalsy()
      }
      for (const spy of [restored, created, updated, deleted]) expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('lets only editors and the owner list frame versions', async () => {
    for (const userId of ['editor', 'owner']) {
      const { client, close } = await as(userId)
      try {
        const { text, isError } = await call(client, 'list_frame_versions', { ...base, frame_id: FRAME.id })
        expect(isError, `${userId}: ${text}`).toBeFalsy()
        expect(text).toContain(VERSION.id)
      } finally {
        await close()
      }
    }
  })

  it.each(['viewer', 'commenter'])(
    'refuses list_frame_versions to a %s-role key without reading history',
    async (userId) => {
      persistMock.listFrameVersions.mockClear()
      const { client, close } = await as(userId)
      try {
        const { text, isError } = await call(client, 'list_frame_versions', { ...base, frame_id: FRAME.id })
        expect(isError).toBe(true)
        expect(text).toMatch(/needs edit access/)
        expect(text).not.toContain(VERSION.id)
        expect(persistMock.listFrameVersions).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    },
  )

  it('shows the notes in get_canvas to a view-only key', async () => {
    const { client, close } = await as('viewer')
    try {
      const { text, isError } = await call(client, 'get_canvas', { canvas_id: CANVAS.id })
      expect(isError).toBeFalsy()
      expect(text).toContain('remember this')
    } finally {
      await close()
    }
  })

  it('gives a stranger the same answer as a missing canvas on every history and note tool', async () => {
    const { client, close } = await as('stranger')
    try {
      const cases: [string, Record<string, unknown>, RegExp][] = [
        ['list_frame_versions', { ...base, frame_id: FRAME.id }, /no frame with id f1 accessible/],
        ['restore_frame_version', EDITOR_ONLY[0]![1], /no frame with id f1 accessible/],
        ['create_note', EDITOR_ONLY[1]![1], /no canvas with id c1 accessible/],
        ['update_note', EDITOR_ONLY[2]![1], /no note with id n1 accessible/],
        ['delete_note', EDITOR_ONLY[3]![1], /no note with id n1 accessible/],
        ['add_comment', { ...base, canvas_id: CANVAS.id, frame_id: FRAME.id, selector: 'h1', text: 'hi' }, /no canvas/],
      ]
      for (const [tool, args, expected] of cases) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, tool).toBe(true)
        expect(text, tool).toMatch(expected)
      }
    } finally {
      await close()
    }
  })
})

describe('slides over MCP', () => {
  it.each(['viewer', 'commenter'])('refuses the slide flag and speaker notes to a %s-role key', async (userId) => {
    const updated = vi.spyOn(actions, 'updateFrame')
    const created = vi.spyOn(actions, 'createFrame')
    const { client, close } = await as(userId)
    try {
      for (const [tool, args] of SLIDE_EDITS) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, `${tool} ${JSON.stringify(args)} should be refused: ${text}`).toBe(true)
        expect(text).toMatch(/needs edit access/)
      }
      expect(updated).not.toHaveBeenCalled()
      expect(created).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('lets an editor key set the slide flag and speaker notes', async () => {
    const updated = vi.spyOn(actions, 'updateFrame').mockReturnValue(SLIDE)
    const created = vi.spyOn(actions, 'createFrame').mockReturnValue(SLIDE)
    const { client, close } = await as('editor')
    try {
      for (const [tool, args] of SLIDE_EDITS) {
        const { text, isError } = await call(client, tool, args)
        expect(isError, `${tool}: ${text}`).toBeFalsy()
      }
      expect(updated).toHaveBeenCalledWith(SLIDE.id, { speakerNotes: 'rewritten' }, expect.anything())
      expect(updated).toHaveBeenCalledWith(SLIDE.id, { speakerNotes: '' }, expect.anything())
      expect(created).toHaveBeenCalledWith(
        CANVAS.id,
        expect.objectContaining({ speakerNotes: 'sneaky' }),
        expect.anything(),
      )
    } finally {
      await close()
    }
  })

  it.each(['viewer', 'commenter', 'editor', 'owner'])(
    'shows the speaker notes in get_frame to a %s-role key',
    async (userId) => {
      const { client, close } = await as(userId)
      try {
        const { text, isError } = await call(client, 'get_frame', { ...base, frame_id: SLIDE.id })
        expect(isError, text).toBeFalsy()
        expect(text).toContain('Say hello, then pause.')
        expect(text).toMatch(/"slide":\s*true/)
      } finally {
        await close()
      }
    },
  )

  it('answers a stranger about a slide like a missing frame, notes included', async () => {
    const { client, close } = await as('stranger')
    try {
      const { text, isError } = await call(client, 'get_frame', { ...base, frame_id: SLIDE.id })
      expect(isError).toBe(true)
      expect(text).toMatch(/no frame with id s1 accessible/)
      expect(text).not.toContain('Say hello')
    } finally {
      await close()
    }
  })
})

describe('add_comment over MCP', () => {
  const args = { ...base, canvas_id: CANVAS.id, frame_id: FRAME.id, selector: 'h1', text: 'looks good' }

  it('is refused for a view-only key', async () => {
    const added = vi.spyOn(actions, 'addElementComment')
    const { client, close } = await as('viewer')
    try {
      const { text, isError } = await call(client, 'add_comment', args)
      expect(isError).toBe(true)
      expect(text).toMatch(/needs comment access/)
      expect(added).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('is allowed for a comment key, which cannot summon an agent with an @mention', async () => {
    const { client, close } = await as('commenter')
    try {
      const plain = await call(client, 'add_comment', args)
      expect(plain.isError, plain.text).toBeFalsy()
      const mention = await call(client, 'add_comment', { ...args, text: '@Doop redo this' })
      expect(mention.isError, mention.text).toBeFalsy()
      expect(mention.text).toContain('Only editors can ask agents to make changes.')
      const stored = actions.getComments(CANVAS.id)
      expect(stored).toHaveLength(2)
      expect(stored.every((c) => c.forAgent === undefined)).toBe(true)
    } finally {
      await close()
    }
  })

  it('is allowed for an editor key', async () => {
    const { client, close } = await as('editor')
    try {
      const { text, isError } = await call(client, 'add_comment', args)
      expect(isError, text).toBeFalsy()
    } finally {
      await close()
    }
  })
})
