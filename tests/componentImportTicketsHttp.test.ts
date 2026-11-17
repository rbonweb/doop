import { gzipSync } from 'node:zlib'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  beginImportUpload,
  createImportTicket,
  endImportUpload,
  IMPORT_TICKET_TTL_MS,
  IMPORT_TICKETS_PER_HOUR,
  ImportTicketLimitError,
  peekImportTicket,
  resetImportTickets,
} from '../server/componentImportTickets.ts'
import { Client, startServer, type Server } from './harness.ts'

/* The real server: a ticket from REST and from MCP, the upload route in front of express.json (no session, the token is
   the capability), single use, the decompressed cap, the edit role checked again when the bytes arrive. */

const BUNDLE = {
  version: 1,
  source: { kind: 'cli', name: 'Acme storybook' },
  package: '@acme/ui',
  components: [
    {
      name: 'Card',
      html: '<div class="card"><script>alert(1)</script><h2 data-doop-prop="title" onclick="x()">Title</h2></div>',
      css: '.card { padding: 16px }',
      code: { exportName: 'Card' },
    },
  ],
}

type Answer = { upload_url: string; expires_at: string; command: string; curl: string }
type Imported = {
  ok?: boolean
  error?: string
  dry_run?: boolean
  created: { name: string; id: string }[]
  updated: unknown[]
  issues: { code: string }[]
}

let server: Server
let owner: Client
let editor: Client
let stranger: Client
let capped: Client
let canvasId: string
let ownerAgent: McpClient
let editorAgent: McpClient
let editorId: string
/* an account may make five tickets an hour: the tests share them, and the refusals below leave a ticket usable */
let first: Answer

async function agent(client: Client, name: string) {
  const { secret } = (await (await client.post('/api/agent-keys', { name })).json()) as { secret: string }
  const mcp = new McpClient({ name, version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return mcp
}

async function restTicket(client: Client = owner, id: string = canvasId): Promise<Answer> {
  const res = await client.post(`/api/canvases/${id}/component-import/ticket`)
  expect(res.status).toBe(200)
  return (await res.json()) as Answer
}

async function mcpTicket(mcp: McpClient): Promise<Answer> {
  const result = await mcp.callTool({
    name: 'create_import_ticket',
    arguments: { canvas_id: canvasId, agent_name: 'T' },
  })
  expect(result.isError).toBeFalsy()
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Answer
}

/** The upload: no cookie, no session; the URL alone. */
const put = (url: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'PUT', body: new Uint8Array(typeof body === 'string' ? Buffer.from(body) : body), headers })

async function components(): Promise<{ id: string; name: string; template: string; rawCss: string }[]> {
  const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as {
    components: { id: string; name: string; template: string; rawCss: string }[]
  }
  return canvas.components
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('owner@import.test', 'Owner')
  editor = await new Client(server).signUp('editor@import.test', 'Editor')
  stranger = await new Client(server).signUp('stranger@import.test', 'Stranger')
  capped = await new Client(server).signUp('capped@import.test', 'Capped')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Imports' })).json()) as { id: string }).id
  editorId = ((await (await editor.get('/api/me')).json()) as { id: string }).id
  const invite = await owner.post(`/api/canvases/${canvasId}/members`, { email: 'editor@import.test', role: 'edit' })
  expect(invite.status).toBe(200)
  ownerAgent = await agent(owner, 'Owner agent')
  editorAgent = await agent(editor, 'Editor agent')
}, 90_000)

afterAll(async () => {
  await ownerAgent?.close()
  await editorAgent?.close()
  server?.stop()
})

