// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  editComponentVariants: vi.fn(),
  componentVariants: vi.fn(),
  previewVariant: vi.fn(),
  setComponentLocal: vi.fn(),
  notices: [] as string[],
  canEdit: true,
}))
vi.mock('../src/lib/api', () => ({
  api: { editComponentVariants: mocks.editComponentVariants, componentVariants: mocks.componentVariants },
  errorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}))
vi.mock('../src/lib/frameBridge', () => ({
  previewVariant: mocks.previewVariant,
  onFrameChange: () => () => {},
}))
vi.mock('../src/lib/components', () => ({ componentContextOf: () => null }))
vi.mock('../src/lib/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const state = {
    canvas: { id: 'canvas1', components: [] as unknown[], frames: [] as unknown[] },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: mocks.setComponentLocal,
  }
  const useStore = Object.assign(
    (select: (s: typeof state) => unknown) =>
      useSyncExternalStore(
        () => () => {},
        () => select(state),
      ),
    { getState: () => state },
  )
  return { useStore, canEditOpenCanvas: () => mocks.canEdit }
})
import { VariantsSection } from '../src/components/VariantsSection'
import { useVariantPreview } from '../src/lib/variantPreview'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Variants group on a main: every action is one POST to the variants endpoint with the right ops, a removal asks
   first and says how many instances use the value, and the preview picker drives the live frame and the style redirect. */

let root: Root
let container: HTMLDivElement

const frame = { id: 'main1', canvasId: 'canvas1', name: 'Components', html: '' } as unknown as Frame

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({
  id: 'cbutton',
  name: 'Button',
  description: '',
  template: '<button data-doop-part="r"></button>',
  css: '',
  rawCss: '',
  head: [],
  props: [
    { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'quiet', type: 'boolean', default: 'false', reflect: true },
  ],
  slots: [],
  rev: 1,
  mainFrameId: 'main1',
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Tester',
  ...over,
})

const ok = (over: Record<string, unknown> = {}) => ({
  component: def(),
  props: [],
  rules: [],
  instances_updated: 0,
  frames_updated: 0,
  ...over,
})

const show = (component = def()) => act(async () => root.render(<VariantsSection frame={frame} def={component} />))
const byLabel = <T extends Element>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!
const calls = () => mocks.editComponentVariants.mock.calls.map((call) => call[2])

const menuLabels = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim())
async function openMenu(trigger: Element) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
}
async function pick(label: string) {
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((i) => i.textContent?.trim() === label)!
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    ;(item as HTMLElement).click()
  })
}
function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = (input: Element) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    set.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.canEdit = true
  mocks.notices.length = 0
  for (const fn of [
    mocks.editComponentVariants,
    mocks.componentVariants,
    mocks.previewVariant,
    mocks.setComponentLocal,
  ]) {
    fn.mockReset()
  }
  mocks.editComponentVariants.mockImplementation(async () => ok())
  mocks.componentVariants.mockImplementation(async () => ({ props: [], rules: [] }))
  mocks.previewVariant.mockImplementation(async () => true)
  useVariantPreview.getState().setPreview(null)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('lists the enum values as chips with the default marked, and the boolean variant beside them', async () => {
  await show()
  const size = container.querySelector('[data-prop="size"]')!
  expect(Array.from(size.querySelectorAll('[data-slot="badge"]')).map((badge) => badge.textContent)).toEqual([
    'sm',
    'md',
    'lg',
  ])
  expect(container.querySelector('[data-prop="quiet"]')?.textContent).toContain('on / off')
})

it('adds a value with one add_value op', async () => {
  await show()
  await act(async () => byLabel<HTMLElement>('Add a value to size').click())
  const input = byLabel<HTMLInputElement>('New value for size')
  type(input, 'xl')
  await enter(input)
  expect(calls()).toEqual([{ ops: [{ op: 'add_value', prop: 'size', value: 'xl' }] }])
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('cbutton', expect.objectContaining({ id: 'cbutton' }))
})

it('renames a value from its menu with one rename_value op', async () => {
  await show()
  await openMenu(byLabel('size: lg'))
  expect(menuLabels()).toEqual(['Make default', 'Rename', 'Remove'])
  await pick('Rename')
  const input = byLabel<HTMLInputElement>('Rename lg')
  expect(input.value).toBe('lg')
  type(input, 'large')
  await enter(input)
  expect(calls()).toEqual([{ ops: [{ op: 'rename_value', prop: 'size', from: 'lg', to: 'large' }] }])
})

it('makes a value the default with set_default', async () => {
  await show()
  await openMenu(byLabel('size: sm'))
  await pick('Make default')
  expect(calls()).toEqual([{ ops: [{ op: 'set_default', prop: 'size', value: 'sm' }] }])
})

it('asks before removing a value, after a dry run says how many instances use it', async () => {
  mocks.editComponentVariants.mockImplementation(async (_c, _d, body: { dryRun?: boolean }) =>
    ok({ instances_updated: body.dryRun ? 3 : 3 }),
  )
  await show()
  await openMenu(byLabel('size: lg'))
  await pick('Remove')
  expect(calls()).toEqual([
    { ops: [{ op: 'remove_value', prop: 'size', value: 'lg', new_default: 'md' }], dryRun: true },
  ])
  const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
  expect(dialog.textContent).toContain('3 instances use it and go back to the default.')
  expect(dialog.textContent).toContain('cannot undo')

  const remove = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!
  await act(async () => remove.click())
  expect(calls().at(-1)).toEqual({ ops: [{ op: 'remove_value', prop: 'size', value: 'lg', new_default: 'md' }] })
  expect(calls()).toHaveLength(2)
})

