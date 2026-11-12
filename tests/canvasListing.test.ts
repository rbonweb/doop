import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { pickCanvasFields, pickFrameFields, pageOf } from '../server/canvasListing.ts'
import { claimFrames } from '../server/frameClaims.ts'
import { webFontsBrief } from '../shared/webFonts.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

describe('pickCanvasFields', () => {
  const payload = { id: 'c1', name: 'Canvas', pages: [], frames: [], notes: [], webFonts: ['Inter'] }

  it('keeps id and name plus the listed parts', () => {
    expect(pickCanvasFields(payload, ['frames'])).toEqual({ id: 'c1', name: 'Canvas', frames: [] })
  })

  it('keeps everything when no list is given', () => {
    expect(pickCanvasFields(payload)).toEqual(payload)
    expect(pickCanvasFields(payload, [])).toEqual(payload)
  })
})

describe('pickFrameFields', () => {
  const frame = { id: 'f1', name: 'Home', x: 10, y: 20, width: 100, height: 200 }

  it('keeps id plus the listed keys and ignores unknown keys', () => {
    expect(pickFrameFields(frame, ['name', 'nope', 'x'])).toEqual({ id: 'f1', name: 'Home', x: 10 })
  })

  it('keeps everything when no list is given', () => {
    expect(pickFrameFields(frame)).toEqual(frame)
  })
})

describe('pageOf', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  it('walks five items two at a time', () => {
    const first = pageOf(items, 2)
    expect(first).toEqual({ items: ['a', 'b'], total: 5, nextCursor: '2' })
    const second = pageOf(items, 2, '2')
    expect(second).toEqual({ items: ['c', 'd'], total: 5, nextCursor: '4' })
    const third = pageOf(items, 2, '4')
    expect(third).toEqual({ items: ['e'], total: 5 })
  })

  it('rejects a cursor that is not an offset in the list', () => {
    for (const cursor of ['x', '-1', '9']) expect(pageOf(items, 2, cursor)).toHaveProperty('error')
  })
})

function frame(id: string) {
  return {
    id,
    name: id,
    html: '<html></html>',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'Agent',
  }
}

async function canvasClient(canvasId: string, options: { pages?: boolean; clientName?: string } = {}) {
  const { store } = await import('../server/store.ts')
  /* two pages: a, b, e on the first, c, d on the second */
  const onSecond = new Set(['c', 'd'])
  store.canvases.set(canvasId, {
    id: canvasId,
    ownerId: 'test-owner-id',
    name: 'Listing',
    createdById: 'test-owner-id',
    frames: ['a', 'b', 'c', 'd', 'e'].map((id) =>
      options.pages ? { ...frame(id), canvasId, pageId: onSecond.has(id) ? 'page-two' : 'page-one' } : frame(id),
    ),
    ...(options.pages
      ? {
          pages: [
            { id: 'page-one', name: 'One' },
            { id: 'page-two', name: 'Two' },
          ],
          notes: [
            {
              id: 'n1',
              pageId: 'page-one',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              markdown: 'one',
              color: 'yellow',
              canvasId,
              createdBy: 'T',
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: 'n2',
              pageId: 'page-two',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              markdown: 'two',
              color: 'yellow',
              canvasId,
              createdBy: 'T',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        }
      : {}),
    createdAt: 0,
    updatedAt: 0,
  } as never)
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: options.clientName ?? 'canvas-listing-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      store.canvases.delete(canvasId)
      await client.close()
      await server.close()
    },
    body: (result: Awaited<ReturnType<Client['callTool']>>) => {
      const first = (result.content as { text: string }[])[0]!
      return JSON.parse(first.text) as Record<string, unknown>
    },
  }
}