describe('the ticket and the upload', () => {
  it('a REST ticket answers with the URL, the CLI command and curl, for editors only', async () => {
    const answer = await restTicket()
    first = answer
    expect(answer.upload_url).toMatch(/\/import\/[A-Za-z0-9_-]{43,}$/)
    expect(answer.command).toBe(`npx doop-import --storybook ./storybook-static --ticket ${answer.upload_url}`)
    expect(answer.curl).toBe(`curl -T bundle.json ${answer.upload_url}`)
    expect(Date.parse(answer.expires_at) - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(Date.parse(answer.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000)
    expect((await stranger.post(`/api/canvases/${canvasId}/component-import/ticket`)).status).toBeGreaterThanOrEqual(
      403,
    )
    expect(
      (await fetch(`${server.base}/api/canvases/${canvasId}/component-import/ticket`, { method: 'POST' })).status,
    ).toBe(401)
  })

  it('imports once, sanitized, and a second use of the ticket is 410', async () => {
    const { upload_url } = first
    const res = await put(upload_url, JSON.stringify(BUNDLE))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Imported
    expect(body.created).toHaveLength(1)
    expect(body.issues.map((issue) => issue.code)).toContain('dropped_element')
    const [card] = await components()
    expect(card?.name).toBe('Card')
    expect(card?.template).not.toMatch(/script|onclick/)
    expect((await put(upload_url, JSON.stringify(BUNDLE))).status).toBe(410)
  })

  it('answers 410 for a token that never existed and for a malformed one', async () => {
    expect((await put(`${server.base}/import/${'A'.repeat(43)}`, '{}')).status).toBe(410)
    expect((await put(`${server.base}/import/short`, '{}')).status).toBe(410)
  })

  it('re-importing through a new ticket updates the same component', async () => {
    const [before] = await components()
    const { upload_url } = await restTicket()
    const changed = { ...BUNDLE, components: [{ ...BUNDLE.components[0]!, css: '.card { padding: 48px }' }] }
    const body = (await (await put(upload_url, JSON.stringify(changed))).json()) as Imported
    expect(body.created).toEqual([])
    expect(body.updated).toHaveLength(1)
    const after = await components()
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before!.id)
    expect(after[0]!.rawCss).toContain('48px')
  })

  it('a dry run answers and writes nothing, and does not use the ticket up', async () => {
    const { upload_url } = await mcpTicket(ownerAgent)
    const fresh = { ...BUNDLE, components: [{ name: 'Badge', html: '<span class="badge">b</span>' }] }
    const dry = (await (await put(`${upload_url}?dry_run=1`, JSON.stringify(fresh))).json()) as Imported
    expect(dry.dry_run).toBe(true)
    expect(dry.created).toEqual([{ name: 'Badge', id: '' }])
    expect((await components()).map((entry) => entry.name)).toEqual(['Card'])
    const real = (await (await put(upload_url, JSON.stringify(fresh))).json()) as Imported
    expect(real.created).toHaveLength(1)
    expect((await components()).map((entry) => entry.name).sort()).toEqual(['Badge', 'Card'])
  })

  it('takes gzip, caps the decompressed size, and keeps the ticket after every refusal', async () => {
    const { upload_url } = await restTicket()
    /* a few KB on the wire, past 20 MB unpacked */
    const bomb = gzipSync(Buffer.from(`{"x":"${'0'.repeat(21_000_000)}"}`))
    expect(bomb.length).toBeLessThan(100_000)
    const refused = await put(upload_url, bomb, { 'Content-Encoding': 'gzip' })
    expect(refused.status).toBe(413)
    expect((await put(upload_url, 'not json')).status).toBe(400)
    expect((await put(upload_url, 'garbage', { 'Content-Encoding': 'gzip' })).status).toBe(400)
    expect((await put(upload_url, '{}', { 'Content-Encoding': 'br' })).status).toBe(400)
    const invalid = await put(upload_url, JSON.stringify({ version: 1, source: { kind: 'cli' }, components: [] }))
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as Imported).error).toMatch(/components/)
    const small = { ...BUNDLE, components: [{ name: 'Zipped', html: '<i>z</i>' }] }
    const ok = await put(upload_url, gzipSync(Buffer.from(JSON.stringify(small))), { 'Content-Encoding': 'gzip' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Imported).created.map((entry) => entry.name)).toEqual(['Zipped'])
  })

  it('checks the edit role again at upload', async () => {
    const { upload_url } = await mcpTicket(editorAgent)
    const removed = await owner.delete(`/api/canvases/${canvasId}/members/${editorId}`)
    expect(removed.status).toBe(200)
    const refused = await put(
      upload_url,
      JSON.stringify({ ...BUNDLE, components: [{ name: 'Nope', html: '<b>n</b>' }] }),
    )
    expect(refused.status).toBe(403)
    expect((await components()).some((entry) => entry.name === 'Nope')).toBe(false)
    /* the ticket was not used up: with the role back it works */
    const added = await owner.post(`/api/canvases/${canvasId}/members`, { email: 'editor@import.test', role: 'edit' })
    expect(added.status).toBe(200)
    const ok = await put(upload_url, JSON.stringify({ ...BUNDLE, components: [{ name: 'Yes', html: '<b>y</b>' }] }))
    expect(ok.status).toBe(200)
  })

  it('refuses a sixth ticket within the hour with a retry hint', async () => {
    const mine = ((await (await capped.post('/api/canvases', { name: 'Capped' })).json()) as { id: string }).id
    for (let n = 0; n < IMPORT_TICKETS_PER_HOUR; n++) await restTicket(capped, mine)
    const res = await capped.post(`/api/canvases/${mine}/component-import/ticket`)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(((await res.json()) as { error: string }).error).toMatch(/at most 5 import tickets an hour/)
  })

  it('import_components over MCP answers a dry run', async () => {
    const result = await ownerAgent.callTool({
      name: 'import_components',
      arguments: {
        canvas_id: canvasId,
        agent_name: 'T',
        bundle: { ...BUNDLE, source: { kind: 'agent' } },
        dry_run: true,
      },
    })
    expect(result.isError).toBeFalsy()
  })
})

