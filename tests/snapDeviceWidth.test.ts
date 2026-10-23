import { describe, expect, it } from 'vitest'
import { snapDeviceWidth } from '../src/lib/snap'

const rect = (width: number) => ({ x: 100, y: 50, width, height: 600 })

describe('snapDeviceWidth', () => {
  it('pulls a width onto a device width within 12 screen px', () => {
    for (const device of [390, 834, 1280, 1440]) {
      expect(snapDeviceWidth(rect(device - 11), 1).width).toBe(device)
      expect(snapDeviceWidth(rect(device + 12), 1).width).toBe(device)
    }
  })

  it('leaves widths further than 12 screen px alone', () => {
    const out = snapDeviceWidth(rect(390 + 13), 1)
    expect(out.width).toBe(403)
    expect(out.guides).toEqual([])
  })

  it('measures the tolerance in screen px, so zooming out widens it in canvas units', () => {
    expect(snapDeviceWidth(rect(390 + 20), 0.5).width).toBe(390)
    expect(snapDeviceWidth(rect(390 + 20), 2).width).toBe(410)
  })

  it('picks the nearest of two close presets', () => {
    expect(snapDeviceWidth(rect(1370), 0.1).width).toBe(1440)
    expect(snapDeviceWidth(rect(1340), 0.1).width).toBe(1280)
  })

  it('draws a guide on the snapped right edge and keeps the other sides', () => {
    const out = snapDeviceWidth(rect(835), 1)
    expect(out).toMatchObject({ x: 100, y: 50, height: 600, width: 834 })
    expect(out.guides).toEqual([{ axis: 'v', at: 100 + 834, from: 50, to: 650 }])
  })
})
