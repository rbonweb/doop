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

async function currentVersionOf(frameId: string): Promise<string> {
  const result = await call('get_frame', { frame_id: frameId, include_html: false })
  return jsonOf(result).updatedAt as string
}

async function versionCount(frameId = frame.id): Promise<number> {
  const result = await call('list_frame_versions', { frame_id: frameId })
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

interface OutlineRow {
  tag: string
  bytes: number
  compactBytes?: number
  elementId?: string
  element_id: string | null
  selector?: string
}

interface OutlineAnswer {
  version: string
  sections: OutlineRow[]
}

async function outlineOf(client: McpClient, frameId: string): Promise<OutlineAnswer> {
  const result = await client.callTool({
    name: 'get_frame',
    arguments: { frame_id: frameId, mode: 'outline', agent_name: 'Sections' },
  })
  return jsonOf(result).outline as OutlineAnswer
}

async function frameHtml(frameId: string): Promise<string> {
  return jsonOf(await call('get_frame', { frame_id: frameId })).html as string
}

describe('true section sizes and element ids in the outline', () => {
  let viewerAgent: McpClient
  let plain: Frame
  const footerFiller = 'F'.repeat(30_000)
  /* no ids anywhere, and a footer whose <p> is closed by the footer's end tag, not its own */
  const bare = `<!doctype html><html><body><header><h1>Top</h1></header><section><h2>Middle</h2></section><footer><p>${footerFiller}</footer></body></html>`

  beforeAll(async () => {
    const viewer = await new Client(server).signUp('sections-viewer@test.dev', 'Sections Viewer')
    expect(
      (await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'sections-viewer@test.dev', role: 'view' }))
        .status,
    ).toBe(200)
    const { secret } = await (await viewer.post('/api/agent-keys', { name: 'Sections viewer' })).json()
    viewerAgent = new McpClient({ name: 'sections-viewer', version: '1.0.0' })
    await viewerAgent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    plain = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Bare page', html: bare })).json()
  }, 60_000)

  afterAll(async () => {
    await viewerAgent?.close()
  })

  it('writes nothing for a view-only caller and gives a positional selector instead of an id', async () => {
    const before = await versionCount(plain.id)
    const outline = await outlineOf(viewerAgent, plain.id)
    expect(outline.sections.map((s) => s.element_id)).toEqual([null, null, null])
    expect(outline.sections.map((s) => s.selector)).toEqual(['body > header', 'body > section', 'body > footer'])
    expect(await frameHtml(plain.id)).toBe(bare)
    expect(await versionCount(plain.id)).toBe(before)
  })

  it('stamps every section once for an editor, keeps the version history and does not write again', async () => {
    const before = await versionCount(plain.id)
    const first = await outlineOf(agent, plain.id)
    expect(first.sections.every((s) => typeof s.element_id === 'string' && s.element_id.length > 0)).toBe(true)
    expect(first.sections.every((s) => s.elementId === s.element_id && s.selector === undefined)).toBe(true)
    expect(first.version).toBe(await currentVersionOf(plain.id))
    expect(await versionCount(plain.id)).toBe(before)

    const second = await outlineOf(agent, plain.id)
    expect(second.version).toBe(first.version)
    expect(second.sections.map((s) => s.element_id)).toEqual(first.sections.map((s) => s.element_id))
    expect(await currentVersionOf(plain.id)).toBe(first.version)
  })

  it('reports the footer at its real size, which replace_section then matches', async () => {
    const outline = await outlineOf(agent, plain.id)
    const footer = outline.sections[2]!
    const html = await frameHtml(plain.id)
    const span = html.indexOf('</footer>') + '</footer>'.length - html.indexOf('<footer')
    expect(footer.bytes).toBe(span)
    expect(footer.bytes).toBeGreaterThan(30_000)

    const replacement = '<footer data-doop-label="Footer"><p>short</p></footer>'
    const result = jsonOf(
      await call('replace_section', {
        frame_id: plain.id,
        target: { element_id: footer.element_id },
        html: replacement,
        expected_version: outline.version,
      }),
    )
    const replaced = result.replaced as {
      bytesBefore: number
      bytesAfter: number
      frameBytesBefore: number
      frameBytesAfter: number
    }
    expect(replaced.bytesBefore).toBe(footer.bytes)
    expect(replaced.frameBytesBefore - replaced.frameBytesAfter).toBe(footer.bytes - replacement.length)
    expect(replaced.frameBytesAfter).toBe((await frameHtml(plain.id)).length)
  })

  it('counts a component instance at its stored size and the <doop-use> form beside it', async () => {
    await call('create_component', {
      canvas_id: canvas.id,
      name: 'Big footer',
      description: 'A footer with a lot in it',
      html: `<footer class="big"><p>${footerFiller}</p></footer>`,
      css: '',
    })
    const withInstance = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Instance page',
        html: '<!doctype html><html><body><header><h1>Top</h1></header><doop-use component="Big footer"></doop-use></body></html>',
      })
    ).json()
    const outline = await outlineOf(agent, withInstance.id)
    const instance = outline.sections[1]!
    expect(instance.bytes).toBeGreaterThan(30_000)
    expect(instance.compactBytes).toBeLessThan(300)
    expect(instance.element_id).toMatch(/^[a-z0-9]{6}$/)
    /* the instance root already wears its instance id as data-doop-id: the outline reuses it, never stamps another */
    const stored = jsonOf(await call('get_frame', { frame_id: withInstance.id, expand_components: true }))
      .html as string
    expect(stored.split(`data-doop-id="${instance.element_id}"`)).toHaveLength(2)
    expect(await frameHtml(withInstance.id)).toContain(`id="${instance.element_id}"`)
    await call('patch_frame', {
      frame_id: withInstance.id,
      ops: [{ op: 'set_attr', target: { element_id: outline.sections[0]!.element_id }, name: 'data-x', value: '1' }],
      expected_version: outline.version,
    })
    const again = await outlineOf(agent, withInstance.id)
    expect(again.sections[1]!.element_id).toBe(instance.element_id)
    const replaceVersion = again.version

    const before = (
      jsonOf(await call('get_frame', { frame_id: withInstance.id, expand_components: true })).html as string
    ).length
    const replacement = '<footer data-doop-label="Footer">bye</footer>'
    const result = jsonOf(
      await call('replace_section', {
        frame_id: withInstance.id,
        target: { selector: 'doop-use' },
        html: replacement,
        expected_version: replaceVersion,
      }),
    )
    const replaced = result.replaced as {
      bytesBefore: number
      storedBytesBefore: number
      frameBytesBefore: number
      frameBytesAfter: number
    }
    expect(replaced.bytesBefore).toBe(instance.compactBytes)
    expect(replaced.storedBytesBefore).toBe(instance.bytes)
    expect(replaced.frameBytesBefore).toBe(before)
    expect(replaced.frameBytesBefore - replaced.frameBytesAfter).toBeGreaterThan(30_000 - 300)
  })
})
