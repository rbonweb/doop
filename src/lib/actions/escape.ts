/* What Esc does on the canvas, in the order the fork always had: it leaves the mode it is in (the laser, then a
   drawing tool) before it clears the selection. The Stage's own listener drops the tool before the page's listener
   runs, so the page notes the mode when the key goes down (a capture listener) and acts on that. */

import { useStore } from '../store'

export type EscapeMode = 'laser' | 'tool' | null

/** The mode an Esc pressed now would leave. */
export function escapeModeNow(): EscapeMode {
  const s = useStore.getState()
  if (s.laser) return 'laser'
  return s.tool !== 'select' ? 'tool' : null
}

/** Esc, given the mode it found: leave that mode and keep the selection, else clear the selection and stop following. */
export function applyEscape(mode: EscapeMode) {
  const s = useStore.getState()
  if (mode === 'laser') {
    s.setLaser(false)
    return
  }
  if (mode === 'tool') {
    s.setTool('select')
    return
  }
  s.select(null)
  s.setFollowing(null)
}
