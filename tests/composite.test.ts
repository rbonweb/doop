import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { composeImages } from '../server/composite.ts'

async function solid(width: number, height: number, colour: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: colour } })
    .png()
    .toBuffer()
}

async function raw(buf: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

function pixel(img: { data: Buffer; channels: number }, x: number, y: number, width: number): number[] {
  const i = (y * width + x) * img.channels
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0, img.data[i + 3] ?? 0]
}

describe('composeImages', () => {
  it('lays a row out left to right with the gap around every cell', async () => {
    const red = await solid(100, 50, '#ff0000')
    const blue = await solid(60, 80, '#0000ff')
    const out = await composeImages([{ buf: red }, { buf: blue }], { layout: 'row' })
    expect(out.width).toBe(24 + 100 + 24 + 60 + 24)
    expect(out.height).toBe(24 + 80 + 24)
    const img = await raw(out.buf)
    expect(pixel(img, 24 + 50, 24 + 25, out.width).slice(0, 3)).toEqual([255, 0, 0])
    expect(pixel(img, 24 + 100 + 24 + 30, 24 + 40, out.width).slice(0, 3)).toEqual([0, 0, 255])
    expect(pixel(img, 24 + 100 + 12, 24 + 70, out.width).slice(0, 3)).toEqual([245, 245, 245])
  })

  it('reserves a label band above the cells when any item is labelled', async () => {
    const red = await solid(100, 50, '#ff0000')
    const blue = await solid(60, 80, '#0000ff')
    const out = await composeImages(
      [
        { buf: red, label: 'before' },
        { buf: blue, label: 'after' },
      ],
      { layout: 'row' },
    )
    expect(out.height).toBe(24 + 36 + 80 + 24)
    const img = await raw(out.buf)
    let dark = 0
    for (let y = 24; y < 60; y++) {
      for (let x = 0; x < out.width; x++) {
        const [r, g, b] = pixel(img, x, y, out.width)
        if ((r ?? 0) < 128 && (g ?? 0) < 128 && (b ?? 0) < 128) dark++
      }
    }
    expect(dark).toBeGreaterThan(0)
    /* the cell starts below the band, not inside it */
    expect(pixel(img, 24 + 50, 24 + 36 + 25, out.width).slice(0, 3)).toEqual([255, 0, 0])
  })

  it('lays a grid out in ceil(sqrt(n)) columns with slots sized by their tallest and widest cell', async () => {
    const cell = await solid(100, 50, '#336699')
    const out = await composeImages(
      Array.from({ length: 5 }, () => ({ buf: cell })),
      { layout: 'grid' },
    )
    expect(out.width).toBe(24 * 4 + 300)
    expect(out.height).toBe(24 * 3 + 100)
    const img = await raw(out.buf)
    expect(pixel(img, 24 + 50, 24 + 25, out.width).slice(0, 3)).toEqual([51, 102, 153])
  })

  it('scales down to maxWidth and never up', async () => {
    const red = await solid(100, 50, '#ff0000')
    const blue = await solid(60, 80, '#0000ff')
    const big = await composeImages([{ buf: red }, { buf: blue }], { layout: 'row', maxWidth: 100 })
    expect(big.width).toBe(100)
    expect(big.height).toBeLessThan(24 + 80 + 24)
    const small = await composeImages([{ buf: red }, { buf: blue }], { layout: 'row', maxWidth: 5000 })
    expect(small.width).toBe(24 + 100 + 24 + 60 + 24)
  })

  it('writes webp when asked', async () => {
    const red = await solid(40, 40, '#ff0000')
    const out = await composeImages([{ buf: red }], { layout: 'row', format: 'webp' })
    expect(out.buf.subarray(0, 4).toString()).toBe('RIFF')
    expect(out.buf.subarray(8, 12).toString()).toBe('WEBP')
  })

  it('rejects an item count outside 1 to 8', async () => {
    const red = await solid(40, 40, '#ff0000')
    await expect(composeImages([], { layout: 'row' })).rejects.toThrow(RangeError)
    await expect(
      composeImages(
        Array.from({ length: 9 }, () => ({ buf: red })),
        { layout: 'row' },
      ),
    ).rejects.toThrow(RangeError)
  })

  it('escapes markup in a label instead of failing', async () => {
    const red = await solid(40, 40, '#ff0000')
    const out = await composeImages([{ buf: red, label: '<&>' }], { layout: 'row' })
    expect(out.width).toBe(24 + 40 + 24)
  })

  it('truncates long labels', async () => {
    const red = await solid(40, 40, '#ff0000')
    const out = await composeImages([{ buf: red, label: 'x'.repeat(200) }], { layout: 'row' })
    expect(out.height).toBe(24 + 36 + 40 + 24)
  })

  it('defaults the background to #f5f5f5 and honours an override', async () => {
    const red = await solid(40, 40, '#ff0000')
    const out = await composeImages([{ buf: red }], { layout: 'row' })
    expect(pixel(await raw(out.buf), 4, 4, out.width).slice(0, 3)).toEqual([245, 245, 245])
    const dark = await composeImages([{ buf: red }], { layout: 'row', background: '#101010' })
    expect(pixel(await raw(dark.buf), 4, 4, dark.width).slice(0, 3)).toEqual([16, 16, 16])
  })
})
