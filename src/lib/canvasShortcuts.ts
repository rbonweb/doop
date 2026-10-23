import { canvasPages, pageFrames } from '../../shared/pages'
import { DEVICES } from '../../shared/devices'
import type { Frame } from '../../shared/types'
import { MOD_KEY } from './keys'
import { copyFrameImage } from './copyFrameImage'
import { copyFrames, duplicateFrames } from './frameClipboard'
import { redo, undo } from './history'
import { deleteSelection } from './layerEdits'
import { applyDevice, restoreDevices, tidyFrames } from './layoutEdits'
import { reviewNext } from './marks'
import { canCommentNow, canEditNow } from './role'
import { isOverlayOpen, type Shortcut } from './shortcuts'
import { startPresenting } from './present'
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

/* The server refuses every write below the edit role; these guards keep the keys from even trying. Reading keys (copy,
   fit, export, laser, notes visibility) stay open to everyone who can see the canvas, commenting needs the comment role. */
const mayEdit = () => canEditNow()
const mayEditOnCanvas = () => onCanvas() && canEditNow()

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
    when: mayEdit,
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
    when: () => mayEdit() && selectedFrames().length > 0,
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
  {
    id: 'undo',
    repeat: true,
    key: 'z',
    mods: ['mod'],
    label: 'Undo',
    group: 'Canvas',
    when: mayEdit,
    run: () => void undo(),
  },
  {
    id: 'redo',
    repeat: true,
    key: 'z',
    mods: ['mod', 'shift'],
    label: 'Redo',
    group: 'Canvas',
    when: mayEdit,
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
    when: mayEdit,
    run: () => void redo(),
  },

  /* ---- layout ---- */
  {
    id: 'tidy',
    key: 't',
    label: 'Tidy the selection, or the whole page, into rows',
    group: 'Canvas',
    when: mayEditOnCanvas,
    run: () => void tidyFrames(),
  },
  ...DEVICES.map((device): Shortcut => ({
    id: `device-${device.id}`,
    key: device.key,
    label: `${device.label} size, ${device.width} × ${device.height}`,
    group: 'Canvas',
    when: mayEditOnCanvas,
    run: () => applyDevice(device),
  })),
  {
    id: 'device-restore',
    key: '0',
    label: 'Restore the sizes and positions from before the device keys',
    group: 'Canvas',
    when: mayEditOnCanvas,
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
    when: () => onCanvas() && canCommentNow(),
    run: () => state().setCommentMode(!state().commentMode),
  },
  {
    id: 'present',
    key: 'p',
    label: 'Present: from the selected frame, or the first frame of the page',
    group: 'Modes',
    when: () => onCanvas() && !!state().canvas?.frames.length,
    run: () => startPresenting(),
  },
  {
    id: 'notes',
    key: 'n',
    label: 'Show or hide sticky notes',
    group: 'View',
    when: onCanvas,
    run: () => {
      const s = state()
      s.setNotesVisible(!s.notesVisible)
      s.pushNotice(s.notesVisible ? 'Notes hidden. Press N to show them.' : 'Notes shown')
    },
  },
  {
    id: 'next-marked',
    key: 'u',
    label: 'Jump to the next frame that needs you, then the next new one',
    group: 'View',
    when: onCanvas,
    run: () => reviewNext(),
  },
  {
    id: 'flow-links',
    key: 'k',
    label: 'Show or hide prototype link arrows on every frame',
    group: 'View',
    when: onCanvas,
    run: () => {
      const s = state()
      s.setFlowLinksVisible(!s.flowLinksVisible)
      s.pushNotice(s.flowLinksVisible ? 'Link arrows hidden. Press K to show them.' : 'Link arrows shown')
    },
  },
  {
    id: 'export',
    key: 'e',
    mods: ['mod', 'shift'],
    label: 'Export the selected frames',
    group: 'Selection',
    /* a dialog already open keeps its run */
    when: () => state().selectedIds.length > 0 && !state().exportIds,
    run: () => state().openExport(state().selectedIds),
  },
]

function copySelectedAsImage(scale: 2 | 4) {
  const frame = state().canvas?.frames.find((f) => f.id === state().selectedId)
  if (frame) void copyFrameImage(frame, scale)
}
