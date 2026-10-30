import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CommentAnchor, ElementComment, Frame } from '../../shared/types'
import { resolveGoto } from '../../shared/gotoLinks'
import { useStore } from '../lib/store'
import { isCanvasElement } from '../lib/drawing'
import { useDrawingMove } from './DrawingMove'
import { FrameLabelLayer } from './FrameLabelLayer'
import { PathEditor } from './PathEditor'
import { loadPathEdit, type PathEditSource } from '../lib/pathEditing'
import { currentPageCanvas } from '../lib/pages'
import { registerFrameWindow, unregisterFrameWindow } from '../lib/frameBridge'
import { api } from '../lib/api'
import { postComment, postReply } from '../lib/commenting'
import { canCommentNow, useCanComment, useCanEdit } from '../lib/role'
import { copyElementLink } from '../lib/elementLink'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { getIdentity } from '../lib/identity'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { useFrameMounted } from '../lib/frameMounting'
import { useFrameSleep } from '../lib/frameSleep'
import { recordCreate, recordUpdate, recordUpdates, trackSave } from '../lib/history'
import { snapDeviceWidth, snapFrame } from '../lib/snap'
import { gesture } from '../lib/gesture'
import { resolvePointerAction } from '../lib/tools'
import { FrameContextMenu } from './FrameContextMenu'
import { CodePanel } from './CodePanel'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { DEFAULT_ROLE_ID } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { isResidentLimit } from './TeamAllowance'
import { MarkDot } from './MarkDot'
import { useFrameMark } from '../lib/marks'
import { CommentComposer, CommentPin, CommentThread } from './CommentPopovers'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { DownloadIcon, EyeClosedIcon, GithubIcon, LockIcon, SlideIcon, SyncIcon } from './ui/icons'
import { isSyncedFrame } from '../lib/sync'
import { EXPORT_SHORTCUT } from '../lib/keys'
import { isGithubFrame, isGithubPlaceholder } from '../lib/github'
import { AgentIcon } from './AgentIcon'
import { ElementResizeHandles } from './ElementResizeHandles'

/** ?comment=<rootId> — the link in a comment email. The thread opens once
 *  Stage has selected the linked frame (deselection closes popovers, and on
 *  first paint no frame is selected yet). Frames that do not hold the
 *  comment ignore it: only a root with that id ever renders an open popover. */
function deepLinkedThread(): string | null {
  return new URLSearchParams(location.search).get('comment')
}

/** Where a pointer event landed relative to an element, in design px (screen
 *  px over the camera zoom: the frame lives inside the zoomed stage). */
function designPoint(e: React.MouseEvent, el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect()
  const zoom = useStore.getState().viewport.zoom
  return { x: (e.clientX - box.left) / zoom, y: (e.clientY - box.top) / zoom }
}

/** Where a press landed on its target, as `offsetX` measured it; `offsetX`
 *  itself counts zoomed px in Chromium under the world's CSS zoom. */
function designOffset(e: React.PointerEvent<HTMLElement>): { x: number; y: number } {
  return designPoint(e, e.target instanceof HTMLElement ? e.target : e.currentTarget)
}

/* Counter-scale contract: chrome that keeps constant on-screen size divides
   by the `--zoom` variable the Stage publishes (capped at 2.4× when zoomed
   far out, so a pin or label never dwarfs the frame it sits on). Preserve
   these expressions exactly. */
const COUNTER_SCALE = '[transform:scale(min(calc(1/var(--zoom,1)),2.4))]'
/* The element toolbar and the composer are not capped, like the rest of the
   comment UI (CommentPopovers): screen UI the user reads and types in keeps
   its size at every zoom, the way Figma's comment pins do. */
const POPOVER_SCALE = '[transform:scale(calc(1/var(--zoom,1)))_translateY(calc(-100%_-_8px))]'

/* screen px between a frame's name and its top edge, at every zoom */
const LABEL_GAP = 6
const EDITOR_CHIP =
  'inline-flex items-center gap-1 rounded-full px-[7px] py-0.5 text-[10px] font-bold text-white animate-[chip-in_0.25s_ease]'
/* the element toolbar's buttons sit on ink and stay compact */
const EL_TOOLBAR_BTN = 'rounded-[7px] px-2 py-1 text-xs'

/** A hidden frame's place on the stage: nothing, unless it is selected —
 *  then a dashed box with its name, so a pick from the Layers panel still
 *  shows where the frame sits. It takes no pointer events: there is nothing
 *  to drag, and the eye in the Layers panel is the way back. */
export function HiddenFrameView({ frame }: { frame: Frame }) {
  const selected = useStore((s) => s.selectedIds.includes(frame.id))
  if (!selected) return null
  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <div
        className={cn(
          'absolute -top-[26px] left-0 flex origin-bottom-left items-center gap-1.5 whitespace-nowrap text-[12px] font-semibold text-ink-faint',
          COUNTER_SCALE,
        )}
      >
        <EyeClosedIcon width={11} height={11} />
        <span>{frame.name}</span>
      </div>
      <div className="absolute inset-0 border border-dashed border-ink-faint bg-paper-deep/40 outline-2 outline-offset-1 outline-dashed outline-brand" />
    </div>
  )
}

/* Figma-style ⌥⇧-drag duplicate cursor: a doubled pointer, hotspot on the
   front arrow's tip. `copy` is the fallback where custom cursors fail. */
const DUP_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M9 8v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/><path d="M4 3v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/></svg>`
const DUP_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(DUP_CURSOR_SVG)}") 4 3, copy`

/** True while ⌥⇧ is held. The duplicate cursor must be showing BEFORE the
 *  drag starts: Chromium freezes the effective cursor for the duration of a
 *  pointer drag, so a swap at drag-start never paints. */
function useDupModifier(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setHeld(e.altKey && e.shiftKey)
    const reset = () => setHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return held
}

/** Re-render the iframe at most every `ms` — keeps streaming chunk updates smooth. */
function useThrottledValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now())
    const t = window.setTimeout(() => {
      last.current = Date.now()
      setV(value)
    }, wait)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

interface ProbeHit {
  selector: string
  /** how to find the element again once the frame is edited */
  anchor?: CommentAnchor
  tag: string
  text: string
  snippet: string
  rect: { x: number; y: number; width: number; height: number }
  /** whether a width/height applies to the box (not an inline text run) */
  sizable?: boolean
  /** inside a locked layer: selectable, but it takes no edits */
  locked?: boolean
}

/** where a comment pin sits in frame coords, or 'orphan' when its element
 *  can no longer be found and the pin parks at the frame's corner */
type PinSpot = { x: number; y: number } | 'orphan'

/** same scale the pins get (CommentPopovers), so orphan stacking spaces by the pin's rendered size */
const PIN_SCALE = 'calc(1/var(--zoom,1))'

type DragRect = { id: string; x: number; y: number; width: number; height: number }

interface HoverHit {
  tag: string
  rect: { x: number; y: number; width: number; height: number }
}

/* Counter-scaled overlays (labels, pins, popovers) get their scale from the
   `--zoom` CSS variable the Stage sets, so a viewport change never re-renders
   this component — memo holds as long as the frame is unchanged. */
