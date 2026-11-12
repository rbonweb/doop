import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* The search tools over a real server and the real /mcp endpoint, the way an
   agent key connects: find across frames, delete a batch, replace across frames. */

let server: Server
let agent: McpClient

beforeAll(async () => {
  server = await startServer()
  const owner = await new Client(server).signUp('search-tools@test.dev', 'Search Tools')
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Search agent' })).json()
  agent = new McpClient({ name: 'search-tools-http', version: '1.0.0' })
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

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return agent.callTool({ name, arguments: { agent_name: 'agent-a', ...args } })
}

async function created(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(name, args)
  expect(result.isError, textOf(result)).not.toBe(true)
  return jsonOf(result)
}

const HERO_HTML =
  '<!doctype html><html><head><style>.note::before { content: "styleonlymarker" }</style></head>' +
  '<body><main><h1>Welcome to Acme</h1><p>Buy now</p><img src="https://cdn.example.com/hero-photo.png"></main></body></html>'
const PRICING_HTML = '<html><body><main><h1>Pricing</h1><p>Buy now</p></main></body></html>'
const LOCKED_HTML = '<html><body><main><p>Buy now</p></main></body></html>'

interface Seeded {
  canvasId: string
  pageId: string
  heroId: string
  pricingId: string
  lockedId: string
}

async function seed(): Promise<Seeded> {
  const canvas = await created('create_canvas', { name: 'Search' })
  const canvasId = canvas.id as string
  const second = await created('create_canvas_page', { canvas_id: canvasId, name: 'Second' })
  const pageId = (second.page as { id: string }).id
  const hero = await created('create_frame', { canvas_id: canvasId, name: 'Hero', html: HERO_HTML })
  const heroId = (hero.frame as { id: string }).id
  const pricing = await created('create_frame', {
    canvas_id: canvasId,
    name: 'Pricing',
    html: PRICING_HTML,
    pageId,
  })
  const pricingId = (pricing.frame as { id: string }).id
  const locked = await created('create_frame', { canvas_id: canvasId, name: 'Locked', html: LOCKED_HTML })
  const lockedId = (locked.frame as { id: string }).id
  await created('update_frame', { frame_id: lockedId, locked: true })
  return { canvasId, pageId, heroId, pricingId, lockedId }
}

function frameIds(result: Record<string, unknown>): string[] {
  return (result.frames as { frameId: string }[]).map((frame) => frame.frameId)
}

async function frameHtml(frameId: string): Promise<string> {
  const frame = await created('get_frame', { frame_id: frameId })
  return frame.html as string
}

async function versionCount(frameId: string): Promise<number> {
  const listed = await created('list_frame_versions', { frame_id: frameId })
  return (listed.versions as unknown[]).length
}

describe('find_frames', () => {
  it('matches name, rendered text, source and image URLs, in canvas order', async () => {
    const { canvasId } = await seed()

    const byName = await created('find_frames', { canvas_id: canvasId, name: 'her' })
    expect(byName.total).toBe(1)
    expect(frameIds(byName)).toEqual([expect.any(String)])
    expect((byName.frames as { name: string }[])[0]!.name).toBe('Hero')

    const byText = await created('find_frames', { canvas_id: canvasId, text: 'welcome' })
    expect((byText.frames as { name: string }[]).map((frame) => frame.name)).toEqual(['Hero'])

    /* <style> content renders nowhere, so text search skips it while html search sees it */
    const styleText = await created('find_frames', { canvas_id: canvasId, text: 'styleonlymarker' })
    expect(styleText.total).toBe(0)
    const styleHtml = await created('find_frames', { canvas_id: canvasId, html: 'styleonlymarker' })
    expect((styleHtml.frames as { name: string }[]).map((frame) => frame.name)).toEqual(['Hero'])

    const byImage = await created('find_frames', { canvas_id: canvasId, image_src: 'HERO-PHOTO' })
    expect((byImage.frames as { name: string }[]).map((frame) => frame.name)).toEqual(['Hero'])

    const both = await created('find_frames', { canvas_id: canvasId, text: 'buy now', name: 'pricing' })
    expect((both.frames as { name: string }[]).map((frame) => frame.name)).toEqual(['Pricing'])
  })

  it('narrows to a page and refuses an unknown one with the page list', async () => {
    const { canvasId, pageId } = await seed()

    const page = await created('find_frames', { canvas_id: canvasId, text: 'buy now', page_id: pageId })
    expect((page.frames as { name: string; pageId: string }[]).map((frame) => frame.name)).toEqual(['Pricing'])
    expect((page.frames as { pageId: string }[])[0]!.pageId).toBe(pageId)

    const missing = await call('find_frames', { canvas_id: canvasId, text: 'buy now', page_id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('no page with id nope')
    expect(textOf(missing)).toContain('Second')
  })
})

describe('delete_frames', () => {
  it('reports a dry run, then deletes while locked and missing frames survive', async () => {
    const { canvasId, heroId, lockedId } = await seed()

    const dry = await created('delete_frames', {
      canvas_id: canvasId,
      frame_ids: [heroId, lockedId, 'nope'],
      dry_run: true,
    })
    expect(dry.wouldDelete).toEqual([{ frameId: heroId, name: 'Hero' }])
    expect(dry.locked).toEqual([{ frameId: lockedId, name: 'Locked' }])
    expect(dry.missing).toEqual(['nope'])
    expect(await frameHtml(heroId)).toContain('Welcome to Acme')

    const real = await created('delete_frames', { canvas_id: canvasId, frame_ids: [heroId, lockedId, 'nope'] })
    expect(real.deleted).toEqual([{ frameId: heroId, name: 'Hero' }])
    expect(real.locked).toEqual([{ frameId: lockedId, name: 'Locked' }])
    expect(real.missing).toEqual(['nope'])
    expect((await call('get_frame', { frame_id: heroId })).isError).toBe(true)
    expect(await frameHtml(lockedId)).toContain('Buy now')
  })
})

describe('replace_in_frames', () => {
  it('dry run reports counts without writing, then each changed frame gets one version', async () => {
    const { canvasId, heroId, lockedId } = await seed()
    const before = await versionCount(heroId)

    const dry = await created('replace_in_frames', {
      canvas_id: canvasId,
      find: 'Buy now',
      replace: 'Get started',
      scope: 'text',
      frame_ids: [heroId, lockedId],
      dry_run: true,
    })
    expect(dry.dryRun).toBe(true)
    expect(dry.frames).toEqual([
      { frameId: heroId, name: 'Hero', count: 1, snippets: [expect.stringContaining('Buy now')] },
    ])
    expect(dry.locked).toEqual([{ frameId: lockedId, name: 'Locked', count: 1 }])
    expect(dry.totalReplacements).toBe(1)
    expect(await frameHtml(heroId)).toContain('Buy now')
    expect(await versionCount(heroId)).toBe(before)

    const real = await created('replace_in_frames', {
      canvas_id: canvasId,
      find: 'Buy now',
      replace: 'Get started',
      scope: 'text',
      frame_ids: [heroId, lockedId],
    })
    expect(real.changed).toEqual([{ frameId: heroId, name: 'Hero', count: 1 }])
    expect(real.locked).toEqual([{ frameId: lockedId, name: 'Locked', count: 1 }])
    expect(real.totalReplacements).toBe(1)
    expect(
      textOf(
        await call('replace_in_frames', {
          canvas_id: canvasId,
          find: 'Buy now',
          replace: 'Get started',
          scope: 'text',
          frame_ids: [heroId],
          dry_run: true,
        }),
      ),
    ).toContain('get_frame_screenshot')

    expect(await frameHtml(heroId)).toContain('Get started')
    expect(await frameHtml(lockedId)).toContain('Buy now')
    expect(await versionCount(heroId)).toBe(before + 1)
  })

  it('refuses frame_ids with page_id and a catastrophic regex', async () => {
    const { canvasId, pageId, heroId } = await seed()

    const both = await call('replace_in_frames', {
      canvas_id: canvasId,
      find: 'Buy now',
      replace: 'x',
      scope: 'text',
      frame_ids: [heroId],
      page_id: pageId,
    })
    expect(both.isError).toBe(true)
    expect(textOf(both)).toContain('exclusive')

    const nested = await call('replace_in_frames', {
      canvas_id: canvasId,
      find: '(a+)+',
      replace: 'x',
      scope: 'html',
      regex: true,
    })
    expect(nested.isError).toBe(true)
    expect(textOf(nested)).toContain('catastrophically')
    expect(await frameHtml(heroId)).toContain('Buy now')
  })
})
