import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * GET /i/<frame>.<ext> end to end against a real server: persisted renders, crops, webp, ETag and 304, the immutable pinned URL, and the render budget with its agent-key exemption.
 */

interface FrameRow {
  id: string
  updatedAt: number
}

const html = (colour: string) =>
  `<!doctype html><html><head><style>*{margin:0}</style></head><body><div style="width:600px;height:400px;background:${colour}"></div></body></html>`

interface Rig {
  server: Server
  owner: Client
  key: string
  canvasId: string
  frame: FrameRow
}

async function rig(env: Record<string, string>, email: string, reuseDir?: string): Promise<Rig> {
  const server = await startServer(env, reuseDir)
  const owner = await new Client(server).signUp(email, 'Owner')
  const canvas = (await (await owner.post('/api/canvases', { name: 'Renders' })).json()) as { id: string }
  const key = ((await (await owner.post('/api/agent-keys', { name: 'render-test' })).json()) as { secret: string })
    .secret
  const frame = (await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Hero',
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      html: html('#2743ee'),
    })
  ).json()) as FrameRow
  return { server, owner, key, canvasId: canvas.id, frame }
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

/** A distinct, cheap, uncached render of the frame: a small crop at a new size. */
const distinct = (frameId: string, n: number) => `/i/${frameId}.png?x=0&y=0&w=${20 + n}&h=20`

