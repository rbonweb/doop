// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef, ComponentProp } from '../shared/components'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  changeInstances: vi.fn(),
  components: [] as unknown[],
  frames: [] as unknown[],
  notices: [] as string[],
  tokens: [] as unknown[],
  listeners: new Set<() => void>(),
}))
vi.mock('../src/lib/api', () => ({
  api: { changeInstances: mocks.changeInstances, updateComponent: vi.fn(), componentVariants: vi.fn() },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/history', () => ({ recordCreate: () => {}, recordUpdate: () => {}, recordUpdates: () => {} }))
vi.mock('../src/lib/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const state = {
    get canvas() {
      return { id: 'canvas1', components: mocks.components, frames: mocks.frames, tokens: mocks.tokens }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: () => {},
    upsertFrame: () => {},
    select: () => {},
    requestFlyTo: () => {},
    setSelectedElement: () => {},
  }
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => void mocks.listeners.delete(listener)
  }
  const useStore = Object.assign(
    (select: (s: typeof state) => unknown) => useSyncExternalStore(subscribe, () => select(state)),
    { getState: () => state },
  )
  return { useStore, canEditOpenCanvas: () => true, pickedSelectors: () => [] }
})
import { ComponentSection } from '../src/components/ComponentSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Design panel's editors for an instance's list props (rows per item, add, remove, reorder) and rich-text props (a
   small contenteditable whose value goes through the ordinary prop-edit path). */

let root: Root
let container: HTMLDivElement

const TEMPLATE =
  '<ul data-doop-part="r"><li data-doop-part="i" data-doop-each="tasks"><span data-doop-part="t" data-doop-prop="title">Sample</span></li></ul>'

const def = (props: ComponentProp[], template = TEMPLATE): ComponentDef => ({
  id: 'clist',
  name: 'Tasks',
  description: '',
  template,
  css: '',
  rawCss: '',
  head: [],
  props,
  slots: [],
  rev: 1,
  mainFrameId: 'main1',
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Tester',
})

const LIST: ComponentProp = {
  name: 'tasks',
  type: 'list',
  fields: { title: { type: 'text' }, done: { type: 'boolean' }, site: { type: 'link' } },
}

const attr = (props: Record<string, string>) => JSON.stringify(props).replace(/"/g, '&quot;')

const instanceFrame = (props: Record<string, string> = {}): Frame =>
  ({
    id: 'frame1',
    canvasId: 'canvas1',
    name: 'Page',
    html: `<!doctype html><html><head></head><body><ul data-doop-part="r" data-doop-instance="clist" data-doop-rev="1" data-doop-id="inst01" data-doop-props="${attr(props)}"></ul></body></html>`,
  }) as unknown as Frame

function show(component: ComponentDef, props: Record<string, string> = {}) {
  const frame = instanceFrame(props)
  mocks.frames = [frame]
  mocks.components = [component]
  act(() => root.render(<ComponentSection frame={frame} selector="[data-doop-id='inst01']" />))
}

const byLabel = <T extends Element>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!
const rows = () => Array.from(container.querySelectorAll('[data-slot="list-item"]'))
const saved = () => mocks.changeInstances.mock.calls.map((call) => call[1][0].props)

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

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.listeners.clear()
  mocks.notices.length = 0
  mocks.changeInstances.mockReset()
  mocks.changeInstances.mockImplementation(async () => ({ frame: instanceFrame(), missing: [] }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const TWO = JSON.stringify([{ done: true, title: 'Write' }, { title: 'Ship' }])

it('draws one row per item with an input for each declared field', () => {
  show(def([LIST]), { tasks: TWO })
  expect(rows()).toHaveLength(2)
  expect(rows()[0]?.textContent).toContain('1. Write')
  expect(rows()[1]?.textContent).toContain('2. Ship')
  expect(byLabel<HTMLInputElement>('title, 1').value).toBe('Write')
  expect(byLabel<HTMLInputElement>('site, 2').placeholder).toBe('https://…')
  expect(byLabel<HTMLElement>('done, 1').getAttribute('aria-checked')).toBe('true')
  expect(byLabel<HTMLElement>('done, 2').getAttribute('aria-checked')).toBe('false')
})

it('shows the main’s one sample item for an instance that has no items of its own', () => {
  show(def([LIST]))
  expect(rows()).toHaveLength(1)
  expect(byLabel<HTMLInputElement>('title, 1').value).toBe('Sample')
  /* nothing was overridden, so there is nothing to reset */
  expect(container.querySelector('[data-slot="override-dot"]')).toBeNull()
})

it('adds an item with every on/off field off, as one save of the whole list', async () => {
  show(def([LIST]), { tasks: TWO })
  act(() => byLabel<HTMLButtonElement>('Add item').click())
  await act(async () => {})
  expect(saved()).toEqual([{ tasks: '[{"done":true,"title":"Write"},{"title":"Ship"},{"done":false}]' }])
})

it('saves an edited field, and drops a cleared one from the item', async () => {
  show(def([LIST]), { tasks: TWO })
  type(byLabel<HTMLInputElement>('title, 2'), 'Ship it')
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '[{"done":true,"title":"Write"},{"title":"Ship it"}]' })

  type(byLabel<HTMLInputElement>('title, 1'), '')
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '[{"done":true},{"title":"Ship"}]' })
})

