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
    role: 'edit',
    laser: false,
    tool: 'select',
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

describe('tidy (⇧T)', () => {
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
    expect(press({ key: 'T', shiftKey: true, code: 'KeyT' })).toBe(false)
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

  it('l is the laser and c the comment tool, which exclude each other, and Esc leaves the mode before clearing the selection', () => {
    useStore.setState({ selectedIds: ['a'], selectedId: 'a' })
    press({ key: 'l' })
    expect(useStore.getState().laser).toBe(true)
    press({ key: 'c' })
    expect(useStore.getState().tool).toBe('comment')
    expect(useStore.getState().laser).toBe(false)
    press({ key: 'l' })
    expect(useStore.getState().laser).toBe(true)
    expect(useStore.getState().tool).toBe('select')
    press({ key: 'Escape' })
    expect(useStore.getState().laser).toBe(false)
    expect(useStore.getState().selectedIds).toEqual(['a'])
    press({ key: 'c' })
    press({ key: 'Escape' })
    expect(useStore.getState().tool).toBe('select')
    expect(useStore.getState().selectedIds).toEqual(['a'])
    press({ key: 'Escape' })
    expect(useStore.getState().selectedIds).toEqual([])
  })

  it('picks a tool with its key and leaves the select tool when Esc is pressed', () => {
    for (const [key, tool] of [
      ['v', 'select'],
      ['h', 'hand'],
      ['f', 'frame'],
      ['r', 'rectangle'],
      ['o', 'circle'],
      ['p', 'path'],
      ['t', 'text'],
    ] as const) {
      expect(press({ key }), key).toBe(true)
      expect(useStore.getState().tool, key).toBe(tool)
    }
    press({ key: 'Escape' })
    expect(useStore.getState().tool).toBe('select')
  })

  it('? opens the shortcuts dialog', () => {
    press({ key: '?', shiftKey: true })
    expect(useStore.getState().shortcutsOpen).toBe(true)
  })

  describe.each(['view', 'comment'] as const)('with the %s role', (role) => {
    beforeEach(() => {
      useStore.setState({ role, laser: false, tool: 'select', selectedIds: ['a'], selectedId: 'a' })
    })

    it('leaves the layout alone: device keys, 0, ⇧T and the drawing tools do nothing', () => {
      const before = rects()
      for (const init of [
        { key: '1', code: 'Digit1' },
        { key: '2', code: 'Digit2' },
        { key: '0', code: 'Digit0' },
        { key: 'T', shiftKey: true, code: 'KeyT' },
        { key: 'f' },
        { key: 'r' },
        { key: 'o' },
        { key: 'p' },
        { key: 't' },
      ]) {
        expect(press(init)).toBe(false)
      }
      expect(useStore.getState().tool).toBe('select')
      expect(rects()).toEqual(before)
      expect(updateFrame).not.toHaveBeenCalled()
    })

    it('does not delete, duplicate, undo or redo', () => {
      for (const init of [
        { key: 'Backspace' },
        { key: 'Delete' },
        { key: 'd', metaKey: true },
        { key: 'z', metaKey: true },
        { key: 'z', metaKey: true, shiftKey: true },
        { key: 'y', metaKey: true },
      ]) {
        expect(press(init)).toBe(false)
      }
      expect(useStore.getState().canvas!.frames).toHaveLength(3)
    })

    it('still lets them look: laser, fit, select all and notes visibility work', () => {
      expect(press({ key: 'l' })).toBe(true)
      expect(useStore.getState().laser).toBe(true)
      expect(press({ key: '1', shiftKey: true, code: 'Digit1' })).toBe(true)
      expect(press({ key: 'a', metaKey: true })).toBe(true)
      const visible = useStore.getState().notesVisible
      expect(press({ key: 'n' })).toBe(true)
      expect(useStore.getState().notesVisible).toBe(!visible)
    })
  })

  it('the comment tool needs the comment role: view is refused, comment is allowed', () => {
    useStore.setState({ role: 'view' })
    expect(press({ key: 'c' })).toBe(false)
    expect(useStore.getState().tool).toBe('select')
    useStore.setState({ role: 'comment' })
    expect(press({ key: 'c' })).toBe(true)
    expect(useStore.getState().tool).toBe('comment')
  })

  it('a canvas whose role has not arrived yet grants nothing', () => {
    useStore.setState({ role: null })
    expect(press({ key: 't' })).toBe(false)
    expect(press({ key: 'T', shiftKey: true, code: 'KeyT' })).toBe(false)
    expect(press({ key: 'c' })).toBe(false)
  })
})
