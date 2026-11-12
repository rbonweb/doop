import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { REVIEW_NUDGE } from '../server/reviewNudge.ts'
import { Client, startServer, type Server } from './harness.ts'

/* /mcp is stateless: initialize and every tool call are separate requests, each served by a fresh MCP server.
   The client's name and the review reminders already given must survive that. */

let server: Server
let secret: string
const open: McpClient[] = []

async function connect(name: string): Promise<McpClient> {
  const client = new McpClient({ name, version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  open.push(client)
  return client
}

const texts = (result: unknown) =>
  (result as { content: { type: string; text?: string }[] }).content.flatMap((b) =>
    b.type === 'text' ? [b.text ?? ''] : [],
  )

beforeAll(async () => {
  server = await startServer()
  const member = await new Client(server).signUp('shaping@test.dev', 'Shaping')
  secret = (await (await member.post('/api/agent-keys', { name: 'Shaping agent' })).json()).secret
}, 60_000)

afterAll(async () => {
  await Promise.all(open.map((client) => client.close()))
  server?.stop()
})

async function canvasWithFrame(client: McpClient) {
  const created = await client.callTool({ name: 'create_canvas', arguments: { name: 'Shaping', agent_name: 'T' } })
  const canvasId = (JSON.parse(texts(created)[0] ?? '{}') as { id: string }).id
  const frame = await client.callTool({
    name: 'create_frame',
    arguments: { canvas_id: canvasId, name: 'Hero', html: '<h1>Hello</h1><p>World</p>', agent_name: 'T' },
  })
  const frameId = (JSON.parse(texts(frame)[0] ?? '{}') as { frame: { id: string } }).frame.id
  return { canvasId, frameId, createTexts: texts(frame) }
}

it('gives Claude Code a one-line read and the full payload as structuredContent', async () => {
  const claude = await connect('claude-code')
  const { canvasId } = await canvasWithFrame(claude)
  const result = await claude.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId, agent_name: 'T' } })
  expect(texts(result)[0]).toMatch(
    /^get_canvas "Shaping" \(.+\): \d+ pages, 1 frames.*Full data in structuredContent\.$/,
  )
  expect(result.structuredContent).toMatchObject({ id: canvasId, name: 'Shaping' })
  expect((result.structuredContent as { frames: unknown[] }).frames).toHaveLength(1)
})

it('keeps the full text for any other client', async () => {
  const other = await connect('some-other-client')
  const { canvasId } = await canvasWithFrame(other)
  const result = await other.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId, agent_name: 'T' } })
  expect(() => JSON.parse(texts(result)[0] ?? '')).not.toThrow()
  expect(JSON.parse(texts(result)[0] ?? '')).toMatchObject({ id: canvasId, name: 'Shaping' })
})

it('sends the review reminder on the first write to a frame only', async () => {
  const agent = await connect('reminder-client')
  const { frameId, createTexts } = await canvasWithFrame(agent)
  const edit = (from: string, to: string) =>
    agent.callTool({
      name: 'edit_frame_html',
      arguments: { frame_id: frameId, old_str: from, new_str: to, agent_name: 'T' },
    })
  expect(createTexts).toContain(REVIEW_NUDGE)
  expect(texts(await edit('Hello', 'Hi'))).not.toContain(REVIEW_NUDGE)
  expect(texts(await edit('Hi', 'Hey'))).not.toContain(REVIEW_NUDGE)
})
