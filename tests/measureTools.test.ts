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

/* A brand-coloured page with a store screenshot mock-up: off-palette colours, a banned word, an image and an svg. */
const SHOT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=='
const SHOT_HTML = `<!doctype html><html><head><style>
* { box-sizing: border-box; margin: 0 }
body { font-family: monospace; background: #ffffff }
.brand { padding: 24px; background: #0177d3; color: #ffffff }
.tint { padding: 24px; background: #e6f1fb; color: #014a84 }
.shot { padding: 24px; background: #ff00aa; color: #00ffcc }
</style></head><body>
<section class="brand" data-doop-id="brand"><h1>Brand</h1></section>
<section class="tint" data-doop-id="tint"><p>A tint of the brand</p></section>
<section data-doop-id="mock">
<div class="shot" data-doop-id="shot"><p data-doop-id="shot-copy">synergy inside the mock-up</p></div>
<img data-doop-id="pic" alt="" width="40" height="40" style="border: 3px solid #12ab34; background: #ab12cd" src="${SHOT_PIXEL}">
<svg data-doop-id="art" width="40" height="40"><text x="0" y="20" style="color: #abcdef">x</text><rect width="10" height="10" fill="#fedcba" style="background-color: #fedcba"/></svg>
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

  describe('palette matching and exclude', () => {
    let shotFrame: Frame

    interface Report {
      pass: boolean
      results: Array<{ rule: string; pass: boolean; offenders: string[]; details: string[] }>
    }

    const lint = (args: Record<string, unknown>) =>
      json<Report>(ownerAgent, 'lint_frame', { frame_id: shotFrame.id, agent_name: 'Linter', ...args })

    beforeAll(async () => {
      shotFrame = (await (
        await owner.post(`/api/canvases/${canvas.id}/frames`, {
          name: 'Shot',
          html: SHOT_HTML,
          width: 600,
          height: 800,
        })
      ).json()) as Frame
    })

    it('flags off-palette colours, accepts tints, and names where each one is used', async () => {
      const report = await lint({ rules: { allowed_colors: ['#0177d3'] } })
      const palette = report.results[0]!
      expect(palette.pass).toBe(false)
      expect(palette.offenders).toEqual(expect.arrayContaining(['#ff00aa', '#00ffcc']))
      expect(palette.offenders).not.toContain('#e6f1fb')
      expect(palette.offenders).not.toContain('#014a84')
      expect(palette.details.join('\n')).toContain('first on shot')
    })

    it('never collects colours from inside an svg, while an image keeps its own box styles', async () => {
      const report = await lint({ rules: { allowed_colors: ['#0177d3'] } })
      const offenders = report.results[0]!.offenders
      for (const drawn of ['#abcdef', '#fedcba']) expect(offenders).not.toContain(drawn)
      expect(offenders).toEqual(expect.arrayContaining(['#12ab34', '#ab12cd']))
    })

    it('skips an excluded subtree for colours and banned words', async () => {
      const report = await lint({
        rules: { allowed_colors: ['#0177d3'], banned_words: ['synergy'] },
        exclude: ['[data-doop-id="shot"]', 'img'],
      })
      expect(report.pass, JSON.stringify(report.results)).toBe(true)
      const without = await lint({ rules: { banned_words: ['synergy'] } })
      expect(without.pass).toBe(false)
    })

    it('skips an excluded subtree for contrast', async () => {
      const exclude = ['.shot']
      const included = await lint({ rules: { min_contrast: 7 } })
      expect(included.results[0]!.offenders).toContain('shot-copy')
      const skipped = await lint({ rules: { min_contrast: 7 }, exclude })
      expect(skipped.results[0]!.offenders).not.toContain('shot-copy')
    })

    it('refuses an invalid exclude selector by name', async () => {
      const answer = await call(ownerAgent, 'lint_frame', {
        frame_id: shotFrame.id,
        rules: { allowed_colors: ['#0177d3'] },
        exclude: ['div[[nope'],
        agent_name: 'Linter',
      })
      expect(answer.isError).toBe(true)
      expect(answer.text).toContain('div[[nope')
    })
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
