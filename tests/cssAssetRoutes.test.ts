import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Stylesheet assets end to end, against the real server: upload_asset over MCP (data and ticket paths), the browser upload route that stays images-only, the /a/ route's headers, and a server render of a frame that links the uploaded stylesheet.
 */

const PORT = 5031
const THEME = '@charset "UTF-8";\n/* theme */\n:root{--brand:#2743ee}\n.hero{background:var(--brand);height:120px}\n'

let server: Server
let owner: Client
let canvasId: string
let mcp: McpClient

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function uploadTool(
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; body: Record<string, unknown> | string }> {
  const result = (await mcp.callTool({
    name: 'upload_asset',
    arguments: { canvas_id: canvasId, agent_name: 'CSS test', ...args },
  })) as unknown as ToolResult
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  try {
    return { isError: result.isError, body: JSON.parse(raw) as Record<string, unknown> }
  } catch {
    return { isError: result.isError, body: raw }
  }
}

function pathOf(url: unknown): string {
  return new URL(String(url)).pathname
}

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = await new Client(server).signUp('css-owner@test.dev', 'Owner')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'CSS' })).json()) as { id: string }).id
  const key = (await (await owner.post('/api/agent-keys', { name: 'css-test' })).json()) as { secret: string }
  mcp = new McpClient({ name: 'css-asset-test', version: '1.0.0' })
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

describe('upload_asset with a stylesheet', () => {
  it('stores base64 CSS and answers with a link tag', async () => {
    const { isError, body } = await uploadTool({ data: Buffer.from(THEME).toString('base64') })
    expect(isError).toBeFalsy()
    const res = body as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.mime).toBe('text/css')
    expect(String(res.url)).toMatch(new RegExp(`^http://localhost:${PORT}/a/[\\w-]+\\.css$`))
    expect(res.usage).toBe(`<link rel="stylesheet" href="${res.url}">`)
    expect(res.size_bytes).toBe(Buffer.byteLength(THEME))
  })

  it('takes CSS through a one-time ticket, the curl -T path', async () => {
    const { body } = await uploadTool({ local_file: true })
    const ticket = body as { upload_url: string; command: string }
    expect(ticket.command).toContain('curl -sS -T')
    const res = await fetch(ticket.upload_url, { method: 'PUT', body: THEME })
    expect(res.status).toBe(200)
    const uploaded = (await res.json()) as Record<string, unknown>
    expect(uploaded.mime).toBe('text/css')
    expect(uploaded.usage).toBe(`<link rel="stylesheet" href="${uploaded.url}">`)
  })

  it('refuses markup on both paths with a message that names css', async () => {
    const viaData = await uploadTool({ data: Buffer.from('<!doctype html><p>hi</p>').toString('base64') })
    expect(viaData.isError).toBe(true)
    expect(viaData.body).toContain('png, jpg, webp, gif, svg and css are accepted')

    const { body } = await uploadTool({ local_file: true })
    const res = await fetch((body as { upload_url: string }).upload_url, {
      method: 'PUT',
      body: 'a{}<script>x()</script>',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('svg and css are accepted')
  })
})

describe('the browser upload route', () => {
  it('stays images-only', async () => {
    const res = await owner.req(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      body: THEME,
      headers: { 'Content-Type': 'text/css' },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'unsupported file type — png, jpg, webp, gif and svg are accepted',
    )
  })
})

describe('serving a stylesheet', () => {
  it('sends UTF-8 CSS with nosniff, a locked-down CSP, immutable caching and open CORS', async () => {
    const { body } = await uploadTool({ data: Buffer.from(THEME).toString('base64') })
    const res = await fetch(`${server.base}${pathOf((body as { url: string }).url)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.text()).toBe(THEME)
  })

  it('compresses stylesheets for clients that accept it, and never binary images', async () => {
    const big = `${THEME}${'.grid-item{display:grid;gap:12px;padding:24px}\n'.repeat(400)}`
    const { body } = await uploadTool({ data: Buffer.from(big).toString('base64') })
    const cssPath = pathOf((body as { url: string }).url)
    const br = await fetch(`${server.base}${cssPath}`, { headers: { 'Accept-Encoding': 'br' } })
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('vary')).toContain('Accept-Encoding')
    expect(await br.text()).toBe(big)
    const plain = await fetch(`${server.base}${cssPath}`, { headers: { 'Accept-Encoding': 'identity' } })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(big)

    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .png()
      .toBuffer()
    const image = (await (
      await owner.req(`/api/canvases/${canvasId}/assets`, {
        method: 'POST',
        body: new Uint8Array(png),
        headers: { 'Content-Type': 'image/png' },
      })
    ).json()) as { url: string }
    const res = await fetch(`${server.base}${pathOf(image.url)}`, { headers: { 'Accept-Encoding': 'br' } })
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('answers 404 for the right id under another extension', async () => {
    const { body } = await uploadTool({ data: Buffer.from(THEME).toString('base64') })
    const cssPath = pathOf((body as { url: string }).url)
    expect((await fetch(`${server.base}${cssPath.replace(/\.css$/, '.png')}`)).status).toBe(404)
  })
})

describe.skipIf(!findBrowserPath())('a frame that links an uploaded stylesheet', () => {
  it('renders with it on the server, url() paths resolving against the sheet', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff3b30' } })
      .png()
      .toBuffer()
    const image = (await (
      await owner.req(`/api/canvases/${canvasId}/assets`, {
        method: 'POST',
        body: new Uint8Array(png),
        headers: { 'Content-Type': 'image/png' },
      })
    ).json()) as { url: string }
    const imageFile = pathOf(image.url).slice('/a/'.length)
    /* the image is referenced relative to the stylesheet's own URL, as a theme file referencing its sibling assets would */
    const sheet = `${THEME}.tile{height:40px;background:url(${imageFile}) repeat}\n`
    const { body } = await uploadTool({ data: Buffer.from(sheet).toString('base64') })
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${(body as { url: string }).url}"></head><body style="margin:0"><div class="hero"></div><div class="tile"></div></body></html>`
    const frame = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Linked',
        x: 0,
        y: 0,
        width: 200,
        height: 160,
        html,
      })
    ).json()) as { id: string }

    const shot = await fetch(`${server.base}/i/${frame.id}.png`)
    expect(shot.status).toBe(200)
    const { data, info } = await sharp(Buffer.from(await shot.arrayBuffer()))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3))
    expect(pixel(100, 60)).toEqual([0x27, 0x43, 0xee])
    expect(pixel(100, 140)).toEqual([0xff, 0x3b, 0x30])
  }, 60_000)
})
