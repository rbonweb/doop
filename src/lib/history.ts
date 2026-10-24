import { applyPageChanges, canvasPages, samePages } from '../../shared/pages'
import type { CanvasNote, CanvasPageInfo, Frame } from '../../shared/types'
import { api, type NoteDraft, type NotePatch } from './api'
import { useStore } from './store'
import { posthog } from './posthog'

/** Local undo/redo for this client's own frame edits. Undo re-issues the
 *  inverse through the normal API, so every collaborator sees it live —
 *  remote actors' work is never undone from here. */

type Patch = Partial<
  Pick<
    Frame,
    'name' | 'pageId' | 'html' | 'x' | 'y' | 'width' | 'height' | 'hidden' | 'locked' | 'slide' | 'speakerNotes'
  >
>
type Snapshot = Pick<
  Frame,
  'canvasId' | 'pageId' | 'name' | 'html' | 'x' | 'y' | 'width' | 'height' | 'hidden' | 'locked'
> &
  Partial<Pick<Frame, 'slide' | 'speakerNotes'>>

type Entry =
  | {
      type: 'pages'
      canvasId: string
      before: CanvasPageInfo[]
      after: CanvasPageInfo[]
      activeBefore: string | null
      activeAfter: string | null
    }
  | { type: 'update'; frameId: string; before: Patch; after: Patch; at: number; discrete?: boolean }
  | { type: 'create'; frameId: string; snapshot: Snapshot }
  | { type: 'delete'; frameId: string; snapshot: Snapshot }
  /* sticky notes: a note is recreated under a fresh id like a frame is */
  | { type: 'note-update'; noteId: string; before: NotePatch; after: NotePatch }
  | { type: 'note-create'; noteId: string; canvasId: string; draft: NoteDraft }
  | { type: 'note-delete'; noteId: string; canvasId: string; draft: NoteDraft }
  /* Destination first, then source removal; reverse that order on undo so
     a failed request can never remove the only copy of a drawing. */
  | { type: 'transfer'; canvasId: string; entries: Entry[] }
  /* one multi-frame action (a group move, a group delete): undone and
     redone as a unit. An `ordered` group's members depend on each other (a
     page and the frames on it), so they run one after another: forward on
     redo, backwards on undo. */
  | { type: 'group'; entries: Entry[]; ordered?: boolean }

const MAX = 100
/* consecutive edits to the same fields land as one entry within this window
   (the Inspector autosaves every 700ms while typing) */
const COALESCE_MS = 1500

let undoStack: Entry[] = []
let redoStack: Entry[] = []
let busy = false
/* saves still in flight from a drag: undo/redo wait for them so the inverse
   write never lands before (and gets overwritten by) the original */
let inflight: Promise<unknown> = Promise.resolve()

export function trackSave(p: Promise<unknown>) {
  inflight = inflight.then(() => p.catch(() => undefined))
}

export function clearHistory() {
  undoStack = []
  redoStack = []
}

function push(entry: Entry) {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack = []
}

function snapshot(f: Frame): Snapshot {
  return {
    canvasId: f.canvasId,
    pageId: f.pageId,
    name: f.name,
    html: f.html,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    ...(f.slide ? { slide: true } : {}),
    ...(f.speakerNotes ? { speakerNotes: f.speakerNotes } : {}),
    /* a hidden or locked frame comes back as it was when its deletion is undone */
    hidden: f.hidden,
    locked: f.locked,
  }
}

type UpdateEntry = Extract<Entry, { type: 'update' }>

function updateEntry(frameId: string, before: Patch, after: Patch): UpdateEntry | null {
  const keys = (Object.keys(after) as (keyof Patch)[]).filter((k) => before[k] !== after[k])
  if (!keys.length) return null
  const b: Patch = {}
  const a: Patch = {}
  for (const k of keys) {
    b[k] = before[k] as never
    a[k] = after[k] as never
  }
  return { type: 'update', frameId, before: b, after: a, at: Date.now() }
}

