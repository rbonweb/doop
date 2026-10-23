import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { usePageCanvas, currentPageCanvas } from '../lib/pages'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { FrameView } from './FrameView'
import { StickyNote } from './StickyNote'
import { addNote } from '../lib/notes'
import { notePageId } from '../../shared/notes'
import { useFrameMountScheduler } from '../lib/frameMounting'
import { noteCameraMove, setStageSize } from '../lib/frameSleep'
import { FlowOverlay } from './FlowOverlay'
import { GhostFrames } from './GhostFrames'
import { Cursors } from './Cursors'
import { FollowFrame } from './FollowFrame'
import { cameraOnCursor, cameraToFollow } from '../lib/follow'
import { SnapGuides } from './SnapGuides'
import { MOD_KEY } from '../lib/keys'
import { MAX_ZOOM, MIN_ZOOM } from '../lib/fit'
import { cn } from '../lib/utils'
import { gesture } from '../lib/gesture'
import { hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { MenuHint } from './ui/menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarValue } from './ui/toolbar'

/* how long the camera must be still before the world layer is re-rasterized at its final scale */
const CAMERA_IDLE_MS = 150

const sendCursor = throttle((x: number, y: number) => sendWs({ type: 'cursor', x, y }), 50)
/* the camera is shared so others can follow it — same cadence as the cursor */
const sendViewport = throttle(
  (vp: { x: number; y: number; zoom: number }, el: HTMLElement) =>
    sendWs({
      type: 'viewport',
      viewport: {
        ...vp,
        pageId: useStore.getState().activePageId ?? undefined,
        width: el.clientWidth,
        height: el.clientHeight,
      },
    }),
  50,
)

/* the canvas says so while laser or comment mode is on, and how to leave it */
function ModePill() {
  const laser = useStore((s) => s.laser)
  const commentMode = useStore((s) => s.commentMode)
  if (!laser && !commentMode) return null
  const label = laser ? 'Laser' : 'Comment mode'
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-3 left-1/2 z-[35] flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink py-1.5 pr-3.5 pl-3 text-[12px] font-semibold text-paper shadow-pop animate-[chip-in_0.18s_ease]"
    >
      <span className="size-1.5 rounded-full bg-brand" aria-hidden />
      {label}
      <span className="font-normal text-paper/60">· Esc to exit</span>
    </div>
  )
}

