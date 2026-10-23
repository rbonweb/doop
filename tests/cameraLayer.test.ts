// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorldLayer, needsReraster } from '../src/lib/cameraLayer'

describe('needsReraster', () => {
  it('treats the same scale as crisp and any real zoom change as stale', () => {
    expect(needsReraster(0.4, 0.4)).toBe(false)
    expect(needsReraster(0.4, 0.4000001)).toBe(false)
    expect(needsReraster(0.4, 0.5)).toBe(true)
    expect(needsReraster(1, 0.08)).toBe(true)
  })
})

describe('createWorldLayer', () => {
  const IDLE = 150
  const world = { style: { willChange: '' } }

  beforeEach(() => {
    vi.useFakeTimers()
    world.style.willChange = ''
  })
  afterEach(() => vi.useRealTimers())

  it('promotes the world on the first move', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    expect(world.style.willChange).toBe('transform')
    layer.dispose()
  })

  it('drops the hint once a zoom has rested, so the browser re-rasterizes crisp', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    layer.moved(0.8)
    vi.advanceTimersByTime(IDLE - 1)
    expect(world.style.willChange).toBe('transform')
    vi.advanceTimersByTime(1)
    expect(world.style.willChange).toBe('')
    layer.dispose()
  })

  it('keeps the layer through pans: the bitmap is still at the right scale', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    layer.moved(0.4)
    layer.moved(0.4)
    vi.advanceTimersByTime(IDLE * 3)
    expect(world.style.willChange).toBe('transform')
    layer.dispose()
  })

  it('promotes again for the next gesture after a demote', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    layer.moved(0.9)
    vi.advanceTimersByTime(IDLE)
    expect(world.style.willChange).toBe('')
    layer.moved(0.9)
    expect(world.style.willChange).toBe('transform')
    /* a pan from here keeps it; the raster scale is the one it was promoted at */
    vi.advanceTimersByTime(IDLE)
    expect(world.style.willChange).toBe('transform')
    layer.dispose()
  })

  it('demotes when a zoom ends on a different scale than the layer was rasterized at', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    vi.advanceTimersByTime(IDLE)
    layer.moved(0.4)
    layer.moved(0.7)
    vi.advanceTimersByTime(IDLE)
    expect(world.style.willChange).toBe('')
    layer.dispose()
  })

  it('does not demote when a zoom returns to the scale it started from', () => {
    const layer = createWorldLayer(world, IDLE)
    layer.moved(0.4)
    layer.moved(0.9)
    layer.moved(0.4)
    vi.advanceTimersByTime(IDLE)
    expect(world.style.willChange).toBe('transform')
    layer.dispose()
  })
})
