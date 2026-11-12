import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * compose_frame over the real HTTP surface: sections resolved by label and element_id, their CSS kept apart,
 * structural rules reported as dropped, cross-canvas sources and ambiguous targets refused.
 */

let server: Server
let agent: McpClient

type ToolResult = Awaited<ReturnType<McpClient['callTool']>>

const textOf = (result: ToolResult) =>
  (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n')

const jsonOf = (result: ToolResult) =>
  JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>

const frameStyle = (html: string, scope: string) => {
  const marker = `<style data-doop-compose="${scope}">`
  const start = html.indexOf(marker) + marker.length
  return html.slice(start, html.indexOf('</style>', start))
}

async function createCanvas(name: string): Promise<string> {
  const result = await agent.callTool({ name: 'create_canvas', arguments: { name, agent_name: 'agent-a' } })
  expect(result.isError).toBeFalsy()
  return jsonOf(result).id as string
}

async function createFrame(canvasId: string, name: string, html: string): Promise<string> {
  const result = await agent.callTool({
    name: 'create_frame',
    arguments: { canvas_id: canvasId, name, html, width: 800, height: 600, agent_name: 'agent-a' },
  })
  expect(result.isError).toBeFalsy()
  return (jsonOf(result).frame as { id: string }).id
}

beforeAll(async () => {
  server = await startServer()
  const member = await new Client(server).signUp('compose-tools@test.dev', 'Compose Tools')
  const { secret } = await (await member.post('/api/agent-keys', { name: 'Compose agent' })).json()
  agent = new McpClient({ name: 'compose-tools-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

it('composes source sections in order with their CSS scoped, and refuses bad sources and targets', async () => {
  const canvasId = await createCanvas('Compose canvas')
  const frameA = await createFrame(
    canvasId,
    'Source A',
    `<!doctype html><html><head><style>
body { margin: 0 }
.title { color: rgb(200, 0, 0) }
section + section { border-top: 4px solid red }
</style></head><body>
<section data-doop-label="Overview"><h2 class="title">Alpha overview</h2></section>
<section data-doop-label="Features"><h2 class="title">Alpha features</h2></section>
</body></html>`,
  )
  const frameB = await createFrame(
    canvasId,
    'Source B',
    `<!doctype html><html><head><style>
.title { color: rgb(0, 0, 200) }
.panel { padding: 8px }
</style></head><body>
<section id="beta-panel" data-doop-id="beta-panel" class="panel"><h2 class="title">Beta panel</h2></section>
</body></html>`,
  )
  const secondPage = jsonOf(
    await agent.callTool({
      name: 'create_canvas_page',
      arguments: { canvas_id: canvasId, name: 'Composed page', agent_name: 'agent-a' },
    }),
  )
  const pageId = (secondPage.page as { id: string }).id

  const composed = await agent.callTool({
    name: 'compose_frame',
    arguments: {
      canvas_id: canvasId,
      name: 'Composed landing',
      page_id: pageId,
      width: 900,
      sections: [
        { frame_id: frameA, target: { label: 'Features' } },
        { frame_id: frameB, target: { element_id: 'beta-panel' } },
      ],
      agent_name: 'agent-a',
    },
  })
  expect(composed.isError).toBeFalsy()
  const answer = jsonOf(composed)
  const newFrameId = (answer.frame as { id: string }).id
  expect(answer.frame).toMatchObject({ pageId, width: 900, height: 1200 })
  expect(answer.documentRulesFrom).toBe(frameA)
  expect(typeof answer.headTags).toBe('number')
  const reports = answer.sections as { frameId: string; dropped: { selector: string; reason: string }[] }[]
  expect(reports.map((report) => report.frameId)).toEqual([frameA, frameB])
  expect(reports[0]!.dropped.some((rule) => rule.selector === 'section + section')).toBe(true)

  const frame = jsonOf(await agent.callTool({ name: 'get_frame', arguments: { frame_id: newFrameId } }))
  const html = frame.html as string
  expect(frame.pageId).toBe(pageId)
  expect(html).toContain(`data-doop-compose="s0-${frameA}"`)
  expect(html).toContain(`data-doop-compose="s1-${frameB}"`)
  expect(html).toContain(`data-doop-section="s0-${frameA}"`)
  expect(html).toContain(`data-doop-section="s1-${frameB}"`)
  expect(html.indexOf('Alpha features')).toBeLessThan(html.indexOf('Beta panel'))

  const firstCss = frameStyle(html, `s0-${frameA}`)
  const secondCss = frameStyle(html, `s1-${frameB}`)
  expect(firstCss).toContain('rgb(200, 0, 0)')
  expect(firstCss).not.toContain('rgb(0, 0, 200)')
  expect(secondCss).toContain('rgb(0, 0, 200)')
  expect(secondCss).not.toContain('rgb(200, 0, 0)')

  const otherCanvas = await createCanvas('Other canvas')
  const foreign = await createFrame(
    otherCanvas,
    'Foreign',
    '<!doctype html><html><body><section><p>Elsewhere</p></section></body></html>',
  )
  const crossCanvas = await agent.callTool({
    name: 'compose_frame',
    arguments: {
      canvas_id: canvasId,
      name: 'Impossible',
      width: 600,
      sections: [{ frame_id: foreign, target: { selector: 'section' } }],
      agent_name: 'agent-a',
    },
  })
  expect(crossCanvas.isError).toBe(true)
  expect(textOf(crossCanvas)).toContain(foreign)
  expect(textOf(crossCanvas)).toContain('another canvas')

  const ambiguous = await agent.callTool({
    name: 'compose_frame',
    arguments: {
      canvas_id: canvasId,
      name: 'Ambiguous',
      width: 600,
      sections: [{ frame_id: frameA, target: { selector: '.title' } }],
      agent_name: 'agent-a',
    },
  })
  expect(ambiguous.isError).toBe(true)
  expect(textOf(ambiguous)).toContain('matches 2 elements')
  expect(textOf(ambiguous)).toContain('Candidates:')
  expect(textOf(ambiguous)).toContain('"path"')
})

it('reports what compose_frame would build on a dry run and creates no frame', async () => {
  const canvasId = await createCanvas('Compose dry run')
  const source = await createFrame(
    canvasId,
    'Dry source',
    `<!doctype html><html><head><style>
body { margin: 0 }
.title { color: rgb(200, 0, 0) }
section + section { border-top: 1px solid red }
</style></head><body>
<section data-doop-label="Hero"><h2 class="title">Hero</h2></section>
<section data-doop-label="Footer"><h2 class="title">Footer</h2></section>
</body></html>`,
  )
  const frames = async () =>
    jsonOf(await agent.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId, fields: ['frames'] } }))
      .frames as { id: string; version?: unknown; updatedAt?: unknown }[]
  const before = await frames()
  const args = {
    canvas_id: canvasId,
    name: 'Dry page',
    width: 900,
    sections: [{ frame_id: source, target: { label: 'Hero' } }],
    agent_name: 'agent-a',
  }
  const dry = await agent.callTool({ name: 'compose_frame', arguments: { ...args, dry_run: true } })
  expect(dry.isError).toBeFalsy()
  const report = jsonOf(dry) as {
    dry_run: boolean
    frame?: unknown
    htmlBytes: number
    sections: { frameId: string; frameName: string; carriedRules: number; dropped: unknown[] }[]
  }
  expect(report.dry_run).toBe(true)
  expect(report.frame).toBeUndefined()
  expect(report.htmlBytes).toBeGreaterThan(100)
  expect(report.sections).toHaveLength(1)
  expect(report.sections[0]).toMatchObject({ frameId: source, frameName: 'Dry source', carriedRules: 1 })
  /* nothing was created: the same frames, at the same versions */
  expect(await frames()).toEqual(before)
  /* a dry run still refuses what the real call refuses */
  const bad = await agent.callTool({
    name: 'compose_frame',
    arguments: { ...args, sections: [{ frame_id: 'nope', target: { label: 'Hero' } }], dry_run: true },
  })
  expect(bad.isError).toBe(true)
  /* and the real call builds the frame of that size */
  const real = jsonOf(await agent.callTool({ name: 'compose_frame', arguments: args }))
  expect((await frames()).length).toBe(before.length + 1)
  expect(real.sections).toEqual(report.sections.map(({ frameName: _frameName, ...section }) => section))
})
