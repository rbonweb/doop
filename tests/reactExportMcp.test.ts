import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { runComponentTool, COMPONENT_TOOL_NAMES } from '../server/componentTools.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { resetReactExportBudget } from '../server/reactExport/canvasExport.ts'
import { RESIDENT_TOOLS, RESIDENT_TOOL_NAMES } from '../server/resident.ts'
import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'

/** export_react over MCP and its resident twin: the small inline answer, the zip for a large one, access, arguments and the budget. */

/** Tailwind mode imports the theme and utilities layers, never the bare import that would bring Preflight's reset along. */
function expectTailwindImports(css: string): void {
  expect(css).toContain('@import "tailwindcss/theme.css" layer(theme);')
  expect(css).toContain('@import "tailwindcss/utilities.css" layer(utilities);')
  expect(css).not.toContain('@import "tailwindcss";')
}

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }
const BUTTON = `<button class="btn"><span class="label">Start</span></button>`
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

type Block = { type: string; text?: string; resource?: { uri: string; mimeType: string; blob: string } }
type ToolResponse = { content: Block[]; isError?: boolean }

let client: Client
let stranger: Client

async function connect(userId: string): Promise<Client> {
  const server = buildMcpServer('Someone', userId)
  const next = new Client({ name: 'react-export-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await next.connect(a)
  return next
}

async function call(who: Client, name: string, args: Record<string, unknown>) {
  const response = (await who.callTool({ name, arguments: { ...AGENT, ...args } })) as ToolResponse
  await propagation.whenIdle()
  const texts = response.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
  let data: unknown
  try {
    data = JSON.parse(texts[0] ?? '')
  } catch {
    data = undefined
  }
  /* a tool's answer is whatever JSON it returns: the assertions are the type check */
  // eslint-disable-next-line typescript/no-explicit-any
  return { data: data as any, texts, blocks: response.content, isError: !!response.isError }
}

async function canvasWithButton() {
  const canvas = store.createCanvas('Agent shop', OWNER)
  const made = await call(client, 'create_component', {
    canvas_id: canvas.id,
    name: 'Button',
    html: BUTTON,
    css: '.btn{padding:8px}',
  })
  expect(made.isError).toBe(false)
  const frame = await call(client, 'create_frame', {
    canvas_id: canvas.id,
    name: 'Home page',
    html: doc('<h1>Welcome</h1><doop-use component="Button" label="Go"></doop-use>'),
  })
  expect(frame.isError).toBe(false)
  return { canvasId: canvas.id, frameId: frame.data.frame.id as string }
}

beforeEach(async () => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  resetReactExportBudget()
  client = await connect(OWNER)
  stranger = await connect('someone-else')
})

afterEach(async () => {
  await client.close()
  await stranger.close()
})

describe('export_react over MCP', () => {
  it('is a read-only tool with the scope arguments', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'export_react')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['canvas_id', 'frame_ids', 'page_id', 'component_ids', 'styling', 'tokens']),
    )
    expect(tool.description).toContain('get_guide')
  })

  it('answers the files and the report inline when they are small', async () => {
    const { canvasId, frameId } = await canvasWithButton()
    const out = await call(client, 'export_react', { canvas_id: canvasId, frame_ids: [frameId] })
    expect(out.isError).toBe(false)
    const paths = (out.data.files as { path: string }[]).map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining(['src/pages/Home-page.tsx', 'src/components/Button.tsx', 'export-report.json']),
    )
    expect(out.data.report.pages).toEqual([expect.objectContaining({ name: 'Home page' })])
    expect(out.data.report.components.map((component: { name: string }) => component.name)).toEqual(['Button'])
    expect(out.texts.join('\n')).toContain('Write each file at its path')
    expect(out.blocks.some((block) => block.type === 'resource')).toBe(false)
    const home = (out.data.files as { path: string; content: string }[]).find(
      (file) => file.path === 'src/pages/Home-page.tsx',
    )!
    expect(home.content).toContain('<Button')
  })

  it('exports components alone, by name, without tokens when asked', async () => {
    const { canvasId } = await canvasWithButton()
    const out = await call(client, 'export_react', { canvas_id: canvasId, component_ids: ['Button'], tokens: false })
    expect(out.isError).toBe(false)
    const paths = (out.data.files as { path: string }[]).map((file) => file.path)
    expect(paths).toContain('src/components/Button.tsx')
    expect(paths.some((path) => path.startsWith('src/pages/'))).toBe(false)
    expect(paths).not.toContain('src/tokens.css')
  })

  it('refuses an account that cannot see the canvas, a frame that is not there and bad arguments', async () => {
    const { canvasId } = await canvasWithButton()
    const denied = await call(stranger, 'export_react', { canvas_id: canvasId })
    expect(denied.isError).toBe(true)
    const missing = await call(client, 'export_react', { canvas_id: canvasId, frame_ids: ['nope'] })
    expect(missing.isError).toBe(true)
    expect(missing.texts.join('\n')).toContain('frame nope is not on this canvas')
    const badStyling = await call(client, 'export_react', { canvas_id: canvasId, styling: 'sass' }).catch(() => ({
      isError: true,
    }))
    expect(badStyling.isError).toBe(true)
  })

  it('exports in tailwind mode', async () => {
    const { canvasId, frameId } = await canvasWithButton()
    const out = await call(client, 'export_react', { canvas_id: canvasId, frame_ids: [frameId], styling: 'tailwind' })
    expect(out.isError).toBe(false)
    expect(out.data.report.styling).toBe('tailwind')
    const tokens = (out.data.files as { path: string; content: string }[]).find(
      (file) => file.path === 'src/tokens.css',
    )!
    expectTailwindImports(tokens.content)
  })

  it('hands a large export over as a zip resource, with the report and a file listing', async () => {
    const canvas = store.createCanvas('Long read', OWNER)
    const paragraphs = Array.from({ length: 1500 }, (_, i) => `<p>${'paragraph text '.repeat(14)}${i}</p>`).join('')
    const made = await call(client, 'create_frame', { canvas_id: canvas.id, name: 'Long', html: doc(paragraphs) })
    expect(made.isError).toBe(false)
    const out = await call(client, 'export_react', { canvas_id: canvas.id })
    expect(out.isError).toBe(false)
    expect(out.data.files.every((file: { content?: string }) => file.content === undefined)).toBe(true)
    expect(out.data.files.map((file: { path: string }) => file.path)).toContain('src/pages/Long.tsx')
    expect(out.data.zip.file_name).toBe('Long-read-react.zip')
    const resource = out.blocks.find((block) => block.type === 'resource')!.resource!
    expect(resource.mimeType).toBe('application/zip')
    expect(resource.uri).toBe(`doop://canvas/${canvas.id}/Long-read-react.zip`)
    const zip = await JSZip.loadAsync(Buffer.from(resource.blob, 'base64'))
    expect(Object.keys(zip.files)).toContain('Long-read-react/src/pages/Long.tsx')
    expect(Buffer.from(resource.blob, 'base64').length).toBe(out.data.zip.bytes)
  })

  it('shares the route budget: the 21st export in a minute is refused', async () => {
    const { canvasId } = await canvasWithButton()
    let refused: { isError: boolean; texts: string[] } | undefined
    for (let i = 0; i < 25 && !refused; i++) {
      const out = await call(client, 'export_react', { canvas_id: canvasId, component_ids: ['Button'] })
      if (out.isError) refused = out
    }
    expect(refused?.texts.join('\n')).toMatch(/rate limit/)
  })
})

