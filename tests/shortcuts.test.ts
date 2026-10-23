// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchShortcut, listShortcuts, registerShortcut, shortcutKeycaps, type Shortcut } from '../src/lib/shortcuts'

const removers: (() => void)[] = []
function add(entry: Partial<Shortcut> & Pick<Shortcut, 'id' | 'key'>) {
  const run = vi.fn()
  removers.push(registerShortcut({ label: entry.id, run, ...entry }))
  return run
}

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(e, 'target', { value: target })
  return { handled: dispatchShortcut(e), event: e }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  removers.splice(0).forEach((remove) => remove())
})

describe('shortcut registry', () => {
  it('runs a plain key and prevents its default', () => {
    const run = add({ id: 't-plain', key: 'q' })
    const { handled, event } = press({ key: 'q' })
    expect(handled).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the default alone when the action returns false', () => {
    add({ id: 't-false', key: 'q', run: () => false })
    expect(press({ key: 'q' }).event.defaultPrevented).toBe(false)
  })

  it('ignores keys typed into inputs, textareas, selects and contenteditable', () => {
    const run = add({ id: 't-typing', key: 'q' })
    const input = document.body.appendChild(document.createElement('input'))
    const textarea = document.body.appendChild(document.createElement('textarea'))
    const select = document.body.appendChild(document.createElement('select'))
    const editable = document.body.appendChild(document.createElement('div'))
    editable.setAttribute('contenteditable', 'true')
    const inner = editable.appendChild(document.createElement('span'))
    for (const target of [input, textarea, select, editable, inner]) {
      expect(press({ key: 'q' }, target).handled).toBe(false)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('does not fire a plain key while ⌘, Ctrl or Alt is held, but fires entries that ask for them', () => {
    const plain = add({ id: 't-bare', key: 'q' })
    const withMod = add({ id: 't-mod', key: 'q', mods: ['mod'] })
    const withAlt = add({ id: 't-alt', key: 'q', mods: ['alt'] })
    press({ key: 'q', metaKey: true })
    press({ key: 'q', ctrlKey: true })
    press({ key: 'q', altKey: true })
    expect(plain).not.toHaveBeenCalled()
    expect(withMod).toHaveBeenCalledTimes(2)
    expect(withAlt).toHaveBeenCalledTimes(1)
  })

  it('tells ⌘Z from ⌘⇧Z and a bare key from ⇧ of it', () => {
    const undo = add({ id: 't-undo', key: 'z', mods: ['mod'] })
    const redo = add({ id: 't-redo', key: 'z', mods: ['mod', 'shift'] })
    const lower = add({ id: 't-i', key: 'i' })
    const upper = add({ id: 't-I', key: 'i', mods: ['shift'] })
    press({ key: 'z', metaKey: true })
    press({ key: 'Z', metaKey: true, shiftKey: true })
    press({ key: 'i' })
    press({ key: 'I', shiftKey: true })
    expect([undo, redo, lower, upper].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1])
  })

  it('reads digits from the physical key, so ⇧1 works whatever it types', () => {
    const device = add({ id: 't-d1', key: '1' })
    const fit = add({ id: 't-fit', key: '1', mods: ['shift'] })
    press({ key: '1', code: 'Digit1' })
    press({ key: '!', code: 'Digit1', shiftKey: true })
    expect(device).toHaveBeenCalledTimes(1)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('accepts a symbol with or without shift (? and +)', () => {
    const help = add({ id: 't-help', key: '?' })
    press({ key: '?', shiftKey: true })
    press({ key: '?' })
    expect(help).toHaveBeenCalledTimes(2)
  })

  it('ignores auto-repeat unless the entry repeats', () => {
    const toggle = add({ id: 't-toggle', key: 'l' })
    const step = add({ id: 't-step', key: 'z', mods: ['mod'], repeat: true })
    press({ key: 'l', repeat: true })
    press({ key: 'z', metaKey: true, repeat: true })
    expect(toggle).not.toHaveBeenCalled()
    expect(step).toHaveBeenCalledTimes(1)
  })

  it('skips an entry whose when() is false and lets the next one take the key', () => {
    const first = add({ id: 't-first', key: 'escape', when: () => false })
    const second = add({ id: 't-second', key: 'escape' })
    press({ key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps bare keys out of an open dialog, but not once it is closing', () => {
    const run = add({ id: 't-dialog', key: 'q' })
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    expect(press({ key: 'q' }).handled).toBe(false)
    dialog.setAttribute('data-state', 'closed')
    expect(press({ key: 'q' }).handled).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('treats aria-modal content and open menus as overlays too', () => {
    const run = add({ id: 't-overlay', key: 'q' })
    const modal = document.body.appendChild(document.createElement('div'))
    modal.setAttribute('aria-modal', 'true')
    expect(press({ key: 'q' }).handled).toBe(false)
    modal.remove()
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-state', 'open')
    expect(press({ key: 'q' }).handled).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('lets ⌘ combos through an open dialog, as undo and copy always did', () => {
    const run = add({ id: 't-dialog-mod', key: 'z', mods: ['mod'] })
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    expect(press({ key: 'z', metaKey: true }).handled).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('unregisters: the returned function removes the entry', () => {
    const run = vi.fn()
    const remove = registerShortcut({ id: 't-gone', key: 'q', label: 'x', run })
    expect(press({ key: 'q' }).handled).toBe(true)
    remove()
    expect(press({ key: 'q' }).handled).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(listShortcuts().some((s) => s.id === 't-gone')).toBe(false)
  })

  it('an older unregister does not remove a replacement registered under the same id', () => {
    const stale = registerShortcut({ id: 't-same', key: 'q', label: 'old', run: vi.fn() })
    const run = add({ id: 't-same', key: 'q' })
    stale()
    expect(press({ key: 'q' }).handled).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lists registered shortcuts for the help dialog, hiding aliases', () => {
    add({ id: 't-listed', key: 'q', group: 'Modes' })
    add({ id: 't-alias', key: 'w', hidden: true })
    const ids = listShortcuts().map((s) => s.id)
    expect(ids).toContain('t-listed')
    expect(ids).not.toContain('t-alias')
  })

  it('spells keycaps from key and mods', () => {
    const entry: Shortcut = { id: 'k', key: 'z', mods: ['mod', 'shift'], label: 'x', run: () => undefined }
    expect(shortcutKeycaps(entry).slice(1)).toEqual(['⇧', 'Z'])
    expect(shortcutKeycaps({ ...entry, key: 'escape', mods: [] })).toEqual(['Esc'])
    expect(shortcutKeycaps({ ...entry, keycaps: ['⌫'] })).toEqual(['⌫'])
  })
})
