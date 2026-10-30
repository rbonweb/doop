import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Replacing an uploaded stylesheet in place, against the real server: the same /a/<id>.css URL serves the next version, `?v=<n>` still serves earlier ones, stylesheets revalidate while images stay immutable, and frames that link the sheet are told to reload it.
 */

const V1 = ':root{--brand:#2743ee}\n.hero{background:var(--brand)}\n'
const V2 = ':root{--brand:#d0341f}\n.hero{background:var(--brand)}\n'
const V3 = ':root{--brand:#0e9f6e}\n.hero{background:var(--brand)}\n'

let server: Server
let owner: Client
let stranger: Client
let canvasId: string
let mcp: McpClient

interface ToolResult {
  content: Array<{ type: string; text?: string }>
}

const pathOf = (url: unknown) => new URL(String(url)).pathname

async function uploadCss(css: string): Promise<string> {
  const result = (await mcp.callTool({
    name: 'upload_asset',
    arguments: { canvas_id: canvasId, agent_name: 'Replace test', data: Buffer.from(css).toString('base64') },
  })) as unknown as ToolResult
  const body = JSON.parse(result.content.find((b) => b.type === 'text')?.text ?? '{}') as { url: string }
  return pathOf(body.url)
}

async function uploadPng(): Promise<string> {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
    .png()
    .toBuffer()
  const res = await owner.req(`/api/canvases/${canvasId}/assets`, {
    method: 'POST',
    body: new Uint8Array(png),
    headers: { 'Content-Type': 'image/png' },
  })
  return pathOf(((await res.json()) as { url: string }).url)
}

function replace(assetPath: string, css: string, as: Client = owner, onCanvas: string = canvasId) {
  const id = assetPath.slice('/a/'.length).replace(/\.\w+$/, '')
  return as.req(`/api/canvases/${onCanvas}/assets/${id}`, {
    method: 'PUT',
    body: css,
    headers: { 'Content-Type': 'text/css' },
  })
}

