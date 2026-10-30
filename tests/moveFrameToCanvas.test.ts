import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame, FrameVersion, FrameVersionInfo, ServerMessage } from '../shared/types.ts'

/* The action layer and the in-memory store run for real; only the database is replaced. The version list behaves
 * like the real table, including the re-pointing a move does, so the history can be read back after it. */
const saved: FrameVersion[] = []
const moves: { frameId: string; canvasId: string; noteIds: string[] }[] = []

vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  const writes = [
    'saveCanvas',
    'saveCanvasCopy',
    'saveFrame',
    'saveNote',
    'saveActivity',
    'saveTask',
    'saveFeedback',
    'saveComment',
    'saveMember',
    'saveGuideline',
    'saveReference',
    'saveDecision',
    'saveProposal',
    'deleteCanvas',
    'deleteFrame',
    'deleteNote',
    'deleteMember',
    'deleteGuideline',
    'deleteReference',
  ]
  return {
    ...Object.fromEntries(writes.map((name) => [name, noop])),
    saveFrameVersion: (v: FrameVersion) => {
      saved.push(v)
    },
    saveFrameMove: (frame: Frame, notes: { id: string }[]) => {
      moves.push({ frameId: frame.id, canvasId: frame.canvasId, noteIds: notes.map((n) => n.id) })
      for (const v of saved) if (v.frameId === frame.id) v.canvasId = frame.canvasId
    },
    listFrameVersions: (frameId: string): Promise<FrameVersionInfo[]> =>
      Promise.resolve(
        saved
          .filter((v) => v.frameId === frameId)
          .sort((a, b) => b.savedAt - a.savedAt)
          .map(({ html: _html, ...info }) => info),
      ),
    getFrameVersion: (frameId: string, id: string) =>
      Promise.resolve(saved.find((v) => v.id === id && v.frameId === frameId)),
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const persist = await import('../server/db/persist.ts')

const OWNER = 'owner-1'
const human = actions.resolveActor({ name: 'Ada', kind: 'user', userId: OWNER })

let sent: { canvasId: string; msg: ServerMessage }[]
let sourceId: string
let targetId: string
let frame: Frame

beforeEach(() => {
  sent = []
  saved.length = 0
  moves.length = 0
  actions.wire(
    (canvasId, msg) => {
      sent.push({ canvasId, msg })
    },
    () => {},
  )
  for (const c of store.allCanvases()) store.deleteCanvas(c.id)
  sourceId = store.createCanvas('Source', OWNER).id
  targetId = store.createCanvas('Target', OWNER).id
  frame = actions.createFrame(
    sourceId,
    { name: 'Hero', x: 600, y: 300, width: 400, height: 300, html: '<p>v0</p>', slide: true, speakerNotes: 'say hi' },
    human,
  )!
  sent = []
})

const messagesTo = (canvasId: string) =>
  sent.filter((s) => s.canvasId === canvasId && s.msg.type !== 'activity').map((s) => s.msg)

describe('moveFrameToCanvas', () => {
  it('moves the frame, keeping its id and design and changing its canvas and page', () => {
    actions.updateFrame(frame.id, { locked: true, hidden: true }, human)
    const targetPage = store.getCanvas(targetId)!.pages![0]!.id
    const result = actions.moveFrameToCanvas(frame.id, targetId, { x: 40, y: 50 }, human)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame).toMatchObject({
      id: frame.id,
      canvasId: targetId,
      pageId: targetPage,
      x: 40,
      y: 50,
      width: 400,
      height: 300,
      html: '<p>v0</p>',
      name: 'Hero',
      slide: true,
      speakerNotes: 'say hi',
      hidden: true,
      locked: true,
    })
    expect(result.frame.updatedAt).toBeGreaterThan(frame.createdAt)
    expect(store.getFrame(frame.id)?.canvasId).toBe(targetId)
    expect(store.getCanvas(sourceId)!.frames.map((f) => f.id)).toEqual([])
    expect(store.getCanvas(targetId)!.frames.map((f) => f.id)).toEqual([frame.id])
    expect(moves).toEqual([{ frameId: frame.id, canvasId: targetId, noteIds: [] }])
  })

  it('places a frame to the right of the target page when no position is given', () => {
    actions.createFrame(targetId, { name: 'Existing', x: 100, y: 200, width: 500, height: 400 }, human)
    const result = actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    expect(result.ok && [result.frame.x, result.frame.y]).toEqual([680, 120])
  })

  it('lands on the first spot of an empty target page and honours a single coordinate', () => {
    const empty = actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    expect(empty.ok && [empty.frame.x, empty.frame.y]).toEqual([120, 120])

    const other = actions.createFrame(sourceId, { name: 'Other', width: 200, height: 100 }, human)!
    const half = actions.moveFrameToCanvas(other.id, targetId, { y: 700 }, human)
    expect(half.ok && [half.frame.x, half.frame.y]).toEqual([120 + 400 + 80, 700])
  })

  it('moves onto the page asked for', () => {
    const pages = [...store.getCanvas(targetId)!.pages!, { id: 'p2', name: 'Page 2' }]
    actions.setCanvasPages(targetId, pages, human)
    const result = actions.moveFrameToCanvas(frame.id, targetId, { pageId: 'p2' }, human)
    expect(result.ok && result.frame.pageId).toBe('p2')
  })

  it('takes attached sticky notes along, shifted by the frame delta, and leaves free notes behind', () => {
    const attached = actions.createNote(sourceId, { markdown: 'on hero', frameId: frame.id, x: 1050, y: 310 }, human)
    const free = actions.createNote(sourceId, { markdown: 'free', x: 5, y: 5 }, human)
    if (!attached.ok || !free.ok) throw new Error('notes not created')
    sent = []

    const result = actions.moveFrameToCanvas(frame.id, targetId, { x: 100, y: 100 }, human)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dx = 100 - 600
    const dy = 100 - 300
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toMatchObject({
      id: attached.note.id,
      frameId: frame.id,
      canvasId: targetId,
      pageId: result.frame.pageId,
      x: 1050 + dx,
      y: 310 + dy,
    })
    expect(store.getNotes(sourceId).map((n) => n.id)).toEqual([free.note.id])
    expect(store.getNotes(targetId).map((n) => n.id)).toEqual([attached.note.id])
    expect(moves[0]?.noteIds).toEqual([attached.note.id])
  })

  it('keeps the version history readable and filed under the new canvas', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human, { replace: true })
    expect(await persist.listFrameVersions(frame.id)).toHaveLength(1)

    actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    const versions = await persist.listFrameVersions(frame.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ frameId: frame.id, canvasId: targetId })

    /* a later edit files its version under the frame's new canvas, and a restore still works */
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, human, { replace: true })
    expect(saved.map((v) => v.canvasId)).toEqual([targetId, targetId])
    const restored = await actions.restoreFrameVersion(frame.id, versions[0]!.id, human)
    expect(restored && 'frame' in restored && restored.frame.html).toBe('<p>v0</p>')
  })

  it('tells both rooms and logs the move on both canvases', () => {
    const note = actions.createNote(sourceId, { markdown: 'n', frameId: frame.id }, human)
    if (!note.ok) throw new Error('note not created')
    sent = []
    const result = actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    if (!result.ok) throw new Error(result.error)

    expect(messagesTo(sourceId)).toEqual([
      { type: 'frame:deleted', frameId: frame.id, actor: human },
      { type: 'note:delete', id: note.note.id, actor: human },
    ])
    expect(messagesTo(targetId)).toEqual([
      { type: 'frame:created', frame: result.frame, actor: human },
      { type: 'note:upsert', note: result.notes[0], actor: human },
    ])
    expect(actions.getActivity(sourceId)[0]?.message).toBe('moved “Hero” to Target')
    expect(actions.getActivity(targetId)[0]?.message).toBe('moved in “Hero” from Source')
  })

  it('moves the comment threads pinned to the frame', () => {
    const root = actions.addElementComment(frame.id, { selector: 'p', snippet: 'v0', text: 'nice' }, 'Ada', OWNER)!
    const reply = actions.replyToComment(root.id, 'thanks', 'Bo')!
    const elsewhere = actions.addCanvasComment(
      sourceId,
      { pageId: store.getCanvas(sourceId)!.pages![0]!.id, x: 1, y: 1, text: 'free' },
      'Ada',
    )!

    actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    expect(
      actions
        .getComments(targetId)
        .map((c) => c.id)
        .sort(),
    ).toEqual([root.id, reply.id].sort())
    expect(actions.getComments(targetId).every((c) => c.canvasId === targetId)).toBe(true)
    expect(actions.getComments(sourceId).map((c) => c.id)).toEqual([elsewhere.id])
  })

  it('caps the target canvas comment list at 100 after the merge, keeping the newest', () => {
    const page = store.getCanvas(targetId)!.pages![0]!.id
    for (let i = 0; i < 100; i++) {
      actions.addCanvasComment(targetId, { pageId: page, x: 1, y: 1, text: `t${i}` }, 'Ada')
    }
    const root = actions.addElementComment(frame.id, { selector: 'p', snippet: 'v0', text: 'moved' }, 'Ada', OWNER)!
    expect(actions.getComments(targetId)).toHaveLength(100)

    actions.moveFrameToCanvas(frame.id, targetId, {}, human)
    const merged = actions.getComments(targetId)
    expect(merged).toHaveLength(100)
    expect(merged.some((c) => c.id === root.id)).toBe(true)
    expect(merged.map((c) => c.at)).toEqual([...merged.map((c) => c.at)].sort((a, b) => b - a))
  })

  it('refuses a missing frame, canvas or page, the same canvas, and demo frames', () => {
    expect(actions.moveFrameToCanvas('nope', targetId, {}, human)).toMatchObject({ ok: false, status: 404 })
    expect(actions.moveFrameToCanvas(frame.id, 'nope', {}, human)).toMatchObject({ ok: false, status: 404 })
    expect(actions.moveFrameToCanvas(frame.id, sourceId, {}, human)).toMatchObject({ ok: false, status: 409 })
    expect(actions.moveFrameToCanvas(frame.id, targetId, { pageId: 'missing' }, human)).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(actions.moveFrameToCanvas(frame.id, targetId, { x: Number.NaN }, human)).toMatchObject({
      ok: false,
      status: 400,
    })
    const demo = actions.createFrame(sourceId, { name: 'Demo', demo: true }, human)!
    sent = []
    expect(actions.moveFrameToCanvas(demo.id, targetId, {}, human)).toMatchObject({ ok: false, status: 400 })

    /* nothing changed along the way */
    expect(store.getFrame(frame.id)?.canvasId).toBe(sourceId)
    expect(moves).toEqual([])
    expect(sent.filter((s) => s.msg.type !== 'activity')).toEqual([])
  })
})
