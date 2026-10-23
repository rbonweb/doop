// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, CanvasNote, Frame } from '../shared/types'

/* Below the edit role the canvas UI offers no control that would be turned down by the server: sticky notes cannot be
   dragged, recoloured, deleted or resized, the page tree only navigates, and version history opens without Restore. */
const api = vi.hoisted(() => ({
  frameVersions: vi.fn(async () => [
    {
      id: 'v1',
      frameId: 'f1',
      canvasId: 'c1',
      savedAt: 1,
      savedBy: 'alice',
      reason: 'human',
      name: 'Hero',
      width: 10,
      height: 10,
    },
  ]),
  frameVersion: vi.fn(async () => ({
    id: 'v1',
    frameId: 'f1',
    canvasId: 'c1',
    savedAt: 1,
    savedBy: 'alice',
    reason: 'human',
    name: 'Hero',
    width: 10,
    height: 10,
    html: '<p>old</p>',
  })),
  restoreFrameVersion: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  createNote: vi.fn(),
  updatePages: vi.fn(),
}))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { StickyNote } = await import('../src/components/StickyNote')
const { PagesPanel } = await import('../src/components/PagesPanel')
const { FrameHistoryPanel } = await import('../src/components/FrameHistoryPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Hero',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<p>now</p>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const note: CanvasNote = {
  id: 'n1',
  canvasId: 'c1',
  x: 0,
  y: 0,
  width: 240,
  height: 180,
  markdown: 'remember',
  color: 'yellow',
  createdBy: 'Claude',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Claude',
}

let container: HTMLDivElement
let root: Root

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(<TooltipProvider>{node}</TooltipProvider>)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useStore.setState({
    canvas: {
      id: 'c1',
      name: 'Canvas',
      frames: [frame],
      notes: [note],
      pages: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two', parentId: 'p1' },
      ],
    } as Canvas,
    activePageId: 'p1',
    selectedIds: ['f1'],
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

const labels = () => [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))

describe.each(['view', 'comment'] as const)('with the %s role', (role) => {
  beforeEach(() => useStore.setState({ role }))

  it('shows a sticky note without drag, colours, delete or resize', async () => {
    await mount(<StickyNote note={note} />)
    expect(container.textContent).toContain('remember')
    expect(labels()).toContain('Fold note')
    expect(labels()).not.toContain('Delete note')
    expect(labels()).not.toContain('Resize note')
    expect(labels().some((l) => l?.endsWith(' note') && l !== 'Fold note' && l !== 'Delete note')).toBe(false)
    expect(container.querySelector('header')?.className).toContain('cursor-default')
    // a double-click does not open the editor
    const body = container.querySelector('[data-note-id] > div:nth-of-type(3)') ?? container
    act(() => {
      body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('lets the page tree navigate but not add, move or move frames', async () => {
    await mount(<PagesPanel />)
    expect(container.textContent).toContain('One')
    expect(container.textContent).toContain('Two')
    expect(labels()).not.toContain('Add page')
    expect(container.querySelector('select')).toBeNull()
    const two = [...container.querySelectorAll<HTMLButtonElement>('button[data-page-name]')].find(
      (b) => b.textContent === 'Two',
    )!
    act(() => two.click())
    expect(useStore.getState().activePageId).toBe('p2')
    expect(api.updatePages).not.toHaveBeenCalled()
  })

  it('opens version history for reading, with no Restore button', async () => {
    await mount(<FrameHistoryPanel frame={frame} onClose={() => {}} />)
    expect(container.textContent).toContain('alice')
    expect(container.textContent).not.toContain('Restore this version')
  })
})

describe('with the edit role', () => {
  beforeEach(() => useStore.setState({ role: 'edit' }))

  it('offers the note controls, the page controls and Restore', async () => {
    await mount(<StickyNote note={note} />)
    expect(labels()).toContain('Delete note')
    expect(labels()).toContain('Resize note')
    await mount(<PagesPanel />)
    expect(labels()).toContain('Add page')
    await mount(<FrameHistoryPanel frame={frame} onClose={() => {}} />)
    expect(container.textContent).toContain('Restore this version')
  })
})
