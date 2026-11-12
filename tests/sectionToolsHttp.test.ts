import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/* Real server, real MCP over HTTP: a generated 12-section page exercises the
   outline, section reads and multi-target patches without resending it. */

let server: Server
let owner: Client
let agent: McpClient
let canvas: Canvas
let frame: Frame

type ToolResult = Awaited<ReturnType<McpClient['callTool']>>

function textBlocks(result: ToolResult): string[] {
  return (result.content as { text?: string }[]).map((block) => block.text ?? '')
}

function textOf(result: ToolResult): string {
  return textBlocks(result).join('\n')
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textBlocks(result)[0]!) as Record<string, unknown>
}

function bytesOf(result: ToolResult): number {
  return Buffer.byteLength(textBlocks(result)[0] ?? '', 'utf8')
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return agent.callTool({ name, arguments: { ...args, agent_name: 'Sections' } })
}

async function currentVersion(): Promise<string> {
  const result = await call('get_frame', { frame_id: frame.id, include_html: false })
  return jsonOf(result).updatedAt as string
}

async function versionCount(): Promise<number> {
  const result = await call('list_frame_versions', { frame_id: frame.id })
  return (jsonOf(result).versions as unknown[]).length
}

function generatedPage(): string {
  const filler = 'A calm paragraph about layout, rhythm and hierarchy. '.repeat(218)
  const sections = Array.from({ length: 12 }, (_, index) => {
    const id = `s${index + 1}`
    return `<section data-doop-id="${id}" data-doop-label="Section ${index + 1}"><h2>Section ${index + 1}</h2><span class="chip">chip ${index + 1}</span><p>${filler}</p></section>`
  }).join('\n')
  return `<!doctype html><html><head><style>body { margin: 0 } .chip { display: inline-block }</style></head><body><main>${sections}</main></body></html>`
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('sections@test.dev', 'Sections Owner')
  canvas = await (await owner.post('/api/canvases', { name: 'Sections' })).json()
  frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Long page', html: generatedPage() })
  ).json()
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Sections agent' })).json()
  agent = new McpClient({ name: 'sections-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 120_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

describe('reading a frame by sections', () => {
  it('gets a small outline with labels and no html for a 140 KB page', async () => {
    const result = await call('get_frame', { frame_id: frame.id, mode: 'outline' })
    expect(result.isError).toBeFalsy()
    const outline = jsonOf(result)
    expect(outline).not.toHaveProperty('html')
    const sections = (outline.outline as { sections: { elementId?: string; label?: string }[] }).sections
    expect(sections).toHaveLength(12)
    expect(sections[0]?.label).toBe('Section 1')
    expect(sections[11]?.elementId).toBe('s12')
    expect(bytesOf(result)).toBeLessThan(5 * 1024)
    expect((outline.outline as { bytes: number }).bytes as number).toBeGreaterThan(130 * 1024)
  })

  it('reads one section by element id, label and selector', async () => {
    const byId = jsonOf(await call('get_section', { frame_id: frame.id, target: { element_id: 's3' } }))
    expect(byId).toMatchObject({ elementId: 's3', tag: 'section', label: 'Section 3', target: 'element_id "s3"' })
    expect(byId.html).toContain('<h2>Section 3</h2>')

    const byLabel = jsonOf(await call('get_section', { frame_id: frame.id, target: { label: 'Section 5' } }))
    expect(byLabel.elementId).toBe('s5')

    const bySelector = jsonOf(
      await call('get_section', { frame_id: frame.id, target: { selector: '[data-doop-id="s7"]' } }),
    )
    expect(bySelector.elementId).toBe('s7')
    expect(Number(bySelector.bytes)).toBeGreaterThan(10_000)
  })
})

describe('writing sections', () => {
  it('patches one heading in one write and one version, and answers small', async () => {
    const before = await versionCount()
    const result = await call('patch_frame', {
      frame_id: frame.id,
      ops: [{ op: 'set_text', target: { selector: '[data-doop-id="s1"] h2' }, text: 'Patched heading' }],
      expected_version: await currentVersion(),
    })
    expect(result.isError).toBeFalsy()
    expect(jsonOf(result)).toMatchObject({ ok: true, applied: 1, edits: 1 })
    expect(bytesOf(result)).toBeLessThan(3 * 1024)
    expect(await versionCount()).toBe(before + 1)
    const read = jsonOf(await call('get_section', { frame_id: frame.id, target: { element_id: 's1' } }))
    expect(read.html).toContain('<h2>Patched heading</h2>')
  })

  it('applies all: true to every selector match in one patch', async () => {
    const result = await call('patch_frame', {
      frame_id: frame.id,
      ops: [{ op: 'set_attr', target: { selector: '.chip' }, all: true, name: 'data-state', value: 'on' }],
      expected_version: await currentVersion(),
    })
    expect(result.isError).toBeFalsy()
    expect(jsonOf(result)).toMatchObject({ ok: true, applied: 1, edits: 12 })
    const read = jsonOf(await call('get_frame', { frame_id: frame.id }))
    expect((read.html as string).match(/data-state="on"/g)).toHaveLength(12)
  })

  it('writes nothing when any target is missing', async () => {
    const before = await versionCount()
    const result = await call('patch_frame', {
      frame_id: frame.id,
      ops: [
        { op: 'set_text', target: { selector: '[data-doop-id="s2"] h2' }, text: 'should not land' },
        { op: 'set_text', target: { selector: '#missing' }, text: 'nope' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('op 1 (set_text)')
    expect(textOf(result)).not.toContain('should not land')
    expect(await versionCount()).toBe(before)
    const read = jsonOf(await call('get_section', { frame_id: frame.id, target: { element_id: 's2' } }))
    expect(read.html).toContain('<h2>Section 2</h2>')
  })

  it('refuses a stale expected_version', async () => {
    const stale = await currentVersion()
    await call('patch_frame', {
      frame_id: frame.id,
      ops: [{ op: 'set_attr', target: { element_id: 's4' }, name: 'data-flag', value: 'a' }],
      expected_version: stale,
    })
    const result = await call('patch_frame', {
      frame_id: frame.id,
      ops: [{ op: 'set_attr', target: { element_id: 's4' }, name: 'data-flag', value: 'b' }],
      expected_version: stale,
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed since your read')
    const read = jsonOf(await call('get_section', { frame_id: frame.id, target: { element_id: 's4' } }))
    expect(read.html).toContain('data-flag="a"')
  })

  it('refuses a target on a component instance and names update_component', async () => {
    await call('create_component', {
      canvas_id: canvas.id,
      name: 'Button',
      description: 'The action button',
      html: '<button class="btn"><span>Go</span></button>',
      css: '.btn { padding: 8px 14px }',
    })
    const componentFrame = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Component use',
        html: '<main><doop-use component="Button" label="Go"></doop-use></main>',
      })
    ).json()
    const result = await call('patch_frame', {
      frame_id: componentFrame.id,
      ops: [{ op: 'set_attr', target: { selector: 'doop-use' }, name: 'data-state', value: 'on' }],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('update_component')
  })

  it('refuses replace_section with an unclosed tag and writes nothing', async () => {
    const before = await versionCount()
    const result = await call('replace_section', {
      frame_id: frame.id,
      target: { element_id: 's12' },
      html: '<div>oops',
      expected_version: await currentVersion(),
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no closing tag')
    expect(await versionCount()).toBe(before)
  })
})