export const FrameView = memo(function FrameView({ frame }: { frame: Frame }) {
  const drawingMove = useDrawingMove(frame)
  const labelLayer = useContext(FrameLabelLayer)
  const [pathEdit, setPathEdit] = useState<PathEditSource | null>(null)
  const editRequest = useRef(0)
  const closePathEdit = useCallback(() => {
    editRequest.current++
    setPathEdit(null)
  }, [])
  const selected = useStore((s) => s.selectedIds.includes(frame.id))
  /* the title bar offers Export only when this is the one selected frame: with
     a group, the top bar's Export acts on all of them */
  const soleSelected = useStore((s) => s.selectedIds.length === 1 && s.selectedIds[0] === frame.id)
  const presenting = useStore((s) => s.presenting)
  const mark = useFrameMark(frame.id)
  /* below edit a frame can be selected, probed and commented on, never moved */
  const mayEdit = useCanEdit()
  const mayComment = useCanComment()
  const guest = useStore((s) => s.guest)
  const pulses = useStore((s) => s.pulses)
  /* the document renders once the Stage's scheduler reaches this frame, or at once when someone selects it */
  const scheduled = useFrameMounted(frame.id)
  const [selectedOnce, setSelectedOnce] = useState(false)
  if (selected && !selectedOnce) setSelectedOnce(true)
  const mounted = scheduled || selectedOnce
  /* space held: the shield stays up even in edit mode, so the press reaches
     the Stage and pans instead of vanishing into the editable iframe */
  const panMode = useStore((s) => s.panMode)
  /* the canvas tool: Hand lets presses fall through to the Stage, Comment
     turns a click on the surface into a comment on the element under it */
  const tool = useStore((s) => s.tool)
  const select = useStore((s) => s.select)
  const flash = useStore((s) => s.flashes[frame.id])
  /* laser turns the frame surface from "select" into "inspect" (the Comment tool has its own cursor, from the Stage) */
  const laser = useStore((s) => s.laser)
  const stream = useStore((s) => s.streams[frame.id])
  /* select the stable presences map, derive in render — a selector that
     builds a fresh array re-renders every frame on EVERY store update
     (zustand compares by identity), which defeats the memo above */
  const presences = useStore((s) => s.presences)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter((p) => p.activeFrameId === frame.id && p.clientId !== me)
  const [dragging, setDragging] = useState(false)
  /* a grip on the selected element is being dragged: no hover outlines
     meanwhile, and the selection outline follows the element */
  const [resizing, setResizing] = useState(false)
  /* ⌥⇧-drag (Figma-style duplicate): the original stays behind, the copy
     rides the cursor — the doubled cursor shows from the moment ⌥⇧ is held */
  const [duping, setDuping] = useState(false)
  const dupKeyHeld = useDupModifier()
  const [editing, setEditing] = useState(false)
  /* after exiting edit mode, hold renders until the final serialized HTML
     lands in the store — otherwise a stale post would morph the edit away */
  const [suspendPost, setSuspendPost] = useState(false)

  /* one throttle per frame, so a group drag broadcasts every member —
     a single throttle would keep only the last frame written each tick */
  const dragSenders = useRef(new Map<string, (f: DragRect) => void>()).current
  function sendDrag(id: string, f: DragRect) {
    let send = dragSenders.get(id)
    if (!send) {
      send = throttle((r: DragRect) => {
        sendWs({ type: 'frame:drag', frameId: r.id, x: r.x, y: r.y, width: r.width, height: r.height })
      }, 50)
      dragSenders.set(id, send)
    }
    send(f)
  }

  function startDrag(
    e: React.PointerEvent<HTMLDivElement>,
    mode: 'move' | 'resize',
    probeOnClick = false,
    panelOnClick = false,
    skipDrawing = false,
  ): { move: (event: PointerEvent) => void; up: () => void } | undefined {
    if (pathEdit && probeOnClick) return
    const s = useStore.getState()
    const action = resolvePointerAction({
      tool: s.tool,
      target: 'frame',
      button: e.button,
      pointerType: e.pointerType,
      spaceHeld: s.panMode,
    })
    /* a pan (Hand, space held, middle button): let the event reach the
       Stage, which pans */
    if (action === 'pan') return
    if (action === 'comment') {
      /* the Comment tool: no drag — the frame is selected and a click on its
         surface opens the composer on the element under the pointer */
      e.stopPropagation()
      e.preventDefault()
      if (!s.selectedIds.includes(frame.id)) select(frame.id)
      if (probeOnClick) {
        const at = designOffset(e)
        probeAt(at.x, at.y, 'comment')
      }
      return
    }
    /* a locked frame is not the stage's to select, move or resize: the press
       falls through to the Stage, which treats it as empty canvas */
    if (action !== 'frame-drag' || frame.locked) return
    if (
      mayEdit &&
      mode === 'move' &&
      probeOnClick &&
      !skipDrawing &&
      drawingMove.start(
        e,
        (press, move, released) => {
          const drag = startDrag(press, mode, probeOnClick, panelOnClick, true)
          if (move) drag?.move(move)
          if (released) drag?.up()
        },
        (selector) => {
          void enterElementEdit({ selector })
        },
      )
    )
      return
    e.stopPropagation()
    e.preventDefault()
    if (!mayEdit) {
      /* read-only: a click selects the frame and picks the element under the
         cursor (so it can be commented on); there is no drag and no resize */
      if (mode !== 'move') return
      select(frame.id)
      const down = { x: e.clientX, y: e.clientY }
      const at = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
      const release = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', release)
        if (Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 4) return
        if (probeOnClick) {
          /* laser is for everyone who can look */
          if (useStore.getState().laser) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'doop:laser-click', x: at.x, y: at.y }, '*')
          } else probeAt(at.x, at.y)
        }
        if (panelOnClick) useStore.getState().setInspectorOpen(true)
      }
      window.addEventListener('pointerup', release)
      return
    }
    /* ⌥⇧-drag duplicates: the moment the drag is real, leave a copy of the
       frame at its origin and keep dragging this one — same net effect as
       Figma's "drag off a duplicate", without retargeting the drag */
    const duplicating = mode === 'move' && e.altKey && e.shiftKey
    /* ⌥-click follows a prototype link under the pointer instead of picking the element */
    const followLink = mode === 'move' && e.altKey && !e.shiftKey
    /* plain ⇧-click adds to (or drops from) the selection; a dropped frame
       does not start a drag */
    if (mode === 'move' && e.shiftKey && !e.altKey) {
      useStore.getState().toggleSelect(frame.id)
      if (!useStore.getState().selectedIds.includes(frame.id)) return
    } else if (!useStore.getState().selectedIds.includes(frame.id)) {
      /* clicking a frame already in a group keeps the group — the drag
         moves all of them */
      select(frame.id)
    } else if (panelOnClick && useStore.getState().selectedElement?.frameId === frame.id) {
      /* grabbing the title bar while one of its elements is picked means
         "the whole frame now" — drop the element selection */
      useStore.getState().pickElement(null)
      closePopovers() // and its outline, so a stale target never lingers
    }
    setDragging(true)
    clearHover()
    const start = { x: e.clientX, y: e.clientY }
    const off = designOffset(e)
    const orig = { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    /* the drag's baseline: finger position and frame rect the deltas are
       measured from. Starts at pointer-down, and re-anchors while a pinch
       owns the finger so the drag resumes from where the finger is (and at
       the zoom it is now) rather than jumping by the pinch's displacement */
    let base = { x: start.x, y: start.y, rect: orig }
    let moved = false
    let dupDropped = false
    if (duplicating) setDuping(true)
    /* a move carries every selected frame along (locked ones stay put — a
       Layers-panel selection may hold one); a resize is this frame only */
    const frames = currentPageCanvas()?.frames ?? []
    const selectedIds = mode === 'move' ? useStore.getState().selectedIds : [frame.id]
    const group = frames
      .filter((f) => selectedIds.includes(f.id) && !f.locked)
      .map((f) => ({ id: f.id, orig: { x: f.x, y: f.y, width: f.width, height: f.height } }))
    const groupIds = new Set(group.map((g) => g.id))

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return
      /* a second finger turns the gesture into a pinch: the frame stays put */
      if (gesture.pinching) {
        const cur = useStore.getState().canvas?.frames.find((x) => x.id === frame.id)
        base = { x: ev.clientX, y: ev.clientY, rect: cur ? { ...cur } : base.rect }
        return
      }
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true
      if (duplicating && moved && !dupDropped) {
        dupDropped = true
        for (const g of group) {
          const src = frames.find((f) => f.id === g.id)
          if (!src) continue
          api
            .createFrame(src.canvasId, { name: src.name, html: src.html, ...g.orig })
            .then((f) => {
              posthog.capture('frame_duplicated', { via: 'drag' })
              recordCreate(f)
            })
            .catch(console.error)
        }
      }
      const zoom = useStore.getState().viewport.zoom
      const dx = (ev.clientX - base.x) / zoom
      const dy = (ev.clientY - base.y) / zoom
      const from = base.rect
      const raw =
        mode === 'move'
          ? { ...from, x: Math.round(from.x + dx), y: Math.round(from.y + dy) }
          : {
              ...from,
              width: Math.max(120, Math.round(from.width + dx)),
              height: Math.max(80, Math.round(from.height + dy)),
            }
      /* edges pull onto neighbouring frames' edges/centers; ⌥ drags free —
         except that a ⌥⇧ duplicate-drag holds ⌥ for the whole gesture, and
         the copy should land on the guides like any other move. Frames
         riding along in the group are not neighbours, and neither is a
         hidden frame — there is nothing on the stage to line up with. */
      const others = currentPageCanvas()?.frames.filter((f) => !f.hidden && !groupIds.has(f.id)) ?? []
      const free = ev.altKey && !duplicating
      let snapped = free ? { ...raw, guides: [] } : snapFrame(mode, raw, others, zoom)
      /* a resize also locks onto device widths — unless a neighbour's edge already took the width */
      if (mode === 'resize' && !free && !snapped.guides.some((g) => g.axis === 'v')) {
        const device = snapDeviceWidth(snapped, zoom)
        snapped = { ...device, guides: [...snapped.guides, ...device.guides] }
      }
      useStore.getState().setSnapGuides(snapped.guides)
      if (mode === 'move') {
        /* the snapped delta of the dragged frame moves the whole group */
        const sdx = snapped.x - orig.x
        const sdy = snapped.y - orig.y
        for (const g of group) {
          useStore.getState().patchFrameLocal(g.id, { x: g.orig.x + sdx, y: g.orig.y + sdy })
        }
      } else {
        useStore.getState().patchFrameLocal(frame.id, { width: snapped.width, height: snapped.height })
      }
      const live = useStore.getState().canvas?.frames ?? []
      for (const g of group) {
        const f = live.find((x) => x.id === g.id)
        if (f) sendDrag(f.id, { id: f.id, x: f.x, y: f.y, width: f.width, height: f.height })
      }
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(false)
      if (duplicating) setDuping(false)
      useStore.getState().setSnapGuides([])
      const live = useStore.getState().canvas?.frames ?? []
      const updates: { frameId: string; before: typeof orig; after: typeof orig }[] = []
      for (const g of group) {
        const f = live.find((x) => x.id === g.id)
        if (!f) continue
        const after = { x: f.x, y: f.y, width: f.width, height: f.height }
        trackSave(api.updateFrame(f.id, after).catch(console.error))
        updates.push({ frameId: f.id, before: g.orig, after })
      }
      const [only, ...more] = updates
      if (only && !more.length) recordUpdate(only.frameId, only.before, only.after)
      else recordUpdates(updates)
      /* a click (no drag) on the frame surface targets the element under
         the cursor: probe it and show the element toolbar */
      if (!moved && probeOnClick) {
        const mode = useStore.getState()
        if (followLink && !mode.laser) followLinkAt(off.x, off.y)
        else if (mode.laser) {
          iframeRef.current?.contentWindow?.postMessage({ type: 'doop:laser-click', x: off.x, y: off.y }, '*')
        } else probeAt(off.x, off.y)
      } else if (moved) closePopovers()
      /* a click (no drag) on the frame name opens the details panel */
      if (!moved && panelOnClick) useStore.getState().setInspectorOpen(true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return { move: onMove, up: onUp }
  }

  const html = useThrottledValue(frame.html, 150)
  const remoteEditor = editors[0]

  /* The iframe loads a bootstrap once; HTML is posted in and DOM-morphed in
     place, so updates never white-flash the frame with a full reload. */
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const localHtml = useRef<string | null>(null)
  /* where the last right-click landed, in screen coordinates: Paste drops the
     frame there, and the menu's own box is not that point once Radix has
     flipped or shifted it away from a viewport edge */
  const menuAt = useRef({ x: 0, y: 0 })
  const [runtimeReady, setRuntimeReady] = useState(false)
  /* a replaced asset remounts the iframe (see `key` below): the fresh document must announce itself again and be sent the HTML again. A remount drops the document's edit mode, path editor and any grip drag with their unsaved work, so a reload that arrives meanwhile waits until they end */
  const reload = useStore((s) => s.frameReloads[frame.id] ?? 0)
  const [appliedReload, setAppliedReload] = useState(reload)
  if (appliedReload !== reload && !editing && !pathEdit && !resizing) {
    setAppliedReload(reload)
    setRuntimeReady(false)
  }
  useEffect(() => {
    localHtml.current = null
  }, [appliedReload])
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.data?.type === 'doop:frame-ready' && ev.source === iframeRef.current?.contentWindow) {
        setRuntimeReady(true)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  /* once the runtime answers, the element panel may talk to this document */
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!runtimeReady || !win) return
    registerFrameWindow(frame.id, win)
    return () => unregisterFrameWindow(frame.id, win)
  }, [runtimeReady, frame.id])
  useEffect(() => {
    if (!runtimeReady || editing || suspendPost || html !== frame.html || html === localHtml.current) return
    localHtml.current = null
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [runtimeReady, html, frame.html, editing, suspendPost])

  /* laser mode lives in the frame's runtime; a frame that mounts or becomes ready while it is on joins in */
  useEffect(() => {
    if (!runtimeReady) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:laser', on: laser }, '*')
  }, [runtimeReady, laser])

  /* "Element path copied" flashes in the title chrome after a laser click */
  const [pathNote, setPathNote] = useState<string | null>(null)
  const pathNoteTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (pathNoteTimer.current) window.clearTimeout(pathNoteTimer.current)
    },
    [],
  )
  function flashPathNote(text: string) {
    setPathNote(text)
    if (pathNoteTimer.current) window.clearTimeout(pathNoteTimer.current)
    pathNoteTimer.current = window.setTimeout(() => setPathNote(null), 1800)
  }

  /* ---- element comments ---- */
  const frameComments = useStore((s) => s.comments).filter((c) => c.frameId === frame.id)
  /* only thread roots get a pin; replies live inside the root's popover */
  const comments = frameComments.filter((c) => !c.parentId && !c.resolvedAt)
  /* frames at rest pause their animations (lib/frameSleep.ts); one being edited, by anyone, or worked by an agent stays awake */
  const setHovered = useFrameSleep(iframeRef, {
    frame,
    ready: runtimeReady,
    editing: editing || editors.length > 0,
    working: frameComments.some((c) => c.forAgent && !c.resolvedAt && !!c.claimedBy && !c.failedAt),
  })
  const [probe, setProbe] = useState<ProbeHit | null>(null)
  /* element selected for text editing inside the iframe (edit mode only) */
  const [activeHit, setActiveHit] = useState<ProbeHit | null>(null)
  const [composing, setComposing] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [linkedThread, setLinkedThread] = useState<string | null>(deepLinkedThread)
  const [pinPos, setPinPos] = useState<Record<string, PinSpot>>({})
  /* selectors already reported to the server, so a pin heals once per path */
  const healed = useRef(new Set<string>())
  const probeReq = useRef(0)
  const probeTimer = useRef<number | null>(null)
  /* what the pending probe is for: the element toolbar, or (Comment tool) a
     composer opened straight away on the hit */
  const probeIntent = useRef<'toolbar' | 'comment'>('toolbar')
  const activeSelRef = useRef<string | null>(null)

  /* ---- hover inspection (paper.design-style element outlines) ---- */
  const [hover, setHover] = useState<HoverHit | null>(null)
  const hoverReq = useRef(0)
  const hoverKey = useRef<string | null>(null)

  const hoverLast = useRef(0)
  function sendHover(x: number, y: number) {
    /* pointermove fires every frame — one probe per ~40ms is plenty */
    const now = Date.now()
    if (now - hoverLast.current < 40) return
    hoverLast.current = now
    if (useStore.getState().laser) {
      /* laser: the runtime draws the hover itself, nothing comes back */
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:laser-move', x, y }, '*')
      return
    }
    hoverReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:hover', reqId: hoverReq.current, x, y }, '*')
  }

  function clearHover() {
    hoverReq.current += 1 // drop any in-flight result
    hoverKey.current = null
    setHover(null)
  }

  /* a Layers row under the pointer outlines its element here, the same as a
     hover over the frame: ask the runtime where the element is, and draw the
     answer (the `doop:located` reply below) as the hover outline. A string
     selector keeps the selection identity-stable, so memo holds. */
  const layerHover = useStore((s) => (s.hoveredLayer?.frameId === frame.id ? s.hoveredLayer.selector : null))
  const [seenLayerHover, setSeenLayerHover] = useState(layerHover)
  if (seenLayerHover !== layerHover) {
    setSeenLayerHover(layerHover)
    /* the row was left: its outline goes (the drawn layer outline already
       reset the canvas hover's dedup key, so the next pointer hover draws) */
    if (!layerHover) setHover(null)
  }

  /* source view + composer prefill for the element toolbar */
  const [codeView, setCodeView] = useState<string | null>(null)
  const [composePrefill, setComposePrefill] = useState('')
  const codeReq = useRef(0)

  function requestCode(selector: string) {
    codeReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:code', reqId: codeReq.current, selector }, '*')
  }

  /* everything hanging off the picked element except the pick itself */
  function closeElementPopovers() {
    if (probeTimer.current) {
      window.clearTimeout(probeTimer.current)
      probeTimer.current = null
    }
    setComposing(false)
    setComposePrefill('')
    setCodeView(null)
    setOpenThread(null)
  }

  function closePopovers() {
    closeElementPopovers()
    setProbe(null)
  }

  /* delayed slightly so the second click of a double-click (→ edit mode)
     cancels it instead of flashing the toolbar; a comment click has no
     double-click to wait out, so it probes at once */
  function probeAt(x: number, y: number, intent: 'toolbar' | 'comment' = 'toolbar') {
    if (!frame.html || editing) return
    /* the current pick stays until the probe answers: clearing it here would
       close the element panel and reopen it a beat later on the next
       element. A probe that hits nothing clears it then. */
    closeElementPopovers()
    probeIntent.current = intent
    probeTimer.current = window.setTimeout(
      () => {
        probeTimer.current = null
        probeReq.current += 1
        iframeRef.current?.contentWindow?.postMessage({ type: 'doop:probe', reqId: probeReq.current, x, y }, '*')
      },
      intent === 'comment' ? 0 : 250,
    )
  }

  /* ⌥-click: ask the document what link sits under the pointer; the answer flies the camera to its frame */
  const gotoReq = useRef(0)
  function followLinkAt(x: number, y: number) {
    if (!frame.html || editing) return
    gotoReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:goto-at', reqId: gotoReq.current, x, y }, '*')
  }

  /* keep comment pins glued to their elements: re-locate whenever the frame's
     html or the comment set changes */
  const commentKey = comments.map((c) => c.id).join(',')
  useEffect(() => {
    if (!runtimeReady) return
    for (const c of comments) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'doop:locate', reqId: c.id, selector: c.selector, anchor: c.anchor },
        '*',
      )
    }
  }, [runtimeReady, html, commentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* the selection outline follows its element across html updates (streams,
     agent edits) the same way pins do */
  const probeSel = probe?.selector ?? null
  useEffect(() => {
    if (!runtimeReady || !probeSel) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:locate', reqId: '__probe__', selector: probeSel }, '*')
  }, [runtimeReady, html, probeSel])
  useEffect(() => {
    if (!runtimeReady || !layerHover) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'doop:locate', reqId: '__layer-hover__', selector: layerHover },
      '*',
    )
  }, [runtimeReady, html, layerHover])

  /* deselecting the frame drops its element selection too, so a stale
     outline never reappears when the frame is picked again */
  const [wasSelected, setWasSelected] = useState(selected)
  if (wasSelected !== selected) {
    setWasSelected(selected)
    if (!selected) setProbe(null)
    else if (linkedThread) {
      /* the emailed thread, now that selection will not close it again */
      setOpenThread(linkedThread)
      setLinkedThread(null)
    }
  }

  /* the Comments panel asked for one of this frame's pins to open: the
     request is consumed once the thread is up, so a remount (a page switch
     back) never reopens it */
  const threadRequest = useStore((s) => s.threadRequest)
  const requestedThread = threadRequest && comments.some((c) => c.id === threadRequest.id) ? threadRequest : null
  const [seenThreadRequest, setSeenThreadRequest] = useState<typeof requestedThread>(null)
  if (requestedThread !== seenThreadRequest) {
    setSeenThreadRequest(requestedThread)
    if (requestedThread) {
      setProbe(null)
      setComposing(false)
      setOpenThread(requestedThread.id)
    }
  }
  useEffect(() => {
    if (requestedThread) useStore.getState().clearThreadRequest()
  }, [requestedThread])

  /* the outlined element is shared with the Layers panel through the store:
     what is probed here is picked (which also opens its properties panel,
     the same as a click on its Layers row), and a row picked there is
     resolved into a probe by asking the runtime for the element behind the
     selector */
  const previousProbe = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousProbe.current
    previousProbe.current = probeSel
    const cur = useStore.getState().selectedElement
    if (probeSel) {
      const el = { frameId: frame.id, selector: probeSel }
      /* the Comment tool outlines the element without sliding its properties panel in */
      if (useStore.getState().tool === 'comment') useStore.getState().setSelectedElement(el)
      else useStore.getState().pickElement(el)
    } else if (previous && cur?.frameId === frame.id && cur.selector === previous) {
      /* Only clear a probe we actually removed. A link or Layers pick can
         select an element before this frame has mounted its runtime. */
      useStore.getState().pickElement(null)
    }
  }, [probeSel, frame.id])
  const wantedSel = useStore((s) => (s.selectedElement?.frameId === frame.id ? s.selectedElement.selector : null))
  const [seenWantedSel, setSeenWantedSel] = useState(wantedSel)
  if (seenWantedSel !== wantedSel) {
    setSeenWantedSel(wantedSel)
    /* Returning to a frame-only link (or closing the element panel) also
       removes the previous element's toolbar and outline. */
    if (!wantedSel) setProbe(null)
  }
  const selectReq = useRef(0)
  const selectSel = useRef<string | null>(null)
  useEffect(() => {
    // A new drawing can be selected before throttled HTML reaches the iframe.
    // Wait for that document before asking it to locate the new layer.
    if (!runtimeReady || !wantedSel || wantedSel === probeSel || html !== frame.html) return
    /* a surface click clears the probe, and the effect above has just cleared
       the store to match — but this render still carries the old selector.
       Re-selecting it here would resurrect the previous element and (via the
       select-result's closePopovers) cancel the pending click probe, so only
       a selection that is still live in the store (a Layers row pick) is
       resolved into a probe. A request already in flight for the old
       selector is dropped for the same reason. */
    const live = useStore.getState().selectedElement
    selectReq.current += 1
    if (live?.frameId !== frame.id || live.selector !== wantedSel) return
    selectSel.current = wantedSel
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'doop:select', reqId: selectReq.current, selector: wantedSel },
      '*',
    )
  }, [runtimeReady, wantedSel, probeSel, frame.id, html, frame.html])

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:goto-result' && ev.data.reqId === gotoReq.current) {
        const target: unknown = ev.data.target
        const canvas = useStore.getState().canvas
        if (typeof target !== 'string' || !canvas) {
          flashPathNote('No link here. Links are elements with data-goto.')
          return
        }
        const to = resolveGoto(canvas, target)
        if (!to) {
          flashPathNote(`No frame matches “${target}”`)
          return
        }
        useStore.getState().select(to.id)
        useStore.getState().requestFlyTo(to.id)
        return
      }
      if (ev.data?.type === 'doop:probe-result' && ev.data.reqId === probeReq.current) {
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        setProbe(hit)
        /* the Comment tool skips the element toolbar: the composer opens on
           the hit, the same one the toolbar's own Comment button opens */
        if (hit && probeIntent.current === 'comment') {
          setComposePrefill('')
          setComposing(true)
        }
      }
      if (ev.data?.type === 'doop:laser-copy' && typeof ev.data.selector === 'string') {
        /* the frame may have been renamed since this listener was set up, so the name is read fresh */
        const name = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.name ?? 'Frame'
        navigator.clipboard
          .writeText(`${name} · ${ev.data.selector}`)
          .then(() => flashPathNote('Element path copied'))
          .catch(() => flashPathNote('Couldn’t copy the path'))
      }
      /* Esc with focus inside the frame never reaches the window as a key event */
      if (ev.data?.type === 'doop:esc') {
        const s = useStore.getState()
        if (s.laser) s.setLaser(false)
        else if (s.tool !== 'select') s.setTool('select')
      }
      if (ev.data?.type === 'doop:select-result' && ev.data.reqId === selectReq.current) {
        /* the answer is only acted on while the asked-for element is still
           the live selection — a surface click in the meantime has moved on */
        const live = useStore.getState().selectedElement
        if (live?.frameId !== frame.id || live.selector !== selectSel.current) return
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        closePopovers()
        if (hit) setProbe(hit)
        else {
          /* The live document is authoritative for linked elements and
             Layers picks, including nodes created or removed by scripts. */
          const s = useStore.getState()
          s.pickElement(null)
          s.setInspectorOpen(true)
          s.pushNotice('This element no longer exists. Showing its frame instead.')
        }
      }
      if (ev.data?.type === 'doop:hover-result' && ev.data.reqId === hoverReq.current) {
        const hit = (ev.data.hit ?? null) as HoverHit | null
        /* only re-render when the outlined element actually changes */
        const key = hit ? hit.tag + JSON.stringify(hit.rect) : null
        if (key !== hoverKey.current) {
          hoverKey.current = key
          setHover(hit)
        }
      }
      if (ev.data?.type === 'doop:active') {
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        /* rect refreshes for the same element keep the composer open;
           switching elements (or deselecting) closes it */
        if ((hit?.selector ?? null) !== activeSelRef.current) setComposing(false)
        activeSelRef.current = hit?.selector ?? null
        setActiveHit(hit)
      }
      if (ev.data?.type === 'doop:code-result' && ev.data.reqId === codeReq.current) {
        setCodeView(typeof ev.data.html === 'string' ? ev.data.html : null)
      }
      if (ev.data?.type === 'doop:located' && typeof ev.data.reqId === 'string') {
        if (ev.data.reqId === '__layer-hover__') {
          /* the pointer may have left the row while the runtime looked: a late
             reply must not paint an outline nobody is hovering */
          const hovered = useStore.getState().hoveredLayer
          if (!hovered || hovered.frameId !== frame.id) return
          const rect = ev.data.rect as HoverHit['rect'] | null
          const selector = hovered.selector
          /* the tag of the selector's last step: "section:nth-of-type(2)" → "section" */
          const tag = (selector.split('>').at(-1) ?? '').trim().split(/[:.#[]/)[0] ?? ''
          hoverKey.current = null
          setHover(rect ? { tag, rect } : null)
          return
        }
        if (ev.data.reqId === '__probe__') {
          /* Refresh both the outline and handle eligibility after style edits. */
          const rect = ev.data.rect as ProbeHit['rect'] | null
          setProbe((p) => {
            if (!p || p.selector !== ev.data.selector) return p
            return rect ? { ...p, rect, sizable: ev.data.sizable === true } : null
          })
          return
        }
        const rect = ev.data.rect as { x: number; y: number; width: number; height: number } | null
        const id = ev.data.reqId as string
        const comment = useStore.getState().comments.find((c) => c.id === id)
        const a = comment?.anchor
        /* an anchored pin sits where it was clicked inside the element; older
           comments keep the element's top-right corner */
        const spot: PinSpot = !rect
          ? 'orphan'
          : a
            ? { x: rect.x + a.fx * rect.width, y: rect.y + a.fy * rect.height }
            : { x: rect.x + rect.width, y: rect.y }
        setPinPos((m) => ({ ...m, [id]: spot }))
        /* found by a fallback: tell the server the new path so the next load is a direct hit */
        const how = ev.data.how as string | null
        const path = ev.data.path as string | null
        /* healing rewrites the stored pin: it takes an account that may comment (guests and viewers just resolve it locally) */
        const mayHeal = canCommentNow() && !useStore.getState().guest
        if (mayHeal && comment && rect && how && how !== 'path' && path && path !== comment.selector) {
          const key = `${id}|${path}`
          if (!healed.current.has(key)) {
            healed.current.add(key)
            api.healCommentAnchor(id, path).catch(() => healed.current.delete(key))
          }
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frame.id])

  /* Esc dismisses popovers (edit mode has its own Esc path inside the iframe) */
  useEffect(() => {
    if (!probe && !openThread) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePopovers()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [probe, openThread])

  useEffect(() => {
    if (!selected) {
      closePopovers()
      const s = useStore.getState()
      if (s.ctxMenu?.frameId === frame.id) s.closeCtxMenu()
    }
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- inline text editing ---- */
  const canEdit = mayEdit && !!frame.html && !stream && !frame.locked && !/<script/i.test(frame.html)

  async function enterElementEdit(where: Record<string, unknown>) {
    if (!mayEdit || !frame.html || stream || frame.locked || editing || pathEdit || !runtimeReady) return
    if (useStore.getState().tool !== 'select') return
    const request = ++editRequest.current
    const canvasId = useStore.getState().canvas?.id
    const pageId = useStore.getState().activePageId
    const path = await loadPathEdit(frame, where)
    const state = useStore.getState()
    const live = state.canvas?.frames.find((f) => f.id === frame.id)
    if (
      request !== editRequest.current ||
      state.canvas?.id !== canvasId ||
      state.activePageId !== pageId ||
      state.tool !== 'select' ||
      !state.selectedIds.includes(frame.id) ||
      live?.html !== frame.html ||
      live.locked ||
      live.hidden
    )
      return
    if (path) {
      select(frame.id)
      closePopovers()
      clearHover()
      setPathEdit(path)
    } else if (canEdit) enterEdit()
  }

  function enterEdit() {
    select(frame.id)
    closePopovers()
    clearHover()
    setEditing(true)
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: true }, '*')
  }
  function exitEdit() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: false }, '*')
    setEditing(false)
    setActiveHit(null)
    setComposing(false)
    activeSelRef.current = null
    setSuspendPost(true)
    window.setTimeout(() => setSuspendPost(false), 500)
  }

  /* switching to Hand or Comment ends a text-edit session: both put the
     shield back over the document, and a comment click has to probe the
     frame, which an open edit blocks. The iframe is told to leave edit mode
     too, so this is a sync with it rather than a state reset. */
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- exitEdit syncs the iframe's edit mode
    if (editing && tool !== 'select') exitEdit()
  }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

  /* serialized edits stream out of the iframe; save through the human path */
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:edited' && typeof ev.data.html === 'string') {
        // The runtime already has this document. Echoing it through the HTML
        // throttle can overwrite a newer style edit still waiting to save.
        localHtml.current = ev.data.html
        const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
        useStore.getState().patchFrameLocal(frame.id, { html: ev.data.html })
        trackSave(api.updateFrame(frame.id, { html: ev.data.html }).catch(console.error))
        if (before !== undefined)
          recordUpdate(frame.id, { html: before }, { html: ev.data.html }, ev.data.discrete === true)
      }
      if (ev.data?.type === 'doop:edit-esc') {
        setEditing(false)
        setSuspendPost(true)
        window.setTimeout(() => setSuspendPost(false), 500)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frame.id])

  /* deselecting the frame ends the edit session. Selection lives in the
     store and the iframe has to be told, so this is a sync with an external
     system rather than derived state. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (!selected && editing) exitEdit()
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  /* so does a lock arriving from a collaborator (or an agent) mid-session:
     what was typed so far is flushed by the exit, nothing more lands */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external-system sync, as above
    if (frame.locked && editing) exitEdit()
  }, [frame.locked]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const store = useStore.getState()
        if (!open) return store.closeCtxMenu()
        /* deferPanel: when this right-click is what selects the frame, the
           Inspector waits until the menu closes — it must not slide in
           underneath the menu the user just opened */
        const alreadySelected = store.selectedIds.includes(frame.id)
        /* a right-click inside a group keeps the group, so Delete takes all */
        if (!alreadySelected) select(frame.id)
        closePopovers()
        store.openCtxMenu({ frameId: frame.id, deferPanel: !alreadySelected })
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          /* the Stage reads this: a press on a locked frame is a press on the canvas */
          data-frame-locked={frame.locked ? '' : undefined}
          className={cn(
            'group absolute',
            stream &&
              "before:pointer-events-none before:absolute before:-inset-[3px] before:border-2 before:border-dashed before:border-[var(--editing-color,var(--brand))] before:content-[''] before:animate-[stream-pulse_1.1s_ease-in-out_infinite]",
          )}
          style={
            {
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              '--editing-color': stream?.color ?? remoteEditor?.color ?? flash?.color,
            } as React.CSSProperties
          }
          /* stop the event here so the Stage's background menu — whose trigger
         wraps this one — does not open a second menu behind ours */
          onContextMenu={(e) => {
            /* stop here so the Stage's background trigger, which wraps this
               one, does not open a second menu behind ours */
            e.stopPropagation()
            menuAt.current = { x: e.clientX, y: e.clientY }
          }}
        >
          {labelLayer &&
            createPortal(
              <div
                /* the Stage reads this off the press target, which a portal no
               longer nests inside the frame */
                data-frame-locked={frame.locked ? '' : undefined}
                className="pointer-events-auto absolute flex cursor-default select-none items-center gap-2 overflow-hidden whitespace-nowrap text-[12px] font-semibold text-ink-soft"
                /* screen px, from the camera the Stage publishes: the name sits a
               fixed gap above the frame's top-left corner and never runs past
               its right edge, whatever the zoom */
                style={{
                  left: `calc(var(--vx, 0px) + ${frame.x}px * var(--zoom, 1))`,
                  top: `calc(var(--vy, 0px) + ${frame.y}px * var(--zoom, 1))`,
                  width: `calc(${frame.width}px * var(--zoom, 1))`,
                  transform: `translateY(calc(-100% - ${LABEL_GAP}px))`,
                  cursor: duping || dupKeyHeld ? DUP_CURSOR : undefined,
                }}
                onPointerDown={(e) => startDrag(e, 'move', false, true)}
              >
                {frame.locked && (
                  <Tooltip label="Locked — unlock it from the Layers panel or the Inspector" side="top" align="start">
                    <span className="flex shrink-0 items-center text-ink-faint">
                      <LockIcon width={11} height={11} />
                    </span>
                  </Tooltip>
                )}
                {isSyncedFrame(frame.html) && (
                  <Tooltip label="Synced from a live app" side="top" align="start">
                    <span className="flex shrink-0 items-center text-brand">
                      <SyncIcon width={11} height={11} />
                    </span>
                  </Tooltip>
                )}
                {isGithubFrame(frame.html) && (
                  <Tooltip
                    label={
                      isGithubPlaceholder(frame.html)
                        ? 'Found in the repo — awaiting capture'
                        : 'Imported from a GitHub repo'
                    }
                    side="top"
                    align="start"
                  >
                    <span
                      className={cn(
                        'flex shrink-0 items-center',
                        isGithubPlaceholder(frame.html) ? 'text-ink-faint' : 'text-brand',
                      )}
                    >
                      <GithubIcon width={11} height={11} />
                    </span>
                  </Tooltip>
                )}
                <MarkDot mark={mark} />
                <span className="overflow-hidden text-ellipsis">{frame.name}</span>
                {frame.slide && (
                  <Tooltip
                    label="A slide: plays with the other slides on this page in present mode"
                    side="top"
                    align="start"
                  >
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-ink px-1.5 py-px text-[10px] font-bold text-paper">
                      <SlideIcon width={10} height={10} aria-hidden />
                      Slide
                    </span>
                  </Tooltip>
                )}
                {soleSelected && !editing && !dragging && !presenting && (
                  <Button
                    variant="default"
                    size="pill"
                    className="gap-1 text-ink-soft hover:text-ink"
                    title={`Export this frame as PNG or JPG (${EXPORT_SHORTCUT})`}
                    aria-label={`Export ${frame.name}`}
                    /* a press here is a button press, not the start of a frame drag */
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => useStore.getState().openExport([frame.id])}
                  >
                    <DownloadIcon width={10} height={10} strokeWidth={2.2} aria-hidden />
                    Export
                  </Button>
                )}
                {pathNote && (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1 rounded-full bg-ink px-[7px] py-0.5 text-[10px] font-bold text-paper animate-[chip-in_0.25s_ease]"
                  >
                    {pathNote}
                  </span>
                )}
                <span className="flex gap-1">
                  {stream && (
                    <span className={EDITOR_CHIP} style={{ background: stream.color }}>
                      <AgentIcon name={stream.name} size={9} color="#fff" />
                      {stream.name} is designing
                      <span className="after:content-['…'] after:[animation:ellipsis_1.2s_steps(4)_infinite]" />
                    </span>
                  )}
                  {editors
                    .filter((p) => p.name !== stream?.name)
                    .map((p) => (
                      <span key={p.clientId} className={EDITOR_CHIP} style={{ background: p.color }}>
                        {p.kind === 'agent' ? <AgentIcon name={p.name} size={9} color="#fff" /> : '✎'} {p.name}
                      </span>
                    ))}
                </span>
              </div>,
              labelLayer,
            )}

          <div
            className={cn(
              'absolute inset-0 overflow-hidden',
              /* frames far outside the view are not rendered at all, so a large canvas keeps a bounded set of live iframe layers and tiles however far out it is zoomed */
              '[content-visibility:auto]',
              /* a frame whose document is still on its way is a quiet placeholder, not a stark white box */
              isCanvasElement(frame.html)
                ? 'bg-transparent'
                : cn('border border-line', frame.html && !runtimeReady ? 'bg-paper-deep' : 'bg-white'),
              /* Select keeps the arrow, like Figma: the frame is a thing to
                 point at, not a handle. The Hand tool's grab and the Comment
                 tool's bubble come from the Stage, which overrides every
                 cursor under it. */
              'cursor-default',
              !isCanvasElement(frame.html) && (dragging ? 'shadow-pop' : 'shadow-card'),
              selected && !pathEdit && 'outline-2 outline-offset-1 outline-brand',
              editing && 'cursor-text outline-2 outline-offset-1 outline-dashed outline-brand',
              !stream &&
                remoteEditor &&
                'outline-2 outline-offset-1 outline-solid outline-[var(--editing-color,var(--brand))]',
              stream && 'border-transparent outline-none',
            )}
            style={
              duping || (dupKeyHeld && !editing) ? { cursor: DUP_CURSOR } : laser ? { cursor: 'crosshair' } : undefined
            }
            onPointerDown={(e) => startDrag(e, 'move', true)}
            onDoubleClick={(e) => {
              void enterElementEdit(designPoint(e, e.currentTarget))
            }}
            onPointerMove={(e) => {
              /* the Hand only pans, and a locked frame has nothing to pick: no
                 element outlines in either case */
              if (
                editing ||
                pathEdit ||
                dragging ||
                resizing ||
                frame.locked ||
                !frame.html ||
                !runtimeReady ||
                tool === 'hand'
              )
                return
              const at = designPoint(e, e.currentTarget)
              sendHover(at.x, at.y)
            }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => {
              clearHover()
              setHovered(false)
              if (laser)
                iframeRef.current?.contentWindow?.postMessage({ type: 'doop:laser-move', x: null, y: null }, '*')
            }}
          >
            {mounted && (
              <iframe
                key={appliedReload}
                ref={iframeRef}
                className={cn(
                  'block border-none',
                  isCanvasElement(frame.html) ? 'bg-transparent' : 'bg-white',
                  /* fade the document in once its runtime answers, so a frame mounting into view never pops */
                  runtimeReady ? 'opacity-100 transition-opacity duration-150' : 'opacity-0',
                )}
                title={frame.name}
                data-doop-frame=""
                sandbox="allow-scripts"
                srcDoc={FRAME_BOOTSTRAP}
                style={{ width: frame.width, height: frame.height }}
              />
            )}
            {!frame.html && (
              <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,transparent_0_10px,rgba(28,26,21,0.025)_10px_20px)] text-[13px] text-ink-faint">
                empty frame — add HTML
              </div>
            )}
            {/* shield keeps pointer events on the canvas, not the iframe;
            lifted while editing so clicks land in the editable document */}
            {(!editing || panMode || laser || tool !== 'select') && <div className="absolute inset-0" />}
            {/* above the selection outline (z-[3]), or that outline covers the
            hovered element's tag */}
            {hover && !editing && !pathEdit && !dragging && !resizing && !laser && (
              <div
                className="pointer-events-none absolute z-[4] bg-[rgba(60,130,246,0.06)] shadow-[inset_0_0_0_calc(1px/var(--zoom,1))_#3c82f6]"
                style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.width, height: hover.rect.height }}
              >
                <span
                  className={cn(
                    'absolute top-0 left-0 whitespace-nowrap bg-[#3c82f6] px-1.5 py-[3px] text-[10px] font-bold leading-none text-white [font-family:ui-monospace,monospace]',
                    hover.rect.y < 18
                      ? 'origin-top-left rounded-[0_0_4px_0] [transform:translateY(0)_scale(min(calc(1/var(--zoom,1)),2.4))]'
                      : 'origin-bottom-left rounded-[4px_4px_4px_0] [transform:translateY(-100%)_scale(min(calc(1/var(--zoom,1)),2.4))]',
                  )}
                >
                  {hover.tag}
                </span>
              </div>
            )}
            {probe && selected && !editing && !pathEdit && !dragging && (
              <div
                /* a one-pixel hairline, the way Paper outlines a selection */
                className="pointer-events-none absolute z-[3] shadow-[inset_0_0_0_calc(1px/var(--zoom,1))_#3c82f6]"
                style={{ left: probe.rect.x, top: probe.rect.y, width: probe.rect.width, height: probe.rect.height }}
              />
            )}
            {/* the grips: only where a drag can change the box, and never on
                a locked layer or frame, or under the Comment tool */}
            {probe &&
              selected &&
              !editing &&
              !pathEdit &&
              !dragging &&
              tool === 'select' &&
              probe.sizable &&
              !probe.locked &&
              !frame.locked && (
                <ElementResizeHandles
                  frame={frame}
                  selector={probe.selector}
                  rect={probe.rect}
                  onRect={(rect) => setProbe((p) => (p && p.selector === probe.selector ? { ...p, rect } : p))}
                  onResizing={(on) => {
                    if (on) clearHover()
                    setResizing(on)
                  }}
                />
              )}
            {flash && (
              <div
                className="pointer-events-none absolute -inset-px animate-[frame-flash_1.2s_ease-out_forwards]"
                style={{ '--editing-color': flash.color } as React.CSSProperties}
              />
            )}
          </div>

          {editing && (
            <div
              className={cn(
                'absolute top-[calc(100%_+_10px)] left-0 flex origin-top-left items-center gap-[9px] whitespace-nowrap rounded-full bg-ink py-1 pr-[5px] pl-3 text-[11px] font-semibold text-paper shadow-card animate-[chip-in_0.25s_ease]',
                COUNTER_SCALE,
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Click any text to edit
              <Button
                variant="primary"
                size="pill"
                className="border-transparent px-2.5 shadow-none hover:translate-x-0 hover:translate-y-0 hover:brightness-110 hover:shadow-none"
                onClick={exitEdit}
                title="Save and finish editing (Esc)"
              >
                ✓ Done
              </Button>
            </div>
          )}

          {/* element comments: pins + element toolbar + composer, all in frame
          coords. The toolbar anchors to the probed element normally, and to
          the actively edited element in edit mode. `data-comment-ui`: the
          Comment tool's cursor is forced over the whole stage except inside
          the comment UI, which keeps its own cursors. */}
          {(() => {
            const anchor = editing ? activeHit : probe
            return (
              <div data-comment-ui className="pointer-events-none absolute inset-0">
                {comments.map((c) => {
                  const spot = pinPos[c.id]
                  if (!spot) return null
                  const orphan = spot === 'orphan'
                  /* orphans stack down the frame's top-right edge in thread order */
                  const orphanIndex = orphan ? comments.filter((o) => pinPos[o.id] === 'orphan').indexOf(c) : 0
                  const open = openThread === c.id
                  const replies = frameComments.filter((r) => r.parentId === c.id).reverse() // store is newest-first
                  const thread: [ElementComment, ...ElementComment[]] = [c, ...replies.sort((a, b) => a.at - b.at)]
                  return (
                    <CommentPin
                      key={c.id}
                      thread={thread}
                      open={open}
                      left={
                        orphan
                          ? `calc(${frame.width}px - 16px * ${PIN_SCALE})`
                          : Math.min(Math.max(spot.x, 10), frame.width - 10)
                      }
                      top={
                        orphan
                          ? `calc(16px * ${PIN_SCALE} + ${orphanIndex} * 32px * ${PIN_SCALE})`
                          : Math.min(Math.max(spot.y, 10), frame.height - 10)
                      }
                      orphan={orphan}
                      mentioned={c.id in pulses}
                      onToggle={() => {
                        setProbe(null)
                        setComposing(false)
                        setOpenThread(open ? null : c.id)
                        useStore.getState().clearPulse(c.id)
                      }}
                    >
                      <CommentThread
                        thread={thread}
                        alignEnd={orphan}
                        canvasId={frame.canvasId}
                        canReply={mayComment}
                        canResolve={mayComment && !guest}
                        canRetry={mayEdit}
                        onReply={(text, mentions) =>
                          postReply(c.id, text, mentions)
                            .then(() => posthog.capture('element_comment_replied'))
                            .catch((err) => {
                              /* the wall explains a hit limit; anything else
                                 surfaces in the thread so the draft survives */
                              if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                              throw err
                            })
                        }
                        onResolve={() => {
                          api
                            .resolveComment(c.id)
                            .then(() => posthog.capture('element_comment_resolved'))
                            .catch(console.error)
                          setOpenThread(null)
                        }}
                        onRetry={(id) =>
                          api.retryComment(id).catch((err) => {
                            if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                            else console.error(err)
                          })
                        }
                      />
                    </CommentPin>
                  )
                })}

                {anchor && selected && (
                  <div
                    className={cn('pointer-events-auto absolute z-[7] origin-top-left', POPOVER_SCALE)}
                    style={{
                      left: Math.min(Math.max(anchor.rect.x, 4), Math.max(4, frame.width - 60)),
                      top: Math.max(anchor.rect.y, 2),
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {!composing ? (
                      <>
                        <div className="flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-ink px-[7px] py-[5px] shadow-pop animate-[chip-in_0.18s_ease]">
                          <span className="rounded-[5px] bg-paper/[0.14] px-[5px] py-px text-[11px] font-bold text-paper [font-family:ui-monospace,monospace]">
                            {anchor.tag}
                          </span>
                          {mayComment && (
                            <Button
                              variant="inverse"
                              className={EL_TOOLBAR_BTN}
                              onClick={() => {
                                setComposePrefill('')
                                setComposing(true)
                              }}
                            >
                              💬 Comment
                            </Button>
                          )}
                          {mayEdit && (
                            <Button
                              variant="inverse"
                              className={EL_TOOLBAR_BTN}
                              onClick={() => {
                                /* pre-mentioned → the comment dispatches as an agent
                             job scoped to this element's selector + snippet */
                                setComposePrefill(`@${DEFAULT_ROLE_ID} `)
                                setComposing(true)
                              }}
                            >
                              ✦ Ask AI
                            </Button>
                          )}
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            onClick={() => (codeView === null ? requestCode(anchor.selector) : setCodeView(null))}
                          >
                            {'</>'} Code
                          </Button>
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            aria-label="Copy link to element"
                            onClick={() => void copyElementLink(frame, anchor.selector)}
                          >
                            Copy link
                          </Button>
                          {!editing && canEdit && anchor.text !== '' && (
                            <Button
                              variant="inverse"
                              className={EL_TOOLBAR_BTN}
                              onClick={() => {
                                enterEdit()
                              }}
                            >
                              ✎ Edit text
                            </Button>
                          )}
                        </div>
                        {codeView !== null && <CodePanel key={anchor.selector} code={codeView} />}
                      </>
                    ) : (
                      <CommentComposer
                        canvasId={frame.canvasId}
                        initialText={composePrefill}
                        onSubmit={(text, mentions) => {
                          postComment(
                            frame.id,
                            { selector: anchor.selector, snippet: anchor.snippet, text, anchor: anchor.anchor },
                            mentions,
                          )
                            .then(() => posthog.capture('element_comment_created'))
                            .catch((err) => {
                              /* an @mention past the free tier raises the wall */
                              if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                              else console.error(err)
                            })
                          if (editing) setComposing(false)
                          else closePopovers()
                        }}
                        onCancel={() => (editing ? setComposing(false) : closePopovers())}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          {mayEdit && !frame.locked && !pathEdit && (
            <div
              className={cn(
                'absolute -right-[7px] -bottom-[7px] h-3.5 w-3.5 cursor-nwse-resize rounded-[4px] border-[1.5px] border-ink bg-surface opacity-0 [transition:opacity_0.12s] group-hover:opacity-100',
                selected && 'opacity-100',
              )}
              onPointerDown={(e) => startDrag(e, 'resize')}
            />
          )}
          {drawingMove.preview}
          {pathEdit && <PathEditor frame={frame} initial={pathEdit} onClose={closePathEdit} />}
        </div>
      </ContextMenuTrigger>
      <FrameContextMenu frame={frame} at={menuAt} />
    </ContextMenu>
  )
})
