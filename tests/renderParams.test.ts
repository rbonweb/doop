import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUALITY,
  normalizeRenderParams,
  parseRenderQuery,
  renderExt,
  renderMime,
  renderParamsHash,
  renderParamsKey,
  renderUrlQuery,
} from '../server/renderParams.ts'
import type { RenderParams } from '../server/renderTypes.ts'

const FRAME = { width: 1000, height: 800 }

function parsed(result: ReturnType<typeof parseRenderQuery>): RenderParams {
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
  return result
}

describe('normalizeRenderParams', () => {
  it('defaults to png 1x with no quality', () => {
    expect(normalizeRenderParams(FRAME, {})).toEqual({ format: 'png', scale: 1, quality: 0 })
  })

  it('starts jpg and webp at their own default quality', () => {
    expect(DEFAULT_QUALITY).toEqual({ png: 0, jpg: 90, webp: 80 })
    expect(normalizeRenderParams(FRAME, { format: 'jpg' })).toEqual({ format: 'jpg', scale: 1, quality: 90 })
    expect(normalizeRenderParams(FRAME, { format: 'webp' })).toEqual({ format: 'webp', scale: 1, quality: 80 })
  })

  it('rounds and clamps a crop to the frame', () => {
    expect(normalizeRenderParams(FRAME, { crop: { x: 10.6, y: 20.4, w: 100.2, h: 50.9 } }).crop).toEqual({
      x: 10,
      y: 20,
      w: 101,
      h: 51,
    })
    expect(normalizeRenderParams(FRAME, { crop: { x: 950, y: 10, w: 100, h: 50 } }).crop).toEqual({
      x: 950,
      y: 10,
      w: 50,
      h: 50,
    })
    expect(normalizeRenderParams(FRAME, { crop: { x: -20, y: -5, w: 100, h: 100 } }).crop).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
  })

  it('refuses a crop that lies entirely outside the frame', () => {
    expect(() => normalizeRenderParams(FRAME, { crop: { x: 1200, y: 0, w: 50, h: 50 } })).toThrow(
      new RangeError('crop is outside the frame'),
    )
    expect(() => normalizeRenderParams(FRAME, { crop: { x: 0, y: 900, w: 50, h: 50 } })).toThrow(
      new RangeError('crop is outside the frame'),
    )
  })

  it('drops a crop equal to the whole frame, so it keys like no crop', () => {
    const whole = normalizeRenderParams(FRAME, { crop: { x: 0, y: 0, w: 1000, h: 800 } })
    const none = normalizeRenderParams(FRAME, {})
    expect(whole.crop).toBeUndefined()
    expect(renderParamsKey(whole)).toBe(renderParamsKey(none))
  })

  it('clamps the scale to the export limits', () => {
    expect(normalizeRenderParams(FRAME, { scale: 9 }).scale).toBe(4)
    expect(normalizeRenderParams(FRAME, { scale: 0.001 }).scale).toBe(0.1)
  })

  it('lowers the scale for a huge frame and never goes below 2x', () => {
    expect(normalizeRenderParams({ width: 20000, height: 20000 }, { scale: 4 }).scale).toBe(2)
  })

  it('lowers the scale through width and never raises it', () => {
    expect(normalizeRenderParams(FRAME, { width: 500 }).scale).toBe(0.5)
    expect(normalizeRenderParams(FRAME, { width: 2000 }).scale).toBe(1)
    expect(normalizeRenderParams(FRAME, { scale: 2, width: 500 }).scale).toBe(0.5)
  })

  it('rounds a width-derived scale to two decimals and floors it at 0.1', () => {
    expect(normalizeRenderParams({ width: 1200, height: 800 }, { width: 380 }).scale).toBe(0.32)
    expect(normalizeRenderParams(FRAME, { width: 5 }).scale).toBe(0.1)
  })

  it('measures width against the crop, not the whole frame', () => {
    expect(normalizeRenderParams(FRAME, { crop: { x: 0, y: 0, w: 200, h: 100 }, width: 100 }).scale).toBe(0.5)
  })

  it('rounds quality for jpg and webp only', () => {
    expect(normalizeRenderParams(FRAME, { format: 'jpg', quality: 72.4 }).quality).toBe(72)
    expect(normalizeRenderParams(FRAME, { format: 'jpg', quality: 500 }).quality).toBe(100)
    expect(normalizeRenderParams(FRAME, { format: 'webp', quality: -5 }).quality).toBe(1)
    expect(normalizeRenderParams(FRAME, { format: 'png', quality: 55 }).quality).toBe(0)
  })
})

