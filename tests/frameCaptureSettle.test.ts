import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types.ts'
import { findBrowserPath, getBrowser, renderFrame } from '../server/screenshot.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * A server capture must show a design at rest. The load event fires before an entrance animation ends, and before fonts and images that layout asks for afterwards, so a capture taken at load showed sections half faded in and text in a fallback font. Here nothing slow is requested before load: the fade-in starts at once, and a load handler switches on a font and a background image that the local stand-in for the asset origin (the one origin the capture browser fetches directly) serves late. */

const PORT = 5051
const DELAY_MS = 1500
const FONT = [
  '/System/Library/Fonts/Supplemental/Arial Black.ttf',
  '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
].find((p) => existsSync(p))

let server: http.Server

beforeAll(async () => {
  const tile = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff3b30' } })
    .png()
    .toBuffer()
  server = http.createServer((req, res) => {
    setTimeout(() => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.url === '/a/late.ttf' && FONT) res.writeHead(200, { 'Content-Type': 'font/ttf' }).end(readFileSync(FONT))
      else if (req.url === '/a/late.png') res.writeHead(200, { 'Content-Type': 'image/png' }).end(tile)
      else res.writeHead(404).end()
    }, DELAY_MS)
  })
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  stubEnv('BETTER_AUTH_URL', `http://localhost:${PORT}`)
})

afterAll(async () => {
  unstubAllEnvs()
  server?.close()
  if (findBrowserPath()) await (await getBrowser()).close()
})

const origin = `http://localhost:${PORT}`
const frame: Frame = {
  id: 'settle',
  canvasId: 'c',
  name: 'Settle',
  x: 0,
  y: 0,
  width: 400,
  height: 460,
  html: `<!doctype html><html><head><style>
    @font-face { font-family: Late; src: url(${origin}/a/late.ttf) format('truetype'); font-display: block }
    * { margin: 0 }
    body { background: #fff }
    .hero { height: 200px; background: #2743ee; opacity: 0; transform: translateY(20px); animation: up 0.8s ease-out forwards }
    @keyframes up { to { opacity: 1; transform: none } }
    .word { height: 160px; font: 120px/1 monospace; color: #000 }
    .ready .word { font-family: Late, monospace }
    .tile { height: 100px }
    .ready .tile { background: url(${origin}/a/late.png) }
  </style></head><body><div class="hero"></div><p class="word">WW</p><div class="tile"></div>
  <script>addEventListener('load', () => document.body.classList.add('ready'))</script></body></html>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'test',
}

describe.skipIf(!findBrowserPath())('capturing a frame at rest', () => {
  it('waits for the fade-in, the late font and the late background image', async () => {
    const png = await renderFrame(frame, 1, { type: 'png' })
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3))

    /* fully faded in and moved up: solid brand blue from the very top edge */
    expect.soft(pixel(200, 2)).toEqual([0x27, 0x43, 0xee])
    expect.soft(pixel(200, 190)).toEqual([0x27, 0x43, 0xee])
    /* the background image arrived */
    expect.soft(pixel(200, 410)).toEqual([0xff, 0x3b, 0x30])
    /* font-display: block hides text until the font loads, so ink in the word's box means the font is in */
    if (FONT) {
      let ink = 0
      for (let y = 200; y < 360; y++) for (let x = 0; x < info.width; x++) if (pixel(x, y)[0]! < 80) ink++
      expect.soft(ink).toBeGreaterThan(500)
    }
  }, 60_000)

  it('does not wait on an infinite animation past the cap', async () => {
    const spinning: Frame = {
      ...frame,
      id: 'spin',
      html: `<!doctype html><html><head><style>* { margin: 0 } .s { width: 50px; height: 50px; background: #111; animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }</style></head><body><div class="s"></div></body></html>`,
    }
    const started = Date.now()
    await renderFrame(spinning, 1, { type: 'png' })
    expect(Date.now() - started).toBeLessThan(4000)
  }, 60_000)
})