export function recordUpdate(frameId: string, before: Patch, after: Patch, discrete = false) {
  const entry = updateEntry(frameId, before, after)
  if (!entry) return
  entry.discrete = discrete
  const keys = Object.keys(entry.after) as (keyof Patch)[]
  const top = undoStack[undoStack.length - 1]
  if (
    top?.type === 'update' &&
    !discrete &&
    !top.discrete &&
    top.frameId === frameId &&
    Date.now() - top.at < COALESCE_MS &&
    keys.every((k) => k in top.after)
  ) {
    /* merge a burst of saves: keep the oldest before, the newest after */
    top.after = { ...top.after, ...entry.after }
    top.at = Date.now()
    redoStack = []
    return
  }
  push(entry)
}

/** Several frames moved together (a group drag): one undo step. */
export function recordUpdates(items: { frameId: string; before: Patch; after: Patch }[]) {
  const entries = items.map((i) => updateEntry(i.frameId, i.before, i.after)).filter((e): e is UpdateEntry => !!e)
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
}

/* a note's id changes when undo recreates it, so entries address it by id and follow remaps */
function noteDraft(n: CanvasNote): NoteDraft {
  const { pageId, frameId, x, y, width, height, markdown, color } = n
  return { pageId, frameId, x, y, width, height, markdown, color }
}

/** A note moved, resized, recoloured or rewritten: one undo step. */
export function recordNoteUpdate(noteId: string, before: NotePatch, after: NotePatch) {
  const keys = (Object.keys(after) as (keyof NotePatch)[]).filter((k) => before[k] !== after[k])
  if (!keys.length) return
  const b: NotePatch = {}
  const a: NotePatch = {}
  for (const k of keys) {
    b[k] = before[k] as never
    a[k] = after[k] as never
  }
  push({ type: 'note-update', noteId, before: b, after: a })
}

export function recordNoteCreate(note: CanvasNote) {
  push({ type: 'note-create', noteId: note.id, canvasId: note.canvasId, draft: noteDraft(note) })
}

/** Take back the undo entry for a note that was discarded before it held anything. */
export function forgetNoteCreate(noteId: string) {
  const top = undoStack[undoStack.length - 1]
  if (top?.type === 'note-create' && top.noteId === noteId) undoStack.pop()
}

/** Delete a note through the API, remembering enough to bring it back. */
export function deleteNoteTracked(note: CanvasNote) {
  push({ type: 'note-delete', noteId: note.id, canvasId: note.canvasId, draft: noteDraft(note) })
  api.deleteNote(note.id).catch(console.error)
}

export function recordPages(
  canvasId: string,
  before: CanvasPageInfo[],
  after: CanvasPageInfo[],
  activeBefore: string | null,
  activeAfter: string | null,
) {
  if (samePages(before, after)) return
  push({
    type: 'pages',
    canvasId,
    before: before.map((p) => ({ ...p })),
    after: after.map((p) => ({ ...p })),
    activeBefore,
    activeAfter,
  })
}

export function recordCreate(frame: Frame) {
  push({ type: 'create', frameId: frame.id, snapshot: snapshot(frame) })
}

export function recordDrawingTransfer(
  destination: { before: Frame | null; after: Frame },
  source: { before: Frame; after: Frame | null },
) {
  const added: Entry = destination.before
    ? updateEntry(destination.after.id, { html: destination.before.html }, { html: destination.after.html })!
    : { type: 'create', frameId: destination.after.id, snapshot: snapshot(destination.after) }
  const removed: Entry = source.after
    ? updateEntry(source.before.id, { html: source.before.html }, { html: source.after.html })!
    : { type: 'delete', frameId: source.before.id, snapshot: snapshot(source.before) }
  push({ type: 'transfer', canvasId: source.before.canvasId, entries: [added, removed] })
}

/** A page duplicated together with its frames: one undo step that removes
 *  the frames before the page (a page with frames cannot be deleted) and
 *  brings the page back before the frames on redo. */
