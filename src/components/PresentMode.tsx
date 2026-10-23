import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveGoto } from '../../shared/gotoLinks'
import { canvasPages, framePageId } from '../../shared/pages'
import { deckOf } from '../../shared/slides'
import { downloadDeckPdf } from '../lib/deckExport'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { backNav, jumpNav, presentOrder, pruneNav, startNav, stepNav } from '../lib/presentNav'
import { parsePresenterMessage, presenterChannelName, type PresenterMessage } from '../lib/presenterSync'
import { useStore } from '../lib/store'
import { cn } from '../lib/utils'
import { PresenterPanel } from './PresenterView'
import { Button } from './ui/button'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, NoteIcon, OpenWindowIcon, UndoIcon, XIcon } from './ui/icons'

/* Full-screen presentation of a canvas page: it fills the viewport (letterboxed on ink) with one frame at native
   resolution scaled to fit, still connected to the room so edits streaming in render live. ← → walk the page in reading
   order, a prototype link (data-goto) jumps and Backspace comes back, Esc closes.
   When the frame is a slide it is a deck over the slides of the page: Space and a click advance, `s` opens the
   presenter strip (notes, the next slide, a timer), and a second window can carry the same view.
   One iframe does it all: the next frame's HTML is posted in and the runtime morphs to it inside a view transition. */

/** How tall the presenter strip is; the stage gives up that much room while it is open. */
const STRIP_HEIGHT = 176
/** The toolbar goes away after this long without the pointer moving. */
const CHROME_HIDE_MS = 2000
const NOTICE_MS = 2600

const toolbarBtn = 'text-paper border border-transparent hover:border-paper/25'

