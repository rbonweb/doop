import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

/* Persistence is out of scope: every write-through is a no-op. */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  const writes = [
    'saveCanvas',
    'saveFrame',
    'saveNote',
    'saveActivity',
    'saveFrameVersion',
    'saveMember',
    'deleteCanvas',
    'deleteFrame',
    'deleteNote',
    'deleteMember',
  ]
  return Object.fromEntries(writes.map((name) => [name, noop]))
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { residentAgentTool } = await import('../server/agentTools/resident.ts')

const OWNER = 'owner'
const VIEWER = 'viewer'
const agent = actions.resolveActor({ name: 'Claude', kind: 'agent' })

let canvas: Canvas

function addFrame(extra: Partial<Frame> & Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height'>): Frame {
  const { name, x, y, width, height, ...rest } = extra
  const frame = actions.createFrame(canvas.id, { name, x, y, width, height }, agent)!
  /* the store updates frames in place: the test sets the rest directly */
  return Object.assign(frame, rest)
}

async function as(userId: string) {
  const server = buildMcpServer('Someone', userId)
  const client = new Client({ name: 'layout-test', version: '1.0.0' })
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
  const blocks = result.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  return { text: blocks[0] ?? '', isError: !!result.isError }
}

/** The result's JSON block (a feedback notice may ride in a later one). */
const json = (text: string): Record<string, any> => JSON.parse(text) // eslint-disable-line typescript/no-explicit-any

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  for (const c of store.allCanvases()) store.deleteCanvas(c.id)
  canvas = store.createCanvas('Layout', OWNER)
  canvas.memberIds = [VIEWER]
  canvas.memberRoles = { [VIEWER]: 'view' }
  canvas.pages = [
    { id: 'p1', name: 'Page 1' },
    { id: 'p2', name: 'Page 2' },
  ]
})

