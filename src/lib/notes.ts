import type { CanvasNote } from '../../shared/types'
import { NOTE_DEFAULT_SIZE } from '../../shared/notes'
import { api, errorMessage, type NotePatch } from './api'
import { frameCenterPosition } from './framePlacement'
import { deleteNoteTracked, forgetNoteCreate, recordNoteCreate, recordNoteUpdate, trackSave } from './history'
import { useStore } from './store'

/* Client-side sticky-note actions: optimistic local writes, the API call, and
   the undo entry, in one place so the stage, the toolbar, the context menu
   and the layers list all behave the same. */

function stageSize(): { width: number; height: number } {
  const rect = document.querySelector('.stage')?.getBoundingClientRect()
  return rect ? { width: rect.width, height: rect.height } : { width: window.innerWidth, height: window.innerHeight }
}

/** The world-space spot at the middle of what the viewer is looking at,
 *  nudged down and right past any note already sitting there. */
function freeSpot(notes: readonly CanvasNote[]): { x: number; y: number } {
  const { viewport } = useStore.getState()
  const spot = frameCenterPosition(viewport, stageSize(), NOTE_DEFAULT_SIZE)
  let x = Math.round(spot.x)
  let y = Math.round(spot.y)
  while (notes.some((n) => Math.abs(n.x - x) < 8 && Math.abs(n.y - y) < 8)) {
    x += 28
    y += 28
  }
  return { x, y }
}

/** Bring a note into view when it landed off-screen (an attached note sits
 *  left of its frame, which may be at the edge of the stage). */
function revealNote(note: CanvasNote) {
  const { viewport } = useStore.getState()
  const stage = stageSize()
  const left = note.x * viewport.zoom + viewport.x
  const top = note.y * viewport.zoom + viewport.y
  const inView =
    left >= 0 &&
    top >= 0 &&
    left + note.width * viewport.zoom <= stage.width &&
    top + note.height * viewport.zoom <= stage.height
  if (!inView) useStore.getState().requestFlyToPoint(note.x + note.width / 2, note.y + note.height / 2)
}

/** Add an empty note and open it for typing: attached beside `frameId` when
 *  given (the server picks the spot), otherwise at `at` (a world point for the
 *  note's top-left) or in the middle of the view. */
export async function addNote(
  canvasId: string,
  where: { frameId?: string; at?: { x: number; y: number } } = {},
): Promise<CanvasNote | undefined> {
  const state = useStore.getState()
  try {
    const note = await api.createNote(canvasId, {
      ...(where.frameId
        ? { frameId: where.frameId }
        : { pageId: state.activePageId ?? undefined, ...(where.at ?? freeSpot(state.canvas?.notes ?? [])) }),
      markdown: '',
    })
    const s = useStore.getState()
    if (!s.notesVisible) s.setNotesVisible(true)
    s.upsertNote(note)
    s.setEditingNote(note.id)
    recordNoteCreate(note)
    revealNote(note)
    return note
  } catch (err) {
    useStore.getState().pushNotice(errorMessage(err, 'Couldn’t add the note'))
    return undefined
  }
}

/** Save a change to a note: shown at once, rolled back if the server refuses. */
export function saveNote(note: CanvasNote, patch: NotePatch) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, note[k as keyof CanvasNote]])) as NotePatch
  const s = useStore.getState()
  s.patchNoteLocal(note.id, patch)
  recordNoteUpdate(note.id, before, patch)
  trackSave(
    api.updateNote(note.id, patch).catch((err) => {
      useStore.getState().patchNoteLocal(note.id, before)
      useStore.getState().pushNotice(errorMessage(err, 'Couldn’t save the note'))
    }),
  )
}

export function removeNote(note: CanvasNote) {
  useStore.getState().removeNote(note.id)
  deleteNoteTracked(note)
}

/** A note that was never written in is not worth keeping: drop it as if it
 *  had not been added, undo entry included. */
export function discardEmptyNote(note: CanvasNote) {
  useStore.getState().removeNote(note.id)
  forgetNoteCreate(note.id)
  api.deleteNote(note.id).catch(console.error)
}