export function PresentMode({ startId, onClose }: { startId: string; onClose: () => void }) {
  const canvas = useStore((s) => s.canvas)
  const storeNotice = useStore((s) => s.notice)
  const [nav, setNav] = useState(() => startNav(startId))
  const [startedAt] = useState(() => Date.now())
  const [ready, setReady] = useState(false)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [stripOpen, setStripOpen] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const chromeHovered = useRef(false)

  const exists = (id: string) => !!canvas?.frames.some((f) => f.id === id)
  /* a frame deleted under us: step back to where a link left from, or end the show when there is nowhere to go */
  if (canvas && !exists(nav.currentId)) {
    const fallback = backNav(pruneNav(nav, exists))
    if (fallback !== nav && exists(fallback.currentId)) setNav(fallback)
  }

  const frame = canvas?.frames.find((f) => f.id === nav.currentId)
  const order = useMemo(() => (canvas && frame ? presentOrder(canvas, frame) : []), [canvas, frame])
  const orderIds = useMemo(() => order.map((f) => f.id), [order])
  const at = orderIds.indexOf(nav.currentId)
  const index = at + 1
  const total = order.length
  const next = at >= 0 ? (order[at + 1] ?? null) : null
  const slidesMode = !!frame?.slide
  const showStrip = stripOpen && slidesMode

  /* what the long-lived listeners (window keys, the iframe's messages, the other window) act on */
  const live = useRef({
    nav,
    orderIds,
    canvas,
    slidesMode,
    frameId: frame?.id ?? null,
    index,
    total,
    nextId: next?.id ?? null,
  })
  useEffect(() => {
    live.current = {
      nav,
      orderIds,
      canvas,
      slidesMode,
      frameId: frame?.id ?? null,
      index,
      total,
      nextId: next?.id ?? null,
    }
  })

  const flash = useCallback((text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice((now) => (now === text ? null : now)), NOTICE_MS)
  }, [])

  const step = useCallback((delta: 1 | -1) => setNav((n) => stepNav(n, live.current.orderIds, delta)), [])
  const back = useCallback(() => setNav((n) => backNav(n)), [])
  const follow = useCallback(
    (target: string) => {
      const c = live.current.canvas
      const to = c ? resolveGoto(c, target) : undefined
      if (to) setNav((n) => jumpNav(n, to.id))
      else flash(`No frame matches “${target}”`)
    },
    [flash],
  )

  /* the keys that run the show; false leaves a key to the browser */
  const onShowKey = useCallback(
    (key: string): boolean => {
      switch (key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          step(1)
          return true
        case ' ':
          if (!live.current.slidesMode) return false
          step(1)
          return true
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          step(-1)
          return true
        case 'Backspace':
          back()
          return true
        case 's':
        case 'S':
          if (!live.current.slidesMode) return false
          setStripOpen((open) => !open)
          return true
        default:
          return false
      }
    },
    [step, back],
  )

  /* the toolbar shows on any movement and goes after CHROME_HIDE_MS of stillness, unless the pointer rests on it */
  const hideTimer = useRef<number | undefined>(undefined)
  const armHide = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!chromeHovered.current) setChromeVisible(false)
    }, CHROME_HIDE_MS)
  }, [])
  const revealChrome = useCallback(() => {
    setChromeVisible(true)
    armHide()
  }, [armHide])
  useEffect(() => {
    armHide()
    window.addEventListener('pointermove', revealChrome)
    window.addEventListener('pointerdown', revealChrome)
    return () => {
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('pointermove', revealChrome)
      window.removeEventListener('pointerdown', revealChrome)
    }
  }, [armHide, revealChrome])

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      const d = ev.data
      if (d?.type === 'doop:frame-ready') setReady(true)
      /* keys and moves with focus inside the frame never reach this window as events; the runtime relays them */
      else if (d?.type === 'doop:esc') onClose()
      else if (d?.type === 'doop:goto' && typeof d.target === 'string') follow(d.target)
      else if (d?.type === 'doop:advance') step(1)
      else if (d?.type === 'doop:key' && typeof d.key === 'string') onShowKey(d.key)
      else if (d?.type === 'doop:pointer') revealChrome()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onClose, follow, step, onShowKey, revealChrome])

  /* the frame learns it is being presented; a deck also gets the show's markers */
  useEffect(() => {
    if (ready)
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:mode', present: true, slides: slidesMode }, '*')
  }, [ready, slidesMode])

  /* the first frame goes in plainly; a later frame arrives through a view transition, and an edit to the frame on
     screen morphs in place */
  const frameId = frame?.id
  const html = frame?.html ?? ''
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !frameId) return
    const swap = shown.current !== null && shown.current !== frameId
    shown.current = frameId
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'doop:html', html, ...(swap ? { transition: true } : {}) },
      '*',
    )
  }, [ready, frameId, html])

  useEffect(() => {
    function onResize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* capture phase so the show's keys never reach the canvas page underneath (Esc would clear its selection) */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (onShowKey(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onShowKey])

  /* the frame vanished with nowhere to go back to — nothing left to present */
  const canRecover = nav.history.some(exists)
  useEffect(() => {
    if (canvas && !frame && !canRecover) onClose()
  }, [canvas, frame, canRecover, onClose])

  /* ---- the presenter window: this end announces the show and obeys its steps ---- */
  const channel = useRef<BroadcastChannel | null>(null)
  const canvasId = canvas?.id
  const announce = useCallback(() => {
    const l = live.current
    if (!channel.current || !l.frameId || !l.slidesMode) return
    channel.current.postMessage({
      type: 'state',
      frameId: l.frameId,
      index: l.index,
      total: l.total,
      nextId: l.nextId,
      startedAt,
    } satisfies PresenterMessage)
  }, [startedAt])
  useEffect(() => {
    if (!canvasId || typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(presenterChannelName(canvasId))
    channel.current = ch
    ch.onmessage = (ev: MessageEvent) => {
      const message = parsePresenterMessage(ev.data)
      if (message?.type === 'hello') announce()
      else if (message?.type === 'command') step(message.command === 'next' ? 1 : -1)
    }
    return () => {
      ch.postMessage({ type: 'end' } satisfies PresenterMessage)
      ch.close()
      channel.current = null
    }
  }, [canvasId, announce, step])
  const nextId = next?.id ?? null
  useEffect(() => {
    if (frameId && slidesMode) announce()
    else channel.current?.postMessage({ type: 'end' } satisfies PresenterMessage)
  }, [frameId, slidesMode, index, total, nextId, announce])

  function openPresenterWindow() {
    if (!canvas) return
    const popup = window.open(`/c/${canvas.id}?presenter=1`, 'doop-presenter', 'popup=yes,width=1100,height=720')
    if (!popup) {
      flash('Your browser blocked the presenter window. Allow pop-ups for this site.')
      return
    }
    setStripOpen(false)
  }

  const deckPage = useMemo(() => {
    if (!canvas || !frame?.slide) return null
    const pageId = framePageId(canvas, frame)
    const name = canvasPages(canvas).find((p) => p.id === pageId)?.name ?? 'deck'
    return {
      canvasId: canvas.id,
      pageId,
      name,
      slides: deckOf(canvas.frames.filter((f) => framePageId(canvas, f) === pageId)).length,
    }
  }, [canvas, frame])

  /* the deck export reports through the canvas toast, which sits under the show: its words surface here */
  const shownNotice = notice ?? (storeNotice && storeNotice.at >= startedAt ? storeNotice.text : null)
  const room = { w: viewport.w, h: viewport.h - (showStrip ? STRIP_HEIGHT : 0) }
  const scale = frame ? Math.min(room.w / frame.width, room.h / frame.height) : 1

  if (!frame) return null

  return (
    <div
      className={cn('fixed inset-0 z-[80] bg-ink', !chromeVisible && 'cursor-none')}
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${frame.name}`}
    >
      <div className="absolute inset-x-0 top-0 grid place-items-center" style={{ height: room.h }}>
        <div
          className="relative overflow-hidden bg-white"
          style={{ width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) }}
        >
          <iframe
            ref={iframeRef}
            className="block border-none bg-white"
            title={frame.name}
            data-doop-frame=""
            sandbox="allow-scripts"
            srcDoc={FRAME_BOOTSTRAP}
            style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
          />
        </div>
      </div>

      {showStrip && (
        <div
          className="absolute inset-x-0 bottom-0 border-t border-paper/15 bg-ink"
          style={{ height: STRIP_HEIGHT }}
          role="region"
          aria-label="Presenter view"
        >
          <PresenterPanel
            frame={frame}
            next={next}
            index={index}
            total={total}
            startedAt={startedAt}
            variant="strip"
            onPrev={() => step(-1)}
            onNext={() => step(1)}
          />
        </div>
      )}

      {shownNotice && (
        <div
          role="status"
          className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-paper px-3.5 py-1.5 text-[12.5px] font-semibold text-ink shadow-pop animate-[chip-in_0.25s_ease]"
        >
          {shownNotice}
        </div>
      )}

      <div
        role="toolbar"
        aria-label="Presentation controls"
        className={cn(
          'absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-paper/20 bg-ink/85 px-2 py-1.5 text-paper shadow-pop backdrop-blur transition-[opacity,translate] duration-200',
          chromeVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
        style={{ bottom: (showStrip ? STRIP_HEIGHT : 0) + 16 }}
        onPointerEnter={() => {
          chromeHovered.current = true
        }}
        onPointerLeave={() => {
          chromeHovered.current = false
          armHide()
        }}
      >
        {nav.history.length > 0 && (
          <Button
            variant="inverse"
            size="icon-sm"
            className={toolbarBtn}
            aria-label="Back to the previous screen"
            title="Back (Backspace)"
            onClick={back}
          >
            <UndoIcon />
          </Button>
        )}
        <Button
          variant="inverse"
          size="icon-sm"
          className={toolbarBtn}
          aria-label="Previous frame"
          title="Previous (←)"
          disabled={index <= 1}
          onClick={() => step(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex min-w-[8.5rem] max-w-[18rem] flex-col items-center px-2 leading-tight">
          <span className="max-w-full truncate text-[12.5px] font-semibold">{frame.name}</span>
          <span className="font-mono text-[10.5px] tabular-nums text-paper/65" aria-label="Position">
            {index > 0 ? `${index} / ${total}` : `– / ${total}`}
          </span>
        </div>
        <Button
          variant="inverse"
          size="icon-sm"
          className={toolbarBtn}
          aria-label="Next frame"
          title="Next (→)"
          disabled={index >= total}
          onClick={() => step(1)}
        >
          <ChevronRightIcon />
        </Button>
        {deckPage && (
          <>
            <span className="mx-1 h-5 w-px bg-paper/20" aria-hidden />
            <Button
              variant="inverse"
              size="icon-sm"
              className={cn(toolbarBtn, showStrip && 'bg-paper/15')}
              aria-label="Presenter view"
              aria-pressed={showStrip}
              title="Presenter view: notes, next slide, timer (S)"
              onClick={() => setStripOpen((open) => !open)}
            >
              <NoteIcon />
            </Button>
            <Button
              variant="inverse"
              size="icon-sm"
              className={toolbarBtn}
              aria-label="Open presenter window"
              title="Open the presenter view in its own window"
              onClick={openPresenterWindow}
            >
              <OpenWindowIcon />
            </Button>
            <Button
              variant="inverse"
              size="icon-sm"
              className={toolbarBtn}
              aria-label="Export deck as PDF"
              title="Export deck as PDF"
              onClick={() => void downloadDeckPdf(deckPage.canvasId, deckPage.pageId, deckPage.name, deckPage.slides)}
            >
              <DownloadIcon />
            </Button>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-paper/20" aria-hidden />
        <Button
          variant="inverse"
          size="icon-sm"
          className={toolbarBtn}
          aria-label="Exit presentation"
          title="Exit presentation (Esc)"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}
