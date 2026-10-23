/** ⌘ on Mac, Ctrl elsewhere — for the shortcut hints in menus. */
export const MOD_KEY = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** The Export-selection shortcut, spelled for the platform. */
export const EXPORT_SHORTCUT = /mac/i.test(navigator.platform) ? '⌘⇧E' : 'Ctrl+Shift+E'