describe('arrange_frames', () => {
  it('puts desktops in the first row and narrower frames in the second, 300 px apart', async () => {
    const big = addFrame({ name: 'Home', x: 500, y: 40, width: 1440, height: 900, pageId: 'p1' })
    const mid = addFrame({ name: 'Pricing', x: 0, y: 900, width: 1280, height: 700, pageId: 'p1' })
    const phone = addFrame({ name: 'Home mobile', x: 9000, y: 9000, width: 390, height: 844, pageId: 'p1' })
    const { client, close } = await as(OWNER)
    try {
      const { text, isError } = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        page_id: 'p1',
        agent_name: 'Claude',
      })
      expect(isError).toBe(false)
      const result = json(text)
      expect(result.ok).toBe(true)
      expect(result.unmatched).toEqual([])
      /* the origin is the top-left of the bounds: x 0, y 40 */
      expect(store.getFrame(mid.id)).toMatchObject({ x: 0, y: 40 })
      expect(store.getFrame(big.id)).toMatchObject({ x: 1280 + 300, y: 40 })
      expect(store.getFrame(phone.id)).toMatchObject({ x: 0, y: 40 + 900 + 300 })
    } finally {
      await close()
    }
  })

  it('plans the moves on a dry run and writes nothing', async () => {
    const big = addFrame({ name: 'Home', x: 500, y: 40, width: 1440, height: 900, pageId: 'p1', updatedAt: 111 })
    const mid = addFrame({ name: 'Pricing', x: 0, y: 900, width: 1280, height: 700, pageId: 'p1', updatedAt: 222 })
    const { client, close } = await as(OWNER)
    try {
      const args = { canvas_id: canvas.id, page_id: 'p1', agent_name: 'Claude' }
      const dry = json((await call(client, 'arrange_frames', { ...args, dry_run: true })).text)
      expect(dry.dry_run).toBe(true)
      expect(dry.moved).toBeUndefined()
      expect(dry.planned).toEqual([
        { frame_id: big.id, name: 'Home', from: { x: 500, y: 40 }, to: { x: 1580, y: 40 } },
        { frame_id: mid.id, name: 'Pricing', from: { x: 0, y: 900 }, to: { x: 0, y: 40 } },
      ])
      expect(store.getFrame(big.id)).toMatchObject({ x: 500, y: 40, updatedAt: 111 })
      expect(store.getFrame(mid.id)).toMatchObject({ x: 0, y: 900, updatedAt: 222 })
      /* the real call then makes exactly the planned moves */
      const real = json((await call(client, 'arrange_frames', args)).text)
      expect((real.moved as { id: string; x: number; y: number }[]).map(({ id, x, y }) => ({ id, x, y }))).toEqual(
        (dry.planned as { frame_id: string; to: { x: number; y: number } }[]).map((p) => ({ id: p.frame_id, ...p.to })),
      )
    } finally {
      await close()
    }
  })

  it('leaves a locked frame where it is and reports it', async () => {
    const a = addFrame({ name: 'A', x: 1000, y: 0, width: 1000, height: 600, pageId: 'p1' })
    const locked = addFrame({ name: 'Locked', x: 50, y: 50, width: 1000, height: 600, pageId: 'p1', locked: true })
    const { client, close } = await as(OWNER)
    try {
      const { text } = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        page_id: 'p1',
        agent_name: 'Claude',
      })
      expect(json(text).skipped_locked).toEqual([locked.id])
      expect(store.getFrame(locked.id)).toMatchObject({ x: 50, y: 50 })
      expect(store.getFrame(a.id)).toMatchObject({ x: 1000, y: 0 })
    } finally {
      await close()
    }
  })

  it('carries a note attached to a moved frame along', async () => {
    addFrame({ name: 'First', x: 0, y: 0, width: 1000, height: 600, pageId: 'p1' })
    const second = addFrame({ name: 'Second', x: 2000, y: 0, width: 1000, height: 600, pageId: 'p1' })
    const note = actions.createNote(
      canvas.id,
      { markdown: 'Check the CTA', x: 2100, y: 700, frameId: second.id },
      agent,
    )
    expect(note.ok).toBe(true)
    const { client, close } = await as(OWNER)
    try {
      await call(client, 'arrange_frames', { canvas_id: canvas.id, page_id: 'p1', agent_name: 'Claude' })
      /* second moved from x 2000 to 1300, so its note moved by the same delta */
      expect(store.getFrame(second.id)?.x).toBe(1300)
      expect(store.getNotes(canvas.id)[0]).toMatchObject({ x: 1400, y: 700 })
    } finally {
      await close()
    }
  })

  it('does not write frames that are already in place', async () => {
    const first = addFrame({ name: 'First', x: 0, y: 0, width: 1000, height: 600, pageId: 'p1', updatedAt: 111 })
    const second = addFrame({ name: 'Second', x: 1300, y: 0, width: 1000, height: 600, pageId: 'p1', updatedAt: 222 })
    const { client, close } = await as(OWNER)
    try {
      const { text } = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        frame_ids: [first.id, second.id],
        agent_name: 'Claude',
      })
      const result = json(text)
      expect(result.moved).toEqual([])
      expect(result.unchanged).toBe(2)
      expect(store.getFrame(first.id)?.updatedAt).toBe(111)
      expect(store.getFrame(second.id)?.updatedAt).toBe(222)
    } finally {
      await close()
    }
  })

  it('refuses frames from two pages, naming them, and a call with neither or both selectors', async () => {
    const a = addFrame({ name: 'A', x: 0, y: 0, width: 400, height: 400, pageId: 'p1' })
    const b = addFrame({ name: 'B', x: 0, y: 0, width: 400, height: 400, pageId: 'p2' })
    const { client, close } = await as(OWNER)
    try {
      const mixed = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        frame_ids: [a.id, b.id],
        agent_name: 'Claude',
      })
      expect(mixed.isError).toBe(true)
      expect(mixed.text).toContain('p1')
      expect(mixed.text).toContain('p2')
      const neither = await call(client, 'arrange_frames', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(neither.isError).toBe(true)
      const both = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        page_id: 'p1',
        frame_ids: [a.id],
        agent_name: 'Claude',
      })
      expect(both.isError).toBe(true)
    } finally {
      await close()
    }
  })

  it('is refused for a view-only account and moves nothing', async () => {
    const a = addFrame({ name: 'A', x: 5000, y: 0, width: 1000, height: 400, pageId: 'p1' })
    const { client, close } = await as(VIEWER)
    try {
      const { isError } = await call(client, 'arrange_frames', {
        canvas_id: canvas.id,
        page_id: 'p1',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(store.getFrame(a.id)?.x).toBe(5000)
    } finally {
      await close()
    }
  })

  it('counts as arranging work for the resident agent only when something moved', async () => {
    addFrame({ name: 'A', x: 0, y: 0, width: 1000, height: 400, pageId: 'p1' })
    addFrame({ name: 'B', x: 1000, y: 0, width: 1000, height: 400, pageId: 'p1' })
    const tool = residentAgentTool('arrange_frames')!
    const runState = { arrangeWrites: 0 } as Parameters<typeof tool.run>[1]['runState']
    const first = await tool.run({ page_id: 'p1' }, { canvasId: canvas.id, actor: agent, runState })
    expect(first.ok).toBe(true)
    expect(runState.arrangeWrites).toBe(1)
    const again = await tool.run({ page_id: 'p1' }, { canvasId: canvas.id, actor: agent, runState })
    expect(again.ok).toBe(true)
    expect(runState.arrangeWrites).toBe(1)
  })
})