export function recordPageCopy(
  canvasId: string,
  before: CanvasPageInfo[],
  after: CanvasPageInfo[],
  activeBefore: string | null,
  activeAfter: string | null,
  frames: Frame[],
) {
  if (samePages(before, after)) return
  push({
    type: 'group',
    ordered: true,
    entries: [
      {
        type: 'pages',
        canvasId,
        before: before.map((p) => ({ ...p })),
        after: after.map((p) => ({ ...p })),
        activeBefore,
        activeAfter,
      },
      ...frames.map((f): Entry => ({ type: 'create', frameId: f.id, snapshot: snapshot(f) })),
    ],
  })
}

/** Several frames created together (a multi-frame paste): one undo step. */
export function recordCreates(frames: Frame[]) {
  if (!frames.length) return
  const entries: Entry[] = frames.map((f) => ({ type: 'create', frameId: f.id, snapshot: snapshot(f) }))
  const [first] = entries
  push(entries.length === 1 && first ? first : { type: 'group', entries })
}

/** Delete a frame through the API, remembering enough to bring it back. */
export function deleteFrameTracked(frame: Frame) {
  deleteFramesTracked([frame])
}

/** Delete several frames as one undo step. */
export function deleteFramesTracked(frames: Frame[]) {
  const entries: Entry[] = frames.map((f) => ({ type: 'delete', frameId: f.id, snapshot: snapshot(f) }))
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
  for (const f of frames) api.deleteFrame(f.id).catch(console.error)
}

/* undoing a delete recreates the frame under a fresh server id — every
   other entry that pointed at the old id must follow it */
function remapId(oldId: string, newId: string) {
  const visit = (e: Entry) => {
    if (e.type === 'group' || e.type === 'transfer') e.entries.forEach(visit)
    else if (e.type === 'pages') return
    else if (e.type === 'note-update' || e.type === 'note-create' || e.type === 'note-delete') {
      if (e.noteId === oldId) e.noteId = newId
      /* an attached note's draft names its frame, which may itself have been recreated */
      if (e.type !== 'note-update' && e.draft.frameId === oldId) e.draft.frameId = newId
    } else if (e.frameId === oldId) e.frameId = newId
  }
  for (const e of [...undoStack, ...redoStack]) visit(e)
}

async function recreate(e: { frameId: string; snapshot: Snapshot }) {
  const { canvasId, ...rest } = e.snapshot
  const canvas = useStore.getState().canvas
  if (!canvas || canvas.id !== canvasId) throw new Error('Canvas changed')
  const pages = canvasPages(canvas)
  if (!rest.pageId || !pages.some((p) => p.id === rest.pageId)) rest.pageId = pages[0]!.id
  const f = await api.createFrame(canvasId, rest)
  useStore.getState().upsertFrame(f)
  remapId(e.frameId, f.id)
  e.frameId = f.id
}

/* Recreated frames and frames moved between pages become the selection,
   so undo/redo displays the page where the affected designs now live. */
function selectionIds(e: Entry, direction: 'undo' | 'redo'): string[] {
  if (e.type === 'group' || e.type === 'transfer') return e.entries.flatMap((child) => selectionIds(child, direction))
  if (e.type === 'pages' || e.type === 'note-update' || e.type === 'note-create' || e.type === 'note-delete') return []
  if (e.type === 'update' && 'pageId' in (direction === 'redo' ? e.after : e.before)) return [e.frameId]
  const recreated = e.type === (direction === 'redo' ? 'create' : 'delete')
  return recreated ? [e.frameId] : []
}

/* A step whose prerequisite failed is not lost: `remaining` goes back on the
   stack it came from for another try, `applied` (what did land before the
   failure) on the opposite stack so it stays reversible. */
class PrerequisiteFailed extends Error {
  constructor(
    readonly remaining: Entry,
    readonly applied: Entry | null,
    cause: unknown,
    readonly canvasId?: string,
  ) {
    super(cause instanceof Error ? cause.message : 'Could not apply the page change', { cause })
  }
}

