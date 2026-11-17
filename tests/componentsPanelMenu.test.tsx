// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components'

const mocks = vi.hoisted(() => ({
  duplicateComponent: vi.fn(),
  detachComponentFromLibrary: vi.fn(),
  notices: [] as string[],
  components: [] as unknown[],
  canEdit: true,
  setComponentLocal: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    duplicateComponent: mocks.duplicateComponent,
    detachComponentFromLibrary: mocks.detachComponentFromLibrary,
    componentPreview: vi.fn(),
  },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: 'canvas1', name: 'Canvas', components: mocks.components, tokens: [], tokenThemes: [] }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: mocks.setComponentLocal,
  }
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state })
  return { useStore, canEditOpenCanvas: () => mocks.canEdit }
})
vi.mock('../src/lib/components', () => ({
  COMPONENT_DRAG_TYPE: 'application/x-doop-component',
  goToMain: () => {},
  placeComponent: () => {},
  removeComponent: () => {},
  renameComponent: () => {},
}))
vi.mock('../src/lib/library', () => ({
  useCanvasLibrary: () => ({ status: null, libraries: [], reload: () => {} }),
}))
vi.mock('../src/lib/libraryResume', () => ({ useLibraryResume: () => {} }))
vi.mock('../src/components/ComponentThumb', () => ({ ComponentThumb: () => null, useTokenStamp: () => 'stamp' }))
vi.mock('../src/components/ComponentImport', () => ({
  ImportCanvasList: () => null,
  ImportComponentsModal: () => null,
}))
vi.mock('../src/components/LibrarySection', () => ({
  LibraryNotices: () => null,
  LibrarySection: () => null,
  LibraryUpgradeFlow: () => null,
  PublishLibraryDialog: () => null,
}))
import { ComponentsPanel } from '../src/components/ComponentsPanel'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The card menu: Duplicate for anyone who may edit, Detach from library only on a linked component,
   and that one asks before it calls the server. */

let root: Root
let container: HTMLDivElement

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({
  id: 'cbutton',
  name: 'Button',
  description: '',
  template: '<button data-doop-part="r">Buy</button>',
  css: '',
  rawCss: '',
  head: [],
  props: [],
  slots: [],
  rev: 1,
  mainFrameId: 'main1',
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Tester',
  ...over,
})
const linked = () => def({ source: { library: true, canvasId: 'lib1', canvasName: 'Library', rev: 1 } as never })

const labels = () => Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim())
const pick = async (label: string) => {
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((i) => i.textContent?.trim() === label)!
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    ;(item as HTMLElement).click()
  })
}
async function openMenu() {
  const trigger = container.querySelector('[data-component-menu]')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.canEdit = true
  mocks.notices.length = 0
  mocks.duplicateComponent.mockReset()
  mocks.detachComponentFromLibrary.mockReset()
  mocks.setComponentLocal.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('offers Duplicate, calls the route, and offers no Detach on a local component', async () => {
  mocks.components = [def()]
  mocks.duplicateComponent.mockResolvedValue({
    component: def({ id: 'ccopy', name: 'Button copy' }),
    main_frame_id: 'm2',
  })
  await act(async () => root.render(<ComponentsPanel />))
  await openMenu()
  expect(labels()).toContain('Duplicate')
  expect(labels()).not.toContain('Detach from library')
  await pick('Duplicate')
  expect(mocks.duplicateComponent).toHaveBeenCalledWith('canvas1', 'cbutton')
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('ccopy', expect.objectContaining({ name: 'Button copy' }))
  expect(mocks.notices).toEqual(['“Button” duplicated as “Button copy”'])
})

it('offers Detach from library on a linked component and asks before calling the server', async () => {
  mocks.components = [linked()]
  mocks.detachComponentFromLibrary.mockResolvedValue({ component: def(), main_frame_id: 'm2' })
  await act(async () => root.render(<ComponentsPanel />))
  await openMenu()
  expect(labels()).toContain('Detach from library')
  await pick('Detach from library')
  expect(mocks.detachComponentFromLibrary).not.toHaveBeenCalled()
  const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
  expect(dialog.textContent).toContain('Library updates will no longer arrive')
  const confirm = Array.from(dialog.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Detach from library',
  )!
  await act(async () => confirm.click())
  expect(mocks.detachComponentFromLibrary).toHaveBeenCalledWith('canvas1', 'cbutton')
  expect(mocks.notices).toEqual(['“Button” detached from its library'])
})

it('hides both items from someone who cannot edit', async () => {
  mocks.canEdit = false
  mocks.components = [linked()]
  await act(async () => root.render(<ComponentsPanel />))
  await openMenu()
  expect(labels()).not.toContain('Duplicate')
  expect(labels()).not.toContain('Detach from library')
})
