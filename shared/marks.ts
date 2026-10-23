import { canvasPages, framePageId, normalizePageTree } from './pages.ts'
import { readingOrder } from './readingOrder.ts'
import type { Canvas, ElementComment, Frame } from './types.ts'

/**
 * The review marks on a frame: 'ask' (orange, "needs you") when a thread is waiting on the viewer, 'new' (blue) when
 * someone else changed the frame's design since the viewer last looked. Orange beats blue. Pure rules, shared by the client
 * (dots, the `u` key) and tests.
 */
export type Mark = 'new' | 'ask'

/** The viewer the marks are for. Without a user id (a guest) there are no marks at all. */
export interface MarkViewer {
  userId: string
  /** display name, used only to recognise the viewer's own edits on frames written before editors were recorded by id */
  name?: string
  /** the viewer created the canvas, so every thread on it is theirs to answer */
  ownsCanvas: boolean
}

export interface MarkInput {
  viewer: MarkViewer
  /** frame id -> the frame `updatedAt` the viewer last saw */
  seen: Readonly<Record<string, number>>
  /** when the viewer first opened the canvas: everything older counts as seen */
  baselineAt: number
}

type MarkFrame = Pick<
  Frame,
  'id' | 'updatedAt' | 'contentUpdatedAt' | 'updatedBy' | 'updatedByUserId' | 'updatedByKind'
>
type MarkComment = Pick<
  ElementComment,
  'id' | 'frameId' | 'parentId' | 'resolvedAt' | 'at' | 'from' | 'fromUserId' | 'fromKind' | 'mentions'
>

/** Most frames one seen request may report; the client batches a second of views, so a real one is far smaller. */
export const MAX_SEEN_PER_REQUEST = 500

/**
 * The version of a frame that marks and seen state compare: when its design last changed. A move, resize or page move
 * bumps `updatedAt` but is not something to review, so it does not move this. Frames written before the stamp existed
 * fall back to `updatedAt`.
 */
export function contentStamp(frame: Pick<Frame, 'updatedAt' | 'contentUpdatedAt'>): number {
  return frame.contentUpdatedAt ?? frame.updatedAt
}

/** Whether the last edit on the frame was the viewer's own hand. An agent's edit is never the viewer's, even with the viewer's key. */
function editedByViewer(frame: MarkFrame, viewer: MarkViewer): boolean {
  if (frame.updatedByKind === 'agent') return false
  if (frame.updatedByUserId) return frame.updatedByUserId === viewer.userId
  return !!viewer.name && frame.updatedBy === viewer.name
}

/** New: its design changed by someone other than the viewer, after the later of what they saw and when they first arrived. */
export function isNewFrame(frame: MarkFrame, input: MarkInput): boolean {
  if (contentStamp(frame) <= Math.max(input.seen[frame.id] ?? 0, input.baselineAt)) return false
  return !editedByViewer(frame, input.viewer)
}

/** A message the viewer wrote by hand; an agent speaking through the viewer's key is not the viewer. */
function writtenByViewer(comment: MarkComment, viewer: MarkViewer): boolean {
  if (comment.fromKind === 'agent') return false
  return !!comment.fromUserId && comment.fromUserId === viewer.userId
}

/** The thread's newest message. When two share a timestamp the person's counts, so a reply always clears the mark. */
function latestOf(thread: readonly MarkComment[]): MarkComment | undefined {
  let latest: MarkComment | undefined
  for (const message of thread) {
    if (!latest || message.at > latest.at || (message.at === latest.at && message.fromKind !== 'agent')) {
      latest = message
    }
  }
  return latest
}

/**
 * Needs you: an open thread whose newest message is an agent's, and the viewer is part of it. The viewer is part of it
 * when they wrote the root, replied, were @mentioned, or own the canvas.
 */
export function threadNeedsViewer(root: MarkComment, replies: readonly MarkComment[], viewer: MarkViewer): boolean {
  if (root.parentId || root.resolvedAt) return false
  const thread = [root, ...replies]
  if (latestOf(thread)?.fromKind !== 'agent') return false
  return (
    viewer.ownsCanvas ||
    thread.some((message) => writtenByViewer(message, viewer)) ||
    thread.some((message) => message.mentions?.includes(viewer.userId))
  )
}

/** Frame ids with a thread waiting on the viewer. */
export function askFrameIds(comments: readonly MarkComment[], viewer: MarkViewer): Set<string> {
  const repliesOf = new Map<string, MarkComment[]>()
  for (const comment of comments) {
    if (!comment.parentId) continue
    const list = repliesOf.get(comment.parentId)
    if (list) list.push(comment)
    else repliesOf.set(comment.parentId, [comment])
  }
  const asks = new Set<string>()
  for (const root of comments) {
    if (!root.parentId && !asks.has(root.frameId) && threadNeedsViewer(root, repliesOf.get(root.id) ?? [], viewer)) {
      asks.add(root.frameId)
    }
  }
  return asks
}

