import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { REVIEW_NUDGE } from '../server/reviewNudge.ts'
import { resetReminders, shapeResponses } from '../server/responseShaping.ts'
import { z } from 'zod'

const json = (data: unknown) => ({ type: 'text' as const, text: JSON.stringify(data, null, 2) })
const canvas = { id: 'abc123', name: 'Landing', pages: [{}, {}, {}], frames: [{ id: 'f1' }, { id: 'f2' }], notes: [] }

async function connect(opts: { sessionKey?: string; client?: string }) {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  shapeResponses(server, { sessionKey: opts.sessionKey, clientName: async () => opts.client })
  server.registerTool(
    'edit_frame_html',
    { inputSchema: { frame_id: z.string() }, annotations: { readOnlyHint: false } },
    async ({ frame_id }) => ({
      content: [json({ ok: true, frame: { id: frame_id } }), { type: 'text' as const, text: REVIEW_NUDGE }],
    }),
  )
  server.registerTool(
    'append_frame_html',
    { inputSchema: { frame_id: z.string() }, annotations: { readOnlyHint: false } },
    async () => ({
      content: [json({ ok: true }), { type: 'text' as const, text: `Stream complete. ${REVIEW_NUDGE}` }],
    }),
  )
  server.registerTool('create_thing', { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({
    content: [json({ ok: true, frame: { id: 'made' } }), { type: 'text' as const, text: REVIEW_NUDGE }],
  }))
  server.registerTool(
    'get_canvas',
    { inputSchema: { canvas_id: z.string() }, annotations: { readOnlyHint: true } },
    async () => ({
      content: [json(canvas), { type: 'text' as const, text: 'HUMAN FEEDBACK — 1 open request' }],
      structuredContent: { ...canvas, messages: ['HUMAN FEEDBACK — 1 open request'] },
    }),
  )
  server.registerTool('update_thing', { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({
    content: [json(canvas)],
    structuredContent: { ...canvas },
  }))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return client
}

const texts = (result: unknown) =>
  ((result as { content: { type: string; text?: string }[] }).content ?? []).flatMap((b) =>
    b.type === 'text' ? [b.text ?? ''] : [],
  )

beforeEach(resetReminders)

describe('review reminder once per frame per session', () => {
  it('keeps it on the first write, removes it on the second, repeats it for another frame', async () => {
    const client = await connect({ sessionKey: 's1' })
    const edit = (frame_id: string) => client.callTool({ name: 'edit_frame_html', arguments: { frame_id } })
    expect(texts(await edit('f1'))).toContain(REVIEW_NUDGE)
    expect(texts(await edit('f1'))).not.toContain(REVIEW_NUDGE)
    expect(texts(await edit('f2'))).toContain(REVIEW_NUDGE)
    await client.close()
  })

  it('reminds another session again', async () => {
    const one = await connect({ sessionKey: 's1' })
    const two = await connect({ sessionKey: 's2' })
    await one.callTool({ name: 'edit_frame_html', arguments: { frame_id: 'f1' } })
    expect(texts(await two.callTool({ name: 'edit_frame_html', arguments: { frame_id: 'f1' } }))).toContain(
      REVIEW_NUDGE,
    )
    await one.close()
    await two.close()
  })

  it('turns the stream variant into a plain completion line after the first', async () => {
    const client = await connect({ sessionKey: 's1' })
    const append = () => client.callTool({ name: 'append_frame_html', arguments: { frame_id: 'f1' } })
    expect(texts(await append())).toContain(`Stream complete. ${REVIEW_NUDGE}`)
    expect(texts(await append())).toContain('Stream complete.')
    await client.close()
  })

  it('finds the frame in the payload when the call has no frame_id', async () => {
    const client = await connect({ sessionKey: 's1' })
    expect(texts(await client.callTool({ name: 'create_thing', arguments: {} }))).toContain(REVIEW_NUDGE)
    expect(texts(await client.callTool({ name: 'create_thing', arguments: {} }))).not.toContain(REVIEW_NUDGE)
    await client.close()
  })

  it('changes nothing without a session key', async () => {
    const client = await connect({})
    await client.callTool({ name: 'edit_frame_html', arguments: { frame_id: 'f1' } })
    expect(texts(await client.callTool({ name: 'edit_frame_html', arguments: { frame_id: 'f1' } }))).toContain(
      REVIEW_NUDGE,
    )
    await client.close()
  })
})

describe('one-line reads for clients that read structuredContent', () => {
  it('summarises a read for Claude Code and leaves the other blocks and structuredContent alone', async () => {
    const client = await connect({ sessionKey: 's1', client: 'Claude-Code' })
    const result = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'abc123' } })
    expect(texts(result)).toEqual([
      'get_canvas "Landing" (abc123): 3 pages, 2 frames, 0 notes. Full data in structuredContent.',
      'HUMAN FEEDBACK — 1 open request',
    ])
    expect(result.structuredContent).toMatchObject({ id: 'abc123', frames: [{ id: 'f1' }, { id: 'f2' }] })
    await client.close()
  })

  it.each([['cursor'], ['some-other-client'], [undefined]])('keeps the full text for %s', async (name) => {
    const client = await connect({ sessionKey: 's1', client: name })
    const result = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'abc123' } })
    expect(texts(result)[0]).toBe(JSON.stringify(canvas, null, 2))
    await client.close()
  })

  it('never summarises a write tool', async () => {
    const client = await connect({ sessionKey: 's1', client: 'claude-code' })
    const result = await client.callTool({ name: 'update_thing', arguments: {} })
    expect(texts(result)[0]).toBe(JSON.stringify(canvas, null, 2))
    await client.close()
  })
})
