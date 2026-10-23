import { describe, expect, it } from 'vitest'
import { tidyLayout } from '../shared/tidy'

const f = (id: string, x: number, y: number, width: number, height: number) => ({ id, x, y, width, height })
const at = (positions: { id: string; x: number; y: number }[], id: string) => positions.find((p) => p.id === id)

describe('tidyLayout', () => {
  it('returns nothing for no frames', () => {
    expect(tidyLayout([])).toEqual([])
  })

  it('lays reading-order rows from the top-left of the bounding box with the minimum gutters', () => {
    /* widest 400 -> gutter max(140, 48) = 140; tallest 500 -> gutter max(96, 80) = 96 */
    const out = tidyLayout([f('a', 1000, 500, 400, 300), f('b', 2500, 520, 200, 500), f('c', 1200, 2000, 300, 200)])
    expect(at(out, 'a')).toMatchObject({ x: 1000, y: 500 })
    expect(at(out, 'b')).toMatchObject({ x: 1000 + 400 + 140, y: 500 })
    /* the next row starts below the tallest frame of the first one (500) plus the gutter */
    expect(at(out, 'c')).toMatchObject({ x: 1000, y: 500 + 500 + 96 })
  })

  it('scales the gutters with the widest and tallest frames', () => {
    /* widest 2000 -> 240; tallest 1000 -> 160 */
    const out = tidyLayout([f('a', 0, 0, 2000, 100), f('b', 3000, 10, 100, 1000), f('c', 0, 5000, 100, 100)])
    expect(at(out, 'b')).toMatchObject({ x: 2000 + 240, y: 0 })
    expect(at(out, 'c')).toMatchObject({ x: 0, y: 1000 + 160 })
  })

  it('reports every frame once and only moves it', () => {
    const frames = [f('a', 10, 10, 120, 80), f('b', 400, 12, 120, 80), f('c', 15, 400, 120, 80)]
    const out = tidyLayout(frames)
    expect(out.map((p) => p.id).sort()).toEqual(['a', 'b', 'c'])
    expect(out.every((p) => Object.keys(p).sort().join() === 'id,x,y')).toBe(true)
  })

  it('is stable: tidying a tidy layout changes nothing', () => {
    const frames = [f('a', 0, 0, 390, 844), f('b', 900, 30, 834, 1194), f('c', 40, 3000, 1280, 800)]
    const once = tidyLayout(frames)
    const moved = frames.map((fr) => ({ ...fr, ...at(once, fr.id)! }))
    expect(tidyLayout(moved)).toEqual(once)
  })
})
