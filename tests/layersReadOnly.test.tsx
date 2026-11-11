// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

/* Below the edit role the Layers panel still selects, reveals and navigates, but offers no rename, drag-reorder,
   hide or lock toggle, delete, new frame or context menu. The server refuses those writes anyway; this keeps the
   panel from offering them. */
type StackWrite = { id: string; z: number }
const api = vi.hoisted(() => ({
  restackFrames: vi.fn(async (_canvasId: string, _frames: StackWrite[]) => []),
  updateFrame: vi.fn(async () => undefined),
  deleteFrame: vi.fn(async () => undefined),
}))
vi.mock('../src/lib/api', () => ({
  api,
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  settleFrames: () => Promise.resolve(),
}))

const { useStore } = await import('../src/lib/store')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

function frameWith(id: string, createdAt: number): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id.toUpperCase(),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '<!doctype html><html><head></head><body><div><p>A</p></div></body></html>',
    createdAt,
    updatedAt: 0,
    updatedBy: 'me',
  }
}
const DIV = 'body:nth-of-type(1) > div:nth-of-type(1)'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const rowByKey = (key: string) => {
  const el = container.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}
const stack = () => useStore.getState().canvas?.frames.map((f) => f.id)
const toggles = (el: HTMLElement) => el.querySelectorAll('button[aria-label="Hide"], button[aria-label="Lock"]').length
const tree = () => {
  const el = container.querySelector<HTMLElement>('[role="tree"][aria-label="Layers"]')
  if (!el) throw new Error('layers tree not rendered')
  return el
}
const nameInput = () => container.querySelector('input[aria-label="Item name"]')

/* happy-dom has no layout: the row under the pointer is whichever one the test names, and every row is 28px tall */
function dragRow(from: string, to: string, atY: number) {
  const target = rowByKey(to)
  document.elementFromPoint = () => target
  target.getBoundingClientRect = () => ({ top: 0, height: 28 }) as DOMRect
  act(() => {
    rowByKey(from).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: atY }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: atY }))
  })
}

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root.render(
      <TooltipProvider>
        <LayersPanel onAddFrame={() => {}} />
      </TooltipProvider>,
    ),
  )
}

function open(role: 'view' | 'comment' | 'edit') {
  api.restackFrames.mockClear()
  api.updateFrame.mockClear()
  api.deleteFrame.mockClear()
  useStore
    .getState()
    .setCanvas({ id: 'c1', name: 'Canvas', frames: [frameWith('f1', 1), frameWith('f2', 2)] } as Canvas)
  useStore.getState().setRole(role)
  /* the selected frame's row opens on its own, so its layers are listed */
  useStore.setState({ selectedId: 'f1', selectedIds: ['f1'], selectedElement: null, notice: null, flyTo: null })
  mount()
  /* a pick inside the frame opens its row, so its layer is listed */
  act(() => useStore.getState().pickElement({ frameId: 'f1', selector: DIV }))
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => useStore.getState().setCanvas(null))
})

describe.each(['view', 'comment'] as const)('Layers panel with the %s role', (role) => {
  beforeEach(() => open(role))

  it('still selects, reveals and navigates', () => {
    act(() => rowByKey('f2').click())
    expect(useStore.getState().selectedId).toBe('f2')
    act(() => rowByKey(`f1|${DIV}`).click())
    expect(useStore.getState().selectedElement).toMatchObject({ frameId: 'f1', selector: DIV })
    act(() => {
      tree().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(useStore.getState().flyTo).not.toBeNull()
  })

  it('offers no hide or lock toggles and no new-frame button', () => {
    expect(toggles(rowByKey('f1'))).toBe(0)
    expect(toggles(rowByKey(`f1|${DIV}`))).toBe(0)
    expect(container.querySelector('button[aria-label="New frame"]')).toBeNull()
  })

  it('does not rename on a double-click', () => {
    act(() => rowByKey('f1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    act(() => rowByKey(`f1|${DIV}`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(nameInput()).toBeNull()
  })

  it('opens no context menu', async () => {
    await act(async () => {
      rowByKey('f1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    await act(async () => {
      rowByKey(`f1|${DIV}`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('does not reorder by dragging', () => {
    dragRow('f1', 'f2', 2)
    expect(stack()).toEqual(['f1', 'f2'])
    expect(api.restackFrames).not.toHaveBeenCalled()
    expect(api.updateFrame).not.toHaveBeenCalled()
    expect(container.querySelector('[data-slot="panel-body"]')?.className).not.toContain('cursor-grabbing')
  })

  it.each(['Delete', 'Backspace'])('does not delete the selection on %s', (key) => {
    act(() => {
      tree().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(stack()).toEqual(['f1', 'f2'])
  })
})

describe('Layers panel with the edit role', () => {
  beforeEach(() => open('edit'))

  it('offers the same controls the viewers lose', async () => {
    expect(toggles(rowByKey('f1'))).toBeGreaterThan(0)
    expect(container.querySelector('button[aria-label="New frame"]')).not.toBeNull()
    act(() => rowByKey('f1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(nameInput()).not.toBeNull()
  })

  it('reorders by dragging', () => {
    dragRow('f1', 'f2', 2)
    expect(stack()).toEqual(['f2', 'f1'])
  })
})
