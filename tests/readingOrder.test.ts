import { describe, expect, it } from 'vitest'
import { readingOrder, readingRows } from '../shared/readingOrder'

const box = (id: string, x: number, y: number, width = 100, height = 100) => ({ id, x, y, width, height })
const ids = (frames: { id: string }[]) => frames.map((f) => f.id)

describe('readingOrder', () => {
  it('reads rows top to bottom and frames left to right', () => {
    const frames = [box('d', 200, 300), box('b', 200, 0), box('c', 0, 300), box('a', 0, 0)]
    expect(ids(readingOrder(frames))).toEqual(['a', 'b', 'c', 'd'])
    expect(readingRows(frames).map(ids)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('puts frames in one row when they overlap by at least half the shorter height', () => {
    /* 100 tall at y=0 and 100 tall at y=50: the overlap is exactly 50, half of 100 */
    const frames = [box('right', 300, 50), box('left', 0, 0)]
    expect(readingRows(frames).map(ids)).toEqual([['left', 'right']])
  })

  it('splits rows when the overlap falls short of half', () => {
    const frames = [box('a', 0, 0), box('b', 300, 51)]
    expect(readingRows(frames).map(ids)).toEqual([['a'], ['b']])
  })

  it('measures the overlap against the shorter frame, so a short frame beside a tall one joins its row', () => {
    const frames = [box('tall', 0, 0, 100, 600), box('short', 200, 250, 100, 100)]
    expect(readingRows(frames).map(ids)).toEqual([['tall', 'short']])
  })

  it('keeps frames at identical positions together', () => {
    const frames = [box('a', 0, 0), box('b', 0, 0)]
    expect(readingRows(frames)).toHaveLength(1)
    expect(readingOrder(frames)).toHaveLength(2)
  })

  it('handles no frames and one frame', () => {
    expect(readingOrder([])).toEqual([])
    expect(ids(readingOrder([box('only', 5, 5)]))).toEqual(['only'])
  })

  it('does not mutate its input', () => {
    const frames = [box('b', 200, 0), box('a', 0, 0)]
    readingOrder(frames)
    expect(ids(frames)).toEqual(['b', 'a'])
  })
})
