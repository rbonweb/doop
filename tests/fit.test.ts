// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { fitViewport, MAX_ZOOM, MIN_ZOOM, zoomAroundCenter } from '../src/lib/fit'
import { useStore } from '../src/lib/store'

const frame = (id: string, x: number, y: number, width: number, height: number): Frame => ({
  id,
  canvasId: 'c1',
  name: id,
  x,
  y,
  width,
  height,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
})

const STAGE = { width: 1000, height: 700 }

describe('fitViewport', () => {
  it('centers the box and leaves 80 px of padding at the limiting side', () => {
    /* one 840×340 frame: its box is 840 wide and 370 tall with the title bar, so the width limits at (1000 - 160) / 840 = 1 */
    const cam = fitViewport([frame('a', 100, 200, 840, 340)], STAGE)
    expect(cam.zoom).toBeCloseTo(1)
    expect(cam.x).toBeCloseTo((1000 - 840) / 2 - 100)
    expect(cam.y).toBeCloseTo((700 - 370) / 2 - (200 - 30))
  })

  it('never zooms in past 125%', () => {
    expect(fitViewport([frame('a', 0, 0, 50, 50)], STAGE).zoom).toBe(1.25)
  })

  it('clamps to the zoom range', () => {
    expect(fitViewport([frame('a', 0, 0, 90000, 90000)], STAGE).zoom).toBe(MIN_ZOOM)
    expect(MAX_ZOOM).toBeGreaterThan(1.25)
  })

  it('rests at the origin when there is nothing to fit', () => {
    expect(fitViewport([], STAGE)).toEqual({ x: 80, y: 80, zoom: 1 })
  })

  it('puts the box center at the stage center', () => {
    const frames = [frame('a', 0, 0, 400, 300), frame('b', 1000, 800, 400, 300)]
    const cam = fitViewport(frames, STAGE)
    const cx = (0 + 1400) / 2
    const cy = (-30 + 1100) / 2
    expect(cx * cam.zoom + cam.x).toBeCloseTo(STAGE.width / 2)
    expect(cy * cam.zoom + cam.y).toBeCloseTo(STAGE.height / 2)
  })
})

describe('zoomAroundCenter', () => {
  it('keeps the point under the stage center fixed', () => {
    const cam = { x: -200, y: -50, zoom: 0.5 }
    const next = zoomAroundCenter(cam, 1, STAGE)
    const worldAtCenter = (STAGE.width / 2 - cam.x) / cam.zoom
    expect(worldAtCenter * next.zoom + next.x).toBeCloseTo(STAGE.width / 2)
    expect(next.zoom).toBe(1)
  })
})

describe('fitSelection and fitAll in the store', () => {
  beforeEach(() => {
    const canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [frame('a', 0, 0, 400, 300), frame('b', 3000, 0, 400, 300), frame('c', 0, 2000, 400, 300)],
    } as Canvas
    useStore.setState({
      canvas,
      activePageId: null,
      selectedIds: [],
      selectedId: null,
      stageSize: STAGE,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
  })

  it('fitSelection frames just the selected frames', () => {
    useStore.setState({ selectedIds: ['b'], selectedId: 'b' })
    useStore.getState().fitSelection()
    const expected = fitViewport([frame('b', 3000, 0, 400, 300)], STAGE)
    expect(useStore.getState().viewport).toEqual(expected)
  })

  it('fitSelection over several frames uses their joint box', () => {
    useStore.setState({ selectedIds: ['a', 'c'], selectedId: 'c' })
    useStore.getState().fitSelection()
    expect(useStore.getState().viewport).toEqual(
      fitViewport([frame('a', 0, 0, 400, 300), frame('c', 0, 2000, 400, 300)], STAGE),
    )
  })

  it('fitSelection with nothing selected frames the whole page, like fitAll', () => {
    useStore.getState().fitSelection()
    const viaSelection = useStore.getState().viewport
    useStore.setState({ viewport: { x: 0, y: 0, zoom: 1 } })
    useStore.getState().fitAll()
    expect(useStore.getState().viewport).toEqual(viaSelection)
  })

  it('does nothing before the stage has reported its size', () => {
    useStore.setState({ stageSize: null })
    useStore.getState().fitAll()
    expect(useStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('zoomTo(1) pivots on the stage center', () => {
    useStore.setState({ viewport: { x: -300, y: -100, zoom: 0.4 } })
    useStore.getState().zoomTo(1)
    const vp = useStore.getState().viewport
    expect(vp.zoom).toBe(1)
    const worldX = (STAGE.width / 2 + 300) / 0.4
    expect(worldX * vp.zoom + vp.x).toBeCloseTo(STAGE.width / 2)
  })
})
