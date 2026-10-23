import { create } from 'zustand'
import {
  DWELL_MS,
  MAX_SEEN_PER_REQUEST,
  computeMarks,
  contentStamp,
  isBeingViewed,
  isNewFrame,
  nextMarked,
  pageMarks as foldPageMarks,
  reviewOrder,
  type Mark,
  type MarkInput,
} from '../../shared/marks'
import { canvasPages, framePageId } from '../../shared/pages'
import { api } from './api'
import { useStore } from './store'

/**
 * Review marks for the open canvas: which frames are new to this person, and which have a thread waiting on them.
 * The rules live in shared/marks.ts; this file keeps the seen state, feeds it to those rules whenever the canvas,
 * the comments or the seen state change, and reports what the person has looked at back to the server in batches.
 * A guest (no account) gets no marks and sends nothing.
 */

interface MarksState {
  /** frame id -> the frame `updatedAt` this person last saw */
  seen: Record<string, number>
  /** when this person first opened the canvas; null until the server has answered */
  baselineAt: number | null
  marks: Record<string, Mark>
  /** the strongest mark of the frames on each page */
  pageMarks: Record<string, Mark>
}

const EMPTY: MarksState = { seen: {}, baselineAt: null, marks: {}, pageMarks: {} }

export const useMarks = create<MarksState>(() => EMPTY)

/** The mark on one frame. */
export const useFrameMark = (frameId: string): Mark | undefined => useMarks((s) => s.marks[frameId])

/** Seen updates are sent together once the person has stopped looking around for this long. */
const FLUSH_MS = 1000
/** How often the camera is checked for frames that have been in view long enough. */
const DWELL_TICK_MS = 500

interface Session {
  canvasId: string
  viewer: { userId: string; name?: string }
  /** frames seen since the last send: frame id -> updatedAt */
  pending: Map<string, number>
  timer: number | null
}

let session: Session | null = null

