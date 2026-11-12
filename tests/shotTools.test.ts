import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/**
 * `get_frame_screenshot`'s target / region / format / actions parameters and `compare_frames`, against the REAL
 * server over MCP HTTP (see ./harness.ts): the images decoded, the text lines, and the access check.
 */

const HTML = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0 }
  body { background: #ffffff }
  #hero { position: absolute; left: 40px; top: 60px; width: 320px; height: 200px; background: #e6194b }
  #panel { position: absolute; left: 0; top: 300px; width: 200px; height: 100px; background: #3cb44b; display: none }
  #panel.open { display: block }
</style></head><body>
  <div id="hero" data-doop-id="hero"></div>
  <button id="tab" onclick="document.getElementById('panel').classList.add('open')">tab</button>
  <div id="panel"></div>
</body></html>`

interface Block {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

let server: Server
let ownerKey: string
let canvasId: string
let frameId: string
let secondFrameId: string
let strangerFrameId: string

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${ownerKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: Block[] } }
  return {
    isError: !!body.result.isError,
    content: body.result.content,
    text: body.result.content
      .map((block) => block.text ?? '')
      .filter((text) => text !== '')
      .join('\n'),
  }
}

async function imageSize(data: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(data, 'base64')).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

beforeAll(async () => {
  server = await startServer()
  const owner = await new Client(server).signUp('shots-owner@test.dev', 'Owner')
  const stranger = await new Client(server).signUp('shots-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Shots' })).json()).id
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'shots-agent' })).json()).secret
  const create = (body: Record<string, unknown>) =>
    owner.post(`/api/canvases/${canvasId}/frames`, { width: 640, height: 480, html: HTML, ...body })
  frameId = (await (await create({ name: 'Hero' })).json()).id
  secondFrameId = (await (await create({ name: 'Second', width: 320, height: 240 })).json()).id
  const otherCanvas = await (await stranger.post('/api/canvases', { name: 'Theirs' })).json()
  strangerFrameId = (
    await (await stranger.post(`/api/canvases/${otherCanvas.id}/frames`, { name: 'Theirs', html: HTML })).json()
  ).id
}, 120_000)

afterAll(() => server?.stop())

describe.skipIf(!findBrowserPath())('get_frame_screenshot parameters', { timeout: 120_000 }, () => {
  it('answers with the same PNG and text line when none of the new parameters is given', async () => {
    const result = await mcpCall('get_frame_screenshot', { frame_id: frameId, agent_name: 'Agent' })
    expect(result.isError).toBe(false)
    const image = result.content.find((block) => block.type === 'image')
    expect(image?.mimeType).toBe('image/png')
    expect(result.text).toMatch(/^Screenshot of “Hero” \(\d+×\d+@1x, html \d+ bytes\)/)
    expect(await imageSize(image!.data!)).toEqual({ width: 640, height: 480 })
  })

  it('returns the targeted element at its own full size', async () => {
    const result = await mcpCall('get_frame_screenshot', {
      frame_id: frameId,
      target: { element_id: 'hero' },
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    const image = result.content.find((block) => block.type === 'image')!
    expect(await imageSize(image.data!)).toEqual({ width: 320, height: 200 })
    expect(result.text).toMatch(/\(40,60 320×200, png, html \d+ bytes\)/)
  })

  it('encodes webp when asked', async () => {
    const result = await mcpCall('get_frame_screenshot', {
      frame_id: frameId,
      format: 'webp',
      scale: 1,
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    const image = result.content.find((block) => block.type === 'image')!
    expect(image.mimeType).toBe('image/webp')
    expect(result.text).toContain(', webp,')
  })

  it('renders a region and reports its bounds', async () => {
    const result = await mcpCall('get_frame_screenshot', {
      frame_id: frameId,
      region: { x: 40, y: 60, w: 100, h: 50 },
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    const image = result.content.find((block) => block.type === 'image')!
    expect(await imageSize(image.data!)).toEqual({ width: 100, height: 50 })
    expect(result.text).toContain('40,60 100×50')
  })

  it('reports a failing action instead of failing the call', async () => {
    const result = await mcpCall('get_frame_screenshot', {
      frame_id: frameId,
      actions: [{ click: '#missing' }],
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('actions: step 1')
  })
})

describe.skipIf(!findBrowserPath())('compare_frames', { timeout: 120_000 }, () => {
  it('joins two frames into one image wider than either', async () => {
    const result = await mcpCall('compare_frames', {
      items: [{ frame_id: frameId, label: 'A' }, { frame_id: secondFrameId }],
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    const image = result.content.find((block) => block.type === 'image')!
    expect(image.mimeType).toBe('image/webp')
    const size = await imageSize(image.data!)
    expect(size.width).toBeGreaterThan(640)
    expect(size.height).toBeGreaterThan(0)
    const payload = JSON.parse(result.content.find((block) => block.type === 'text')!.text!) as {
      image: { width: number; height: number; format: string }
      cells: { label: string; frame_id: string; region: string }[]
    }
    expect(payload.image).toEqual({ width: size.width, height: size.height, format: 'webp' })
    expect(payload.cells.map((cell) => cell.label)).toEqual(['A', 'Second'])
    expect(payload.cells[0]!.region).toBe('0,0 640×480')
  })

  it('captures a targeted section per cell', async () => {
    const result = await mcpCall('compare_frames', {
      items: [{ frame_id: frameId, target: { element_id: 'hero' } }],
      format: 'png',
      scale: 1,
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.content.find((block) => block.type === 'text')!.text!) as {
      cells: { label: string; region: string }[]
    }
    expect(payload.cells[0]!.label).toBe('Hero · element_id "hero"')
    expect(payload.cells[0]!.region).toBe('40,60 320×200')
  })

  it('refuses a frame the user cannot see', async () => {
    const result = await mcpCall('compare_frames', {
      items: [{ frame_id: frameId }, { frame_id: strangerFrameId }],
      agent_name: 'Agent',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`no frame with id ${strangerFrameId}`)
  })
})
