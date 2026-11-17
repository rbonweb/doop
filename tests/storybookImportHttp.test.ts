import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { startFakeStorybook, type FakeStorybook } from './fakeStorybook.ts'
import { Client, startServer, type Server } from './harness.ts'

/* The real server, rebooted with DOOP_STORYBOOK_PRIVATE_HOSTS so it may reach the fake Storybook on this machine (its own origin only): REST and MCP import land components on the "Imported components" page with enum props, the stream has the lines the contract names, and the refusals are what they should be. */

type Line = {
  type: string
  [key: string]: unknown
}

type Progress = { progress: number; total?: number; message?: string }

let server: Server
let storybook: FakeStorybook
let owner: Client
let canvasId: string
let agent: McpClient

/** An NDJSON answer read line by line. */
async function lines(res: Response): Promise<Line[]> {
  expect(res.headers.get('content-type')).toContain('application/x-ndjson')
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line)
}

const importUrl = (id = canvasId) => `/api/canvases/${id}/import/storybook`

async function canvasComponents() {
  const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as {
    components: { name: string; props: { name: string; type: string; options?: string[] }[] }[]
    pages: { id: string; name: string }[]
  }
  return { ...canvas, components: canvas.components ?? [], pages: canvas.pages ?? [] }
}

beforeAll(async () => {
  storybook = await startFakeStorybook()
  server = await startServer({ DOOP_STORYBOOK_PRIVATE_HOSTS: 'true' })
  owner = await new Client(server).signUp('owner@storybook.test', 'Owner')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Storybook' })).json()) as { id: string }).id
  const { secret } = (await (await owner.post('/api/agent-keys', { name: 'Agent' })).json()) as { secret: string }
  agent = new McpClient({ name: 'storybook-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 120_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
  await storybook?.close()
})

describe.skipIf(!findBrowserPath())(
  'importing a published Storybook over the real server',
  { timeout: 180_000 },
  () => {
    it('a dry run over REST plans from the index alone and writes nothing', async () => {
      const before = storybook.requests.filter((url) => url.startsWith('/sb/iframe.html')).length
      const res = await owner.post(importUrl(), { url: `${storybook.origin}/sb/`, package: '@acme/ui', dryRun: true })
      expect(res.status).toBe(200)
      const out = await lines(res)
      expect(out.map((line) => line.type)).toEqual(['plan', 'result'])
      expect(
        (out[0]!.components as { name: string; group: string; stories: number; renders: number }[]).map((c) => c.name),
      ).toEqual(['Button', 'Badge'])
      expect(out[0]!.components).toEqual([
        { name: 'Button', group: 'Inputs/Button', stories: 2, renders: 1 },
        { name: 'Badge', group: 'Data/Badge', stories: 1, renders: 1 },
      ])
      expect(out[0]!.renders).toBe(2)
      const result = out[1]!.result as { created: { name: string }[]; updated: unknown[] }
      expect(result.created.map((c) => c.name)).toEqual(['Button', 'Badge'])
      expect(result.updated).toEqual([])
      expect((await canvasComponents()).components).toEqual([])
      /* no story was rendered */
      expect(storybook.requests.filter((url) => url.startsWith('/sb/iframe.html')).length).toBe(before)
    })

    it('a real import over REST streams the plan, the progress and the result, and lands components with enum props', async () => {
      const res = await owner.post(importUrl(), { url: `${storybook.origin}/sb/`, package: '@acme/ui' })
      expect(res.status).toBe(200)
      const out = await lines(res)
      const kinds = out.map((line) => line.type)
      expect(kinds[0]).toBe('plan')
      expect(kinds.at(-1)).toBe('result')
      const progress = out.filter((line) => line.type === 'progress') as unknown as {
        rendered: number
        total: number
        component: string
      }[]
      expect(progress.length).toBeGreaterThan(3)
      progress.forEach((entry, index) => {
        expect(entry.rendered).toBe(index + 1)
        expect(entry.total).toBeGreaterThanOrEqual(entry.rendered)
        if (index) expect(entry.total).toBeGreaterThanOrEqual(progress[index - 1]!.total)
      })
      expect(progress.map((entry) => entry.component)).toContain('Button')
      const last = out.at(-1)! as unknown as {
        result: { created: { name: string; id: string }[]; pageId: string }
        issues: unknown[]
      }
      expect(last.result.created.map((c) => c.name).sort()).toEqual(['Badge', 'Button'])
      expect(Array.isArray(last.issues)).toBe(true)

      const canvas = await canvasComponents()
      const button = canvas.components.find((c) => c.name === 'Button')!
      expect(button.props.find((prop) => prop.name === 'tone')).toMatchObject({
        type: 'enum',
        options: ['primary', 'secondary'],
      })
      expect(button.props.find((prop) => prop.name === 'disabled')?.type).toBe('boolean')
      expect(canvas.pages.map((page) => page.name)).toContain('Imported components')
      expect(canvas.pages.some((page) => page.id === last.result.pageId)).toBe(true)
    })

    it('MCP import_storybook: a dry run, then again for real, which updates in place', async () => {
      const call = async (args: Record<string, unknown>, onprogress?: (progress: Progress) => void) => {
        const result = await agent.callTool(
          {
            name: 'import_storybook',
            arguments: { canvas_id: canvasId, agent_name: 'T', url: `${storybook.origin}/sb/`, ...args },
          },
          undefined,
          onprogress ? { onprogress } : undefined,
        )
        return { isError: result.isError, text: (result.content as { text: string }[])[0]!.text }
      }
      const dry = await call({ dry_run: true })
      expect(dry.isError).toBeFalsy()
      const dryData = JSON.parse(dry.text) as {
        dry_run: boolean
        created: unknown[]
        updated: { name: string }[]
        renders: number
      }
      expect(dryData.dry_run).toBe(true)
      expect(dryData.updated.map((entry) => entry.name).sort()).toEqual(['Badge', 'Button'])
      expect(dryData.renders).toBeGreaterThan(3)

      /* a client that sends a progress token hears one notification per render, which also starts the answer streaming at once (a long call would otherwise outlast a client's headers timeout) */
      const progress: Progress[] = []
      const real = await call({ package: '@acme/ui', include: ['Inputs'] }, (update) => progress.push(update))
      expect(real.isError).toBeFalsy()
      expect(progress.length).toBeGreaterThanOrEqual(2)
      expect(progress.map((update) => update.progress)).toEqual(
        [...progress.map((update) => update.progress)].sort((a, b) => a - b),
      )
      expect(progress.at(-1)?.message).toContain('Rendered Button')
      expect(progress.at(-1)?.total).toBeGreaterThanOrEqual(progress.at(-1)?.progress ?? 0)
      const data = JSON.parse(real.text) as {
        created: unknown[]
        updated: { name: string }[]
        unchanged: { name: string }[]
      }
      expect(data.created).toEqual([])
      expect([...data.updated, ...data.unchanged].map((entry) => entry.name)).toEqual(['Button'])
      expect((await canvasComponents()).components.map((c) => c.name).sort()).toEqual(['Badge', 'Button'])
    })

    it('the fourth import in an hour is refused, over REST and MCP, with a retry hint', async () => {
      const rest = await owner.post(importUrl(), { url: `${storybook.origin}/sb/` })
      expect(rest.status).toBe(429)
      expect(Number(rest.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(((await rest.json()) as { code: string }).code).toBe('too_many')
      const tool = await agent.callTool({
        name: 'import_storybook',
        arguments: { canvas_id: canvasId, agent_name: 'T', url: `${storybook.origin}/sb/` },
      })
      expect(tool.isError).toBe(true)
      expect((tool.content as { text: string }[])[0]!.text).toContain('Storybook imports in the last hour')
    })

    it('refuses a private Storybook, an address with no Storybook, a bad URL, a bad body and a stranger', async () => {
      const privateRun = await lines(
        await owner.post(importUrl(), { url: `${storybook.origin}/private/`, dryRun: true }),
      )
      expect(privateRun).toEqual([
        { type: 'error', code: 'private', message: expect.stringContaining('needs a sign-in') },
      ])
      const gone = await lines(await owner.post(importUrl(), { url: `${storybook.origin}/gone/`, dryRun: true }))
      expect(gone[0]).toMatchObject({ type: 'error', code: 'unreachable' })

      const bad = await owner.post(importUrl(), { url: 'ftp://x.test/', dryRun: true })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { code: string }).code).toBe('invalid')
      const body = await owner.post(importUrl(), {
        url: `${storybook.origin}/sb/`,
        package: 'Not A Package',
        dryRun: true,
      })
      expect(body.status).toBe(400)
      const include = await owner.post(importUrl(), { url: `${storybook.origin}/sb/`, include: 'Inputs', dryRun: true })
      expect(include.status).toBe(400)

      const stranger = await new Client(server).signUp('stranger@storybook.test', 'Stranger')
      const denied = await stranger.post(importUrl(), { url: `${storybook.origin}/sb/`, dryRun: true })
      expect([403, 404]).toContain(denied.status)
      const anonymous = await fetch(server.base + importUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect([401, 403]).toContain(anonymous.status)
    })
  },
)

describe('a server that has not opted in', () => {
  it('refuses a private Storybook address as private, before anything streams', async () => {
    const plain = await startServer()
    try {
      const client = await new Client(plain).signUp('plain@storybook.test', 'Plain')
      const id = ((await (await client.post('/api/canvases', { name: 'Plain' })).json()) as { id: string }).id
      const res = await client.post(`/api/canvases/${id}/import/storybook`, {
        url: `${storybook.origin}/sb/`,
        dryRun: true,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('private')
    } finally {
      plain.stop()
    }
  })
})
