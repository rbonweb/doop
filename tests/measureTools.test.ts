import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/* The frame is 400 px wide with one 1100 px section and a headline long
   enough to wrap over several lines at that width and fewer at 1200 px. */
const HTML = `<!doctype html><html><head><style>
* { box-sizing: border-box; margin: 0 }
body { font-family: monospace }
.hero { height: 1100px; padding: 24px; background: #ffffff }
h1 { font-size: 40px; line-height: 1.2; color: #111111 }
</style></head><body>
<section class="hero" data-doop-id="hero" data-doop-label="Hero">
<h1 data-doop-id="title">A headline long enough to wrap over several lines when the frame is narrow and settle into a couple of lines once the frame is wide</h1>
</section>
</body></html>`

interface TextContent {
  type: string
  text?: string
}

interface ToolAnswer {
  isError: boolean
  text: string
}

let server: Server
let budgetServer: Server
let owner: Client
let viewer: Client
let stranger: Client
let budgetUser: Client
let canvas: Canvas
let frame: Frame
let ownerAgent: McpClient
let viewerAgent: McpClient
let strangerAgent: McpClient
let budgetAgent: McpClient
let budgetFrame: Frame

async function mcp(base: string, secret: string): Promise<McpClient> {
  const client = new McpClient({ name: 'measure-tools-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return client
}

async function keyFor(client: Client, name: string): Promise<string> {
  const { secret } = await (await client.post('/api/agent-keys', { name })).json()
  return secret as string
}

async function call(client: McpClient, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: TextContent[]
    isError?: boolean
  }
  return {
    isError: result.isError === true,
    text: result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n'),
  }
}

async function json<T>(client: McpClient, name: string, args: Record<string, unknown>): Promise<T> {
  const answer = await call(client, name, args)
  expect(answer.isError, answer.text).toBe(false)
  return JSON.parse(answer.text) as T
}

async function makeFrame(client: Client, canvasId: string): Promise<Frame> {
  return (await (
    await client.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero', html: HTML, width: 400, height: 1400 })
  ).json()) as Frame
}

describe.skipIf(!findBrowserPath())('measure_frame and lint_frame', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    server = await startServer()
    budgetServer = await startServer({ MCP_RENDERS_PER_MIN: '2' })
    owner = await new Client(server).signUp('measure-owner@test.dev', 'Measure Owner')
    viewer = await new Client(server).signUp('measure-viewer@test.dev', 'Measure Viewer')
    stranger = await new Client(server).signUp('measure-stranger@test.dev', 'Measure Stranger')
    budgetUser = await new Client(budgetServer).signUp('measure-budget@test.dev', 'Measure Budget')

    canvas = (await (await owner.post('/api/canvases', { name: 'Measurements' })).json()) as Canvas
    frame = await makeFrame(owner, canvas.id)
    expect(
      (await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'measure-viewer@test.dev', role: 'view' }))
        .status,
    ).toBe(200)

    ownerAgent = await mcp(server.base, await keyFor(owner, 'measure owner'))
    viewerAgent = await mcp(server.base, await keyFor(viewer, 'measure viewer'))
    strangerAgent = await mcp(server.base, await keyFor(stranger, 'measure stranger'))
    budgetAgent = await mcp(budgetServer.base, await keyFor(budgetUser, 'measure budget'))

    const budgetCanvas = (await (await budgetUser.post('/api/canvases', { name: 'Budget' })).json()) as Canvas
    budgetFrame = await makeFrame(budgetUser, budgetCanvas.id)
  }, 120_000)

  afterAll(async () => {
    await ownerAgent?.close()
    await viewerAgent?.close()
    await strangerAgent?.close()
    await budgetAgent?.close()
    server?.stop()
    budgetServer?.stop()
  })

  it('measures section heights and text line counts', async () => {
    const started = Date.now()
    const measurement = await json<{
      width: number
      height: number
      sections: Array<{
        element_id: string | null
        box: { height: number }
        texts: Array<{ element_id: string | null; lines: number }>
      }>
    }>(ownerAgent, 'measure_frame', { frame_id: frame.id, agent_name: 'Measurer' })
    console.info(`measure_frame at ${frame.width}px: ${Date.now() - started} ms`)

    expect(measurement.width).toBe(400)
    const hero = measurement.sections.find((section) => section.element_id === 'hero')
    expect(hero, JSON.stringify(measurement.sections.map((section) => section.element_id))).toBeDefined()
    expect(hero!.box.height).toBe(1100)
    const title = hero!.texts.find((block) => block.element_id === 'title')
    expect(title).toBeDefined()
    expect(title!.lines).toBeGreaterThanOrEqual(3)
  })

  it('changes line counts with the width', async () => {
    const narrow = await json<{
      sections: Array<{ element_id: string | null; texts: Array<{ element_id: string | null; lines: number }> }>
    }>(ownerAgent, 'measure_frame', { frame_id: frame.id, agent_name: 'Measurer' })
    const wide = await json<{
      width: number
      sections: Array<{
        element_id: string | null
        box: { height: number }
        texts: Array<{ element_id: string | null; lines: number }>
      }>
    }>(ownerAgent, 'measure_frame', { frame_id: frame.id, width: 1200, agent_name: 'Measurer' })
    expect(wide.width).toBe(1200)
    expect(wide.sections[0]!.box.height).toBe(1100)
    const narrowTitle = narrow.sections[0]!.texts.find((block) => block.element_id === 'title')!
    const wideTitle = wide.sections[0]!.texts.find((block) => block.element_id === 'title')!
    expect(wideTitle.lines).toBeLessThan(narrowTitle.lines)
  })

  it('fails the rules a frame breaks and names the offenders', async () => {
    const started = Date.now()
    const report = await json<{
      pass: boolean
      summary: string
      results: Array<{ rule: string; pass: boolean; offenders: string[]; details: string[] }>
    }>(ownerAgent, 'lint_frame', {
      frame_id: frame.id,
      rules: { max_section_height: 900, max_heading_lines: 2 },
      agent_name: 'Linter',
    })
    console.info(`lint_frame with two rules: ${Date.now() - started} ms`)

    expect(report.pass).toBe(false)
    expect(report.summary).toBe('0 of 2 rules pass')
    const height = report.results.find((result) => result.rule === 'max_section_height')!
    expect(height.pass).toBe(false)
    expect(height.offenders).toContain('hero')
    expect(height.details.join('\n')).toContain('1100px')
    const heading = report.results.find((result) => result.rule === 'max_heading_lines')!
    expect(heading.pass).toBe(false)
    expect(heading.offenders).toContain('title')
  })

  it('passes rules the frame meets', async () => {
    const report = await json<{ pass: boolean; summary: string }>(ownerAgent, 'lint_frame', {
      frame_id: frame.id,
      rules: { max_section_height: 2000, max_heading_lines: 50 },
      agent_name: 'Linter',
    })
    expect(report.pass).toBe(true)
    expect(report.summary).toBe('2 of 2 rules pass')
  })

  it('refuses an empty rule set', async () => {
    const answer = await call(ownerAgent, 'lint_frame', { frame_id: frame.id, rules: {}, agent_name: 'Linter' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('give at least one rule')
  })

  it('lets a view-only account measure', async () => {
    const measurement = await json<{ width: number }>(viewerAgent, 'measure_frame', {
      frame_id: frame.id,
      agent_name: 'Viewer',
    })
    expect(measurement.width).toBe(400)
  })

  it('refuses an account without access to the canvas', async () => {
    const answer = await call(strangerAgent, 'measure_frame', { frame_id: frame.id, agent_name: 'Stranger' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('no frame with id')
  })

  it('refuses past the per-user render budget', async () => {
    for (let i = 0; i < 2; i++) {
      const allowed = await call(budgetAgent, 'measure_frame', { frame_id: budgetFrame.id, agent_name: 'Budget' })
      expect(allowed.isError, allowed.text).toBe(false)
    }
    const refused = await call(budgetAgent, 'measure_frame', { frame_id: budgetFrame.id, agent_name: 'Budget' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('render rate limit')
  })
})
