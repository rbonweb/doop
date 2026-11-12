import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { limits } = vi.hoisted(() => {
  process.env.MCP_UPLOADS_PER_MIN = '2'
  return { limits: { uploads: 2 } }
})

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

const OWNER = 'batch-owner'
const CANVAS_ID = 'batch-canvas'

function seed(): Canvas {
  const frame = {
    id: 'bf1',
    canvasId: CANVAS_ID,
    name: 'Hero',
    html: '<p>hi</p>',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    updatedAt: 1,
    updatedBy: 'Test',
  } as Frame
  const canvas = {
    id: CANVAS_ID,
    ownerId: OWNER,
    name: 'Batch',
    memberIds: ['batch-viewer', 'rate-batch', 'rate-direct'],
    memberRoles: { 'batch-viewer': 'view' },
    frames: [frame],
    createdAt: 0,
    updatedAt: 0,
  } as Canvas
  store.canvases.set(canvas.id, canvas)
  ;(store as unknown as { frameIndex: Map<string, string> }).frameIndex.set(frame.id, canvas.id)
  return canvas
}

async function connect(userId: string, clientName?: string) {
  const server = buildMcpServer('Someone', userId, undefined, clientName ? async () => clientName : undefined)
  const client = new Client({ name: 'batch-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return { client, close: async () => (await client.close(), await server.close()) }
}

interface Summary {
  ok: boolean
  results: { index: number; tool: string; status: string; error?: string }[]
}

async function batch(client: Client, ops: { tool: string; args?: Record<string, unknown> }[], stop?: boolean) {
  const result = await client.callTool({
    name: 'run_batch',
    arguments: { ops, ...(stop === undefined ? {} : { stop_on_error: stop }) },
  })
  const content = result.content as { type: string; text?: string }[]
  const texts = content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  return { summary: JSON.parse(texts[0]!) as Summary, texts, isError: !!result.isError, result }
}

async function direct(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as { type: string; text?: string }[]
  return { text: content.map((b) => b.text ?? '').join('\n'), isError: !!result.isError }
}

const base = { canvas_id: CANVAS_ID, agent_name: 'Claude' }

beforeEach(() => {
  seed()
})
afterEach(() => {
  store.canvases.delete(CANVAS_ID)
})

describe('run_batch', () => {
  it('keeps the full JSON of a read for a client that gets one-line summaries when called alone', async () => {
    const { client, close } = await connect(OWNER, 'claude-code')
    try {
      const alone = await direct(client, 'get_canvas', base)
      expect(() => JSON.parse(alone.text.split('\n')[0] ?? '')).toThrow()
      const { summary, texts } = await batch(client, [{ tool: 'get_canvas', args: base }])
      expect(summary.ok).toBe(true)
      const payload = JSON.parse(texts[texts.indexOf('--- op 0 get_canvas ---') + 1] ?? '') as {
        id: string
        frames: unknown[]
      }
      expect(payload.id).toBe(CANVAS_ID)
      expect(payload.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('runs get_canvas, create_frame and update_frame in order', async () => {
    const { client, close } = await connect(OWNER)
    try {
      const { summary, texts, isError } = await batch(client, [
        { tool: 'get_canvas', args: base },
        { tool: 'create_frame', args: { ...base, name: 'Made', html: '<p>made</p>' } },
        { tool: 'update_frame', args: { frame_id: 'bf1', name: 'Renamed', agent_name: 'Claude' } },
      ])
      expect(isError).toBe(false)
      expect(summary.ok).toBe(true)
      expect(summary.results.map((r) => [r.index, r.tool, r.status])).toEqual([
        [0, 'get_canvas', 'ok'],
        [1, 'create_frame', 'ok'],
        [2, 'update_frame', 'ok'],
      ])
      expect(texts.filter((t) => t.startsWith('--- op '))).toEqual([
        '--- op 0 get_canvas ---',
        '--- op 1 create_frame ---',
        '--- op 2 update_frame ---',
      ])
      expect(store.getCanvas(CANVAS_ID)!.frames.map((f) => f.name)).toEqual(['Renamed', 'Made'])
    } finally {
      await close()
    }
  })

  it('refuses a write for a view-only account with the direct call text, and still runs a read', async () => {
    const { client, close } = await connect('batch-viewer')
    try {
      const args = { frame_id: 'bf1', name: 'Nope', agent_name: 'Claude' }
      const alone = await direct(client, 'update_frame', args)
      expect(alone.isError).toBe(true)
      const { summary, texts } = await batch(
        client,
        [
          { tool: 'update_frame', args },
          { tool: 'get_canvas', args: base },
        ],
        false,
      )
      expect(summary.ok).toBe(false)
      expect(summary.results[0]).toMatchObject({ tool: 'update_frame', status: 'error', error: alone.text })
      expect(summary.results[1]).toMatchObject({ tool: 'get_canvas', status: 'ok' })
      expect(texts).toContain(`--- op 0 update_frame ---`)
      expect(store.getFrame('bf1')!.name).toBe('Hero')
    } finally {
      await close()
    }
  })

  it('skips the ops after a failure by default', async () => {
    const { client, close } = await connect(OWNER)
    try {
      const { summary } = await batch(client, [
        { tool: 'update_frame', args: { frame_id: 'missing', name: 'x', agent_name: 'Claude' } },
        { tool: 'get_canvas', args: base },
      ])
      expect(summary.results.map((r) => r.status)).toEqual(['error', 'skipped'])
    } finally {
      await close()
    }
  })

  it('refuses nesting, unknown tools and bad arguments like a direct call', async () => {
    const { client, close } = await connect(OWNER)
    try {
      const bad = { frame_id: 'bf1', x: 'left', agent_name: 'Claude' }
      const alone = await direct(client, 'update_frame', bad)
      const { summary } = await batch(
        client,
        [
          { tool: 'run_batch', args: { ops: [{ tool: 'get_canvas', args: base }] } },
          { tool: 'no_such_tool' },
          { tool: 'update_frame', args: bad },
        ],
        false,
      )
      expect(summary.results.map((r) => r.status)).toEqual(['error', 'error', 'error'])
      expect(summary.results[0]!.error).toMatch(/nested/)
      expect(summary.results[1]!.error).toMatch(/not found/)
      expect(summary.results[2]!.error).toBe(alone.text)
      expect(store.getFrame('bf1')!.x).toBe(0)
    } finally {
      await close()
    }
  })

  it('counts every op against the same rate limit as direct calls', async () => {
    const upload = { ...base, local_file: true }
    const batched = await connect('rate-batch')
    const alone = await connect('rate-direct')
    try {
      const { summary } = await batch(
        batched.client,
        Array.from({ length: limits.uploads + 1 }, () => ({ tool: 'upload_asset', args: upload })),
        false,
      )
      expect(summary.results.map((r) => r.status)).toEqual(['ok', 'ok', 'error'])
      expect(summary.results[2]!.error).toMatch(/rate limit/)
      const first = await direct(alone.client, 'upload_asset', upload)
      const second = await direct(alone.client, 'upload_asset', upload)
      const third = await direct(alone.client, 'upload_asset', upload)
      expect([first.isError, second.isError, third.isError]).toEqual([false, false, true])
      expect(third.text).toBe(summary.results[2]!.error)
      /* the batch's own calls used the same budget: a direct call right after is refused too */
      expect((await direct(batched.client, 'upload_asset', upload)).isError).toBe(true)
    } finally {
      await batched.close()
      await alone.close()
    }
  })

  it('keeps each server to its own handlers', async () => {
    const owner = await connect(OWNER)
    const viewer = await connect('batch-viewer')
    try {
      const write = { tool: 'update_frame', args: { frame_id: 'bf1', name: 'Mixed', agent_name: 'Claude' } }
      const asViewer = await batch(viewer.client, [write])
      const asOwner = await batch(owner.client, [write])
      expect(asViewer.summary.results[0]!.status).toBe('error')
      expect(asOwner.summary.results[0]!.status).toBe('ok')
      const again = await batch(viewer.client, [{ ...write, args: { ...write.args, name: 'Again' } }])
      expect(again.summary.results[0]!.status).toBe('error')
      expect(store.getFrame('bf1')!.name).toBe('Mixed')
    } finally {
      await owner.close()
      await viewer.close()
    }
  })
})