/* The canvas a page change belongs to: a pages entry's own, or the one its
   ordered group leads with. */
function pagesCanvasId(e: Entry): string | undefined {
  if (e.type === 'pages') return e.canvasId
  const [first] = e.type === 'group' ? e.entries : []
  return first ? pagesCanvasId(first) : undefined
}

/* The members of a group that took effect, in the group's order. */
async function settle(entries: Entry[], direction: 'undo' | 'redo'): Promise<Entry[]> {
  const results = await Promise.allSettled(entries.map((child) => apply(child, direction)))
  const ok = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) console.error(`${direction} failed for ${entries.length - ok.length} frame(s)`, failed.reason)
  return ok
}

function groupOf(entries: Entry[], ordered: boolean): Entry | null {
  const [first, ...rest] = entries
  if (!first) return null
  return rest.length ? { type: 'group', entries, ...(ordered ? { ordered: true } : {}) } : first
}

/* An ordered group's first member is the prerequisite of the rest (the page
   the frames live on). Redo applies it first and goes no further when it
   fails, so no frame is recreated on the wrong page. Undo removes the frames
   first; a page that then cannot be removed keeps the still-present frames
   with it for the next try. */
async function applyOrdered(entries: Entry[], direction: 'undo' | 'redo'): Promise<Entry | null> {
  const [prerequisite, ...dependents] = entries
  if (!prerequisite) return null
  if (direction === 'redo') {
    let first: Entry | null
    try {
      first = await apply(prerequisite, 'redo')
    } catch (err) {
      throw new PrerequisiteFailed(groupOf(entries, true)!, null, err)
    }
    const ok = await settle(dependents, 'redo')
    return groupOf(first ? [first, ...ok] : ok, true)
  }
  const ok = await settle(dependents, 'undo')
  try {
    const first = await apply(prerequisite, 'undo')
    return groupOf(first ? [first, ...ok] : ok, true)
  } catch (err) {
    const left = dependents.filter((child) => !ok.includes(child))
    throw new PrerequisiteFailed(groupOf([prerequisite, ...left], true)!, groupOf(ok, false), err)
  }
}

/* Apply an entry and report which of its members took effect. A group's
   frames are independent, so every member is attempted even if one fails;
   the survivors are what the opposite stack gets, so a partially failed
   group can still be reversed. Failed members are dropped, exactly as a
   failed single entry is: the frame is gone or the canvas moved on. */
