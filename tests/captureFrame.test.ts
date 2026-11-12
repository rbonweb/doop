import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types.ts'
import { captureFrame, findBrowserPath, getBrowser } from '../server/screenshot.ts'

/* Each 200 px band is its own colour, so a misplaced clip or strip shows up as a wrong colour at a known height. */
const BAND = 200
const COLOURS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c']

function bandedFrame(width: number, height: number): Frame {
  let bands = ''
  for (let y = 0, i = 0; y < height; y += BAND, i++) {
    bands += `<div class="band" style="height:${BAND}px;background:${COLOURS[i % COLOURS.length]}"></div>`
  }
  return {
    id: 'cap',
    canvasId: 'c',
    name: 'Cap',
    x: 0,
    y: 0,
    width,
    height,
    html: `<!doctype html><html><head><style>*{margin:0}</style></head><body>${bands}</body></html>`,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'test',
  }
}

const bandColour = (y: number) => COLOURS[Math.floor(y / BAND) % COLOURS.length]!

function hex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`
}

async function pixel(image: Buffer, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (y * info.width + x) * 3
  return hex(Array.from(data.subarray(at, at + 3)))
}

const near = (got: string, want: string, tolerance = 14) =>
  [1, 3, 5].every((o) => Math.abs(parseInt(got.slice(o, o + 2), 16) - parseInt(want.slice(o, o + 2), 16)) <= tolerance)

afterAll(async () => {
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe.skipIf(!findBrowserPath())('captureFrame', { timeout: 60_000 }, () => {
  it('captures the whole frame as png at 1x', async () => {
    const frame = bandedFrame(400, 1200)
    const started = Date.now()
    const out = await captureFrame(frame, { format: 'png', scale: 1 })
    console.info(`captureFrame whole frame 400x1200 png: ${Date.now() - started} ms`)
    expect([out.width, out.height]).toEqual([400, 1200])
    expect(out.clip).toEqual({ x: 0, y: 0, width: 400, height: 1200 })
    for (let y = BAND / 2; y < 1200; y += BAND) expect(await pixel(out.buf, 200, y)).toBe(bandColour(y))
  })

  it('crops a clip to webp at 2x', async () => {
    const out = await captureFrame(bandedFrame(400, 1200), {
      format: 'webp',
      scale: 2,
      clip: { x: 0, y: 600, width: 400, height: 200 },
    })
    expect([out.width, out.height]).toEqual([800, 400])
    expect(out.buf.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(out.buf.subarray(8, 12).toString('latin1')).toBe('WEBP')
    expect(near(await pixel(out.buf, 400, 200), bandColour(700))).toBe(true)
  })

  it('honours jpg quality', async () => {
    const frame = bandedFrame(400, 1200)
    const noisy = {
      ...frame,
      html: frame.html.replace(
        '</body>',
        `<div style="position:absolute;top:0;left:0;width:400px;height:400px;background:repeating-linear-gradient(37deg,#000 0 3px,#fff 3px 7px,#f00 7px 9px)"></div></body>`,
      ),
    }
    const low = await captureFrame(noisy, { format: 'jpg', scale: 1, quality: 30 })
    const high = await captureFrame(noisy, { format: 'jpg', scale: 1, quality: 95 })
    expect((await sharp(low.buf).metadata()).format).toBe('jpeg')
    expect(low.buf.length).toBeLessThan(high.buf.length)
  })

  it('lets prepare see the page and pick the region over clip', async () => {
    let found = false
    const out = await captureFrame(bandedFrame(400, 1200), {
      format: 'png',
      scale: 1,
      clip: { x: 0, y: 0, width: 400, height: 100 },
      prepare: async (page) => {
        found = (await page.evaluate(() => document.querySelector('.band') !== null)) === true
        return { x: 0, y: 400, width: 400, height: 200 }
      },
    })
    expect(found).toBe(true)
    expect(out.clip).toEqual({ x: 0, y: 400, width: 400, height: 200 })
    expect(await pixel(out.buf, 100, 100)).toBe(bandColour(500))
  })

  it('clamps the region to the frame', async () => {
    const out = await captureFrame(bandedFrame(400, 1200), {
      format: 'png',
      scale: 1,
      clip: { x: -10, y: 1100, width: 600, height: 400 },
    })
    expect(out.clip).toEqual({ x: 0, y: 1100, width: 400, height: 100 })
    expect([out.width, out.height]).toEqual([400, 100])
  })

  it('refuses a region outside the frame', async () => {
    await expect(
      captureFrame(bandedFrame(400, 1200), {
        format: 'png',
        scale: 1,
        clip: { x: 0, y: 1300, width: 100, height: 100 },
      }),
    ).rejects.toThrow(RangeError)
  })

  it('stitches strips for a tall crop, offset by the region', async () => {
    const out = await captureFrame(bandedFrame(400, 5000), {
      format: 'png',
      scale: 1,
      clip: { x: 0, y: 100, width: 400, height: 4600 },
    })
    expect([out.width, out.height]).toEqual([400, 4600])
    expect(await pixel(out.buf, 200, 50)).toBe(bandColour(150))
    expect(await pixel(out.buf, 200, 4096 + 10)).toBe(bandColour(100 + 4096 + 10))
    expect(await pixel(out.buf, 200, 4590)).toBe(bandColour(4690))
  })
})