it('refuses an address a list link field may not hold, and says why', async () => {
  show(def([LIST]), { tasks: TWO })
  type(byLabel<HTMLInputElement>('site, 1'), 'javascript:alert(1)')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('web address')
  expect(mocks.changeInstances).not.toHaveBeenCalled()
})

it('flips an on/off field', async () => {
  show(def([LIST]), { tasks: TWO })
  act(() => byLabel<HTMLButtonElement>('done, 2').click())
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '[{"done":true,"title":"Write"},{"done":true,"title":"Ship"}]' })
})

it('removes, duplicates and moves an item from its menu, one save each', async () => {
  show(def([LIST]), { tasks: TWO })

  await openMenu(byLabel('Actions for item 1'))
  await pick('Remove')
  expect(saved().at(-1)).toEqual({ tasks: '[{"title":"Ship"}]' })

  await openMenu(byLabel('Actions for item 1'))
  await pick('Duplicate')
  expect(saved().at(-1)).toEqual({
    tasks: '[{"done":true,"title":"Write"},{"done":true,"title":"Write"},{"title":"Ship"}]',
  })

  await openMenu(byLabel('Actions for item 1'))
  await pick('Move down')
  expect(saved().at(-1)).toEqual({ tasks: '[{"title":"Ship"},{"done":true,"title":"Write"}]' })
  expect(mocks.changeInstances).toHaveBeenCalledTimes(3)
})

it('cannot move the first item up or the last item down', async () => {
  show(def([LIST]), { tasks: TWO })
  await openMenu(byLabel('Actions for item 1'))
  const up = Array.from(document.querySelectorAll('[role="menuitem"]')).find((i) => i.textContent === 'Move up')!
  expect(up.getAttribute('aria-disabled')).toBe('true')
})

it('moves an item with ⌥↑ and ⌥↓ on its card', async () => {
  show(def([LIST]), { tasks: TWO })
  act(() => {
    byLabel<HTMLInputElement>('title, 2').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }),
    )
  })
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '[{"title":"Ship"},{"done":true,"title":"Write"}]' })
})

it('reorders by dragging the grip onto another card', async () => {
  show(def([LIST]), { tasks: TWO })
  const grip = rows()[0]!.querySelector('[data-slot="list-grip"]')!
  const target = rows()[1]!
  const data = new Map<string, string>()
  const dataTransfer = { effectAllowed: '', setData: (k: string, v: string) => data.set(k, v) }
  act(() => {
    const start = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer?: unknown }
    start.dataTransfer = dataTransfer
    grip.dispatchEvent(start)
  })
  act(() => {
    target.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
  })
  act(() => {
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '[{"title":"Ship"},{"done":true,"title":"Write"}]' })
})

