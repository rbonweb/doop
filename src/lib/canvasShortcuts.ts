import { canvasPages, pageFrames } from '../../shared/pages'
import { DEVICES } from '../../shared/devices'
import type { Frame } from '../../shared/types'
import { MOD_KEY } from './keys'
import { copyFrameImage } from './copyFrameImage'
import { copyFrames, duplicateFrames } from './frameClipboard'
import { redo, undo } from './history'
import { deleteSelection } from './layerEdits'
import { applyDevice, restoreDevices, tidyFrames } from './layoutEdits'
import { isOverlayOpen, type Shortcut } from './shortcuts'
import { useStore } from './store'

/* The canvas's own keys. Existing ones (delete, esc, undo/redo, copy, duplicate, zoom) behave exactly as they did when
   CanvasPage and the Stage each listened for them; the rest are new. */

const state = useStore.getState

/** Whether the canvas (not the board) is on screen — the Stage reports its size only while it is mounted. */
const onCanvas = () => state().stageSize !== null

const selectedFrames = (): Frame[] => state().canvas?.frames.filter((f) => state().selectedIds.includes(f.id)) ?? []

function pageFrameList(): Frame[] {
  const { canvas, activePageId } = state()
  return canvas ? pageFrames(canvas, activePageId ?? canvasPages(canvas)[0]!.id) : []
}

/* ⌘C should not hijack copying selected text */
const hasTextSelection = () => !!window.getSelection()?.toString()

const ZOOM_STEP = 1.25

/* The dispatcher takes the first matching entry, so the mode-exit Esc sits ahead of the selection's. */
export const canvasShortcuts: Shortcut[] = [
  {
    id: 'exit-mode',
    key: 'escape',
    label: 'Leave laser or comment mode',
    group: 'Modes',
    when: () => state().laser || state().commentMode,
    run: () => {
      state().setLaser(false)
      state().setCommentMode(false)
    },
  },

  /* ---- selection ---- */
  {
    id: 'delete',
    key: ['delete', 'backspace'],
    keycaps: ['⌫'],
    label: 'Delete the selected element or frames',
    group: 'Selection',
    /* a picked element is what ⌫ removes, the frame only when nothing inside it is picked; nothing to act on leaves the key alone */
    run: () => deleteSelection(),
  },
  {
    id: 'select-all',
    key: 'a',
    mods: ['mod'],
    label: 'Select every frame on this page',
    group: 'Selection',
    when: () => onCanvas() && !isOverlayOpen(),
    run: () => state().selectMany(pageFrameList().map((f) => f.id)),
  },
  {
    id: 'copy',
    key: 'c',
    mods: ['mod'],
    label: 'Copy the selected frames',
    group: 'Selection',
    when: () => selectedFrames().length > 0 && !hasTextSelection(),
    run: () => {
      copyFrames(selectedFrames())
      return false
    },
  },
  {
    id: 'duplicate',
    key: 'd',
    mods: ['mod'],
    label: 'Duplicate the selected frames',
    group: 'Selection',
    when: () => selectedFrames().length > 0,
    run: () => duplicateFrames(selectedFrames()),
  },
  {
    id: 'copy-image-2x',
    key: 'i',
    label: 'Copy the selected frame as an image (2×)',
    group: 'Selection',
    when: () => onCanvas() && !!state().selectedId,
    run: () => copySelectedAsImage(2),
  },
  {
    id: 'copy-image-4x',
    key: 'i',
    mods: ['shift'],
    label: 'Copy the selected frame as an image (4×)',
    group: 'Selection',
    when: () => onCanvas() && !!state().selectedId,
    run: () => copySelectedAsImage(4),
  },
  {
    id: 'deselect',
    key: 'escape',
    label: 'Clear the selection',
    group: 'Selection',
    run: () => {
      state().select(null)
      state().setFollowing(null)
      return false
    },
  },

  /* ---- history ---- */
  { id: 'undo', repeat: true, key: 'z', mods: ['mod'], label: 'Undo', group: 'Canvas', run: () => void undo() },
  {
    id: 'redo',
    repeat: true,
    key: 'z',
    mods: ['mod', 'shift'],
    label: 'Redo',
    group: 'Canvas',
    run: () => void redo(),
  },
  {
    id: 'redo-y',
    repeat: true,
    key: 'y',
    mods: ['mod'],
    label: 'Redo',
    group: 'Canvas',
    hidden: true,
    run: () => void redo(),
  },

  /* ---- layout ---- */
  {
    id: 'tidy',
    key: 't',
    label: 'Tidy the selection, or the whole page, into rows',
    group: 'Canvas',
    when: onCanvas,
    run: () => void tidyFrames(),
  },
  ...DEVICES.map((device): Shortcut => ({
    id: `device-${device.id}`,
    key: device.key,
    label: `${device.label} size, ${device.width} × ${device.height}`,
    group: 'Canvas',
    when: onCanvas,
    run: () => applyDevice(device),
  })),
  {
    id: 'device-restore',
    key: '0',
    label: 'Restore the sizes and positions from before the device keys',
    group: 'Canvas',
    when: onCanvas,
    run: () => restoreDevices(),
  },
  {
    id: 'shortcuts',
    key: '?',
    label: 'Keyboard shortcuts',
    group: 'Canvas',
    run: () => state().setShortcutsOpen(true),
  },

  /* ---- view ---- */
  {
    id: 'fit-all',
    key: '1',
    mods: ['shift'],
    label: 'Fit every frame on screen',
    group: 'View',
    when: onCanvas,
    run: () => state().fitAll(),
  },
  {
    id: 'fit-selection',
    key: '2',
    mods: ['shift'],
    label: 'Fit the selection on screen',
    group: 'View',
    when: onCanvas,
    run: () => state().fitSelection(),
  },
  {
    id: 'zoom-100-shift',
    key: '0',
    mods: ['shift'],
    label: `Zoom to 100% (${MOD_KEY}0 too)`,
    group: 'View',
    when: onCanvas,
    run: () => state().zoomTo(1),
  },
  {
    id: 'zoom-100',
    hidden: true,
    key: '0',
    mods: ['mod'],
    label: 'Zoom to 100%',
    group: 'View',
    when: onCanvas,
    run: () => state().zoomTo(1),
  },
  {
    id: 'zoom-in',
    repeat: true,
    key: ['=', '+'],
    keycaps: ['⌘', '+'],
    mods: ['mod'],
    label: 'Zoom in',
    group: 'View',
    when: onCanvas,
    run: () => state().zoomTo(state().viewport.zoom * ZOOM_STEP),
  },
  {
    id: 'zoom-out',
    repeat: true,
    key: '-',
    mods: ['mod'],
    label: 'Zoom out',
    group: 'View',
    when: onCanvas,
    run: () => state().zoomTo(state().viewport.zoom / ZOOM_STEP),
  },

  /* ---- modes ---- */
  {
    id: 'laser',
    key: 'l',
    label: 'Laser: outline every element and click one to copy its path',
    group: 'Modes',
    when: onCanvas,
    run: () => state().setLaser(!state().laser),
  },
  {
    id: 'comment-mode',
    key: 'c',
    label: 'Comment: click an element to comment on it',
    group: 'Modes',
    when: onCanvas,
    run: () => state().setCommentMode(!state().commentMode),
  },
]

function copySelectedAsImage(scale: 2 | 4) {
  const frame = state().canvas?.frames.find((f) => f.id === state().selectedId)
  if (frame) void copyFrameImage(frame, scale)
}