describe('parseRenderQuery', () => {
  it('reads ext as the format and defaults the rest', () => {
    expect(parseRenderQuery(FRAME, 'png', {})).toEqual({ format: 'png', scale: 1, quality: 0 })
  })

  it('lets format override ext, with jpeg as the jpg alias', () => {
    expect(parsed(parseRenderQuery(FRAME, 'png', { format: 'webp' })).format).toBe('webp')
    expect(parseRenderQuery(FRAME, 'png', { format: 'jpeg' })).toEqual({ format: 'jpg', scale: 1, quality: 90 })
    expect(parsed(parseRenderQuery(FRAME, 'jpg', { format: 'png' })).format).toBe('png')
  })

  it('rejects an unsupported ext or format', () => {
    expect(parseRenderQuery(FRAME, 'gif', {})).toEqual({ error: 'unsupported format' })
    expect(parseRenderQuery(FRAME, 'png', { format: 'gif' })).toEqual({ error: 'unsupported format' })
  })

  it('reads scale through parseExportScale and treats a bad one as 1x', () => {
    expect(parsed(parseRenderQuery(FRAME, 'png', { scale: '2' })).scale).toBe(2)
    expect(parsed(parseRenderQuery(FRAME, 'png', { scale: '1,5' })).scale).toBe(1.5)
    expect(parsed(parseRenderQuery(FRAME, 'png', { scale: 'huge' })).scale).toBe(1)
    expect(parsed(parseRenderQuery(FRAME, 'png', {})).scale).toBe(1)
  })

  it('takes q over quality, and ignores numbers it cannot read', () => {
    expect(parsed(parseRenderQuery(FRAME, 'jpg', { q: '50', quality: '80' })).quality).toBe(50)
    expect(parsed(parseRenderQuery(FRAME, 'jpg', { quality: '80' })).quality).toBe(80)
    expect(parsed(parseRenderQuery(FRAME, 'jpg', { q: 'abc', quality: '80' })).quality).toBe(80)
    expect(parsed(parseRenderQuery(FRAME, 'jpg', { q: '1000' })).quality).toBe(100)
  })

  it('reads width only as a positive integer', () => {
    expect(parsed(parseRenderQuery(FRAME, 'png', { width: '500' })).scale).toBe(0.5)
    expect(parsed(parseRenderQuery(FRAME, 'png', { width: '0' })).scale).toBe(1)
    expect(parsed(parseRenderQuery(FRAME, 'png', { width: '-4' })).scale).toBe(1)
    expect(parsed(parseRenderQuery(FRAME, 'png', { width: '2.5' })).scale).toBe(1)
  })

  it('builds a crop only from all four values', () => {
    expect(parsed(parseRenderQuery(FRAME, 'png', { x: '10', y: '20', w: '100', h: '50' })).crop).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
    })
    expect(parseRenderQuery(FRAME, 'png', { x: '10', y: '20' })).toEqual({ error: 'crop needs x, y, w and h' })
    expect(parseRenderQuery(FRAME, 'png', { x: '10', y: '20', w: '100' })).toEqual({
      error: 'crop needs x, y, w and h',
    })
  })

  it('maps the crop-outside error to an error result', () => {
    expect(parseRenderQuery(FRAME, 'png', { x: '2000', y: '0', w: '50', h: '50' })).toEqual({
      error: 'crop is outside the frame',
    })
  })

  it('takes the first value of an array, as Express may send', () => {
    const result = parsed(
      parseRenderQuery(FRAME, 'jpg', {
        format: ['webp', 'png'],
        scale: ['2', '1'],
        q: ['70', '20'],
        width: ['400'],
      }),
    )
    expect(result).toEqual({ format: 'webp', scale: 0.4, quality: 70 })
  })
})

describe('render keys, types and URLs', () => {
  const wide = parsed(parseRenderQuery(FRAME, 'jpg', { scale: '2', q: '80' }))
  const small = parsed(parseRenderQuery(FRAME, 'jpg', { scale: '2', q: '80', x: '0', y: '0', w: '500', h: '400' }))

  it('names the file and type of each format', () => {
    expect(renderExt('png')).toBe('png')
    expect(renderExt('jpg')).toBe('jpg')
    expect(renderExt('webp')).toBe('webp')
    expect(renderMime('png')).toBe('image/png')
    expect(renderMime('jpg')).toBe('image/jpeg')
    expect(renderMime('webp')).toBe('image/webp')
  })

  it('keys every field of the params', () => {
    expect(renderParamsKey(wide)).toBe('jpg|s2|q80')
    expect(renderParamsKey(small)).toBe('jpg|s2|q80|c0,0,500,400')
    expect(renderParamsKey(parsed(parseRenderQuery(FRAME, 'png', {})))).toBe('png|s1|q0')
  })

  it('hashes stably, in 16 hex chars, differently per key', () => {
    const a = renderParamsHash(wide)
    expect(renderParamsHash(wide)).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(renderParamsHash(small)).not.toBe(a)
  })

  it('writes the query string in the fixed order, version last', () => {
    expect(renderUrlQuery(wide)).toBe('scale=2&q=80')
    expect(renderUrlQuery(small)).toBe('scale=2&q=80&x=0&y=0&w=500&h=400')
    expect(renderUrlQuery(parsed(parseRenderQuery(FRAME, 'png', {})), 7)).toBe('scale=1&v=7')
  })

  it('round-trips its query string through parseRenderQuery', () => {
    const fromWidth = parsed(parseRenderQuery({ width: 1200, height: 800 }, 'png', { width: '380' }))
    const tiny = parsed(parseRenderQuery(FRAME, 'png', { width: '5' }))
    for (const p of [wide, small, parsed(parseRenderQuery(FRAME, 'png', { scale: '1.5' })), fromWidth, tiny]) {
      const query = Object.fromEntries(new URLSearchParams(renderUrlQuery(p, 3)))
      const frame = p === fromWidth ? { width: 1200, height: 800 } : FRAME
      expect(parsed(parseRenderQuery(frame, renderExt(p.format), query))).toEqual(p)
    }
  })
})