describe('tickets in memory', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetImportTickets()
  })
  const actor = { name: 'Agent', kind: 'agent' as const, color: '#000' }

  it('expires after fifteen minutes', () => {
    vi.useFakeTimers()
    const ticket = createImportTicket({ canvasId: 'c', userId: 'u', actor })
    expect(peekImportTicket(ticket.token)).not.toBeNull()
    vi.advanceTimersByTime(IMPORT_TICKET_TTL_MS + 1)
    expect(peekImportTicket(ticket.token)).toBeNull()
    expect(beginImportUpload(ticket.token)).toBeNull()
  })

  it('is single use, retryable after a failure, bound to its canvas, and unguessable', () => {
    const ticket = createImportTicket({ canvasId: 'c1', userId: 'u', actor })
    expect(Buffer.from(ticket.token, 'base64url')).toHaveLength(32)
    expect(beginImportUpload(ticket.token)?.canvasId).toBe('c1')
    expect(beginImportUpload(ticket.token)).toBeNull()
    endImportUpload(ticket.token, false)
    expect(beginImportUpload(ticket.token)).not.toBeNull()
    endImportUpload(ticket.token, true)
    expect(peekImportTicket(ticket.token)).toBeNull()
    expect(createImportTicket({ canvasId: 'c1', userId: 'u', actor }).token).not.toBe(ticket.token)
  })

  it('caps tickets an hour per account and frees the cap as time passes', () => {
    vi.useFakeTimers()
    for (let n = 0; n < IMPORT_TICKETS_PER_HOUR; n++) createImportTicket({ canvasId: 'c', userId: 'u', actor })
    expect(() => createImportTicket({ canvasId: 'c', userId: 'u', actor })).toThrow(ImportTicketLimitError)
    createImportTicket({ canvasId: 'c', userId: 'someone-else', actor })
    vi.advanceTimersByTime(61 * 60_000)
    expect(() => createImportTicket({ canvasId: 'c', userId: 'u', actor })).not.toThrow()
  })
})
