import { useState } from 'react'
import { useStore } from '../lib/store'
import { DeckPresent } from './DeckPresent'
import { PrototypePlayer } from './PrototypePlayer'

/* Full-screen presentation over the editor, still connected to the room so edits streaming in render live. One entry
   point, two players, chosen by the frame it starts on: a slide plays the deck (presenter view, speaker notes, timer,
   second-window sync, deck PDF), anything else plays the prototype player (interactions, overlays, transitions, with
   data-goto links as click-to-navigate and the arrows walking reading order when a frame takes no key). Esc closes. */
export function PresentMode({ frameId, onClose }: { frameId: string; onClose: () => void }) {
  /* the player is chosen once, by the frame the show opens on: a later edit to the slide flag does not swap it */
  const [isSlide] = useState(() => !!useStore.getState().canvas?.frames.find((f) => f.id === frameId)?.slide)
  return isSlide ? (
    <DeckPresent key={frameId} startId={frameId} onClose={onClose} />
  ) : (
    <PrototypePlayer key={frameId} startFrameId={frameId} onClose={onClose} />
  )
}