const get = (assetPath: string, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${assetPath}`, { headers: { 'Accept-Encoding': 'identity', ...headers } })

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('replace-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('replace-stranger@test.dev', 'Stranger')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Replace' })).json()) as { id: string }).id
  const key = (await (await owner.post('/api/agent-keys', { name: 'replace-test' })).json()) as { secret: string }
  mcp = new McpClient({ name: 'asset-replace-test', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
    }),
  )
}, 70_000)

afterAll(async () => {
  await mcp?.close()
  server?.stop()
})

describe('replacing a stylesheet in place', () => {
  it('keeps the URL, bumps the version, serves the latest and keeps earlier versions at ?v=', async () => {
    const path = await uploadCss(V1)
    expect(await (await get(path)).text()).toBe(V1)

    const res = await replace(path, V2)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; version: number; mime: string }
    expect(pathOf(body.url)).toBe(path)
    expect(body.version).toBe(2)
    expect(body.mime).toBe('text/css')

    expect(await (await get(path)).text()).toBe(V2)
    expect(await (await get(`${path}?v=1`)).text()).toBe(V1)
    expect(await (await get(`${path}?v=2`)).text()).toBe(V2)
    expect((await get(`${path}?v=3`)).status).toBe(404)
    expect((await get(`${path}?v=0`)).status).toBe(404)

    expect(((await (await replace(path, V3)).json()) as { version: number }).version).toBe(3)
    expect(await (await get(`${path}?v=1`)).text()).toBe(V1)
    expect(await (await get(`${path}?v=2`)).text()).toBe(V2)
    expect(await (await get(path)).text()).toBe(V3)
  })

  it('serves a replaced sheet to clients that accept compression, not the stale compressed body', async () => {
    const pad = '.grid-item{display:grid;gap:12px;padding:24px}\n'.repeat(300)
    const path = await uploadCss(`${V1}${pad}`)
    const first = await get(path, { 'Accept-Encoding': 'br' })
    expect(first.headers.get('content-encoding')).toBe('br')
    expect(await first.text()).toBe(`${V1}${pad}`)
    await replace(path, `${V2}${pad}`)
    expect(await (await get(path, { 'Accept-Encoding': 'br' })).text()).toBe(`${V2}${pad}`)
  })

  it('treats identical bytes as no change, and links no previous version that does not exist', async () => {
    const path = await uploadCss(V1)
    const body = (await (await replace(path, V1)).json()) as { version: number; unchanged: boolean }
    expect(body.version).toBe(1)
    expect(body.unchanged).toBe(true)
    expect(JSON.stringify(body)).not.toContain('?v=0')
    expect(body).not.toHaveProperty('previous_url')

    const second = (await (await replace(path, V2)).json()) as { unchanged: boolean; previous_url?: string }
    expect(second.unchanged).toBe(false)
    expect(pathOf(second.previous_url)).toBe(path)
    expect(second.previous_url).toMatch(/\?v=1$/)
    const again = (await (await replace(path, V2)).json()) as { version: number; unchanged: boolean }
    expect(again).toMatchObject({ version: 2, unchanged: true })
    expect(again).not.toHaveProperty('previous_url')
  })

  it('keeps version 1 at <id>.css and writes later versions to <id>-v<n>.css, never overwriting a served object', async () => {
    const stored = (key: string) => readFileSync(path.join(server.dataDir, 'data', 'assets', key), 'utf8')
    const assetPath = await uploadCss(V1)
    const id = assetPath.slice('/a/'.length).replace(/\.css$/, '')
    await replace(assetPath, V2)
    expect(stored(`${id}.css`)).toBe(V1)
    expect(stored(`${id}-v2.css`)).toBe(V2)
    await replace(assetPath, V3)
    expect(stored(`${id}.css`)).toBe(V1)
    expect(stored(`${id}-v2.css`)).toBe(V2)
    expect(stored(`${id}-v3.css`)).toBe(V3)
    expect(await (await get(`${assetPath}?v=2`)).text()).toBe(V2)
    expect(await (await get(assetPath)).text()).toBe(V3)
  })

  it('answers 500 JSON when storage fails, and leaves the served version alone', async () => {
    const assetPath = await uploadCss(V1)
    const id = assetPath.slice('/a/'.length).replace(/\.css$/, '')
    /* a directory where version 2 would be written makes the storage write throw */
    mkdirSync(path.join(server.dataDir, 'data', 'assets', `${id}-v2.css`))
    const res = await replace(assetPath, V2)
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(typeof ((await res.json()) as { error: string }).error).toBe('string')
    expect(await (await get(assetPath)).text()).toBe(V1)
    expect(await (await get(`${assetPath}?v=1`)).text()).toBe(V1)
  })

  it('refuses an image asset', async () => {
    const path = await uploadPng()
    const res = await replace(path, V2)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(
      /only stylesheets can be replaced.*images are immutable/,
    )
  })

  it('refuses bytes that are not a stylesheet and leaves the sheet alone', async () => {
    const path = await uploadCss(V1)
    for (const bad of ['<!doctype html><p>hi</p>', '{"a": 1}', '']) {
      const res = await replace(path, bad)
      expect(res.status).toBe(400)
    }
    expect(await (await get(path)).text()).toBe(V1)
  })

  it('answers 404 for an unknown asset and refuses someone who is not tied to the asset', async () => {
    expect((await replace('/a/doesnotexist.css', V2)).status).toBe(404)
    const path = await uploadCss(V1)
    expect([403, 404]).toContain((await replace(path, V2, stranger)).status)
    const own = ((await (await stranger.post('/api/canvases', { name: 'Own' })).json()) as { id: string }).id
    const res = await replace(path, V2, stranger, own)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('belongs to someone else')
    expect(await (await get(path)).text()).toBe(V1)
  })
})

describe('caching', () => {
  it('revalidates a stylesheet with a strong ETag of id-version and answers 304', async () => {
    const path = await uploadCss(V1)
    const id = path.slice('/a/'.length).replace(/\.css$/, '')
    const first = await get(path)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(first.headers.get('etag')).toBe(`"${id}-1"`)

    const again = await get(path, { 'If-None-Match': `"${id}-1"` })
    expect(again.status).toBe(304)

    await replace(path, V2)
    const after = await get(path, { 'If-None-Match': `"${id}-1"` })
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).toBe(`"${id}-2"`)
    expect(await after.text()).toBe(V2)
    expect((await get(path, { 'If-None-Match': `"${id}-2"` })).status).toBe(304)
  })

  it('keeps a pinned ?v= request immutable, and images immutable', async () => {
    const path = await uploadCss(V1)
    await replace(path, V2)
    const pinned = await get(`${path}?v=1`)
    expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const image = await get(await uploadPng())
    expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})

describe('frames that link the stylesheet', () => {
  it('are named in an asset:updated message to the canvas room, and only those', async () => {
    const path = await uploadCss(V1)
    const id = path.slice('/a/'.length).replace(/\.css$/, '')
    const frame = async (name: string, html: string) =>
      (
        (await (
          await owner.post(`/api/canvases/${canvasId}/frames`, { name, x: 0, y: 0, width: 200, height: 100, html })
        ).json()) as {
          id: string
        }
      ).id
    const linked = await frame('Linked', `<link rel="stylesheet" href="${server.base}${path}"><div class="hero"></div>`)
    const plain = await frame('Plain', '<div>no sheet</div>')
    /* asset_refs is written behind the frame write */
    await new Promise((r) => setTimeout(r, 300))

    const messages: ServerMessage[] = []
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage))
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'replace-test', name: 't', kind: 'user' }))
        ws.on('message', (d) => JSON.parse(String(d)).type === 'init' && resolve())
      })
    })
    try {
      expect((await replace(path, V2)).status).toBe(200)
      await expect
        .poll(() => messages.find((m) => m.type === 'asset:updated'), { timeout: 5000 })
        .toEqual({ type: 'asset:updated', assetId: id, version: 2, frameIds: [linked] })
      expect(JSON.stringify(messages.filter((m) => m.type === 'asset:updated'))).not.toContain(plain)
    } finally {
      ws.close()
    }
  })
})

describe('frames that link the stylesheet but are not in asset_refs yet', () => {
  it('are still told to reload: a frame created just before the replace is found in memory', async () => {
    const assetPath = await uploadCss(V1)
    const id = assetPath.slice('/a/'.length).replace(/\.css$/, '')
    const created = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Fresh',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      html: `<link rel="stylesheet" href="${server.base}${assetPath}"><div class="hero"></div>`,
    })
    const fresh = ((await created.json()) as { id: string }).id

    const messages: ServerMessage[] = []
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage))
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'replace-fresh', name: 't', kind: 'user' }))
        ws.on('message', (d) => JSON.parse(String(d)).type === 'init' && resolve())
      })
    })
    try {
      /* no wait: asset_refs is written on a debounce, so only the in-memory scan can know this frame */
      expect((await replace(assetPath, V2)).status).toBe(200)
      await expect
        .poll(() => messages.find((m) => m.type === 'asset:updated'), { timeout: 5000 })
        .toEqual({ type: 'asset:updated', assetId: id, version: 2, frameIds: [fresh] })
    } finally {
      ws.close()
    }
  })
})

describe('assetIdFromUrl', () => {
  it('reads the id from absolute and relative asset URLs, with or without ?v=', async () => {
    const { assetIdFromUrl } = await import('../server/assets.ts')
    expect(assetIdFromUrl('https://doop.example.com/a/Ab3_x-9Zq1.css')).toBe('Ab3_x-9Zq1')
    expect(assetIdFromUrl('http://localhost:4400/a/abc123.css?v=2')).toBe('abc123')
    expect(assetIdFromUrl('/a/abc123.css')).toBe('abc123')
    expect(assetIdFromUrl('/a/abc123.css?v=7#x')).toBe('abc123')
    expect(assetIdFromUrl('/a/abc123.png')).toBe('abc123')
    expect(assetIdFromUrl('https://doop.example.com/i/abc123.png')).toBeUndefined()
    expect(assetIdFromUrl('https://example.com/other/a/abc123.css')).toBeUndefined()
    expect(assetIdFromUrl('not a url')).toBeUndefined()
    expect(assetIdFromUrl('')).toBeUndefined()
  })
})
