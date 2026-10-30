import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* saving writes through to the database, which these in-memory tests do not open */
vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/db/persist.ts')>()),
  ...Object.fromEntries(
    ['saveCanvas', 'saveFrame', 'saveFrameMove', 'saveNote', 'saveActivity', 'saveComment'].map((name) => [
      name,
      () => undefined,
    ]),
  ),
}))

const OWNER = 'test-owner-id'

function frame(id: string, pageId: string | undefined, x: number): Frame {
  return {
    id,
    canvasId: 'gaps',
    ...(pageId ? { pageId } : {}),
    name: `Frame ${id}`,
    html: `<p>${id}</p>`,
    x,
    y: 0,
    width: 400,
    height: 300,
    updatedAt: 1,
    updatedBy: 'Test',
  } as Frame
}

function seed(): Canvas {
  const canvas = {
    id: 'gaps',
    ownerId: OWNER,
    name: 'Gaps',
    pages: [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ],
    frames: [frame('f1', undefined, 0), frame('f2', 'p2', 0)],
    notes: [
      {
        id: 'n1',
        frameId: 'f1',
        x: -264,
        y: 0,
        width: 240,
        height: 180,
        color: 'yellow',
        markdown: 'Why this frame exists',
        createdBy: 'Test',
        updatedAt: 1,
      },
      {
        id: 'n2',
        pageId: 'p2',
        x: 900,
        y: 0,
        width: 240,
        height: 180,
        color: 'blue',
        markdown: 'Free note',
        createdBy: 'Test',
        updatedAt: 1,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  } as Canvas
  store.canvases.set(canvas.id, canvas)
  /* get_frame resolves a frame through the store's private frame index */
  const index = (store as unknown as { frameIndex: Map<string, string> }).frameIndex
  for (const f of canvas.frames) index.set(f.id, canvas.id)
  return canvas
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER)
  const client = new Client({ name: 'gaps-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return { client, close: async () => (await client.close(), await server.close()) }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[]
  return JSON.parse(content[0]!.text) as Record<string, unknown>
}

afterEach(() => {
  store.canvases.delete('gaps')
})

describe('get_canvas', () => {
  it('carries pages, notes and every frame page in structuredContent as well as the text', async () => {
    seed()
    const { client, close } = await connect()
    try {
      const result = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'gaps' } })
      const structured = result.structuredContent as Record<string, unknown>
      for (const data of [payload(result), structured]) {
        expect(data.pages).toEqual([
          { id: 'p1', name: 'One' },
          { id: 'p2', name: 'Two' },
        ])
        expect(data.frames).toEqual([
          expect.objectContaining({ id: 'f1', pageId: 'p1' }),
          expect.objectContaining({ id: 'f2', pageId: 'p2' }),
        ])
        expect(data.notes).toEqual([
          expect.objectContaining({ id: 'n1', frame_id: 'f1', page_id: 'p1', x: -264, width: 240 }),
          expect.objectContaining({ id: 'n2', page_id: 'p2', text: 'Free note' }),
        ])
      }
      /* the preview card still finds its canvas and frame links */
      expect(structured.canvas).toEqual(expect.objectContaining({ id: 'gaps', name: 'Gaps' }))
      expect(structured.frames).toEqual([
        expect.objectContaining({ id: 'f1', url: expect.stringContaining('frame=f1') }),
        expect.objectContaining({ id: 'f2', url: expect.stringContaining('frame=f2') }),
      ])
    } finally {
      await close()
    }
  })

  it('lists one page when page_id is given and names the pages when it is unknown', async () => {
    seed()
    const { client, close } = await connect()
    try {
      const one = payload(
        await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'gaps', page_id: 'p2' } }),
      )
      expect((one.frames as { id: string }[]).map((f) => f.id)).toEqual(['f2'])
      expect((one.notes as { id: string }[]).map((n) => n.id)).toEqual(['n2'])
      const bad = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'gaps', page_id: 'nope' } })
      expect(bad.isError).toBe(true)
      expect(JSON.stringify(bad)).toContain('p2')
    } finally {
      await close()
    }
  })
})

describe('get_frame', () => {
  it('leaves the HTML out when include_html is false', async () => {
    seed()
    const { client, close } = await connect()
    try {
      const full = payload(await client.callTool({ name: 'get_frame', arguments: { frame_id: 'f1' } }))
      expect(full).toEqual(expect.objectContaining({ canvasId: 'gaps', pageId: 'p1', html: '<p>f1</p>' }))
      const lean = payload(
        await client.callTool({ name: 'get_frame', arguments: { frame_id: 'f1', include_html: false } }),
      )
      expect(lean).not.toHaveProperty('html')
      expect(lean).toEqual(expect.objectContaining({ id: 'f1', pageId: 'p1', htmlBytes: 9 }))
    } finally {
      await close()
    }
  })
})

