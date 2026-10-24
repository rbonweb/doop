import { canvasPages, pageFrames } from '../../shared/pages'
import { DEVICES } from '../../shared/devices'
import type { Frame } from '../../shared/types'
import { MOD_KEY } from './keys'
import { copyFramePng } from './frameExport'
import { copyFrames, duplicateFrames } from './frameClipboard'
import { redo, undo } from './history'
import { hideUiHinted } from './hideUi'
import { deleteSelection, toggleLockSelection, toggleSelectionHidden } from './layerEdits'
import { applyDevice, restoreDevices, tidyFrames } from './layoutEdits'
import { markAllSeen, reviewNext } from './marks'
import { canCommentNow, canEditNow } from './role'
import { isOverlayOpen, type Shortcut } from './shortcuts'
import { startPresenting } from './present'
import { useStore } from './store'
import { TOOLS, isDrawingTool, type Tool } from './tools'

/* The canvas's own keys, the only keyboard listener the canvas has: the tool letters, undo/redo, copy, duplicate,
   delete, zoom and fit, ⌘. (hide the UI), ⌘K (the Agents composer), ⌘⇧H / ⌘⇧L (hide and lock the selection) and Esc
   all live in this table. Keys that belong to one gesture (Space-hold pan, and Esc/Enter inside the path editor, the
   drag preview, the resize grips and the drawing composer) stay with that gesture's own capture-phase handler. */

const state = useStore.getState

/** Whether the canvas is on screen and not covered by present mode: the Stage reports its size only while it is mounted. */
const onCanvas = () => state().stageSize !== null && !state().presenting

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

/* The tools that change the design need the edit role; select and hand only move the camera, comment needs comment. */
const toolAllowed = (tool: Tool) => (tool === 'comment' ? canCommentNow() : !isDrawingTool(tool) || canEditNow())

/* Esc inside the canvas's own composers (a comment, a drawing's text box) drops the draft and goes back to Select;
   any other field keeps Escape for its own editing. */
const inCanvasComposer = (target: HTMLElement) => !!target.closest('[data-comment-ui], [data-drawing-input]')

/* The dispatcher takes the first matching entry, so the mode-exit Esc sits ahead of the selection's. */
export const canvasShortcuts: Shortcut[] = [
  {
    id: 'exit-laser',
    key: 'escape',
    label: 'Leave laser mode',
    group: 'Modes',
    when: () => state().laser,
    run: () => state().setLaser(false),
  },
  {
    id: 'exit-tool',
    key: 'escape',
    label: 'Back to the Select tool',
    group: 'Tools',
    when: () => state().tool !== 'select',
    inFields: inCanvasComposer,
    run: () => {
      state().setTool('select')
      /* a draft in a composer is the composer's own business (its handler runs first); the key itself is left alone */
      return false
    },
  },

  /* ---- tools: V H F R O P T C, from the one TOOLS table the rail draws its buttons from ---- */
  ...TOOLS.map((tool): Shortcut => ({
    id: `tool-${tool.id}`,
    key: tool.key.toLowerCase(),
    label: `${tool.label} tool`,
    group: 'Tools',
    when: () => onCanvas() && toolAllowed(tool.id),
    run: () => state().setTool(tool.id),
  })),

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
    id: 'hide-selection',
    key: 'h',
    mods: ['mod', 'shift'],
    label: 'Hide or show the selection',
    group: 'Selection',
    when: () => mayEdit() && state().selectedIds.length + (state().selectedElement ? 1 : 0) > 0,
    /* false (nothing to act on) leaves the browser's own ⌘⇧H alone */
    run: () => toggleSelectionHidden(),
  },
  {
    id: 'lock-selection',
    key: 'l',
    mods: ['mod', 'shift'],
    label: 'Lock or unlock the selection',
    group: 'Selection',
    when: () => mayEdit() && state().selectedIds.length + (state().selectedElement ? 1 : 0) > 0,
    run: () => toggleLockSelection(),
  },
  {
    id: 'deselect',
    key: 'escape',
    label: 'Clear the selection and stop following',
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
    mods: ['shift'],
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
    id: 'present',
    key: 'p',
    mods: ['shift'],
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
    id: 'mark-all-seen',
    key: 'u',
    mods: ['shift'],
    label: 'Mark every new frame as seen',
    group: 'View',
    when: onCanvas,
    run: () => void markAllSeen(),
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
    id: 'hide-ui',
    key: '.',
    mods: ['mod'],
    label: 'Hide or show every panel and toolbar',
    group: 'View',
    /* only the bare chord: ⌘⇧. and ⌥ variants stay free for the browser and the OS */
    when: (e) => !e.shiftKey && !e.altKey && !state().presenting && state().stageSize !== null,
    run: () => {
      const s = state()
      s.toggleUiHidden()
      /* Esc deliberately leaves the UI hidden, as in Figma; the first hide in this browser says how to get it back */
      if (state().uiHidden && !hideUiHinted()) s.pushNotice(`UI hidden · ${MOD_KEY}. to show`)
    },
  },
  {
    id: 'agents-composer',
    key: 'k',
    mods: ['mod'],
    label: 'Ask the Doop Agent',
    group: 'Canvas',
    /* from anywhere, text fields included: the page opens the Agents panel, this puts the keyboard in its composer */
    inFields: true,
    when: (e) => !e.shiftKey && !e.altKey && canEditNow() && !state().presenting,
    run: () => {
      const s = state()
      /* a field under `hidden` cannot take focus, so asking for the composer ends hide-UI */
      if (s.uiHidden) s.toggleUiHidden()
      s.setPanelTab('tasks')
      s.requestComposerFocus()
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
  if (frame) void copyFramePng(frame, scale)
}
