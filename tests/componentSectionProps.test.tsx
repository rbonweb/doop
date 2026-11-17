// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef, ComponentProp } from '../shared/components'
import type { DesignToken } from '../shared/designTokens'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  changeInstances: vi.fn(),
  updateComponent: vi.fn(),
  select: vi.fn(),
  requestFlyTo: vi.fn(),
  setSelectedElement: vi.fn(),
  notices: [] as string[],
  components: [] as unknown[],
  frames: [] as unknown[],
  tokens: [] as unknown[],
  canEdit: true,
}))
vi.mock('../src/lib/api', () => ({
  api: { changeInstances: mocks.changeInstances, updateComponent: mocks.updateComponent },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/history', () => ({ recordCreate: () => {}, recordUpdate: () => {}, recordUpdates: () => {} }))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: 'canvas1', components: mocks.components, frames: mocks.frames, tokens: mocks.tokens }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: () => {},
    upsertFrame: () => {},
    select: mocks.select,
    requestFlyTo: mocks.requestFlyTo,
    setSelectedElement: mocks.setSelectedElement,
  }
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state })
  return { useStore, canEditOpenCanvas: () => mocks.canEdit, pickedSelectors: () => [] }
})
import { ComponentSection } from '../src/components/ComponentSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Design panel's component section: the control each prop type gets, what is overridden and how
   to reset it, a main's instance list, and its code mapping. */

let root: Root
let container: HTMLDivElement

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({
  id: 'cbutton',
  name: 'Button',
  description: '',
  template:
    '<button data-doop-part="r"><span data-doop-part="l" data-doop-prop="label">Buy</span><span data-doop-part="n" data-name="Badge"></span></button>',
  css: '',
  rawCss: '',
  head: [],
  props: [{ name: 'label', type: 'text' }],
  slots: [],
  rev: 1,
  mainFrameId: 'main1',
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Tester',
  ...over,
})

const icon = def({ id: 'cicon', name: 'Icon', props: [] })
const avatar = def({ id: 'cavatar', name: 'Avatar', props: [] })

const instanceFrame = (attrs = ''): Frame =>
  ({
    id: 'frame1',
    canvasId: 'canvas1',
    name: 'Page',
    html: `<!doctype html><html><head></head><body><button data-doop-part="r" data-doop-instance="cbutton" data-doop-rev="1" data-doop-id="inst01"${attrs}><span data-doop-part="l">Buy</span></button></body></html>`,
  }) as unknown as Frame

const mainFrame = {
  id: 'main1',
  canvasId: 'canvas1',
  name: 'Components',
  html: '<!doctype html><html><head></head><body><button data-doop-component="cbutton" data-doop-part="r" data-doop-id="main01"><span data-doop-part="l">Buy</span></button></body></html>',
} as unknown as Frame

const token = (name: string, value: string): DesignToken => ({
  name,
  type: 'color',
  value,
  order: 0,
  updatedAt: 1,
  updatedBy: 'Tester',
})

const byLabel = <T extends Element>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!

function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.focus()
    input.blur()
  })
}

function showInstance(props: ComponentProp[], attrs = '', defs: ComponentDef[] = []) {
  const frame = instanceFrame(attrs)
  mocks.frames = [frame]
  mocks.components = [def({ props }), ...defs]
  act(() => root.render(<ComponentSection frame={frame} selector="[data-doop-id='inst01']" />))
}