/** The mark of every frame that has one. Pass `undefined` input (no user, or the seen state has not loaded) for none. */
export function computeMarks(
  frames: readonly MarkFrame[],
  comments: readonly MarkComment[],
  input: MarkInput | undefined,
): Record<string, Mark> {
  const marks: Record<string, Mark> = {}
  if (!input) return marks
  const asks = askFrameIds(comments, input.viewer)
  for (const frame of frames) {
    if (asks.has(frame.id)) marks[frame.id] = 'ask'
    else if (isNewFrame(frame, input)) marks[frame.id] = 'new'
  }
  return marks
}

/** The stronger of two marks: orange beats blue. */
export function strongerMark(a: Mark | undefined, b: Mark | undefined): Mark | undefined {
  return a === 'ask' || b === 'ask' ? 'ask' : (a ?? b)
}

/** The page ids each marked frame lives on, folded to the strongest mark per page. */
export function pageMarks(
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>,
  marks: Readonly<Record<string, Mark>>,
): Record<string, Mark> {
  const byPage: Record<string, Mark> = {}
  for (const frame of canvas.frames) {
    const mark = marks[frame.id]
    if (!mark) continue
    const pageId = framePageId(canvas, frame)
    byPage[pageId] = strongerMark(byPage[pageId], mark) ?? mark
  }
  return byPage
}

/** Every frame in the order a person reads the canvas: pages as the page tree lists them, then each page row by row. */
export function reviewOrder(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>): Frame[] {
  return normalizePageTree(canvasPages(canvas)).flatMap((page) =>
    readingOrder(canvas.frames.filter((frame) => framePageId(canvas, frame) === page.id)),
  )
}

/**
 * Where `u` goes next. Orange first: the next needs-you frame after the current one, in reading order across pages.
 * With none ahead, the next new frame (wrapping to the first, since visiting clears a blue mark). With no blue left,
 * the needs-you frames before the current one. Undefined when nothing but the current frame is marked.
 */
export function nextMarked(
  order: readonly { id: string }[],
  marks: Readonly<Record<string, Mark>>,
  currentId: string | null | undefined,
): string | undefined {
  const at = currentId ? order.findIndex((frame) => frame.id === currentId) : -1
  const ahead = order.slice(at + 1)
  const behind = order.slice(0, Math.max(at, 0))
  const pick = (frames: readonly { id: string }[], mark: Mark) => frames.find((f) => marks[f.id] === mark)?.id
  return pick(ahead, 'ask') ?? pick([...ahead, ...behind], 'new') ?? pick(behind, 'ask')
}

/** Below this zoom a frame is a thumbnail, not something being read. */
export const MIN_READING_ZOOM = 0.5
/** How long a frame must stay in view before it counts as seen. */
export const DWELL_MS = 2000

/**
 * Whether the camera is looking at the frame: zoomed in enough to read, and at least half the frame inside the stage.
 * A frame bigger than the stage can never show half of itself, so it counts once half of the stage is covered by it.
 * `viewport` maps world to screen as `screen = world * zoom + (x, y)`.
 */
export function isBeingViewed(
  frame: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
  stage: { width: number; height: number },
): boolean {
  if (viewport.zoom < MIN_READING_ZOOM || frame.width <= 0 || frame.height <= 0) return false
  const left = frame.x * viewport.zoom + viewport.x
  const top = frame.y * viewport.zoom + viewport.y
  const width = frame.width * viewport.zoom
  const height = frame.height * viewport.zoom
  const overlapX = Math.min(left + width, stage.width) - Math.max(left, 0)
  const overlapY = Math.min(top + height, stage.height) - Math.max(top, 0)
  if (overlapX <= 0 || overlapY <= 0) return false
  return overlapX * overlapY >= Math.min(width * height, stage.width * stage.height) / 2
}

/** "3 need you · 5 new", or an empty string when nothing is marked. */
export function marksSummary(marks: Readonly<Record<string, Mark>>): string {
  let ask = 0
  let fresh = 0
  for (const mark of Object.values(marks)) {
    if (mark === 'ask') ask++
    else fresh++
  }
  return [ask > 0 && `${ask} need${ask === 1 ? 's' : ''} you`, fresh > 0 && `${fresh} new`].filter(Boolean).join(' · ')
}
