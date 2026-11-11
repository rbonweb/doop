// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { ACTIONS, MENUS, dispatchActionKey, setActionHost } = await import('../src/lib/actions/registry')
const { chordHint, boundOn } = await import('../src/lib/actions/chords')
const { useStore } = await import('../src/lib/store')
const { CANVAS_MOD_CHORDS } = await import('../src/lib/keys')
const { CommandPalette } = await import('../src/components/CommandPalette')
const { ShortcutsSheet } = await import('../src/components/ShortcutsSheet')
const { t } = await import('../src/lib/i18n')
type ActionHost = import('../src/lib/actions/registry').ActionHost
type KeyInit = {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
}

/* The fork's own keys, now bound in the one registry: every one reaches its action on the canvas and none acts
   while a text field has the focus (the two global chords, ⌘K and ⌘/, are the exceptions). */

const frame = (id: string): Frame => ({
  id,
  canvasId: 'c1',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
})

const event = (init: KeyInit) => ({
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  preventDefault: vi.fn(),
  ...init,
})

function stubHost(): ActionHost {
  return {
    canvasId: 'c1',
    guest: false,
    presenting: false,
    hideUiActive: true,
    agentsOpen: false,
    boardOpen: false,
    openPalette: vi.fn(),
    openAgent: vi.fn(),
    openShortcuts: vi.fn(),
    goToFiles: vi.fn(),
    openDocs: vi.fn(),
    contactSupport: vi.fn(),
    openFind: vi.fn(),
    findStep: vi.fn(),
    openExport: vi.fn(),
    openImport: vi.fn(),
    openVersionHistory: vi.fn(),
    openLink: vi.fn(),
    placeImage: vi.fn(),
    newCanvas: vi.fn(),
    duplicateCanvas: vi.fn(),
    present: vi.fn(),
    toggleHideUi: vi.fn(),
    toggleAgents: vi.fn(),
    toggleBoard: vi.fn(),
  }
}

let host: ActionHost

beforeEach(() => {
  host = stubHost()
  setActionHost(host)
  useStore.setState({
    canvas: { id: 'c1', name: 'Canvas', frames: [frame('a'), frame('b')] } as Canvas,
    activePageId: null,
    role: 'edit',
    laser: false,
    tool: 'select',
    selectedIds: ['a'],
    selectedId: 'a',
    exportIds: null,
    stageSize: { width: 1200, height: 800 },
    viewport: { x: 0, y: 0, zoom: 1 },
  })
  document.body.innerHTML = ''
})

afterEach(() => {
  setActionHost(null)
  vi.restoreAllMocks()
})

/* [action id, the key as the browser reports it (a Mac), whether a field may keep it] */
const PORTED: [string, KeyInit][] = [
  ['copy-image-2x', { key: 'i', code: 'KeyI' }],
  ['copy-image-4x', { key: 'I', code: 'KeyI', shiftKey: true }],
  ['tidy-rows', { key: 'T', code: 'KeyT', shiftKey: true }],
  ['device-mobile', { key: '1', code: 'Digit1' }],
  ['device-tablet', { key: '2', code: 'Digit2' }],
  ['device-laptop', { key: '3', code: 'Digit3' }],
  ['device-desktop', { key: '4', code: 'Digit4' }],
  ['device-restore', { key: '0', code: 'Digit0' }],
  ['zoom-reset', { key: ')', code: 'Digit0', shiftKey: true }],
  ['laser', { key: 'l', code: 'KeyL' }],
  ['flow-links', { key: 'k', code: 'KeyK' }],
  ['present', { key: 'P', code: 'KeyP', shiftKey: true }],
  ['next-marked', { key: 'u', code: 'KeyU' }],
  ['mark-all-seen', { key: 'U', code: 'KeyU', shiftKey: true }],
  ['export', { key: 'e', code: 'KeyE', metaKey: true, shiftKey: true }],
  ['sticky-notes', { key: 'Dead', code: 'KeyN', altKey: true }],
  ['shortcuts', { key: '?', code: 'Slash', shiftKey: true }],
  ['zoom-next-frame', { key: 'n', code: 'KeyN' }],
  ['zoom-previous-frame', { key: 'N', code: 'KeyN', shiftKey: true }],
]

