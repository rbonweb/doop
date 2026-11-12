import { describe, expect, it } from 'vitest'
import {
  composite,
  contrastRatio,
  normalizeColor,
  parseCssColor,
  relativeLuminance,
  toHex,
  type Rgba,
} from '../server/colorMath.ts'

const white: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const black: Rgba = { r: 0, g: 0, b: 0, a: 1 }

describe('parseCssColor', () => {
  it('parses rgb() and rgba() in every accepted form', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('rgba(0, 128, 255, 0.5)')).toEqual({ r: 0, g: 128, b: 255, a: 0.5 })
    expect(parseCssColor('rgb(10 20 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseCssColor('rgb(10 20 30 / 0.25)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 })
    expect(parseCssColor('rgba(255 0 0 / 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(parseCssColor('RGB(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
  })

  it('parses hex in 3, 4, 6 and 8 digits, case-insensitively', () => {
    expect(parseCssColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('#F00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('#ABC')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseCssColor('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 136 / 255 })
    expect(parseCssColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 })
  })

  it('parses transparent', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseCssColor('TRANSPARENT')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('returns null for anything else', () => {
    expect(parseCssColor('red')).toBeNull()
    expect(parseCssColor('#ff000')).toBeNull()
    expect(parseCssColor('#gggggg')).toBeNull()
    expect(parseCssColor('rgb(255, 0)')).toBeNull()
    expect(parseCssColor('rgb(0 0 0 / 0 / 0)')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

describe('toHex and normalizeColor', () => {
  it('writes #rrggbb when opaque and #rrggbbaa otherwise', () => {
    expect(toHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000')
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080')
    expect(toHex({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000')
    expect(toHex({ r: 1, g: 2, b: 3, a: 1 })).toBe('#010203')
  })

  it('normalises a parsed colour or reports null', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff')
    expect(normalizeColor('rgba(17, 17, 17, 1)')).toBe('#111111')
    expect(normalizeColor('rgba(17, 17, 17, 0.5)')).toBe('#11111180')
    expect(normalizeColor('#ff000080')).toBe('#ff000080')
    expect(normalizeColor('currentColor')).toBeNull()
  })
})

describe('composite', () => {
  it('is source-over with the briefed alpha result', () => {
    const result = composite({ r: 0, g: 0, b: 0, a: 0.5 }, white)
    expect(result.r).toBeCloseTo(127.5, 5)
    expect(result.g).toBeCloseTo(127.5, 5)
    expect(result.b).toBeCloseTo(127.5, 5)
    expect(result.a).toBe(1)
  })

  it('keeps the result alpha when the bottom is translucent too', () => {
    const result = composite({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 255, a: 0.5 })
    expect(result.a).toBeCloseTo(0.75, 5)
    expect(result.r).toBeCloseTo((255 * 0.5) / 0.75, 4)
    expect(result.b).toBeCloseTo((255 * 0.5 * 0.5) / 0.75, 4)
  })

  it('is fully transparent over nothing', () => {
    expect(composite({ r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 })).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
})

describe('relativeLuminance', () => {
  it('matches the WCAG values for black, white and pure channels', () => {
    expect(relativeLuminance(black)).toBe(0)
    expect(relativeLuminance(white)).toBeCloseTo(1, 5)
    expect(relativeLuminance({ r: 255, g: 0, b: 0, a: 1 })).toBeCloseTo(0.2126, 4)
    expect(relativeLuminance({ r: 0, g: 255, b: 0, a: 1 })).toBeCloseTo(0.7152, 4)
  })

  it('ignores alpha', () => {
    expect(relativeLuminance({ ...black, a: 0.25 })).toBe(0)
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio(black, white)).toBe(21)
    expect(contrastRatio(white, black)).toBe(21)
    expect(contrastRatio({ r: 120, g: 120, b: 120, a: 1 }, { r: 120, g: 120, b: 120, a: 1 })).toBe(1)
  })

  it('puts #777777 on white at WCAG 4.48', () => {
    expect(contrastRatio({ r: 0x77, g: 0x77, b: 0x77, a: 1 }, white)).toBe(4.48)
  })

  it('composites a semi-transparent foreground over the background first', () => {
    const half = { r: 0, g: 0, b: 0, a: 0.5 }
    expect(contrastRatio(half, white)).toBe(3.98)
    const overBlack = { r: 0, g: 0, b: 0, a: 0.5 }
    expect(contrastRatio(overBlack, black)).toBe(1)
  })

  it('rounds to two decimals', () => {
    const ratio = contrastRatio({ r: 0x11, g: 0x11, b: 0x11, a: 1 }, white)
    expect(ratio).toBe(18.88)
    expect(Number.isInteger(ratio * 100)).toBe(true)
  })
})
