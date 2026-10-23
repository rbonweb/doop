// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { DEVICES } from '../shared/devices'

const updateFrame = vi.fn((_id: string, _patch: unknown) => Promise.resolve())
vi.mock('../src/lib/api', () => ({ api: { updateFrame: (id: string, patch: unknown) => updateFrame(id, patch) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { applyDevice, clearLayoutSnapshots, restoreDevices, tidyFrames } = await import('../src/lib/layoutEdits')
const { clearHistory, undo } = await import('../src/lib/history')
const { dispatchShortcut, registerShortcut } = await import('../src/lib/shortcuts')
const { canvasShortcuts } = await import('../src/lib/canvasShortcuts')

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

const originals = () => [frame('a', 13, 27, 640, 480), frame('b', 900, 31, 777, 555), frame('c', 41, 1200, 300, 900)]
const rects = () =>
  useStore.getState().canvas!.frames.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))
const mobile = DEVICES[0]!
const desktop = DEVICES[3]!

beforeEach(() => {
  updateFrame.mockClear()
  clearHistory()
  clearLayoutSnapshots()
  const canvas = { id: 'c1', name: 'Canvas', frames: originals() } as Canvas
  useStore.setState({
    canvas,
    activePageId: null,
    selectedIds: [],
    selectedId: null,
    stageSize: { width: 1200, height: 800 },
    viewport: { x: 0, y: 0, zoom: 1 },
  })
})

describe('device sizes and 0', () => {
  it('applies a preset to every frame on the page when nothing is selected, then tidies', () => {
    applyDevice(mobile)
    const after = rects()
    expect(after.every((r) => r.width === 390 && r.height === 844)).toBe(true)
    /* tidied: no two frames overlap, and the layout starts at the old top-left corner (13, 27) */
    expect(Math.min(...after.map((r) => r.x))).toBe(13)
    expect(Math.min(...after.map((r) => r.y))).toBe(27)
    const [a, b, c] = after
    expect(b!.x - (a!.x + a!.width)).toBeGreaterThanOrEqual(140)
    expect(c!.y).toBeGreaterThan(a!.y + a!.height)
    expect(updateFrame).toHaveBeenCalledTimes(3)
  })

  it('applies a preset to the selection only', () => {
    useStore.setState({ selectedIds: ['b'], selectedId: 'b' })
    applyDevice(desktop)
    const byId = Object.fromEntries(rects().map((r) => [r.id, r]))
    expect(byId.b).toMatchObject({ width: 1440, height: 900 })
    expect(byId.a).toMatchObject({ x: 13, y: 27, width: 640, height: 480 })
    expect(byId.c).toMatchObject({ x: 41, y: 1200, width: 300, height: 900 })
  })

  it('0 restores sizes and positions exactly, and clears the snapshot', () => {
    const before = rects()
    applyDevice(mobile)
    expect(rects()).not.toEqual(before)
    expect(restoreDevices()).toBe(true)
    expect(rects()).toEqual(before)
    expect(restoreDevices()).toBe(false)
  })

  it('restores to the layout before the FIRST device key, however many were pressed', () => {
    const before = rects()
    for (const device of DEVICES) applyDevice(device)
    expect(rects()).not.toEqual(before)
    restoreDevices()
    expect(rects()).toEqual(before)
  })

  it('sends the restore through the normal update path so collaborators see it', () => {
    applyDevice(mobile)
    updateFrame.mockClear()
    restoreDevices()
    expect(updateFrame).toHaveBeenCalledTimes(3)
    expect(updateFrame).toHaveBeenCalledWith('a', { x: 13, y: 27, width: 640, height: 480 })
  })

  it('one device key press is one undo entry', async () => {
    const before = rects()
    applyDevice(mobile)
    await undo()
    expect(rects()).toEqual(before)
  })

  it('does not tidy on restore: the frames land where they were, gaps and all', () => {
    const before = rects()
    applyDevice(mobile)
    restoreDevices()
    expect(rects()).toEqual(before)
    expect(rects()[0]).toMatchObject({ x: 13, y: 27 })
  })

  it('fits the result into view', () => {
    applyDevice(mobile)
    const { x, y, zoom } = useStore.getState().viewport
    expect({ x, y, zoom }).not.toEqual({ x: 0, y: 0, zoom: 1 })
    expect(zoom).toBeGreaterThan(0)
  })
})

describe('tidy (t)', () => {
  it('moves frames into rows without resizing them and is one undo entry', async () => {
    const before = rects()
    tidyFrames()
    const after = rects()
    expect(after.map((r) => [r.width, r.height])).toEqual(before.map((r) => [r.width, r.height]))
    expect(after).not.toEqual(before)
    await undo()
    expect(rects()).toEqual(before)
  })

  it('does nothing and records nothing when the layout is already tidy', async () => {
    tidyFrames()
    updateFrame.mockClear()
    expect(tidyFrames()).toBe(0)
    expect(updateFrame).not.toHaveBeenCalled()
  })
})

describe('the keys', () => {
  const removers: (() => void)[] = []
  beforeEach(() => {
    removers.splice(0).forEach((remove) => remove())
    removers.push(...canvasShortcuts.map(registerShortcut))
  })
  const press = (init: KeyboardEventInit) => dispatchShortcut(new KeyboardEvent('keydown', { bubbles: true, ...init }))

  it('1 sizes to mobile and 0 puts it back', () => {
    const before = rects()
    expect(press({ key: '1', code: 'Digit1' })).toBe(true)
    expect(rects().every((r) => r.width === 390)).toBe(true)
    expect(press({ key: '0', code: 'Digit0' })).toBe(true)
    expect(rects()).toEqual(before)
  })

  it('does nothing while the board is showing (no stage)', () => {
    useStore.setState({ stageSize: null })
    expect(press({ key: '1', code: 'Digit1' })).toBe(false)
    expect(press({ key: 't' })).toBe(false)
    expect(rects()).toEqual(originals().map(({ id, x, y, width, height }) => ({ id, x, y, width, height })))
  })

  it('⌘A selects every frame on the page', () => {
    expect(press({ key: 'a', metaKey: true })).toBe(true)
    expect(useStore.getState().selectedIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('⌘A only takes the current page', () => {
    useStore.setState({
      canvas: {
        id: 'c1',
        name: 'Canvas',
        pages: [
          { id: 'p1', name: 'One' },
          { id: 'p2', name: 'Two' },
        ],
        frames: [
          { ...frame('a', 0, 0, 10, 10), pageId: 'p1' },
          { ...frame('b', 0, 0, 10, 10), pageId: 'p2' },
        ],
      } as Canvas,
      activePageId: 'p2',
    })
    press({ key: 'a', metaKey: true })
    expect(useStore.getState().selectedIds).toEqual(['b'])
  })

  it('l and c toggle their modes, which exclude each other, and Esc leaves the mode before clearing the selection', () => {
    useStore.setState({ selectedIds: ['a'], selectedId: 'a' })
    press({ key: 'l' })
    expect(useStore.getState().laser).toBe(true)
    press({ key: 'c' })
    expect(useStore.getState().commentMode).toBe(true)
    expect(useStore.getState().laser).toBe(false)
    press({ key: 'Escape' })
    expect(useStore.getState().commentMode).toBe(false)
    expect(useStore.getState().selectedIds).toEqual(['a'])
    press({ key: 'Escape' })
    expect(useStore.getState().selectedIds).toEqual([])
  })

  it('? opens the shortcuts dialog', () => {
    press({ key: '?', shiftKey: true })
    expect(useStore.getState().shortcutsOpen).toBe(true)
  })
})
