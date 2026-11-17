import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { startFakeStorybook, type FakeStorybook } from './fakeStorybook.ts'
import { Client, startServer, type Server } from './harness.ts'

/* A Storybook import writes its components the way the CLI does: every definition whole (template, css, props, revision, main frame), in memory and in the database. The real server imports through REST and through MCP into two canvases, then is rebooted on its data directory and read again. */

interface Def {
  id: string
  name: string
  template: string
  css: string
  props: { name: string; type: string }[]
  rev: number
  mainFrameId: string | null
}

let server: Server
let storybook: FakeStorybook
let owner: Client
let secret: string
const canvases: Record<'rest' | 'mcp', string> = { rest: '', mcp: '' }

const componentsOf = async (canvasId: string): Promise<Def[]> => {
  const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as { components?: Def[] }
  return (canvas.components ?? []).filter((def) => !('deletedAt' in def && def.deletedAt))
}

function expectWhole(defs: Def[]) {
  expect(defs.map((def) => def.name).sort()).toEqual(['Badge', 'Button'])
  for (const def of defs) {
    expect(def.template, `${def.name} template`).toContain('<')
    expect(def.css, `${def.name} css`).not.toBe('')
    expect(def.rev, `${def.name} rev`).toBeGreaterThan(0)
    expect(def.mainFrameId, `${def.name} mainFrameId`).toBeTruthy()
  }
  const button = defs.find((def) => def.name === 'Button')!
  expect(button.props.map((prop) => [prop.name, prop.type]).sort()).toEqual([
    ['disabled', 'boolean'],
    ['label', 'text'],
    ['tone', 'enum'],
  ])
}

beforeAll(async () => {
  storybook = await startFakeStorybook()
  server = await startServer({ DOOP_STORYBOOK_PRIVATE_HOSTS: 'true' })
  owner = await new Client(server).signUp('persist@storybook.test', 'Owner')
  for (const key of ['rest', 'mcp'] as const) {
    canvases[key] = ((await (await owner.post('/api/canvases', { name: key })).json()) as { id: string }).id
  }
  secret = ((await (await owner.post('/api/agent-keys', { name: 'Agent' })).json()) as { secret: string }).secret
}, 120_000)

afterAll(async () => {
  server?.stop()
  await storybook?.close()
})

describe.skipIf(!findBrowserPath())('a Storybook import stores whole components', { timeout: 180_000 }, () => {
  it('imports over REST and MCP, and reads the same after a restart', async () => {
    /* the picker's order: a plan first (a dry run that writes nothing), then the import of what was picked */
    const plan = await owner.post(`/api/canvases/${canvases.rest}/import/storybook`, {
      url: `${storybook.origin}/sb/`,
      package: '@acme/ui',
      dryRun: true,
    })
    expect(plan.status).toBe(200)
    await plan.text()
    expect(await componentsOf(canvases.rest)).toEqual([])
    const res = await owner.post(`/api/canvases/${canvases.rest}/import/storybook`, {
      url: `${storybook.origin}/sb/`,
      package: '@acme/ui',
      include: ['Inputs/Button', 'Data/Badge'],
    })
    expect(res.status).toBe(200)
    await res.text()

    const agent = new McpClient({ name: 'persist', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    const tool = await agent.callTool({
      name: 'import_storybook',
      arguments: { canvas_id: canvases.mcp, agent_name: 'T', url: `${storybook.origin}/sb/`, package: '@acme/ui' },
    })
    expect(tool.isError).toBeFalsy()
    /* it answers with a job: read its status until it ends (each read is the wait, bounded by count) */
    const { job_id } = JSON.parse((tool.content as { text: string }[])[0]!.text) as { job_id: string }
    let status = 'running'
    for (let reads = 0; reads < 4000 && status === 'running'; reads++) {
      const read = await agent.callTool({
        name: 'get_import_status',
        arguments: { canvas_id: canvases.mcp, agent_name: 'T', job_id },
      })
      status = (JSON.parse((read.content as { text: string }[])[0]!.text) as { status: string }).status
    }
    expect(status).toBe('done')
    await agent.close()

    for (const id of Object.values(canvases)) expectWhole(await componentsOf(id))

    /* a reboot on the same database */
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({ DOOP_STORYBOOK_PRIVATE_HOSTS: 'true' }, dataDir)
    for (const id of Object.values(canvases)) expectWhole(await componentsOf(id))
  })
})