describe('get_canvas listing controls', () => {
  it('pages through the frames with limit and cursor', async () => {
    const { client, close, body } = await canvasClient('mcp-canvas-listing-page')
    try {
      const first = body(
        await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-canvas-listing-page', limit: 2 } }),
      )
      expect((first.frames as { id: string }[]).map((f) => f.id)).toEqual(['a', 'b'])
      expect(first.total).toBe(5)
      expect(first.nextCursor).toBe('2')
      const second = body(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: 'mcp-canvas-listing-page', limit: 2, cursor: '2' },
        }),
      )
      expect((second.frames as { id: string }[]).map((f) => f.id)).toEqual(['c', 'd'])
      expect(second.nextCursor).toBe('4')
    } finally {
      await close()
    }
  })

  it('returns only the requested canvas parts and frame keys', async () => {
    const { client, close, body } = await canvasClient('mcp-canvas-listing-fields')
    try {
      const trimmed = body(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: 'mcp-canvas-listing-fields', fields: ['frames'] },
        }),
      )
      expect(Object.keys(trimmed).sort()).toEqual(['frames', 'id', 'name'])
      const framesOnly = body(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: 'mcp-canvas-listing-fields', frame_fields: ['name'] },
        }),
      )
      for (const f of framesOnly.frames as Record<string, unknown>[])
        expect(Object.keys(f).sort()).toEqual(['id', 'name'])
    } finally {
      await close()
    }
  })

  it('keeps the default payload and states the hosted fonts once', async () => {
    const { client, close, body } = await canvasClient('mcp-canvas-listing-default')
    try {
      const payload = body(
        await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-canvas-listing-default' } }),
      )
      expect(payload.pages).toBeDefined()
      expect((payload.frames as unknown[]).length).toBe(5)
      expect(payload.webFonts).toContain('Inter')
      expect(typeof payload.note).toBe('string')
      expect((payload.note as string).length).toBeLessThan(webFontsBrief().length)
      expect(payload.note as string).not.toContain('Fira Code')
    } finally {
      await close()
    }
  })

  describe('with page_id', () => {
    const ids = (value: unknown) => (value as { id: string }[]).map((f) => f.id)
    const claimed = (value: unknown) => (value as { frameId: string }[]).map((c) => c.frameId)

    for (const clientName of ['canvas-listing-test', 'claude-code']) {
      it(`keeps every part of the answer on the page (${clientName})`, async () => {
        const canvasId = `mcp-canvas-listing-page-id-${clientName}`
        const { client, close, body } = await canvasClient(canvasId, { pages: true, clientName })
        try {
          const { store } = await import('../server/store.ts')
          const frames = store.canvases.get(canvasId)!.frames
          claimFrames(
            frames.filter((f) => ['a', 'c'].includes(f.id)),
            { kind: 'agent', name: 'Other agent', color: '#000000' },
            15,
            'working',
          )
          const structured = (result: Awaited<ReturnType<Client['callTool']>>) =>
            result.structuredContent as Record<string, unknown>
          for (const extra of [
            {},
            { limit: 1 },
            { limit: 5 },
            { frame_fields: ['name'] },
            { fields: ['frames', 'claims'] },
          ]) {
            const result = await client.callTool({
              name: 'get_canvas',
              arguments: { canvas_id: canvasId, page_id: 'page-two', ...extra },
            })
            const shown = clientName === 'claude-code' ? structured(result) : body(result)
            if (shown.frames) expect(ids(shown.frames).every((id) => ['c', 'd'].includes(id))).toBe(true)
            if (shown.claims) expect(claimed(shown.claims)).toEqual(['c'])
            if (shown.notes) expect(ids(shown.notes)).toEqual(['n2'])
            const preview = structured(result)
            expect(ids(preview.frames).every((id) => ['c', 'd'].includes(id))).toBe(true)
            if (preview.claims) expect(claimed(preview.claims)).toEqual(['c'])
          }
          const wholeResult = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId } })
          const whole = clientName === 'claude-code' ? structured(wholeResult) : body(wholeResult)
          expect(claimed(whole.claims).sort()).toEqual(['a', 'c'])
          expect(ids(whole.frames)).toHaveLength(5)
        } finally {
          await close()
        }
      })
    }
  })
})