describe('export_react limits', () => {
  it('is refused inside run_batch, with a pointer to call it directly', async () => {
    const { canvasId } = await canvasWithButton()
    const out = await call(client, 'run_batch', {
      ops: [{ tool: 'export_react', args: { canvas_id: canvasId, component_ids: ['Button'], agent_name: 'Tester' } }],
    })
    const text = out.texts.join('\n')
    expect(text).toContain('export_react cannot run inside run_batch')
    expect(out.blocks.some((block) => block.type === 'resource')).toBe(false)
  })

  it('refuses a request whose input is over the conversion bound before converting anything', async () => {
    const { canvasId, frameId } = await canvasWithButton()
    store.getFrame(frameId)!.html = doc(`<p>${'x'.repeat(8 * 1024 * 1024 + 1)}</p>`)
    const out = await call(client, 'export_react', { canvas_id: canvasId, frame_ids: [frameId] })
    expect(out.isError).toBe(true)
    expect(out.texts.join('\n')).toMatch(/too large to convert at once/)
  })

  it('does not spend the budget on a request that fails validation', async () => {
    const { canvasId } = await canvasWithButton()
    for (let i = 0; i < 30; i++) {
      const bad = await call(client, 'export_react', { canvas_id: canvasId, frame_ids: ['nope'] })
      expect(bad.texts.join('\n')).toContain('is not on this canvas')
    }
    const good = await call(client, 'export_react', { canvas_id: canvasId, component_ids: ['Button'] })
    expect(good.isError).toBe(false)
  })
})