function sameMarks(a: Record<string, Mark>, b: Record<string, Mark>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** The inputs the rules need, or undefined while there is no one to mark for (a guest, or the seen state is loading). */
function markInput(s: Session): MarkInput | undefined {
  const canvas = useStore.getState().canvas
  const { seen, baselineAt } = useMarks.getState()
  if (!canvas || canvas.id !== s.canvasId || baselineAt === null) return undefined
  return {
    viewer: { userId: s.viewer.userId, name: s.viewer.name, ownsCanvas: canvas.ownerId === s.viewer.userId },
    seen,
    baselineAt,
  }
}

function send(s: Session, keepalive = false) {
  if (s.timer !== null) window.clearTimeout(s.timer)
  s.timer = null
  if (s.pending.size === 0) return
  const all = [...s.pending]
  s.pending.clear()
  /* a request takes at most MAX_SEEN_PER_REQUEST frames; "mark all as seen" on a big canvas is a few of them */
  for (let from = 0; from < all.length; from += MAX_SEEN_PER_REQUEST) {
    const frames = Object.fromEntries(all.slice(from, from + MAX_SEEN_PER_REQUEST))
    api.postSeen(s.canvasId, frames, keepalive).catch(() => {
      /* kept for the next send; the person's own screen already shows the frame as seen */
      for (const [id, at] of Object.entries(frames)) s.pending.set(id, Math.max(at, s.pending.get(id) ?? 0))
    })
  }
}

/** Record that this person has now seen the frame as it is. Does nothing for a frame that is not new to them. */
export function markFrameSeen(frameId: string) {
  const s = session
  const input = s && markInput(s)
  if (!s || !input) return
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  if (!frame || !isNewFrame(frame, input)) return
  const stamp = contentStamp(frame)
  useMarks.setState({ seen: { ...input.seen, [frameId]: stamp } })
  s.pending.set(frameId, stamp)
  if (s.timer !== null) window.clearTimeout(s.timer)
  s.timer = window.setTimeout(() => send(s), FLUSH_MS)
}

/**
 * Mark every new frame on the canvas as seen, in one batched report, and offer to undo it with a toast. The
 * needs-you (orange) marks are left alone: those clear only when the person replies. Returns how many frames it marked.
 */
export function markAllSeen(): number {
  const s = session
  const input = s && markInput(s)
  const { canvas, pushNotice } = useStore.getState()
  if (!s || !input || !canvas) return 0
  const { marks } = useMarks.getState()
  const fresh = canvas.frames.filter((frame) => marks[frame.id] === 'new')
  if (fresh.length === 0) {
    pushNotice('Nothing new to mark as seen')
    return 0
  }
  const seen = { ...input.seen }
  const reported: Record<string, number> = {}
  const previous: Record<string, number | null> = {}
  for (const frame of fresh) {
    previous[frame.id] = input.seen[frame.id] ?? null
    reported[frame.id] = seen[frame.id] = contentStamp(frame)
  }
  useMarks.setState({ seen })
  for (const [id, at] of Object.entries(reported)) s.pending.set(id, at)
  send(s)

  pushNotice(`Marked ${fresh.length} ${fresh.length === 1 ? 'frame' : 'frames'} as seen`, {
    action: {
      label: 'Undo',
      run: () => {
        if (session !== s) return
        /* put back only what this action changed: a frame viewed since is still seen */
        const now = useMarks.getState().seen
        const restored = { ...now }
        const restore: Record<string, number | null> = {}
        for (const [id, before] of Object.entries(previous)) {
          if (now[id] !== reported[id]) continue
          restore[id] = before
          if (before === null) delete restored[id]
          else restored[id] = before
          s.pending.delete(id)
        }
        useMarks.setState({ seen: restored })
        for (let from = 0; from < Object.keys(restore).length; from += MAX_SEEN_PER_REQUEST) {
          const batch = Object.fromEntries(Object.entries(restore).slice(from, from + MAX_SEEN_PER_REQUEST))
          api
            .replaceSeen(s.canvasId, batch)
            .catch(() => useStore.getState().pushNotice('Couldn’t undo that. Try again.'))
        }
      },
    },
  })
  return fresh.length
}

/**
 * Fly to the next frame that needs the person, then the next new one, across pages in reading order, and mark it
 * seen. With nothing left, say so.
 */
export function reviewNext() {
  const { canvas, selectedId, requestFlyTo, select, pushNotice } = useStore.getState()
  if (!canvas) return
  const target = nextMarked(reviewOrder(canvas), useMarks.getState().marks, selectedId)
  if (!target) {
    pushNotice("You're all caught up")
    return
  }
  requestFlyTo(target)
  select(target)
  markFrameSeen(target)
}

/**
 * Start tracking marks for a canvas and signed-in viewer. Returns the function that stops it (and sends what is
 * still waiting to be reported).
 */
export function bindMarks(canvasId: string, viewer: { userId: string; name?: string }): () => void {
  const mine: Session = { canvasId, viewer, pending: new Map(), timer: null }
  session = mine
  useMarks.setState(EMPTY)
  let alive = true

  /* ---- marks follow the canvas, the comments and the seen state ---- */
  let lastCanvas: unknown
  let lastComments: unknown
  let lastSeen: unknown
  let lastBaseline: unknown
  function recompute() {
    const { canvas, comments } = useStore.getState()
    const { seen, baselineAt } = useMarks.getState()
    if (canvas === lastCanvas && comments === lastComments && seen === lastSeen && baselineAt === lastBaseline) return
    lastCanvas = canvas
    lastComments = comments
    lastSeen = seen
    lastBaseline = baselineAt
    const input = markInput(mine)
    const marks = input && canvas ? computeMarks(canvas.frames, comments, input) : {}
    if (sameMarks(marks, useMarks.getState().marks)) return
    useMarks.setState({ marks, pageMarks: canvas ? foldPageMarks(canvas, marks) : {} })
  }

  /* ---- load, and refetch when the window regains focus (another tab may have seen things) ---- */
  function load() {
    api
      .getSeen(canvasId)
      .then(({ seen, baselineAt }) => {
        if (!alive) return
        const local = useMarks.getState().seen
        const merged = { ...seen }
        for (const [id, at] of Object.entries(local)) merged[id] = Math.max(at, merged[id] ?? 0)
        useMarks.setState({ seen: merged, baselineAt })
      })
      .catch(() => {})
  }
  load()
  const onFocus = () => {
    send(mine)
    load()
  }
  const onHide = () => {
    if (document.visibilityState === 'hidden') send(mine, true)
  }
  const onPageHide = () => send(mine, true)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onHide)

  /* ---- a selected frame (a click, a double-click, a deep link, the Layers rail, the u key) is seen ---- */
  const unsubStore = useStore.subscribe((state, prev) => {
    recompute()
    if (state.selectedIds === prev.selectedIds) return
    for (const id of state.selectedIds) if (!prev.selectedIds.includes(id)) markFrameSeen(id)
  })
  const unsubMarks = useMarks.subscribe(recompute)

  /* ---- a frame that stays in view is seen: checked from the camera and the frame boxes, never per iframe ---- */
  const dwell = new Map<string, { updatedAt: number; since: number }>()
  const ticker = window.setInterval(() => {
    const { canvas, activePageId, viewport, stageSize } = useStore.getState()
    const { marks } = useMarks.getState()
    const newIds = Object.keys(marks).filter((id) => marks[id] === 'new')
    if (document.visibilityState !== 'visible' || !canvas || !stageSize || canvas.id !== canvasId || !newIds.length) {
      dwell.clear()
      return
    }
    const pageId = activePageId ?? canvasPages(canvas)[0]!.id
    const now = Date.now()
    const inView = new Set<string>()
    for (const id of newIds) {
      const frame = canvas.frames.find((f) => f.id === id)
      if (!frame || framePageId(canvas, frame) !== pageId || !isBeingViewed(frame, viewport, stageSize)) continue
      inView.add(id)
      const entry = dwell.get(id)
      if (!entry || entry.updatedAt !== contentStamp(frame))
        dwell.set(id, { updatedAt: contentStamp(frame), since: now })
      else if (now - entry.since >= DWELL_MS) {
        dwell.delete(id)
        markFrameSeen(id)
      }
    }
    for (const id of [...dwell.keys()]) if (!inView.has(id)) dwell.delete(id)
  }, DWELL_TICK_MS)

  recompute()
  return () => {
    alive = false
    window.clearInterval(ticker)
    unsubStore()
    unsubMarks()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onHide)
    send(mine, true)
    if (session === mine) session = null
    useMarks.setState(EMPTY)
  }
}
