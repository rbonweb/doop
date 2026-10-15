// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/api', () => ({
  api: { updateFrame: () => Promise.resolve(), deleteFrame: () => Promise.resolve() },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

/* a frame as big as a real store template: thousands of elements, every one a
   match for a one-letter search */
const COUNT = 3000
const ROW = 26
const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Big frame',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: `<!doctype html><html><head></head><body>${Array.from({ length: COUNT }, (_, i) => `<p>P${i}</p>`).join('')}</body></html>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function tree() {
  const el = container.querySelector<HTMLElement>('[role="tree"]')
  if (!el) throw new Error('layers tree not rendered')
  return el
}

function items() {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

function search(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Search layers"]')
  if (!input) throw new Error('search field not rendered')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function scrollTo(top: number) {
  act(() => {
    tree().scrollTop = top
    tree().dispatchEvent(new Event('scroll'))
  })
}

describe('LayersPanel on a large frame', () => {
  beforeEach(() => {
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
    useStore.setState({ canvas, selectedId: null, selectedIds: [], selectedElement: null })
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
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders only the rows in view when a search matches thousands of elements', () => {
    search('p')
    const rendered = items()
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(100)
    expect(rendered[0]?.textContent).toBe('Big frame')
  })

  it('keeps the full height of the list so the scrollbar covers every row', () => {
    search('p')
    expect(tree().scrollHeight === 0 || tree().scrollHeight >= (COUNT + 1) * ROW).toBe(true)
    const spacers = [...tree().querySelectorAll<HTMLElement>('[data-slot="rows-spacer"]')]
    const total = spacers.reduce((sum, el) => sum + parseFloat(el.style.height || '0'), 0) + items().length * ROW
    expect(total).toBe((COUNT + 1) * ROW)
  })

  it('renders the rows that scrolling brings into view', () => {
    search('p')
    scrollTo(2000 * ROW)
    const labels = items().map((el) => el.textContent)
    expect(labels).toContain('P1999')
    expect(labels).not.toContain('P0')
  })

  it('scrolls a selection made in the frame into view even when its row is far down', () => {
    act(() => useStore.getState().select('f1'))
    act(() => useStore.getState().pickElement({ frameId: 'f1', selector: 'body:nth-of-type(1) > p:nth-of-type(2501)' }))
    expect(tree().scrollTop).toBeGreaterThan(0)
    const selected = items().find((el) => el.getAttribute('aria-selected') === 'true')
    expect(selected?.textContent).toBe('P2500')
  })
})