export function Stage({ onAddFrame }: { onAddFrame: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const setViewport = useStore((s) => s.setViewport)
  const canvas = usePageCanvas()
  const activePageId = useStore((s) => s.activePageId)
  /* sticky notes: the full canvas decides which page an attached note is on */
  const fullCanvas = useStore((s) => s.canvas)
  const notesVisible = useStore((s) => s.notesVisible)
  const pageNotes = useMemo(
    () => (fullCanvas?.notes ?? []).filter((n) => notePageId(fullCanvas!, n) === activePageId),
    [fullCanvas, activePageId],
  )
  const select = useStore((s) => s.select)
  const panMode = useStore((s) => s.panMode)
  const [panning, setPanning] = useState(false)
  /* the selection rectangle being dragged out, in world coordinates */
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  /* where the background menu opened, so Paste drops the frame there */
  const bgAt = useRef({ x: 0, y: 0 })
  /* frame iframes mount progressively, near the viewport first (lib/frameMounting.ts) */
  useFrameMountScheduler(ref)
  const fitted = useRef(false)
  const deepLinkHandled = useRef(false)
  const focusedPage = useRef<string | null>(null)

  /* the shortcuts (fit, zoom) measure against the stage, which lives here */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const publish = () => useStore.getState().setStageSize({ width: el.clientWidth, height: el.clientHeight })
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      ro.disconnect()
      useStore.getState().setStageSize(null)
    }
  }, [])

  /* Viewport → DOM without React: no component subscribes to the viewport, so
     pan/zoom never renders anything. A store subscription writes the world
     transform, the grid layer, the --zoom variable (which counter-scales
     labels/pins/cursors from CSS), and the toolbar % directly.

     The world layer is promoted to its own compositor layer only while the
     camera moves (will-change: transform), so a zoom is a pure GPU scale of
     the last bitmap. Once the camera has been still for a moment the hint is
     dropped and the browser rasterizes every frame again at the final scale:
     crisp at any zoom, with no iframe resize or relayout, so nothing reflows
     or flickers. */
  useLayoutEffect(() => {
    function apply(vp: { x: number; y: number; zoom: number }) {
      const world = worldRef.current
      const grid = gridRef.current
      const stage = ref.current
      if (!world || !grid || !stage) return
      world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`
      stage.style.setProperty('--zoom', String(vp.zoom))
      const period = 26 * vp.zoom
      grid.style.backgroundSize = `${period}px ${period}px`
      const gx = (((vp.x % period) + period) % period) - period
      const gy = (((vp.y % period) + period) % period) - period
      grid.style.transform = `translate(${gx}px, ${gy}px)`
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(vp.zoom * 100)}%`
    }
    apply(useStore.getState().viewport)
    /* the size the frames judge "off screen" against */
    const stage = ref.current
    const publishSize = () => stage && setStageSize(stage.clientWidth, stage.clientHeight)
    publishSize()
    const sizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishSize)
    if (stage) sizeObserver?.observe(stage)
    let idle = 0
    const unsub = useStore.subscribe((s, prev) => {
      /* a (re)connect needs the camera announced afresh — the server only
         knows what this socket has sent */
      if (s.connected && !prev.connected && ref.current) sendViewport(s.viewport, ref.current)
      if (s.viewport === prev.viewport) return
      apply(s.viewport)
      /* frames pause their animations while the camera moves (lib/frameSleep.ts) */
      noteCameraMove()
      if (ref.current) sendViewport(s.viewport, ref.current)
      const world = worldRef.current
      if (!world) return
      world.style.willChange = 'transform'
      window.clearTimeout(idle)
      idle = window.setTimeout(() => {
        world.style.willChange = ''
      }, CAMERA_IDLE_MS)
    })
    return () => {
      unsub()
      sizeObserver?.disconnect()
      window.clearTimeout(idle)
    }
  }, [])

  /* following a peer: whenever their camera (or, lacking one, their cursor)
     moves, ease ours toward the same view. Writes go through
     setViewportFollowing so they don't count as "our own move" and end the
     follow — everything else that touches the camera does. */
  useEffect(() => {
    let raf = 0
    let target: { x: number; y: number; zoom: number } | null = null
    function step() {
      raf = 0
      const s = useStore.getState()
      if (!target || !s.following) return
      const vp = s.viewport
      const k = 0.35
      const next = {
        x: vp.x + (target.x - vp.x) * k,
        y: vp.y + (target.y - vp.y) * k,
        zoom: vp.zoom + (target.zoom - vp.zoom) * k,
      }
      const done =
        Math.abs(next.x - target.x) < 0.5 &&
        Math.abs(next.y - target.y) < 0.5 &&
        Math.abs(next.zoom - target.zoom) < 0.001
      s.setViewportFollowing(done ? target : next)
      if (!done) raf = requestAnimationFrame(step)
    }
    function retarget() {
      const el = ref.current
      const s = useStore.getState()
      if (!el || !s.following) return
      const leader = s.presences[s.following]
      const cursor = s.cursors[s.following]
      const stage = { width: el.clientWidth, height: el.clientHeight }
      if (leader?.viewport?.pageId && leader.viewport.pageId !== s.activePageId) {
        s.setActivePage(leader.viewport.pageId)
        useStore.setState({ following: s.following })
      }
      if (leader?.viewport) target = cameraToFollow(leader.viewport, stage)
      else if (cursor) target = cameraOnCursor(cursor, stage, s.viewport.zoom)
      else return
      if (!raf) raf = requestAnimationFrame(step)
    }
    const unsub = useStore.subscribe((s, prev) => {
      if (!s.following) {
        target = null
        return
      }
      const started = s.following !== prev.following
      const moved =
        s.presences[s.following] !== prev.presences[s.following] || s.cursors[s.following] !== prev.cursors[s.following]
      if (started || moved) retarget()
    })
    /* the stage growing or shrinking changes what we can see: followers of
       ours need the new size, and if we are following, the leader's view
       has to be refitted to it */
    const el = ref.current
    const ro = new ResizeObserver(() => {
      if (!el) return
      sendViewport(useStore.getState().viewport, el)
      retarget()
    })
    if (el) ro.observe(el)
    return () => {
      unsub()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /* a fly-to request (prompt bar): glide the camera to the frame instead of
     snapping, so the new design streams in on-screen with a bit of drama.
     The request object stays in the store; only a NEW request re-runs this. */
  const flyTo = useStore((s) => s.flyTo)
  useEffect(() => {
    if (!flyTo) return
    const el = ref.current
    if (!el) return
    const from = useStore.getState().viewport
    const target = flyTargetFor(flyTo, el, from)
    if (!target) return
    const start = performance.now()
    const DURATION = 700
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    let raf = requestAnimationFrame(function step(now: number) {
      const k = ease(Math.min(1, (now - start) / DURATION))
      setViewport({
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        zoom: from.zoom + (target.zoom - from.zoom) * k,
      })
      if (now - start < DURATION) raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }, [flyTo]) // eslint-disable-line react-hooks/exhaustive-deps

  /** where a fly-to lands: a frame fitted with padding, or a bare world
   *  point centred at the zoom we already have (a peer's cursor) */
  function flyTargetFor(
    req: NonNullable<typeof flyTo>,
    el: HTMLDivElement,
    from: { x: number; y: number; zoom: number },
  ): { x: number; y: number; zoom: number } | undefined {
    if ('point' in req) {
      return {
        x: el.clientWidth / 2 - req.point.x * from.zoom,
        y: el.clientHeight / 2 - req.point.y * from.zoom,
        zoom: from.zoom,
      }
    }
    const f = currentPageCanvas()?.frames.find((x) => x.id === req.frameId)
    if (!f) return undefined
    const pad = 80
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / f.width, (el.clientHeight - pad * 2) / f.height, 1)),
    )
    return {
      x: (el.clientWidth - f.width * zoom) / 2 - f.x * zoom,
      y: (el.clientHeight - f.height * zoom) / 2 - f.y * zoom,
      zoom,
    }
  }

  /* center one frame in the viewport and select it (shared frame links) */
  const focusFrame = useCallback(
    (f: { id: string; x: number; y: number; width: number; height: number }) => {
      const el = ref.current
      if (!el) return
      select(f.id)
      focusedPage.current = useStore.getState().activePageId
      const pad = 80
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / f.width, (el.clientHeight - pad * 2) / f.height, 1)),
      )
      setViewport({
        x: (el.clientWidth - f.width * zoom) / 2 - f.x * zoom,
        y: (el.clientHeight - f.height * zoom) / 2 - f.y * zoom,
        zoom,
      })
      /* a shared frame link asks for this exact frame — show its details too */
      useStore.getState().setInspectorOpen(true)
    },
    [setViewport, select],
  )

  const fit = useCallback(() => useStore.getState().fitAll(), [])

  useEffect(() => {
    fitted.current = focusedPage.current === activePageId
    focusedPage.current = null
  }, [activePageId])

  /* zoom-to-fit once the canvas arrives — unless the URL deep-links a frame */
  useEffect(() => {
    if (!canvas || fitted.current) return
    fitted.current = true
    if (useStore.getState().following) return
    const focusId = deepLinkHandled.current ? null : new URLSearchParams(location.search).get('frame')
    const target = focusId ? useStore.getState().canvas?.frames.find((f) => f.id === focusId) : null
    if (target) {
      deepLinkHandled.current = true
      focusFrame(target)
    } else fit()
  }, [canvas, activePageId, fit, focusFrame])

  /* wheel: pan / pinch-zoom — needs a non-passive listener. Trackpads fire
     wheel events faster than the display refreshes, so deltas accumulate and
     flush once per animation frame: one store update (→ one React render)
     per painted frame instead of one per input event. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let panX = 0
    let panY = 0
    let zoomDelta = 0
    let pivotX = 0
    let pivotY = 0

    function flush() {
      raf = 0
      const vp = useStore.getState().viewport
      let { x, y, zoom } = vp
      if (zoomDelta !== 0) {
        /* exp(-deltaY/100) is the browser's own pinch↔wheel mapping, so the
           zoom tracks the finger spread 1:1 like Figma; per-event clamping
           (below) keeps discrete mouse-wheel notches from over-jumping */
        const factor = Math.exp(-zoomDelta * 0.01)
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
        const scale = next / zoom
        x = pivotX - (pivotX - x) * scale
        y = pivotY - (pivotY - y) * scale
        zoom = next
        zoomDelta = 0
      }
      x -= panX
      y -= panY
      panX = panY = 0
      useStore.getState().setViewport({ x, y, zoom })
    }

    function onWheel(e: WheelEvent) {
      /* let overlays with their own scrollbar scroll instead of panning */
      if ((e.target as Element | null)?.closest('[data-stage-scroll]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect()
        pivotX = e.clientX - rect.left
        pivotY = e.clientY - rect.top
        zoomDelta += Math.max(-40, Math.min(40, e.deltaY))
      } else {
        panX += e.deltaX
        panY += e.deltaY
      }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /* touch: a two-finger pinch zooms around the fingers' midpoint and pans
     with it. iOS never maps a pinch onto ctrl+wheel the way desktop browsers
     do, so it needs its own listener — on touch events rather than pointers,
     because frames swallow pointerdown to start their own drag and a pinch
     must win regardless of what the fingers landed on. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let prev: { dist: number; x: number; y: number } | null = null

    function pinchOf(touches: TouchList) {
      const rect = el!.getBoundingClientRect()
      const [a, b] = [touches[0], touches[1]]
      if (!a || !b) return null
      return {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top,
      }
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length < 2) return
      e.preventDefault()
      prev = pinchOf(e.touches)
      gesture.pinching = true
    }
    function onMove(e: TouchEvent) {
      if (!prev || e.touches.length < 2) return
      e.preventDefault()
      const cur = pinchOf(e.touches)
      if (!cur) return
      const vp = useStore.getState().viewport
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * (cur.dist / Math.max(1, prev.dist))))
      const scale = zoom / vp.zoom
      /* the world point under the previous midpoint stays under the new one */
      useStore.getState().setViewport({
        x: cur.x - (prev.x - vp.x) * scale,
        y: cur.y - (prev.y - vp.y) * scale,
        zoom,
      })
      prev = cur
    }
    function onEnd(e: TouchEvent) {
      /* three fingers down and one lifts: the pair that remains may not be
         the pair being tracked, so measure it afresh instead of comparing
         it against the old pair's spread */
      if (e.touches.length >= 2) {
        prev = pinchOf(e.touches)
        return
      }
      prev = null
      gesture.pinching = false
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      gesture.pinching = false
    }
  }, [])

  function toWorld(clientX: number, clientY: number) {
    const rect = ref.current!.getBoundingClientRect()
    const vp = useStore.getState().viewport
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    }
  }

  /* space bar → pan mode: the stage drags the viewport instead of drawing a
     marquee, and frames let the press fall through to it. Held-space repeats
     must not re-trigger, and typing in a field is never a pan. */
  useEffect(() => {
    function isTyping(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    }
    function onDown(e: KeyboardEvent) {
      if (e.key !== ' ' || isTyping(e)) return
      e.preventDefault()
      if (!useStore.getState().panMode) useStore.getState().setPanMode(true)
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === ' ') useStore.getState().setPanMode(false)
    }
    const reset = () => useStore.getState().setPanMode(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', reset)
      reset()
    }
  }, [])

  function onPointerDown(e: React.PointerEvent) {
    const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
    /* pan: middle mouse anywhere, space-drag anywhere, or a finger on the
       background (touch has no space bar, and one-finger pan is how phones
       move around) */
    const pan = e.button === 1 || (e.button === 0 && (useStore.getState().panMode || e.pointerType === 'touch'))
    if (pan) return startPan(e, isBackground)
    /* left drag on the background draws a selection marquee */
    if (e.button !== 0 || !isBackground) return
    startMarquee(e)
  }

  function startPan(e: React.PointerEvent, isBackground: boolean) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning(true)
    let last = { x: e.clientX, y: e.clientY }
    let moved = false

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return
      const dx = ev.clientX - last.x
      const dy = ev.clientY - last.y
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
      last = { x: ev.clientX, y: ev.clientY }
      /* a pinch owns the viewport while it lasts; keep tracking the finger
         so the pan resumes from where it is, not from where the pinch began */
      if (gesture.pinching) return
      const vp = useStore.getState().viewport
      useStore.getState().setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy })
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPanning(false)
      if (!moved && isBackground) select(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startMarquee(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const origin = toWorld(e.clientX, e.clientY)
    /* ⇧-marquee adds to what is already selected */
    const keep = e.shiftKey ? useStore.getState().selectedIds : []
    let moved = false

    function onMove(ev: PointerEvent) {
      const cur = toWorld(ev.clientX, ev.clientY)
      const zoom = useStore.getState().viewport.zoom
      if (Math.abs(cur.x - origin.x) * zoom + Math.abs(cur.y - origin.y) * zoom > 3) moved = true
      if (!moved) return
      const rect = {
        x: Math.min(origin.x, cur.x),
        y: Math.min(origin.y, cur.y),
        width: Math.abs(cur.x - origin.x),
        height: Math.abs(cur.y - origin.y),
      }
      setMarquee(rect)
      const frames = currentPageCanvas()?.frames ?? []
      const hits = frames
        .filter(
          (f) =>
            f.x < rect.x + rect.width &&
            f.x + f.width > rect.x &&
            f.y < rect.y + rect.height &&
            f.y + f.height > rect.y,
        )
        .map((f) => f.id)
      useStore.getState().selectMany([...keep, ...hits.filter((id) => !keep.includes(id))])
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setMarquee(null)
      /* a plain click on empty canvas clears the selection */
      if (!moved && !e.shiftKey) select(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function onPointerMove(e: React.PointerEvent) {
    const { x, y } = toWorld(e.clientX, e.clientY)
    sendCursor(Math.round(x), Math.round(y))
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            /* `stage` is a behaviour hook, not a style: frameClipboard.ts queries
           `.stage` to map screen coordinates into the canvas. No CSS is
           attached to it — everything visual is in the utilities beside it. */
            className={cn(
              'stage absolute inset-0 touch-none',
              panning
                ? 'cursor-grabbing! [&_*]:cursor-grabbing!'
                : panMode
                  ? 'cursor-grab! [&_*]:cursor-grab!'
                  : 'cursor-default',
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onContextMenu={(e) => {
              /* frames stop the event on their own trigger, so anything arriving
                 here is the empty canvas — except a right-click on a frame's
                 chrome overlay, which is not a menu target at all */
              const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
              if (!isBackground) return e.preventDefault()
              /* Paste drops the frame where the click landed. The menu's own
                 box is not that point: Radix positions it after mount, and
                 flips it away from a viewport edge. */
              bgAt.current = { x: e.clientX, y: e.clientY }
            }}
          >
            {/* dot grid on its own composited layer: panning is transform-only
            (zero paint), zooming repaints just this layer's tiny tile */}
            <div
              className="pointer-events-none absolute left-0 top-0 h-[calc(100%+160px)] w-[calc(100%+160px)] origin-top-left will-change-transform [background-image:radial-gradient(circle,var(--dot)_1.2px,transparent_1.2px)]"
              ref={gridRef}
            />
            {/* `world` is likewise a behaviour hook: pan hit-testing checks
            classList.contains('world') to tell background from frame */}
            <div className="world absolute left-0 top-0 origin-top-left" ref={worldRef}>
              {canvas?.frames.map((f) => (
                <FrameView key={f.id} frame={f} />
              ))}
              {notesVisible &&
                pageNotes.map((n) => (
                  <StickyNote
                    key={n.id}
                    note={n}
                    frameName={n.frameId ? fullCanvas?.frames.find((f) => f.id === n.frameId)?.name : undefined}
                  />
                ))}
              <GhostFrames />
              <FlowOverlay />
              <SnapGuides />
              <Cursors />
              {marquee && (
                <div
                  className="pointer-events-none absolute bg-brand/10 [box-shadow:inset_0_0_0_calc(1px/var(--zoom,1))_var(--brand)]"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
                />
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <FollowFrame />

        <Toolbar className="absolute bottom-[calc(8px+env(safe-area-inset-bottom))] left-1/2 z-[35] -translate-x-1/2 sm:bottom-4">
          <ToolbarButton onClick={onAddFrame}>+ Frame</ToolbarButton>
          <ToolbarButton
            title="Add a sticky note (N shows or hides all notes)"
            onClick={() => canvas && void addNote(canvas.id)}
          >
            Note
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton
            aria-label="Zoom out"
            onClick={() => {
              const vp = useStore.getState().viewport
              const el = ref.current!
              zoomAround(el, vp, 1 / 1.25)
            }}
          >
            −
          </ToolbarButton>
          <ToolbarValue ref={zoomLabelRef}>100%</ToolbarValue>
          <ToolbarButton
            aria-label="Zoom in"
            onClick={() => {
              const vp = useStore.getState().viewport
              const el = ref.current!
              zoomAround(el, vp, 1.25)
            }}
          >
            +
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={fit} title="Fit every frame (⇧1)">
            Fit
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => useStore.getState().setShortcutsOpen(true)}
          >
            ?
          </ToolbarButton>
        </Toolbar>
        <ModePill />

        {canvas && (
          <ContextMenuContent>
            <ContextMenuItem
              disabled={!hasFrameClip()}
              onSelect={() => pasteFrameAtScreen(canvas.id, bgAt.current.x, bgAt.current.y)}
            >
              Paste
              <MenuHint>{MOD_KEY}V</MenuHint>
            </ContextMenuItem>
            <ContextMenuItem onSelect={onAddFrame}>New frame</ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                const at = toWorld(bgAt.current.x, bgAt.current.y)
                void addNote(canvas.id, { at: { x: Math.round(at.x), y: Math.round(at.y) } })
              }}
            >
              New note
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => useStore.getState().setShortcutsOpen(true)}>
              Keyboard shortcuts
              <MenuHint>?</MenuHint>
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
    </>
  )

  function zoomAround(el: HTMLDivElement, vp: { x: number; y: number; zoom: number }, factor: number) {
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor))
    const scale = zoom / vp.zoom
    setViewport({ x: px - (px - vp.x) * scale, y: py - (py - vp.y) * scale, zoom })
  }
}