function showMain(over: Partial<ComponentDef> = {}) {
  mocks.frames = [mainFrame, instanceFrame(), { ...instanceFrame(), id: 'frame2', name: 'Home' }]
  mocks.components = [def(over)]
  act(() => root.render(<ComponentSection frame={mainFrame} selector="[data-doop-id='main01']" />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.canEdit = true
  mocks.tokens = []
  mocks.notices.length = 0
  for (const fn of [
    mocks.changeInstances,
    mocks.updateComponent,
    mocks.select,
    mocks.requestFlyTo,
    mocks.setSelectedElement,
  ])
    fn.mockReset()
  mocks.changeInstances.mockImplementation(async () => ({ frame: instanceFrame(), missing: [] }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const changed = () => mocks.changeInstances.mock.calls.map((call) => call[1])

it('gives a number prop a field that honours its range and step, and refuses a bad value', async () => {
  showInstance([{ name: 'count', type: 'number', min: 0, max: 10, step: 2, default: '4' }])
  const input = byLabel<HTMLInputElement>('count')
  expect(input.value).toBe('4')

  type(input, '3')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Use a number')
  expect(mocks.changeInstances).not.toHaveBeenCalled()

  type(input, 'abc')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('a number from 0 to 10')
  expect(mocks.changeInstances).not.toHaveBeenCalled()

  type(input, '6')
  await act(async () => {})
  expect(changed()).toEqual([[{ instanceId: 'inst01', props: { count: '6' } }]])
  expect(container.querySelector('[role="alert"]')).toBeNull()

  /* past the range the field holds the edge rather than saving a value the component refuses */
  type(byLabel<HTMLInputElement>('count'), '99')
  await act(async () => {})
  expect(changed().at(-1)).toEqual([{ instanceId: 'inst01', props: { count: '10' } }])

  /* arrow keys walk the step, from the 10 the field now holds */
  act(() => {
    byLabel<HTMLInputElement>('count').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  await act(async () => {})
  expect(changed().at(-1)).toEqual([{ instanceId: 'inst01', props: { count: '8' } }])
})

it('offers the canvas colour tokens on a colour prop and saves the pick as var(--name)', async () => {
  mocks.tokens = [token('--brand', '#0177d3'), token('--ink', '#111111')]
  showInstance([{ name: 'tint', type: 'color', default: '#ff0000' }])
  expect(byLabel<HTMLInputElement>('tint').value).toBe('#ff0000')

  act(() => byLabel<HTMLButtonElement>('Use a token').click())
  const options = Array.from(document.querySelectorAll('[role="option"]'))
  expect(options.map((option) => option.textContent)).toEqual(['brand#0177d3', 'ink#111111'])
  await act(async () => (options[0] as HTMLElement).click())
  expect(changed()).toEqual([[{ instanceId: 'inst01', props: { tint: 'var(--brand)' } }]])
})

it('takes a typed colour name, and says why a bad colour was refused', async () => {
  showInstance([{ name: 'tint', type: 'color', default: '#ff0000' }])
  type(byLabel<HTMLInputElement>('tint'), 'rebeccapurple')
  await act(async () => {})
  expect(changed()).toEqual([[{ instanceId: 'inst01', props: { tint: 'rebeccapurple' } }]])

  mocks.changeInstances.mockClear()
  type(byLabel<HTMLInputElement>('tint'), 'not a colour')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('hex colour')
  expect(mocks.changeInstances).not.toHaveBeenCalled()
})

it('lists the components an instance prop accepts, by name', async () => {
  showInstance([{ name: 'leading', type: 'instance', accepts: ['Icon', 'cavatar'] }], '', [
    icon,
    avatar,
    def({ id: 'cother', name: 'Other', props: [] }),
  ])
  const select = byLabel<HTMLSelectElement>('leading')
  expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
    'Choose a component',
    'Icon',
    'Avatar',
  ])
  await act(async () => {
    select.value = 'Avatar'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(changed()).toEqual([[{ instanceId: 'inst01', props: { leading: 'Avatar' } }]])
})

it('lists every other active component when an instance prop accepts anything', () => {
  showInstance([{ name: 'leading', type: 'instance' }], '', [icon, avatar])
  const select = byLabel<HTMLSelectElement>('leading')
  expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
    'Choose a component',
    'Icon',
    'Avatar',
  ])
})

it('marks an overridden prop with a dot that puts the main’s value back', async () => {
  showInstance([{ name: 'label', type: 'text' }], ` data-doop-props='{"label":"Sell"}'`)
  const dot = container.querySelector<HTMLButtonElement>('[data-slot="override-dot"]')!
  expect(dot.getAttribute('aria-label')).toBe('Reset “label” to the main')
  await act(async () => dot.click())
  expect(changed()).toEqual([[{ instanceId: 'inst01', props: { label: '' } }]])
})

it('has no dot while a prop follows the main', () => {
  showInstance([{ name: 'label', type: 'text' }], ` data-doop-props='{"label":"Buy"}'`)
  expect(container.querySelector('[data-slot="override-dot"]')).toBeNull()
  expect(container.querySelector('[data-slot="overrides"]')).toBeNull()
})

it('lists an overridden part and resets it alone, or everything at once', async () => {
  showInstance(
    [{ name: 'label', type: 'text' }],
    ` data-doop-props='{"label":"Sell"}' data-doop-overrides='{"l":{"text":"Sell"},"n":{"hidden":true}}'`,
  )
  const rows = Array.from(container.querySelectorAll('[data-slot="part-override"]'))
  expect(rows.map((row) => row.getAttribute('data-part'))).toEqual(['l', 'n'])
  expect(rows[1]!.textContent).toContain('Badge')
  expect(rows[1]!.textContent).toContain('overridden')

  await act(async () => byLabel<HTMLButtonElement>('Reset Badge').click())
  expect(changed()).toEqual([[{ instanceId: 'inst01', reset: ['n'] }]])

  mocks.changeInstances.mockClear()
  const all = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Reset all (3)')!
  await act(async () => all.click())
  expect(changed()).toEqual([[{ instanceId: 'inst01', reset: true }]])
})

it('says which component a nested instance was swapped to', () => {
  showInstance([], ` data-doop-overrides='{"n":{"swap":"cicon"}}'`, [icon])
  expect(container.querySelector('[data-part="n"]')?.textContent).toContain('Swapped to Icon')
})

it('shows no reset to someone who cannot edit the frame', () => {
  mocks.canEdit = true
  const frame = instanceFrame(` data-doop-overrides='{"n":{"hidden":true}}' data-doop-locked`)
  mocks.frames = [frame]
  mocks.components = [def()]
  act(() => root.render(<ComponentSection frame={{ ...frame, locked: true }} selector="[data-doop-id='inst01']" />))
  expect(container.querySelector('[data-slot="part-override"]')).not.toBeNull()
  expect(byLabel('Reset Badge')).toBeNull()
})

it('lists a main’s instances per frame and jumps to one', async () => {
  showMain()
  const list = container.querySelector('[data-slot="instance-list"]')!
  expect(list.textContent).toContain('Instances2')
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-frame]'))
  expect(rows.map((row) => row.dataset.frame)).toEqual(['frame1', 'frame2'])
  expect(rows[1]!.textContent).toContain('Home')

  await act(async () => rows[1]!.click())
  expect(mocks.select).toHaveBeenCalledWith('frame2')
  expect(mocks.requestFlyTo).toHaveBeenCalledWith('frame2')
  const [picked] = mocks.setSelectedElement.mock.calls[0] as [{ frameId: string; selector: string }]
  expect(picked.frameId).toBe('frame2')
  expect(picked.selector).toContain('button')
})

it('shows the code mapping on a main with a copyable import line', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  showMain({
    props: [{ name: 'tone', type: 'enum', options: ['primary', 'ghost'] }],
    code: {
      importFrom: '@acme/ui',
      exportName: 'Button',
      props: { tone: { name: 'variant', values: { primary: 'solid' } }, label: { omit: true } },
      slots: { actions: 'children' },
    },
  })
  const code = container.querySelector('[data-slot="component-code"]')!
  expect(code.querySelector('[data-slot="import-line"]')?.textContent).toBe("import { Button } from '@acme/ui'")
  const lines = Array.from(code.querySelectorAll('[data-slot="code-mapping"] li')).map((li) => li.textContent)
  expect(lines).toEqual(['tone → variant (primary → "solid")', 'label → omitted', 'actions slot → children'])

  await act(async () => byLabel<HTMLButtonElement>('Copy import').click())
  expect(writeText).toHaveBeenCalledWith("import { Button } from '@acme/ui'")
})

it('writes a default export as a default import', () => {
  showMain({ code: { importFrom: './button', exportName: 'Button', defaultExport: true } })
  expect(container.querySelector('[data-slot="import-line"]')?.textContent).toBe("import Button from './button'")
})

it('edits the package and export through the component route, keeping the rest of the mapping', async () => {
  const code = { importFrom: '@acme/ui', exportName: 'Button', props: { tone: { name: 'variant' } } }
  mocks.updateComponent.mockResolvedValue({ component: def({ code }) })
  showMain({ code })
  const edit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!
  act(() => edit.click())
  type(byLabel<HTMLInputElement>('Package to import from'), '@acme/core')
  type(byLabel<HTMLInputElement>('Export name'), 'PrimaryButton')
  const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save')!
  await act(async () => save.click())
  expect(mocks.updateComponent).toHaveBeenCalledWith('canvas1', 'cbutton', {
    code: { importFrom: '@acme/core', exportName: 'PrimaryButton', props: { tone: { name: 'variant' } } },
  })
  expect(container.querySelector('[data-slot="code-form"]')).toBeNull()
})

it('offers to map an unmapped component, and cannot save half a mapping', () => {
  showMain()
  expect(container.querySelector('[data-slot="component-code"]')?.textContent).toContain('Not mapped to code yet.')
  const map = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Map to code')!
  act(() => map.click())
  const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save')!
  expect(save.disabled).toBe(true)
})

it('leaves the code mapping read-only for someone who can only look', () => {
  mocks.canEdit = false
  showMain({ code: { importFrom: '@acme/ui', exportName: 'Button' } })
  expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Edit')).toBe(false)
})
