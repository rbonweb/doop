import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/** snapshot_frame and list_assets over MCP HTTP on a real server, plus the upload provenance and get_frame image details they feed. */

let server: Server
let owner: Client
let viewer: Client
let canvasId: string
let frameId: string
let ownerKey: string
let viewerKey: string
let snapshotUrl = ''

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('snapshot-owner@test.dev', 'Owner')
  viewer = await new Client(server).signUp('snapshot-viewer@test.dev', 'Viewer')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Snapshots' })).json()).id
  const viewerId = (await (await viewer.get('/api/me')).json()).id
  await owner.post(`/api/canvases/${canvasId}/members`, { email: 'snapshot-viewer@test.dev' })
  await owner.patch(`/api/canvases/${canvasId}/members/${viewerId}`, { role: 'view' })
  const body =
    '<!doctype html><html><head><style>*{margin:0}</style></head><body><section style="width:400px;height:300px;background:#1d4ed8"></section><section data-doop-id="hero" style="width:200px;height:100px;background:#f59e0b"></section></body></html>'
  frameId = (
    (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Card', width: 400, height: 400, html: body })
    ).json()) as {
      id: string
    }
  ).id
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'owner-agent' })).json()).secret
  viewerKey = (await (await viewer.post('/api/agent-keys', { name: 'viewer-agent' })).json()).secret
}, 90_000)

afterAll(() => server?.stop())

async function mcpCall(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text?: string }[] } }
  const text = body.result.content.map((block) => block.text ?? '').join('\n')
  return { isError: !!body.result.isError, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

describe.skipIf(!findBrowserPath())('snapshot tools over MCP', { timeout: 90_000 }, () => {
  it('snapshots a frame to a permanent webp that GETs at the reported size', async () => {
    const started = Date.now()
    const call = await mcpCall(ownerKey, 'snapshot_frame', {
      frame_id: frameId,
      format: 'webp',
      agent_name: 'Snapshot Agent',
      tags: ['hero', 'card'],
    })
    const elapsed = Date.now() - started
    expect(call.isError, call.text).toBe(false)
    const body = call.json()
    snapshotUrl = String(body.url)
    console.info(`snapshot_frame over MCP: ${elapsed} ms, ${String(body.bytes)} bytes`)
    expect(snapshotUrl).toBe(`${server.base}/a/${String(body.asset_id)}.webp`)
    expect(body).toMatchObject({ format: 'webp', width: 400, height: 400 })
    expect(String(body.html_snippet)).toContain(`src="${snapshotUrl}"`)
    const img = await fetch(snapshotUrl)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/webp')
    const bytes = Buffer.from(await img.arrayBuffer())
    expect(bytes.length).toBe(body.bytes)
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 400, height: 400 })
  })

  it('refuses a viewer who may not write the canvas', async () => {
    const call = await mcpCall(viewerKey, 'snapshot_frame', { frame_id: frameId, agent_name: 'Viewer Agent' })
    expect(call.isError).toBe(true)
    expect(call.text).toContain('edit')
  })

  it('lists assets filtered by tag, provenance kind and frame', async () => {
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const upload = await mcpCall(ownerKey, 'upload_asset', {
      canvas_id: canvasId,
      data: tinyPng,
      source: { kind: 'store', name: 'Pexels' },
      tags: ['photo'],
      agent_name: 'Snapshot Agent',
    })
    expect(upload.isError, upload.text).toBe(false)

    const byTag = await mcpCall(ownerKey, 'list_assets', { canvas_id: canvasId, tag: 'hero', agent_name: 'Snap' })
    const tagged = byTag.json()
    expect(Number(tagged.count)).toBe(1)
    expect((tagged.assets as { url: string }[])[0]?.url).toBe(snapshotUrl)

    const frames = (await mcpCall(ownerKey, 'list_assets', { canvas_id: canvasId, source_kind: 'frame' })).json()
    expect((frames.assets as { source: { kind: string } }[]).every((a) => a.source.kind === 'frame')).toBe(true)
    expect(Number(frames.count)).toBeGreaterThanOrEqual(1)

    const photos = (await mcpCall(ownerKey, 'list_assets', { canvas_id: canvasId, tag: 'photo' })).json()
    expect(photos.count).toBe(1)
    expect((photos.assets as { source: { kind: string; name: string } }[])[0]?.source).toMatchObject({
      kind: 'store',
      name: 'Pexels',
    })

    const forFrame = (await mcpCall(ownerKey, 'list_assets', { canvas_id: canvasId, frame_id: frameId })).json()
    expect(Number(forFrame.count)).toBe(0)
  })

  it('gives get_frame the image details of a frame that uses the snapshot', async () => {
    const linked = (
      (await (
        await owner.post(`/api/canvases/${canvasId}/frames`, {
          name: 'Linked',
          width: 400,
          height: 400,
          html: `<!doctype html><html><body><img src="${snapshotUrl}" alt=""></body></html>`,
        })
      ).json()) as { id: string }
    ).id
    const body = await expect
      .poll(
        async () => {
          const call = await mcpCall(ownerKey, 'get_frame', { frame_id: linked, include_html: false })
          return (call.json() as { image_assets?: unknown[] }).image_assets?.length ?? 0
        },
        { timeout: 5000, interval: 150 },
      )
      .toBeGreaterThan(0)
    expect(body).toBeDefined()
    const detail = (await mcpCall(ownerKey, 'get_frame', { frame_id: linked, include_html: false })).json() as {
      canvasId: string
      image_assets?: { url: string; source: { kind: string } }[]
    }
    expect(detail.canvasId).toBe(canvasId)
    expect(detail.image_assets?.[0]?.url).toBe(snapshotUrl)
    expect(detail.image_assets?.[0]?.source.kind).toBe('frame')
    const forLinked = (await mcpCall(ownerKey, 'list_assets', { canvas_id: canvasId, frame_id: linked })).json()
    expect(forLinked.count).toBe(1)
  })
})