async function apply(e: Entry, direction: 'undo' | 'redo'): Promise<Entry | null> {
  if (e.type === 'transfer') {
    const entries = direction === 'redo' ? e.entries : [...e.entries].reverse()
    const applied: Entry[] = []
    for (const child of entries) {
      try {
        await apply(child, direction)
        applied.push(child)
      } catch (err) {
        // Leave a partially applied transfer reversible and retryable. Never
        // remove the source when saving/recreating its destination failed.
        const remaining = { ...e, entries: e.entries.filter((entry) => !applied.includes(entry)) }
        throw new PrerequisiteFailed(remaining, groupOf(applied, false), err, e.canvasId)
      }
    }
    return e
  }
  if (e.type === 'group') {
    if (e.ordered) return applyOrdered(e.entries, direction)
    return groupOf(await settle(e.entries, direction), false)
  }
  const forward = direction === 'redo'
  if (e.type === 'pages') {
    const state = useStore.getState()
    const canvas = state.canvas
    if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
    const expected = canvasPages(canvas)
    const next = applyPageChanges(expected, forward ? e.before : e.after, forward ? e.after : e.before)
    const saved = await api.setPages(canvas.id, next, expected)
    const current = useStore.getState()
    if (current.canvas?.id !== e.canvasId) throw new Error('Canvas changed')
    if (samePages(canvasPages(current.canvas), expected) || samePages(canvasPages(current.canvas), saved)) {
      current.setPages(saved, canvas.id)
      const active = forward ? e.activeAfter : e.activeBefore
      if (active) current.setActivePage(active)
    }
  } else if (e.type === 'note-update') {
    const patch = forward ? e.after : e.before
    const note = useStore.getState().canvas?.notes?.find((n) => n.id === e.noteId)
    const rollback = note
      ? (Object.fromEntries(Object.keys(patch).map((key) => [key, note[key as keyof CanvasNote]])) as NotePatch)
      : patch
    useStore.getState().patchNoteLocal(e.noteId, patch)
    try {
      await api.updateNote(e.noteId, patch)
    } catch (err) {
      useStore.getState().patchNoteLocal(e.noteId, rollback)
      throw err
    }
  } else if (e.type === 'note-create' || e.type === 'note-delete') {
    if ((e.type === 'note-create') === forward) {
      const canvas = useStore.getState().canvas
      if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
      const note = await api.createNote(e.canvasId, e.draft)
      useStore.getState().upsertNote(note)
      remapId(e.noteId, note.id)
      e.noteId = note.id
    } else {
      await api.deleteNote(e.noteId)
    }
  } else if (e.type === 'update') {
    const patch = { ...(forward ? e.after : e.before) }
    const canvas = useStore.getState().canvas
    if (patch.pageId !== undefined && canvas) {
      const pages = canvasPages(canvas)
      if (!pages.some((page) => page.id === patch.pageId)) patch.pageId = pages[0]!.id
    }
    const frame = canvas?.frames.find((frame) => frame.id === e.frameId)
    const rollback = frame
      ? (Object.fromEntries(Object.keys(patch).map((key) => [key, frame[key as keyof Frame]])) as Patch)
      : forward
        ? e.before
        : e.after
    useStore.getState().patchFrameLocal(e.frameId, patch)
    try {
      await api.updateFrame(e.frameId, patch)
      // Remember the actual fallback so the opposite operation stays reversible.
      if (forward) e.after = patch
      else e.before = patch
    } catch (err) {
      /* the server kept the old value — put the local copy back in step
         with it rather than leave a client-only position behind */
      useStore.getState().patchFrameLocal(e.frameId, rollback)
      throw err
    }
  } else if ((e.type === 'create') === forward) {
    await recreate(e)
  } else {
    await api.deleteFrame(e.frameId)
    useStore.getState().removeFrame(e.frameId)
  }
  return e
}

async function step(direction: 'undo' | 'redo') {
  if (busy) return
  busy = true
  let entry: Entry | undefined
  try {
    await inflight
    const from = direction === 'undo' ? undoStack : redoStack
    entry = from.pop()
    if (!entry) return
    const applied = await apply(entry, direction)
    if (applied) {
      const to = direction === 'undo' ? redoStack : undoStack
      to.push(applied)
      const ids = selectionIds(applied, direction)
      if (ids.length) useStore.getState().selectMany(ids)
      posthog.capture(direction === 'undo' ? 'canvas_undo' : 'canvas_redo')
    }
  } catch (err) {
    /* a page change that did not land stays on its stack for another try */
    const retry =
      err instanceof PrerequisiteFailed
        ? err
        : entry?.type === 'pages'
          ? new PrerequisiteFailed(entry, null, err)
          : null
    if (retry && (retry.canvasId ?? pagesCanvasId(retry.remaining)) === useStore.getState().canvas?.id) {
      const from = direction === 'undo' ? undoStack : redoStack
      from.push(retry.remaining)
      if (retry.applied) (direction === 'undo' ? redoStack : undoStack).push(retry.applied)
      useStore.getState().pushNotice(retry.message)
    }
    /* the frame is gone or the canvas moved on — drop the entry */
    console.error(`${direction} failed`, err)
  } finally {
    busy = false
  }
}

export function undo() {
  return step('undo')
}

export function redo() {
  return step('redo')
}