it('puts the main’s items back with the reset dot', async () => {
  show(def([LIST]), { tasks: TWO })
  act(() => container.querySelector<HTMLButtonElement>('[data-slot="override-dot"]')!.click())
  await act(async () => {})
  expect(saved().at(-1)).toEqual({ tasks: '' })
})

it('stops adding at the list’s limit', () => {
  const many = JSON.stringify(Array.from({ length: 100 }, (_, n) => ({ title: `t${n}` })))
  show(def([LIST]), { tasks: many })
  expect(byLabel<HTMLButtonElement>('Add item').disabled).toBe(true)
})

/* ----- rich text ----- */

const RICH: ComponentProp = { name: 'body', type: 'richtext' }
const RICH_TEMPLATE = '<p data-doop-part="r" data-doop-prop="body">Plain <b>bold</b> text</p>'
const richDef = () => def([RICH], RICH_TEMPLATE)
const editor = () => byLabel<HTMLElement>('body, rich text')

function stubExec() {
  const calls: [string, string | undefined][] = []
  document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
    calls.push([command, value])
    const el = editor()
    if (command === 'bold') el.innerHTML = `<b>${el.innerHTML}</b>`
    else if (command === 'insertText') el.append(document.createTextNode(value ?? ''))
    else if (command === 'insertLineBreak') el.append(document.createElement('br'))
    return true
  }) as typeof document.execCommand
  return calls
}

it('shows a rich-text prop as an editable field holding the main’s formatted content', () => {
  show(richDef())
  expect(editor().getAttribute('contenteditable')).toBe('true')
  expect(editor().innerHTML).toBe('Plain <b>bold</b> text')
})

it('shows the stored value, rebuilt in the subset, never as it came', () => {
  show(richDef(), { body: 'Hi <b>there</b><script>alert(1)</script><a href="javascript:x">no</a>' })
  expect(editor().innerHTML).toBe('Hi <b>there</b>no')
})

it('formats with ⌘B and ⌘I and saves the subset markup when the field loses focus', async () => {
  const calls = stubExec()
  show(richDef(), { body: 'Hello' })
  act(() => {
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }))
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  expect(calls.map(([command]) => command)).toEqual(['bold', 'italic'])
  act(() => {
    editor().focus()
    editor().blur()
  })
  await act(async () => {})
  expect(saved()).toEqual([{ body: '<b>Hello</b>' }])
})

it('pastes plain text only and breaks lines with Enter', () => {
  const calls = stubExec()
  show(richDef(), { body: 'Hello' })
  const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
  paste.clipboardData = {
    getData: (type: string) => (type === 'text/plain' ? 'just <b>text</b>' : '<p style="color:red">styled</p>'),
  }
  act(() => void editor().dispatchEvent(paste))
  expect(paste.defaultPrevented).toBe(true)
  expect(calls).toEqual([['insertText', 'just <b>text</b>']])

  act(
    () => void editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  )
  expect(calls.at(-1)).toEqual(['insertLineBreak', undefined])
})

it('asks for an http(s) address before it makes a link', () => {
  stubExec()
  show(richDef(), { body: 'Hello' })
  const text = editor().firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  act(() => byLabel<HTMLButtonElement>('Link').click())
  const input = byLabel<HTMLInputElement>('Link address')
  expect(input).toBeTruthy()

  type(input, 'javascript:alert(1)')
  act(
    () => void container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('http://')
})

it('leaves a locked frame’s rich text and list uneditable', () => {
  const frame = instanceFrame({ body: 'Hello', tasks: TWO })
  frame.locked = true
  mocks.frames = [frame]
  mocks.components = [def([RICH, LIST], RICH_TEMPLATE + TEMPLATE)]
  act(() => root.render(<ComponentSection frame={frame} selector="[data-doop-id='inst01']" />))
  expect(editor().getAttribute('contenteditable')).toBe('false')
  expect(container.querySelector('[aria-label="Bold"]')).toBeNull()
  expect(container.querySelector('[aria-label="Add item"]')).toBeNull()
  expect(byLabel<HTMLInputElement>('title, 1').disabled).toBe(true)
})
