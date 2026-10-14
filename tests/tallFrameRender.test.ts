import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types.ts'
import { MAX_STRIP_DEVICE_PX, findBrowserPath, getBrowser, renderFrame } from '../server/screenshot.ts'

/**
 * Exports of tall frames. Chrome rasterizes a screenshot into one surface, and past its size limit the image wraps instead of failing: a 2x export of a 9000 px frame used to repeat the top of the page from 16384 device px down. Each band below is painted its own colour, so any wrap, gap or misplaced strip shows up as a wrong colour at a known height.
 */

const BAND = 500
const COLOURS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c']

function bandedFrame(width: number, height: number): Frame {
  let bands = ''
  for (let y = 0, i = 0; y < height; y += BAND, i++) {
    bands += `<div style="height:${BAND}px;background:${COLOURS[i % COLOURS.length]}"></div>`
  }
  return {
    id: 'tall',
    canvasId: 'c',
    name: 'Tall',
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

function hex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`
}

async function bandColours(image: Buffer, scale: number, height: number) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const seen: string[] = []
  const expected: string[] = []
  for (let y = BAND / 2, i = 0; y < height; y += BAND, i++) {
    const row = Math.round(y * scale)
    const at = (row * info.width + Math.round(info.width / 2)) * 3
    seen.push(hex(Array.from(data.subarray(at, at + 3))))
    expected.push(COLOURS[i % COLOURS.length]!)
  }
  return { seen, expected, info }
}

afterAll(async () => {
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe.skipIf(!findBrowserPath())('rendering tall frames', () => {
  it('keeps every band in place in a 2x PNG far past the surface limit', async () => {
    /* 9100 px at 2x is 18200 device px: past 16384, and not a whole number of strips */
    const frame = bandedFrame(1200, 9100)
    const png = await renderFrame(frame, 2, { type: 'png' })
    const { seen, expected, info } = await bandColours(png, 2, frame.height)
    expect(info.width).toBe(2400)
    expect(info.height).toBe(18200)
    expect(18200 % MAX_STRIP_DEVICE_PX).not.toBe(0)
    expect(seen).toEqual(expected)
  }, 120_000)

  it('stitches a JPEG at the requested quality', async () => {
    const frame = bandedFrame(800, 5200)
    const jpg = await renderFrame(frame, 2, { type: 'jpeg', quality: 90 })
    expect((await sharp(jpg).metadata()).format).toBe('jpeg')
    const { data, info } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([1600, 10400])
    /* JPEG shifts colours slightly; compare each band's centre within a small tolerance */
    for (let y = BAND / 2, i = 0; y < frame.height; y += BAND, i++) {
      const at = (Math.round(y * 2) * info.width + 800) * 3
      const want = COLOURS[i % COLOURS.length]!
      const wanted = [1, 3, 5].map((o) => parseInt(want.slice(o, o + 2), 16))
      Array.from(data.subarray(at, at + 3)).forEach((c, k) => expect(Math.abs(c - wanted[k]!)).toBeLessThan(12))
    }
  }, 120_000)

  it('crops to maxHeight when that crop itself needs strips', async () => {
    const frame = bandedFrame(600, 9000)
    const png = await renderFrame(frame, 2, { type: 'png', maxHeight: 3000 })
    const { seen, expected, info } = await bandColours(png, 2, 3000)
    expect([info.width, info.height]).toEqual([1200, 6000])
    expect(seen).toEqual(expected)
  }, 120_000)

  it('still takes a frame that fits in one capture in one shot', async () => {
    const frame = bandedFrame(400, 1500)
    const png = await renderFrame(frame, 2, { type: 'png' })
    const { seen, expected, info } = await bandColours(png, 2, frame.height)
    expect([info.width, info.height]).toEqual([800, 3000])
    expect(seen).toEqual(expected)
  }, 60_000)
})
