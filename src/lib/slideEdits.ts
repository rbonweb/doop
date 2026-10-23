import type { Frame } from '../../shared/types'
import { api } from './api'
import { recordUpdate } from './history'
import { canEditNow } from './role'
import { useStore } from './store'

interface DeckFields {
  slide?: boolean
  speakerNotes?: string
}

/** Turn a frame into a slide, or back into an ordinary frame. Undoable like any other edit to the frame. */
export function toggleSlide(frame: Frame) {
  setFrameDeckFields(frame, { slide: !frame.slide })
}

/**
 * Change the deck fields of a frame (the slide flag, its speaker notes): shown at once, saved, and one undo step.
 * A frame with no flag counts as `false` and one with no notes as `''`, so undo always has a value to send back.
 * Editing the deck needs the edit role (the server refuses it below that); nothing is sent or shown otherwise.
 */
export function setFrameDeckFields(frame: Frame, patch: DeckFields) {
  if (!canEditNow()) return
  const before = { slide: !!frame.slide, speakerNotes: frame.speakerNotes ?? '' }
  const changed: DeckFields = {}
  if (patch.slide !== undefined && patch.slide !== before.slide) changed.slide = patch.slide
  if (patch.speakerNotes !== undefined && patch.speakerNotes !== before.speakerNotes) {
    changed.speakerNotes = patch.speakerNotes
  }
  if (!Object.keys(changed).length) return
  recordUpdate(
    frame.id,
    {
      ...(changed.slide === undefined ? {} : { slide: before.slide }),
      ...(changed.speakerNotes === undefined ? {} : { speakerNotes: before.speakerNotes }),
    },
    changed,
  )
  /* the store mirrors the server, which drops a false flag and empty notes */
  useStore.getState().patchFrameLocal(frame.id, {
    ...(changed.slide === undefined ? {} : { slide: changed.slide || undefined }),
    ...(changed.speakerNotes === undefined ? {} : { speakerNotes: changed.speakerNotes || undefined }),
  })
  api.updateFrame(frame.id, changed).catch(console.error)
}