describe('the fork keys in the registry', () => {
  it.each(PORTED)('%s runs from its key on the canvas', (id, init) => {
    const action = ACTIONS.find((a) => a.id === id)!
    const run = vi.spyOn(action, 'run').mockImplementation(() => undefined)
    const e = event(init)
    expect(dispatchActionKey(e, false, true)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it.each(PORTED)('%s is left alone while a text field has the focus', (id, init) => {
    const action = ACTIONS.find((a) => a.id === id)!
    const run = vi.spyOn(action, 'run').mockImplementation(() => undefined)
    /* the export chord is ⌘-led but not global: a field keeps it too */
    expect(dispatchActionKey(event(init), true, true)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('⌘K opens the palette and ⌘/ the agent composer, from a field too', () => {
    expect(dispatchActionKey(event({ key: 'k', metaKey: true }), true, true)).toBe(true)
    expect(host.openPalette).toHaveBeenCalledTimes(1)
    expect(dispatchActionKey(event({ key: '/', code: 'Slash', metaKey: true }), true, true)).toBe(true)
    expect(host.openAgent).toHaveBeenCalledTimes(1)
  })

  it('a held key does not repeat a toggle', () => {
    expect(dispatchActionKey(event({ key: 'l', code: 'KeyL', repeat: true }), false, true)).toBe(true)
    expect(useStore.getState().laser).toBe(false)
  })

  it('bare keys stay out of an open dialog, menu or aria-modal, but ⌘ chords pass; a closing one does not count', () => {
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    expect(dispatchActionKey(event({ key: 'l', code: 'KeyL' }), false, true)).toBe(false)
    expect(useStore.getState().laser).toBe(false)
    expect(dispatchActionKey(event({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true }), false, true)).toBe(true)
    dialog.setAttribute('data-state', 'closed')
    expect(dispatchActionKey(event({ key: 'l', code: 'KeyL' }), false, true)).toBe(true)
    dialog.remove()
    const modal = document.body.appendChild(document.createElement('div'))
    modal.setAttribute('aria-modal', 'true')
    expect(dispatchActionKey(event({ key: 'k', code: 'KeyK' }), false, true)).toBe(false)
    modal.remove()
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-state', 'open')
    expect(dispatchActionKey(event({ key: 'k', code: 'KeyK' }), false, true)).toBe(false)
  })

  it('nothing acts while the board is showing (the stage reports no size)', () => {
    useStore.setState({ stageSize: null })
    for (const init of [
      { key: '1', code: 'Digit1' },
      { key: 'T', code: 'KeyT', shiftKey: true },
      { key: 'l', code: 'KeyL' },
      { key: 'k', code: 'KeyK' },
      { key: 'u', code: 'KeyU' },
      { key: 'Dead', code: 'KeyN', altKey: true },
    ]) {
      expect(dispatchActionKey(event(init), false, true), init.code).toBe(false)
    }
    expect(useStore.getState().laser).toBe(false)
  })

  it('leaves the keys alone while presenting', () => {
    setActionHost({ ...host, presenting: true })
    expect(dispatchActionKey(event({ key: 'l', code: 'KeyL' }), false, true)).toBe(false)
  })

  it('an open export dialog keeps its run', () => {
    useStore.setState({ exportIds: ['a'] })
    expect(dispatchActionKey(event({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true }), false, true)).toBe(false)
    expect(host.openExport).not.toHaveBeenCalled()
  })

  it('⌘⇧E reaches the page host, which preticks the selection', () => {
    expect(dispatchActionKey(event({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true }), false, true)).toBe(true)
    expect(host.openExport).toHaveBeenCalledTimes(1)
    expect(CANVAS_MOD_CHORDS).toContain('shift+e')
  })

  it('⌥N toggles the sticky notes and says how to bring them back', () => {
    useStore.setState({ notesVisible: true, notice: null } as never)
    dispatchActionKey(event({ key: 'Dead', code: 'KeyN', altKey: true }), false, true)
    expect(useStore.getState().notesVisible).toBe(false)
    expect(useStore.getState().notice?.text).toContain(chordHint({ code: 'KeyN', alt: true }))
    dispatchActionKey(event({ key: 'Dead', code: 'KeyN', altKey: true }), false, true)
    expect(useStore.getState().notesVisible).toBe(true)
  })

  it('K toggles the prototype link arrows', () => {
    const before = useStore.getState().flowLinksVisible
    dispatchActionKey(event({ key: 'k', code: 'KeyK' }), false, true)
    expect(useStore.getState().flowLinksVisible).toBe(!before)
  })

  it('L is the laser, and a drawing tool turns it off', () => {
    dispatchActionKey(event({ key: 'l', code: 'KeyL' }), false, true)
    expect(useStore.getState().laser).toBe(true)
    useStore.getState().setTool('comment')
    expect(useStore.getState().laser).toBe(false)
    dispatchActionKey(event({ key: 'l', code: 'KeyL' }), false, true)
    expect(useStore.getState().laser).toBe(true)
    expect(useStore.getState().tool).toBe('select')
  })

  describe.each(['view', 'comment'] as const)('with the %s role', (role) => {
    beforeEach(() => useStore.setState({ role }))

    it('the layout keys do nothing', () => {
      for (const init of [
        { key: '1', code: 'Digit1' },
        { key: '0', code: 'Digit0' },
        { key: 'T', code: 'KeyT', shiftKey: true },
      ]) {
        expect(dispatchActionKey(event(init), false, true), init.code).toBe(false)
      }
    })

    it('looking still works: laser, notes, link arrows, review marks and the image copy', () => {
      for (const id of ['laser', 'sticky-notes', 'flow-links', 'next-marked', 'copy-image-2x']) {
        const action = ACTIONS.find((a) => a.id === id)!
        const run = vi.spyOn(action, 'run').mockImplementation(() => undefined)
        const chord = action.keys![0]!
        const init = { key: chord.key ?? 'Dead', code: chord.code ?? '', altKey: !!chord.alt, shiftKey: !!chord.shift }
        expect(dispatchActionKey(event(init), false, true), id).toBe(true)
        expect(run).toHaveBeenCalledTimes(1)
      }
    })
  })

  it('a canvas whose own role is view grants no edit key before the store role is set', () => {
    /* the room hands the role on the canvas copy; roleOf reads it while the store's own is still null */
    useStore.setState({ role: null, canvas: { ...useStore.getState().canvas!, role: 'view' } })
    expect(dispatchActionKey(event({ key: 'T', code: 'KeyT', shiftKey: true }), false, true)).toBe(false)
    expect(dispatchActionKey(event({ key: '1', code: 'Digit1' }), false, true)).toBe(false)
  })
})

describe('the menus and the help read the same list', () => {
  it('the Board sits in View, the sticky notes toggle in View, and the palette names both', () => {
    const board = ACTIONS.find((a) => a.id === 'board')!
    const notes = ACTIONS.find((a) => a.id === 'sticky-notes')!
    expect([board.menu, notes.menu]).toEqual(['view', 'view'])
    expect(MENUS.some((m) => m.id === 'view')).toBe(true)
  })

  it('every ported action is in a menu with a chord, so the ? help lists it', () => {
    for (const [id] of PORTED) {
      const action = ACTIONS.find((a) => a.id === id)!
      expect(
        MENUS.some((m) => m.id === action.menu),
        id,
      ).toBe(true)
      expect(
        action.keys?.some((k) => boundOn(k, true)),
        id,
      ).toBe(true)
    }
  })

  let root: Root
  let mount: HTMLDivElement
  beforeEach(() => {
    mount = document.createElement('div')
    document.body.append(mount)
    root = createRoot(mount)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    mount.remove()
  })

  it('the ? sheet lists every ported key, generated from the registry', async () => {
    await act(async () => root.render(<ShortcutsSheet onClose={vi.fn()} />))
    const text = document.body.textContent ?? ''
    for (const id of [
      'tidy-rows',
      'laser',
      'flow-links',
      'sticky-notes',
      'next-marked',
      'mark-all-seen',
      'copy-image-4x',
    ]) {
      const action = ACTIONS.find((a) => a.id === id)!
      expect(text, id).toContain(t(action.label))
    }
    const notes = ACTIONS.find((a) => a.id === 'sticky-notes')!
    expect(text).toContain(chordHint(notes.keys![0]!))
  })

  it('the palette leads with Ask agent and offers the Board', async () => {
    await act(async () => root.render(<CommandPalette onClose={vi.fn()} onAsk={vi.fn()} />))
    const items = [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent ?? '')
    expect(items[0]).toContain(t('actions.askAgent'))
    expect(items.some((text) => text.includes(t('actions.board')))).toBe(true)
  })
})
