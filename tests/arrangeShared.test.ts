import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROWS,
  arrangeRows,
  freeSpotBeside,
  gapBetween,
  layoutIssues,
  tooClose,
  type LayoutItem,
  type NamedBox,
} from '../shared/arrange'

const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height })

describe('gapBetween', () => {
  it('measures a horizontal separation', () => {
    expect(gapBetween(box(0, 0), box(140, 0))).toBe(40)
  })

  it('measures a vertical separation', () => {
    expect(gapBetween(box(0, 0), box(0, 125))).toBe(25)
  })

  it('takes the larger side of a diagonal', () => {
    expect(gapBetween(box(0, 0), box(130, 150))).toBe(50)
  })

  it('is zero when the boxes touch', () => {
    expect(gapBetween(box(0, 0), box(100, 0))).toBe(0)
    expect(gapBetween(box(0, 0), box(0, 100))).toBe(0)
  })

  it('is negative by the smaller side of an overlap', () => {
    expect(gapBetween(box(0, 0), box(90, 80))).toBe(-10)
  })
})

describe('tooClose', () => {
  it('does not call touching boxes too close at gap 0', () => {
    expect(tooClose(box(0, 0), box(100, 0))).toBe(false)
  })

  it('sees boxes 10 apart as too close for gap 20', () => {
    expect(tooClose(box(0, 0), box(110, 0), 20)).toBe(true)
  })

  it('sees an overlap as too close', () => {
    expect(tooClose(box(0, 0), box(50, 50))).toBe(true)
  })
})

describe('freeSpotBeside', () => {
  it('starts right of the source by the gap', () => {
    expect(freeSpotBeside(box(0, 0), [], 40)).toEqual({ x: 140, y: 0 })
  })

  it('jumps past one blocker', () => {
    expect(freeSpotBeside(box(0, 0), [box(140, 0)], 40)).toEqual({ x: 280, y: 0 })
  })

  it('jumps past a chain of two blockers', () => {
    expect(freeSpotBeside(box(0, 0), [box(140, 0), box(280, 0)], 40)).toEqual({ x: 420, y: 0 })
  })

  it('ignores a blocker on another row', () => {
    expect(freeSpotBeside(box(0, 0), [box(140, 500)], 40)).toEqual({ x: 140, y: 0 })
  })
})

const named = (id: string, x: number, width: number, name = id): NamedBox => ({ id, x, y: 0, width, height: 100, name })

describe('arrangeRows', () => {
  it('puts desktops in the first row and the narrow box in the second', () => {
    const result = arrangeRows([named('a', 5000, 1440), named('b', 0, 1280), named('c', 0, 390)], DEFAULT_ROWS, {
      gap: 40,
      origin: { x: 100, y: 100 },
    })
    expect(result.unmatched).toEqual([])
    expect(result.placed.get('b')).toEqual({ x: 100, y: 100 })
    expect(result.placed.get('a')).toEqual({ x: 1420, y: 100 })
    expect(result.placed.get('c')).toEqual({ x: 100, y: 240 })
  })

  it('sorts a row by name numerically', () => {
    const result = arrangeRows([named('p10', 0, 100, 'Page 10'), named('p2', 0, 100, 'Page 2')], [{ order: 'name' }], {
      gap: 20,
      origin: { x: 0, y: 0 },
    })
    expect(result.placed.get('p2')).toEqual({ x: 0, y: 0 })
    expect(result.placed.get('p10')).toEqual({ x: 120, y: 0 })
  })

  it('returns unmatched boxes when no rule matches', () => {
    const result = arrangeRows([named('a', 0, 100)], [{ minWidth: 500 }], { gap: 20, origin: { x: 0, y: 0 } })
    expect(result.placed.size).toBe(0)
    expect(result.unmatched).toEqual(['a'])
  })

  it('lets an empty first row take no space', () => {
    const result = arrangeRows([named('a', 0, 390)], [{ minWidth: 900 }, { maxWidth: 899 }], {
      gap: 40,
      origin: { x: 10, y: 200 },
    })
    expect(result.placed.get('a')).toEqual({ x: 10, y: 200 })
  })
})

const item = (id: string, x: number, y: number, extra: Partial<LayoutItem> = {}): LayoutItem => ({
  id,
  kind: 'frame',
  x,
  y,
  width: 100,
  height: 100,
  ...extra,
})

describe('layoutIssues', () => {
  it('reports an overlap with a negative gap', () => {
    expect(layoutIssues([item('a', 0, 0), item('b', 90, 0)], 40)).toEqual([
      { kind: 'overlap', a: 'a', b: 'b', gap: -10 },
    ])
  })

  it('reports facing boxes closer than the gap as tight', () => {
    expect(layoutIssues([item('a', 0, 0), item('b', 120, 0)], 40)).toEqual([{ kind: 'tight', a: 'a', b: 'b', gap: 20 }])
  })

  it('says nothing about boxes 60 apart', () => {
    expect(layoutIssues([item('a', 0, 0), item('b', 160, 0)], 40)).toEqual([])
  })

  it('ignores diagonal neighbours', () => {
    expect(layoutIssues([item('a', 0, 0), item('b', 120, 120)], 40)).toEqual([])
  })

  it('ignores a note and the frame it is attached to', () => {
    const note = item('n', 10, 10, { kind: 'note', attachedTo: 'f' })
    expect(layoutIssues([item('f', 0, 0), note], 40)).toEqual([])
  })

  it('reports a free note overlapping a frame', () => {
    expect(layoutIssues([item('f', 0, 0), item('n', 10, 10, { kind: 'note' })], 40)).toEqual([
      { kind: 'overlap', a: 'f', b: 'n', gap: -90 },
    ])
  })
})
