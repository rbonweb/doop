import { describe, expect, it } from 'vitest'
import { rowWindow } from '../src/lib/rowWindow'

/* ten 20px rows, then one 40px row */
const offsets = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 240]

describe('rowWindow', () => {
  it('takes the rows the view covers, plus the overscan on each side', () => {
    expect(rowWindow(offsets, 0, 50, 0)).toEqual({ start: 0, end: 3 })
    expect(rowWindow(offsets, 0, 50, 2)).toEqual({ start: 0, end: 5 })
    expect(rowWindow(offsets, 100, 30, 1)).toEqual({ start: 4, end: 8 })
  })

  it('finds a row of its own height by its top, not its index', () => {
    expect(rowWindow(offsets, 210, 20, 0)).toEqual({ start: 10, end: 11 })
  })

  it('stops at the ends of the list', () => {
    expect(rowWindow(offsets, 5000, 100, 3)).toEqual({ start: 7, end: 11 })
    expect(rowWindow([0], 0, 100, 3)).toEqual({ start: 0, end: 0 })
  })
})