describe('check_layout', () => {
  it('reports an overlap and a tight pair, and nothing for a clean page', async () => {
    const a = addFrame({ name: 'A', x: 0, y: 0, width: 400, height: 400, pageId: 'p1' })
    const b = addFrame({ name: 'B', x: 300, y: 100, width: 400, height: 400, pageId: 'p1' })
    const c = addFrame({ name: 'C', x: 710, y: 100, width: 400, height: 400, pageId: 'p1' })
    addFrame({ name: 'Elsewhere', x: 0, y: 0, width: 400, height: 400, pageId: 'p2' })
    addFrame({ name: 'Hidden', x: 0, y: 0, width: 400, height: 400, pageId: 'p1', hidden: true })
    const { client, close } = await as(OWNER)
    try {
      const { text, isError } = await call(client, 'check_layout', { canvas_id: canvas.id, page_id: 'p1' })
      expect(isError).toBe(false)
      const result = json(text)
      expect(result.checked).toBe(3)
      expect(result.issues).toHaveLength(2)
      expect(result.issues[0]).toMatchObject({ kind: 'overlap', a: { id: a.id, kind: 'frame' }, b: { id: b.id } })
      expect(result.issues[1]).toMatchObject({ kind: 'tight', gap: 10, a: { id: b.id }, b: { id: c.id } })

      c.x = 1000
      b.x = 500
      const clean = await call(client, 'check_layout', { canvas_id: canvas.id, page_id: 'p1' })
      expect(clean.text).toContain('no overlaps')
      expect(clean.text).not.toContain('{')
    } finally {
      await close()
    }
  })

  it('judges notes in canvas coordinates and skips the frame a note is attached to', async () => {
    const frame = addFrame({ name: 'Hero', x: 0, y: 0, width: 400, height: 400, pageId: 'p1' })
    const other = addFrame({ name: 'Next', x: 800, y: 0, width: 400, height: 400, pageId: 'p1' })
    /* attached and sitting on its frame: never reported */
    actions.createNote(canvas.id, { markdown: 'Attached', x: 100, y: 100, frameId: frame.id }, agent)
    /* free, on top of the next frame */
    actions.createNote(canvas.id, { markdown: 'Free note on Next', x: 900, y: 50, pageId: 'p1' }, agent)
    const { client, close } = await as(OWNER)
    try {
      const { text } = await call(client, 'check_layout', { canvas_id: canvas.id, page_id: 'p1' })
      const result = json(text)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]).toMatchObject({
        kind: 'overlap',
        a: { id: other.id, kind: 'frame', name: 'Next' },
        b: { kind: 'note', name: 'Free note on Next' },
      })
    } finally {
      await close()
    }
  })

  it('is allowed for a view-only account and refuses an unknown page', async () => {
    addFrame({ name: 'A', x: 0, y: 0, width: 400, height: 400, pageId: 'p1' })
    const { client, close } = await as(VIEWER)
    try {
      const ok = await call(client, 'check_layout', { canvas_id: canvas.id, page_id: 'p1' })
      expect(ok.isError).toBe(false)
      const bad = await call(client, 'check_layout', { canvas_id: canvas.id, page_id: 'nope' })
      expect(bad.isError).toBe(true)
      expect(bad.text).toContain('p1')
    } finally {
      await close()
    }
  })
})