it('asks for a new default when the value removed is the default', async () => {
  await show()
  await openMenu(byLabel('size: md'))
  await pick('Remove')
  const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
  expect(dialog.textContent).toContain('No instance uses it.')
  const select = dialog.querySelector('select')!
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['sm', 'lg'])
  choose(select, 'lg')
  const remove = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!
  await act(async () => remove.click())
  expect(calls().at(-1)).toEqual({ ops: [{ op: 'remove_value', prop: 'size', value: 'md', new_default: 'lg' }] })
})

it('writes nothing when the dry run is refused, and says why', async () => {
  mocks.editComponentVariants.mockRejectedValue(new Error('“lg” is the last value of size'))
  await show()
  await openMenu(byLabel('size: lg'))
  await pick('Remove')
  expect(document.querySelector('[data-slot="confirm-dialog"]')).toBeNull()
  expect(mocks.notices).toEqual(['“lg” is the last value of size'])
})

it('adds a boolean variant with one add_boolean op, named as an attribute', async () => {
  await show()
  await openMenu(container.querySelector('[data-variant-add]')!)
  await pick('On or off')
  type(byLabel<HTMLInputElement>('Variant name'), 'Has Icon')
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Add')!
      .click(),
  )
  expect(calls()).toEqual([{ ops: [{ op: 'add_boolean', prop: 'has-icon' }] }])
})

it('adds a choice variant with add_enum and its values', async () => {
  await show()
  await openMenu(container.querySelector('[data-variant-add]')!)
  await pick('Choice (sm, md, lg)')
  type(byLabel<HTMLInputElement>('Variant name'), 'tone')
  type(byLabel<HTMLInputElement>('Values'), 'solid, ghost ,')
  await enter(byLabel('Values'))
  expect(calls()).toEqual([{ ops: [{ op: 'add_enum', prop: 'tone', options: ['solid', 'ghost'] }] }])
})

it('renames and removes a prop through its menu', async () => {
  await show()
  await openMenu(byLabel('Actions for the size variant'))
  await pick('Rename variant')
  const input = byLabel<HTMLInputElement>('Rename size')
  type(input, 'Scale')
  await enter(input)
  expect(calls()).toEqual([{ ops: [{ op: 'rename_prop', prop: 'size', to: 'scale' }] }])

  mocks.editComponentVariants.mockClear()
  await openMenu(byLabel('Actions for the quiet variant'))
  await pick('Remove variant')
  expect(calls()).toEqual([{ ops: [{ op: 'remove_prop', prop: 'quiet' }], dryRun: true }])
})

it('previews a combination in the live frame and says what it edits, then goes back to the base', async () => {
  await show()
  expect(mocks.previewVariant).toHaveBeenLastCalledWith('main1', 'cbutton', null)
  expect(container.querySelector('[data-slot="variant-editing"]')).toBeNull()

  choose(byLabel<HTMLSelectElement>('Preview size'), 'lg')
  expect(mocks.previewVariant).toHaveBeenLastCalledWith('main1', 'cbutton', {
    'data-size': 'lg',
    'data-quiet': 'false',
  })
  expect(container.querySelector('[data-slot="variant-editing"]')?.textContent).toContain('Editing size=lg')
  expect(useVariantPreview.getState().preview?.when).toEqual({ size: 'lg' })

  choose(byLabel<HTMLSelectElement>('Preview quiet'), 'true')
  expect(container.querySelector('[data-slot="variant-editing"]')?.textContent).toContain('Editing size=lg, quiet=true')

  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Back to base')!
      .click(),
  )
  expect(mocks.previewVariant).toHaveBeenLastCalledWith('main1', 'cbutton', null)
  expect(useVariantPreview.getState().preview?.when).toEqual({})
  expect(container.querySelector('[data-slot="variant-editing"]')).toBeNull()
})

it('ends the preview when the selection leaves the component', async () => {
  await show()
  choose(byLabel<HTMLSelectElement>('Preview size'), 'sm')
  expect(useVariantPreview.getState().preview).not.toBeNull()
  act(() => root.render(<div />))
  expect(useVariantPreview.getState().preview).toBeNull()
  expect(mocks.previewVariant).toHaveBeenLastCalledWith('main1', 'cbutton', null)
})

it('shows how many properties the previewed combination styles, from the rules the server reads', async () => {
  mocks.componentVariants.mockImplementation(async () => ({
    props: [],
    rules: [
      {
        selector: '[data-size="lg"]',
        when: { size: 'lg' },
        element: null,
        declarations: { padding: '12px', gap: '8px' },
      },
      { selector: '[data-size="sm"]', when: { size: 'sm' }, element: null, declarations: { padding: '2px' } },
    ],
  }))
  await show()
  await act(async () => {})
  choose(byLabel<HTMLSelectElement>('Preview size'), 'lg')
  expect(container.querySelector('[data-slot="variant-editing"]')?.textContent).toContain('2 properties styled')
})

it('lets a viewer see and preview the variants but offers no edit', async () => {
  mocks.canEdit = false
  await show()
  expect(container.querySelector('[data-variant-add]')).toBeNull()
  expect(byLabel('Add a value to size')).toBeNull()
  expect(byLabel('Actions for the size variant')).toBeNull()
  expect(byLabel('Preview size')).not.toBeNull()
})
