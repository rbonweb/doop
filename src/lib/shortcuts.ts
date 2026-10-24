import { useEffect } from 'react'
import { MOD_KEY } from './keys'

/**
 * The keyboard shortcut registry: one table of entries and one window keydown listener.
 * Features add their own keys with registerShortcut() from their own modules; the help dialog lists whatever is registered.
 */

export type ShortcutMod = 'mod' | 'shift' | 'alt'
export type ShortcutGroup = 'Tools' | 'Canvas' | 'Selection' | 'View' | 'Modes'

export interface Shortcut {
  id: string
  /**
   * What the key is called by `KeyboardEvent.key`, lowercased ('z', 'escape', 'delete', '?').
   * Digits are read from `code`, so ⇧1 is key '1' with the shift mod on any layout. An array lists aliases.
   */
  key: string | readonly string[]
  /** `mod` is ⌘ on Mac and Ctrl elsewhere (either counts). A key with no mods only fires bare. */
  mods?: readonly ShortcutMod[]
  label: string
  /** Where the help dialog files it; defaults to Canvas. */
  group?: ShortcutGroup
  /** The keycaps the help dialog shows, when they can't be derived from `key` and `mods`. */
  keycaps?: readonly string[]
  /** An alias of another entry: works, but is not listed in the help dialog. */
  hidden?: boolean
  /** Skipped (the next matching entry gets a turn) when this returns false. */
  when?: (e: KeyboardEvent) => boolean
  /**
   * Fires while a text field has the focus too: true for every field, or a test of the focused one. Left off, a key
   * typed into a field is never ours.
   */
  inFields?: boolean | ((target: HTMLElement) => boolean)
  /**
   * The action. The key's default is prevented afterwards unless this returns false.
   */
  run: (e: KeyboardEvent) => boolean | void
  /** Fires again while the key is held; toggles leave this off. */
  repeat?: boolean
}

const entries = new Map<string, Shortcut>()

/** Add a shortcut (a second entry with the same id replaces the first). Returns a function that removes it again. */
export function registerShortcut(entry: Shortcut): () => void {
  entries.set(entry.id, entry)
  return () => {
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
  }
}

/** Every registered shortcut that the help dialog should show, in registration order. */
export function listShortcuts(): Shortcut[] {
  return [...entries.values()].filter((s) => !s.hidden)
}

const keysOf = (s: Shortcut) => (typeof s.key === 'string' ? [s.key] : s.key)

/** The key of an event as the table names it: digits from the physical key (shift would turn 1 into !), the rest from `key`. */
function eventKey(e: KeyboardEvent): string {
  const digit = /^Digit(\d)$/.exec(e.code ?? '')
  return digit?.[1] ?? e.key.toLowerCase()
}

/* a symbol like ? or + is typed with shift on some layouts and without it on others, so shift never decides it */
const isSymbol = (key: string) => key.length === 1 && !/[a-z0-9]/.test(key)

function matches(s: Shortcut, e: KeyboardEvent): boolean {
  const key = eventKey(e)
  const wanted = keysOf(s).find((k) => k === key)
  if (!wanted) return false
  const mods = s.mods ?? []
  if (mods.includes('mod') !== (e.metaKey || e.ctrlKey)) return false
  if (mods.includes('alt') !== e.altKey) return false
  return mods.includes('shift') === e.shiftKey || isSymbol(wanted)
}

/** True when the key was typed into something that takes text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return true
  return !!target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
}

/* Radix marks an open dialog (and sheet, popover) role=dialog with data-state=open, and a menu role=menu likewise; a
   closing one stays mounted for its exit animation with data-state=closed, which must not count. aria-modal covers
   hand-rolled modals. */
const OPEN_OVERLAY = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[aria-modal="true"]',
].join(', ')

/** True while a modal, sheet, popover or menu is open — keys belong to it then. */
export function isOverlayOpen(): boolean {
  return !!document.querySelector(OPEN_OVERLAY)
}

/* An overlay that closes on this very key (Esc on a dialog) is already gone from the DOM by the time the bubble
   listener runs, so the window's capture listener notes whether one was open when the key went down. */
let overlayAtKeydown: boolean | null = null
const noteOverlay = () => {
  overlayAtKeydown = isOverlayOpen()
}

function allowedInField(s: Shortcut, e: KeyboardEvent): boolean {
  if (!s.inFields) return false
  return s.inFields === true || (e.target instanceof HTMLElement && s.inFields(e.target))
}

/** Handle one keydown against the table. Returns whether an entry took it. */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  if (e.isComposing) return false
  const typing = isTypingTarget(e.target)
  /* a key typed into a field is the field's, unless an entry says otherwise below */
  if (typing && ![...entries.values()].some((s) => s.inFields && matches(s, e))) return false
  const hasMod = e.metaKey || e.ctrlKey
  /* bare keys (including Delete and Esc) stay out of an open dialog's way; ⌘ combos have always passed through */
  const overlay = overlayAtKeydown ?? isOverlayOpen()
  overlayAtKeydown = null
  if (!hasMod && overlay) return false
  for (const s of entries.values()) {
    if (!matches(s, e) || (s.when && !s.when(e))) continue
    if (typing && !allowedInField(s, e)) continue
    if (e.repeat && !s.repeat) {
      if (hasMod) e.preventDefault()
      return true
    }
    if (s.run(e) !== false) e.preventDefault()
    return true
  }
  return false
}

/**
 * Install the registry on the window for as long as the caller is mounted, with `own` registered for the same span.
 * CanvasPage passes the canvas's shortcuts; other features register theirs with registerShortcut().
 */
export function useShortcuts(own: readonly Shortcut[] = []) {
  useEffect(() => {
    const removers = own.map(registerShortcut)
    window.addEventListener('keydown', noteOverlay, true)
    window.addEventListener('keydown', dispatchShortcut)
    return () => {
      window.removeEventListener('keydown', noteOverlay, true)
      window.removeEventListener('keydown', dispatchShortcut)
      removers.forEach((remove) => remove())
    }
  }, [own])
}

const SYMBOLS: Record<string, string> = {
  escape: 'Esc',
  delete: '⌫',
  backspace: '⌫',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  ' ': 'Space',
}

/** The keycaps for a shortcut, one string per cap: ['⌘', '⇧', 'Z']. */
export function shortcutKeycaps(s: Shortcut): string[] {
  if (s.keycaps) return [...s.keycaps]
  const mods = s.mods ?? []
  const caps: string[] = []
  if (mods.includes('mod')) caps.push(MOD_KEY.replace('+', ''))
  if (mods.includes('alt')) caps.push('⌥')
  if (mods.includes('shift')) caps.push('⇧')
  const key = keysOf(s)[0] ?? ''
  caps.push(SYMBOLS[key] ?? key.toUpperCase())
  return caps
}