describe('list_notes', () => {
  it('returns full markdown, filtered by page or frame', async () => {
    seed()
    const { client, close } = await connect()
    try {
      const all = payload(await client.callTool({ name: 'list_notes', arguments: { canvas_id: 'gaps' } }))
      expect(all.notes).toEqual([
        expect.objectContaining({ id: 'n1', page_id: 'p1', frame_id: 'f1', markdown: 'Why this frame exists' }),
        expect.objectContaining({ id: 'n2', page_id: 'p2', markdown: 'Free note' }),
      ])
      const byFrame = payload(
        await client.callTool({ name: 'list_notes', arguments: { canvas_id: 'gaps', frame_id: 'f1' } }),
      )
      expect((byFrame.notes as { id: string }[]).map((n) => n.id)).toEqual(['n1'])
      const byPage = payload(
        await client.callTool({ name: 'list_notes', arguments: { canvas_id: 'gaps', page_id: 'p2' } }),
      )
      expect((byPage.notes as { id: string }[]).map((n) => n.id)).toEqual(['n2'])
    } finally {
      await close()
    }
  })
})

describe('add_canvas_page', () => {
  it('adds pages from many parallel calls without losing any', async () => {
    const canvas = seed()
    const { client, close } = await connect()
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          client.callTool({
            name: 'add_canvas_page',
            arguments: { canvas_id: 'gaps', name: `Preset ${i + 1}`, agent_name: `Agent ${i}` },
          }),
        ),
      )
      expect(results.every((r) => !r.isError)).toBe(true)
      expect(canvas.pages).toHaveLength(32)
      expect(new Set(canvas.pages!.map((p) => p.id)).size).toBe(32)
    } finally {
      await close()
    }
  })

  it('nests a page under its parent and refuses an unknown parent', async () => {
    const canvas = seed()
    const { client, close } = await connect()
    try {
      const added = payload(
        await client.callTool({
          name: 'add_canvas_page',
          arguments: { canvas_id: 'gaps', name: 'Child', parent_id: 'p1', agent_name: 'Agent' },
        }),
      )
      const page = added.page as { id: string; parent_id: string }
      expect(page.parent_id).toBe('p1')
      /* a subpage sits under its parent, before the next top-level page */
      expect(canvas.pages!.map((p) => p.id)).toEqual(['p1', page.id, 'p2'])
      const bad = await client.callTool({
        name: 'add_canvas_page',
        arguments: { canvas_id: 'gaps', name: 'Orphan', parent_id: 'nope', agent_name: 'Agent' },
      })
      expect(bad.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('move_frame', () => {
  it('moves a frame and its attached note to another canvas the agent can edit', async () => {
    const source = seed()
    const target = {
      id: 'gaps-target',
      ownerId: OWNER,
      name: 'Target',
      pages: [{ id: 't1', name: 'Landing' }],
      frames: [],
      notes: [],
      createdAt: 0,
      updatedAt: 0,
    } as Canvas
    store.canvases.set(target.id, target)
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'move_frame',
        arguments: { frame_id: 'f1', canvas_id: 'gaps-target', x: 100, y: 50, agent_name: 'Agent' },
      })
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
      const moved = payload(result)
      expect(moved.frame).toEqual(expect.objectContaining({ id: 'f1', canvasId: 'gaps-target', pageId: 't1', x: 100 }))
      expect(moved.notes).toEqual([expect.objectContaining({ id: 'n1', frame_id: 'f1', page_id: 't1' })])
      expect(source.frames.map((f) => f.id)).toEqual(['f2'])
      expect(store.getFrame('f1')?.canvasId).toBe('gaps-target')
      const badPage = await client.callTool({
        name: 'move_frame',
        arguments: { frame_id: 'f2', canvas_id: 'gaps-target', page_id: 'nope', agent_name: 'Agent' },
      })
      expect(badPage.isError).toBe(true)
      expect(JSON.stringify(badPage)).toContain('t1')
    } finally {
      store.canvases.delete(target.id)
      await close()
    }
  })
})

describe('upload_asset replace_url', () => {
  it('refuses a replace_url that is not an uploaded asset', async () => {
    seed()
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'upload_asset',
        arguments: {
          canvas_id: 'gaps',
          data: Buffer.from('body { color: red }').toString('base64'),
          replace_url: 'https://example.com/theme.css',
          agent_name: 'Agent',
        },
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('not an uploaded asset URL')
    } finally {
      await close()
    }
  })
})
