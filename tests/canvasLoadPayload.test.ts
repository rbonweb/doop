import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Joining a canvas sends every frame's HTML in one init message, so its size is most of what a canvas open downloads. The server offers permessage-deflate; a client that does not ask for it still gets plain frames.
 */

const PORT = 5052
const FRAME_HTML = `<!doctype html><html><head><style>${'.card{padding:16px;border-radius:12px;box-shadow:0 1px 2px #0002}'.repeat(400)}</style></head><body>${'<section class="card"><h2>Feature</h2><p>Copy that repeats across a page.</p></section>'.repeat(200)}</body></html>`

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer(PORT)
  owner = await new Client(server).signUp('payload@test.dev', 'Owner')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Payload' })).json()) as { id: string }).id
  for (let i = 0; i < 6; i++) {
    await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: `F${i}`,
      x: i * 1540,
      y: 0,
      width: 1440,
      height: 2000,
      html: FRAME_HTML,
    })
  }
}, 70_000)

afterAll(() => server?.stop())

function join(perMessageDeflate: boolean): Promise<{ extensions: string; jsonBytes: number; wireBytes: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: owner.header() }, perMessageDeflate })
    let wireBytes = 0
    ws.on('upgrade', (res) => res.socket.on('data', (chunk: Buffer) => (wireBytes += chunk.length)))
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `p-${Math.random()}`, name: 'p', kind: 'user' })),
    )
    ws.on('message', (data) => {
      const text = String(data)
      if (!text.startsWith('{"type":"init"')) return
      /* the socket's data events for this message have all fired by now */
      setTimeout(() => {
        ws.close()
        resolve({ extensions: ws.extensions, jsonBytes: Buffer.byteLength(text), wireBytes })
      }, 50)
    })
    ws.on('error', reject)
  })
}

describe('the canvas init message', () => {
  it('goes out deflated to a client that offers permessage-deflate', async () => {
    const { extensions, jsonBytes, wireBytes } = await join(true)
    expect(extensions).toContain('permessage-deflate')
    expect(jsonBytes).toBeGreaterThan(6 * FRAME_HTML.length)
    expect(wireBytes).toBeLessThan(jsonBytes / 5)
  })

  it('still arrives whole for a client that does not', async () => {
    const { extensions, jsonBytes, wireBytes } = await join(false)
    expect(extensions).toBe('')
    expect(wireBytes).toBeGreaterThan(jsonBytes)
  })
})
