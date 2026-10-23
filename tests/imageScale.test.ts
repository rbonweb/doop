import { describe, expect, it } from 'vitest'
import { clampImageScale, MAX_IMAGE_SIDE_PX, parseImageScale } from '../shared/imageScale'

describe('parseImageScale', () => {
  it('honors 2 and 4 and treats everything else as 1', () => {
    expect(parseImageScale('2')).toBe(2)
    expect(parseImageScale('4')).toBe(4)
    for (const raw of [undefined, '1', '3', '8', '4x', ['4'], 4]) expect(parseImageScale(raw)).toBe(1)
  })
})

describe('clampImageScale', () => {
  it('keeps the asked scale when both sides stay within the cap', () => {
    expect(clampImageScale(4, { width: 1440, height: 900 })).toBe(4)
    expect(clampImageScale(2, { width: 8000, height: 100 })).toBe(2)
  })

  it('lowers the scale so the longest side lands on the cap', () => {
    const scale = clampImageScale(4, { width: 1280, height: 6000 })
    expect(scale).toBeLessThan(4)
    expect(Math.round(6000 * scale)).toBeLessThanOrEqual(MAX_IMAGE_SIDE_PX)
    expect(Math.round(6000 * scale)).toBeGreaterThan(MAX_IMAGE_SIDE_PX - 20)
  })

  it('clamps on the wider side too', () => {
    const scale = clampImageScale(4, { width: 9000, height: 400 })
    expect(Math.round(9000 * scale)).toBeLessThanOrEqual(MAX_IMAGE_SIDE_PX)
  })

  it('never goes below 1: a frame already past the cap renders at its own size', () => {
    expect(clampImageScale(4, { width: 20000, height: 500 })).toBe(1)
    expect(clampImageScale(2, { width: 20000, height: 500 })).toBe(1)
  })

  it('leaves scale 1 alone', () => {
    expect(clampImageScale(1, { width: 30000, height: 30000 })).toBe(1)
  })
})