describe('the resident twin', () => {
  it('is a tool of resident runs under the same name, in the same shape', () => {
    expect(COMPONENT_TOOL_NAMES).toContain('export_react')
    expect(RESIDENT_TOOL_NAMES).toContain('export_react')
    const twin = RESIDENT_TOOLS.find((tool) => tool.name === 'export_react')!
    expect(Object.keys((twin.input_schema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['frame_ids', 'page_id', 'component_ids', 'styling', 'tokens']),
    )
  })

  const context = (canvasId: string) => ({
    canvas: store.getCanvas(canvasId)!,
    actor: { name: 'Doop', kind: 'agent' as const, color: '#000' },
    canRead: () => true,
    canEdit: () => false,
    readableCanvases: () => [],
    userId: OWNER,
    surface: 'resident' as const,
  })

  it('returns the files inline for a small export', async () => {
    const { canvasId, frameId } = await canvasWithButton()
    const out = await runComponentTool('export_react', { frame_ids: [frameId] }, context(canvasId))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const data = out.result.data as { files: { path: string }[] }
    expect(data.files.map((file) => file.path)).toContain('src/components/Button.tsx')
    expect(out.result.attachment).toBeUndefined()
  })

  it('says to narrow the scope for a large one, and carries no zip', async () => {
    const canvas = store.createCanvas('Long read', OWNER)
    const paragraphs = Array.from({ length: 1500 }, (_, i) => `<p>${'paragraph text '.repeat(14)}${i}</p>`).join('')
    await call(client, 'create_frame', { canvas_id: canvas.id, name: 'Long', html: doc(paragraphs) })
    const out = await runComponentTool('export_react', {}, context(canvas.id))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.attachment).toBeUndefined()
    expect(out.result.data).toMatchObject({ too_large: true })
    expect(out.result.note).toMatch(/narrower scope/)
  })

  it('keeps one bucket per account whatever name the agent gives, and a different account its own', async () => {
    const { canvasId } = await canvasWithButton()
    const as = (name: string, budgetKey: string) => ({
      ...context(canvasId),
      actor: { name, kind: 'agent' as const, color: '#000' },
      userId: undefined,
      budgetKey,
    })
    let refused = ''
    for (let i = 0; i < 25 && !refused; i++) {
      const out = await runComponentTool('export_react', { component_ids: ['Button'] }, as(`Agent ${i}`, 'payer-1'))
      if (!out.ok) refused = out.error
    }
    expect(refused).toMatch(/rate limit/)
    const other = await runComponentTool('export_react', { component_ids: ['Button'] }, as('Agent 0', 'payer-2'))
    expect(other.ok).toBe(true)
  })

  it('answers inline only up to 100 KB where an MCP agent gets up to 300 KB', async () => {
    const canvas = store.createCanvas('Mid read', OWNER)
    const paragraphs = Array.from({ length: 700 }, (_, i) => `<p>${'paragraph text '.repeat(14)}${i}</p>`).join('')
    await call(client, 'create_frame', { canvas_id: canvas.id, name: 'Mid', html: doc(paragraphs) })
    const viaMcp = await call(client, 'export_react', { canvas_id: canvas.id })
    expect(viaMcp.data.files[0].content).toBeDefined()
    expect(viaMcp.blocks.some((block) => block.type === 'resource')).toBe(false)
    const resident = await runComponentTool('export_react', {}, context(canvas.id))
    expect(resident.ok && resident.result.data).toMatchObject({ too_large: true })
  })

  it('turns a bad argument into an error the agent can read', async () => {
    const { canvasId } = await canvasWithButton()
    const out = await runComponentTool('export_react', { styling: 'sass' }, context(canvasId))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/invalid export_react arguments/)
  })
})