describe.skipIf(!findBrowserPath())('the /i/ render budget', { timeout: 120_000 }, () => {
  let r: Rig
  let stranger: Client
  let strangerKey: string

  beforeAll(async () => {
    r = await rig({ PREVIEW_RENDERS_PER_MIN: '3' }, 'budget-owner@test.dev')
    stranger = await new Client(r.server).signUp('budget-stranger@test.dev', 'Stranger')
    strangerKey = ((await (await stranger.post('/api/agent-keys', { name: 'stranger' })).json()) as { secret: string })
      .secret
  }, 70_000)

  afterAll(() => r?.server.stop())

  it('answers the fourth distinct uncached anonymous render in a minute with 429 and Retry-After', async () => {
    for (let i = 0; i < 3; i++) expect((await fetch(r.server.base + distinct(r.frame.id, i))).status).toBe(200)
    const limited = await fetch(r.server.base + distinct(r.frame.id, 3))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('still serves a cached render once the budget is spent', async () => {
    expect((await fetch(r.server.base + distinct(r.frame.id, 0))).status).toBe(200)
  })

  it('gives a key of someone with no access to the canvas no extra budget', async () => {
    const res = await fetch(r.server.base + distinct(r.frame.id, 4), { headers: bearer(strangerKey) })
    expect(res.status).toBe(429)
  })

  it('lets the owner agent key render past the budget, in sequence and at once', async () => {
    for (let i = 10; i < 16; i++) {
      const res = await fetch(r.server.base + distinct(r.frame.id, i), { headers: bearer(r.key) })
      expect(res.status).toBe(200)
    }
    const burst = await Promise.all(
      [20, 21, 22, 23].map((n) => fetch(r.server.base + distinct(r.frame.id, n), { headers: bearer(r.key) })),
    )
    expect(burst.map((res) => res.status)).toEqual([200, 200, 200, 200])
  })
})

describe.skipIf(!findBrowserPath())('the /i/ route', { timeout: 120_000 }, () => {
  let r: Rig
  let mcp: McpClient
  const timings: Record<string, number> = {}

  beforeAll(async () => {
    r = await rig({ PREVIEW_RENDERS_PER_MIN: '1000' }, 'route-owner@test.dev')
    mcp = new McpClient({ name: 'render-route-test', version: '1.0.0' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${r.server.base}/mcp`), {
        requestInit: { headers: bearer(r.key) },
      }),
    )
  }, 70_000)

  afterAll(async () => {
    await mcp?.close()
    r?.server.stop()
  })

  const url = (path: string) => r.server.base + path

  it('renders cold, then serves warm from cache with the same ETag', async () => {
    const path = `/i/${r.frame.id}.png`
    let t = performance.now()
    const cold = await fetch(url(path))
    const coldBytes = Buffer.from(await cold.arrayBuffer())
    timings.cold = performance.now() - t
    expect(cold.status).toBe(200)
    expect(cold.headers.get('content-type')).toBe('image/png')
    const etag = cold.headers.get('etag')
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/)
    expect((await sharp(coldBytes).metadata()).width).toBe(600)

    t = performance.now()
    const warm = await fetch(url(path))
    await warm.arrayBuffer()
    timings.warm = performance.now() - t
    expect(warm.status).toBe(200)
    expect(warm.headers.get('etag')).toBe(etag)
    expect(timings.warm).toBeLessThan(50)
  })

  it('answers If-None-Match with a 304 and no body', async () => {
    const path = `/i/${r.frame.id}.png`
    const etag = (await fetch(url(path))).headers.get('etag')!
    const t = performance.now()
    const res = await fetch(url(path), { headers: { 'If-None-Match': etag } })
    timings.notModified = performance.now() - t
    expect(res.status).toBe(304)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
    expect(res.headers.get('etag')).toBe(etag)
  })

  it('crops to webp, from the query or the extension', async () => {
    const query = await fetch(url(`/i/${r.frame.id}.png?format=webp&x=0&y=100&w=200&h=150`))
    expect(query.status).toBe(200)
    expect(query.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await query.arrayBuffer())).metadata()
    expect(meta.format).toBe('webp')
    expect([meta.width, meta.height]).toEqual([200, 150])

    const ext = await fetch(url(`/i/${r.frame.id}.webp`))
    expect(ext.status).toBe(200)
    expect(ext.headers.get('content-type')).toBe('image/webp')
    expect((await sharp(Buffer.from(await ext.arrayBuffer())).metadata()).width).toBe(600)
  })

  it('pins a versioned URL as immutable and answers a bare one no-cache', async () => {
    const pinned = await fetch(url(`/i/${r.frame.id}.png?v=${r.frame.updatedAt}`))
    expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const bare = await fetch(url(`/i/${r.frame.id}.png`))
    expect(bare.headers.get('cache-control')).toBe('no-cache')
    const stale = await fetch(url(`/i/${r.frame.id}.png?v=${r.frame.updatedAt - 1}`))
    expect(stale.headers.get('cache-control')).toBe('no-cache')
  })

  it('refuses a crop outside the frame or a partial one with 400', async () => {
    const outside = await fetch(url(`/i/${r.frame.id}.png?x=5000&y=0&w=10&h=10`))
    expect(outside.status).toBe(400)
    expect(((await outside.json()) as { error: string }).error).toBeTruthy()
    expect((await fetch(url(`/i/${r.frame.id}.png?x=0&y=0`))).status).toBe(400)
    expect((await fetch(url(`/i/${r.frame.id}.png?format=gif`))).status).toBe(400)
  })

  it('export_frame returns a pinned image_url, a live_url without the version, and webp', async () => {
    const call = async (args: Record<string, unknown>) => {
      const result = (await mcp.callTool({
        name: 'export_frame',
        arguments: { frame_id: r.frame.id, ...args },
      })) as { content: Array<{ type: string; text?: string }> }
      return JSON.parse(result.content.find((b) => b.type === 'text')?.text ?? '{}') as Record<string, string>
    }
    const png = await call({ scale: 1 })
    expect(new URL(png.image_url!).searchParams.get('v')).toBe(String(r.frame.updatedAt))
    expect(new URL(png.live_url!).searchParams.has('v')).toBe(false)
    expect(png.download_url).toContain('&download')
    const webp = await call({ format: 'webp', scale: 1, quality: 70 })
    expect(new URL(webp.image_url!).pathname).toBe(`/i/${r.frame.id}.webp`)
    const res = await fetch(webp.image_url!)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await fetch(png.live_url!)).status).toBe(200)
  })

  it('changes the bare URL ETag after the frame is edited', async () => {
    const path = `/i/${r.frame.id}.png`
    const before = (await fetch(url(path))).headers.get('etag')
    const edit = await r.owner.patch(`/api/frames/${r.frame.id}`, { html: html('#e6194b') })
    expect(edit.status).toBe(200)
    const after = await fetch(url(path))
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).not.toBe(before)
  })

  it('serves the same URL from storage after a restart, without rendering', async () => {
    const path = `/i/${r.frame.id}.png?x=0&y=0&w=300&h=200`
    const first = await fetch(url(path))
    const bytes = Buffer.from(await first.arrayBuffer())
    expect(first.status).toBe(200)
    /* the persist is fire and forget: this request is answered from memory once it has landed */
    expect((await fetch(url(path))).status).toBe(200)

    const { dataDir } = r.server
    r.server.stop({ keepData: true })
    await r.server.stopped
    const server = await startServer({ PREVIEW_RENDERS_PER_MIN: '1000' }, dataDir)
    r = { ...r, server }
    const t = performance.now()
    const again = await fetch(url(path))
    const body = Buffer.from(await again.arrayBuffer())
    timings.restart = performance.now() - t
    expect(again.status).toBe(200)
    expect(body.equals(bytes)).toBe(true)
    expect(timings.restart).toBeLessThan(200)
    console.log('render route timings (ms)', JSON.stringify(timings))
  })
})
