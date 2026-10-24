import { useState, type MutableRefObject } from 'react'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { copyFrames, duplicateFrames, hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { copyFramePng } from '../lib/frameExport'
import { deleteFramesTracked } from '../lib/history'
import { setFramesHidden, setFramesLocked } from '../lib/layerEdits'
import { addNote } from '../lib/notes'
import { startPresenting } from '../lib/present'
import { useStore } from '../lib/store'
import { toggleSlide } from '../lib/slideEdits'
import { EXPORT_SHORTCUT, MOD_KEY } from '../lib/keys'
import { useCanEdit } from '../lib/role'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { FrameExportModal } from './FrameExportModal'
import { FrameHistoryModal } from './FrameHistoryModal'

async function copyImageUrl(frame: Frame) {
  const notify = useStore.getState().pushNotice
  try {
    await navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)
    notify('Image URL copied')
  } catch (err) {
    notify(errorMessage(err, 'Couldn’t copy the image URL'))
  }
}

/** Right-click menu for a frame. FrameView owns the trigger, and passes the
 *  point the right-click happened at — Paste lands there. */
export function FrameContextMenu({ frame, at }: { frame: Frame; at: MutableRefObject<{ x: number; y: number }> }) {
  /* the frames the open export dialog is for, fixed when Export is chosen */
  const [exportTargets, setExportTargets] = useState<Frame[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  /* below edit the menu only reads: copy, present, share and export; no paste, duplicate, notes, slides, hide, lock, history, memory or delete */
  const mayEdit = useCanEdit()
  /* a right-click inside a multi-selection acts on the whole group */
  const groupSize = useStore((s) => (s.selectedIds.includes(frame.id) ? s.selectedIds.length : 1))
  /* Hide/Show reads as one item: the group shows when every frame in it is hidden */
  const allHidden = useStore((s) => {
    const ids = s.selectedIds.includes(frame.id) ? s.selectedIds : [frame.id]
    return (s.canvas?.frames ?? []).filter((f) => ids.includes(f.id)).every((f) => !!f.hidden)
  })
  function groupFrames(): Frame[] {
    const s = useStore.getState()
    const ids = s.selectedIds.includes(frame.id) ? s.selectedIds : [frame.id]
    return s.canvas?.frames.filter((f) => ids.includes(f.id)) ?? [frame]
  }
  /* Lock reads as one state for the group: it unlocks only once every frame
     in it is locked, otherwise it locks the rest (as ⌘⇧L does) */
  const allLocked = useStore((s) => {
    const ids = s.selectedIds.includes(frame.id) ? s.selectedIds : [frame.id]
    const group = s.canvas?.frames.filter((f) => ids.includes(f.id)) ?? [frame]
    return group.every((f) => f.locked)
  })
  function deleteSelection() {
    /* locked frames stay, as they do on ⌫ */
    deleteFramesTracked(groupFrames().filter((f) => !f.locked))
  }
  return (
    <>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // The export and history dialogs own focus once the menu closes.
          if (exportTargets || historyOpen) event.preventDefault()
        }}
      >
        <ContextMenuItem onSelect={() => copyFrames(groupFrames())}>
          {groupSize > 1 ? `Copy ${groupSize} frames` : 'Copy'}
          <MenuHint>{MOD_KEY}C</MenuHint>
        </ContextMenuItem>
        {mayEdit && (
          <>
            <ContextMenuItem
              disabled={!hasFrameClip()}
              onSelect={() => pasteFrameAtScreen(frame.canvasId, at.current.x, at.current.y)}
            >
              Paste
              <MenuHint>{MOD_KEY}V</MenuHint>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => duplicateFrames(groupFrames())}>
              {groupSize > 1 ? `Duplicate ${groupSize} frames` : 'Duplicate'}
              <MenuHint>{MOD_KEY}D</MenuHint>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void addNote(frame.canvasId, { frameId: frame.id })}>
              Add note
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem onSelect={() => startPresenting(frame.id)}>
          Present
          <MenuHint>⇧P</MenuHint>
        </ContextMenuItem>
        {mayEdit && (
          <>
            <ContextMenuItem onSelect={() => toggleSlide(frame)}>
              {frame.slide ? 'Remove from deck' : 'Make a slide'}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setFramesHidden(groupFrames(), !allHidden)}>
              {`${allHidden ? 'Show' : 'Hide'}${groupSize > 1 ? ` ${groupSize} frames` : ''}`}
              <MenuHint>{MOD_KEY}⇧H</MenuHint>
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => navigator.clipboard.writeText(`${location.origin}/c/${frame.canvasId}?frame=${frame.id}`)}
        >
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyFramePng(frame)}>
          Copy as PNG
          <MenuHint>I</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyImageUrl(frame)}>Copy image URL</ContextMenuItem>
        <ContextMenuItem onSelect={() => setExportTargets(groupFrames())}>
          {groupSize > 1 ? `Export ${groupSize} frames…` : 'Export…'}
          <MenuHint>{EXPORT_SHORTCUT}</MenuHint>
        </ContextMenuItem>
        {mayEdit && (
          <>
            <ContextMenuItem onSelect={() => setHistoryOpen(true)}>Version history…</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setFramesLocked(groupFrames(), !allLocked)}>
              {allLocked ? 'Unlock' : 'Lock'}
              {groupSize > 1 ? ` ${groupSize} frames` : ''}
              <MenuHint>{MOD_KEY}⇧L</MenuHint>
            </ContextMenuItem>
            <ContextMenuItem
              title="Will be used as reference — agents copy its style in new designs"
              onSelect={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
            >
              Add to design memory
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem tone="danger" disabled={allLocked} onSelect={deleteSelection}>
              {groupSize > 1 ? `Delete ${groupSize} frames` : 'Delete frame'}
              <MenuHint>⌫</MenuHint>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      {exportTargets && <FrameExportModal frames={exportTargets} onClose={() => setExportTargets(null)} />}
      {historyOpen && <FrameHistoryModal frame={frame} onClose={() => setHistoryOpen(false)} />}
    </>
  )
}
