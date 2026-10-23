import { useEffect, useReducer, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { formatElapsed } from '../lib/presentNav'
import {
  idlePresenterView,
  parsePresenterMessage,
  presenterChannelName,
  reducePresenterView,
  type PresenterMessage,
} from '../lib/presenterSync'
import { connect, disconnect } from '../lib/ws'
import { useStore } from '../lib/store'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { ChevronLeftIcon, ChevronRightIcon } from './ui/icons'
import { MarkdownText } from './StickyNote'

/* What a speaker looks at while the audience sees the slide: the notes, the slide that comes next, the time, and where
   they are in the deck. It is one panel in two places: a strip along the bottom of the presentation (the `s` key), and
   a window of its own that follows the presentation over a BroadcastChannel. */

/** A small live copy of a frame: the same sandboxed document the canvas renders, scaled down and inert. */
export function FrameThumb({ frame, width, className }: { frame: Frame; width: number; className?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source === iframeRef.current?.contentWindow && ev.data?.type === 'doop:frame-ready') setReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  useEffect(() => {
    if (ready) iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html: frame.html }, '*')
  }, [ready, frame.html])
  const scale = width / frame.width
  return (
    <div
      className={cn('relative shrink-0 overflow-hidden rounded-[6px] bg-white ring-1 ring-paper/20', className)}
      style={{ width, height: Math.round(frame.height * scale) }}
    >
      <iframe
        ref={iframeRef}
        aria-hidden
        tabIndex={-1}
        title={frame.name}
        sandbox="allow-scripts"
        srcDoc={FRAME_BOOTSTRAP}
        className="pointer-events-none block border-none bg-white"
        style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      />
    </div>
  )
}

/** "m:ss" since the show began, ticking once a second. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return formatElapsed(startedAt === null ? 0 : now - startedAt)
}

export interface PresenterPanelProps {
  frame: Frame
  next: Frame | null
  /** 1-based place in the deck and its length */
  index: number
  total: number
  startedAt: number | null
  variant: 'strip' | 'window'
  onPrev: () => void
  onNext: () => void
}

export function PresenterPanel({ frame, next, index, total, startedAt, variant, onPrev, onNext }: PresenterPanelProps) {
  const elapsed = useElapsed(startedAt)
  const big = variant === 'window'
  const notes = frame.speakerNotes?.trim()
  return (
    <div
      className={cn(
        'flex gap-5 text-paper',
        big ? 'h-full flex-col p-6 md:flex-row' : 'h-full items-stretch px-5 py-3',
      )}
      data-testid="presenter-panel"
    >
      <section
        aria-label="Speaker notes"
        data-stage-scroll=""
        className={cn(
          'min-w-0 flex-1 overflow-y-auto overscroll-contain',
          big ? 'text-[22px] leading-[1.45]' : 'text-[15px] leading-[1.5]',
        )}
      >
        <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-paper/55">
          {frame.name || 'Slide'}
        </h2>
        {notes ? <MarkdownText markdown={notes} /> : <p className="text-paper/55">No notes for this slide.</p>}
      </section>
      <aside className={cn('flex shrink-0 gap-4', big ? 'flex-col md:w-[360px]' : 'items-stretch')}>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-paper/55">Next</span>
          {next ? (
            <FrameThumb frame={next} width={big ? 360 : 192} />
          ) : (
            <div
              className="grid place-items-center rounded-[6px] text-[12px] text-paper/55 ring-1 ring-paper/20"
              style={{ width: big ? 360 : 192, height: big ? 202 : 108 }}
            >
              End of the deck
            </div>
          )}
        </div>
        <div className={cn('flex flex-col justify-between gap-2', big ? '' : 'w-[132px]')}>
          <div>
            <div className="font-mono text-[28px] font-semibold leading-none tabular-nums" aria-label="Elapsed time">
              {elapsed}
            </div>
            <div className="mt-1.5 text-[12px] text-paper/70" aria-label="Slide number">
              Slide {index} / {total}
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button
              variant="inverse"
              size="icon-sm"
              className="border border-paper/25"
              aria-label="Previous slide"
              title="Previous slide (←)"
              disabled={index <= 1}
              onClick={onPrev}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="inverse"
              size="icon-sm"
              className="border border-paper/25"
              aria-label="Next slide"
              title="Next slide (→)"
              disabled={index >= total}
              onClick={onNext}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

function sendCommand(channel: BroadcastChannel | null, command: 'next' | 'prev') {
  channel?.postMessage({ type: 'command', command } satisfies PresenterMessage)
}

/** The presenter's own window: notes and the next slide, following the presentation in the opener's window. */
export function PresenterWindow({ canvasId }: { canvasId: string }) {
  const canvas = useStore((s) => (s.canvas?.id === canvasId ? s.canvas : null))
  const [view, dispatch] = useReducer(reducePresenterView, idlePresenterView)
  const channel = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    connect(canvasId)
    return () => {
      disconnect()
      useStore.getState().setCanvas(null)
    }
  }, [canvasId])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(presenterChannelName(canvasId))
    channel.current = ch
    ch.onmessage = (ev: MessageEvent) => {
      const message = parsePresenterMessage(ev.data)
      if (message) dispatch(message)
    }
    ch.postMessage({ type: 'hello' } satisfies PresenterMessage)
    return () => {
      channel.current = null
      ch.close()
    }
  }, [canvasId])

  const frame = canvas?.frames.find((f) => f.id === view.frameId)
  const next = canvas?.frames.find((f) => f.id === view.nextId) ?? null

  useEffect(() => {
    document.title = canvas ? `Presenter · ${canvas.name}` : 'Presenter'
  }, [canvas])

  function command(command: 'next' | 'prev') {
    sendCommand(channel.current, command)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') sendCommand(channel.current, 'next')
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') sendCommand(channel.current, 'prev')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <main className="fixed inset-0 bg-ink" aria-label="Presenter view">
      {view.live && frame ? (
        <PresenterPanel
          frame={frame}
          next={next}
          index={view.index}
          total={view.total}
          startedAt={view.startedAt}
          variant="window"
          onPrev={() => command('prev')}
          onNext={() => command('next')}
        />
      ) : (
        <div className="grid h-full place-items-center px-6 text-center text-paper/70">
          <div>
            <p className="text-[18px] font-semibold text-paper">
              {canvas ? 'Waiting for the presentation' : 'Connecting…'}
            </p>
            <p className="mt-1.5 text-[14px]">
              Present a deck in the other window. Notes and the next slide show up here as you go.
            </p>
          </div>
        </div>
      )}
    </main>
  )
}
