import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notePageId } from '../shared/notes'
import type { Actor, Canvas, CanvasNote, Frame, ServerMessage } from '../shared/types'
import { parseInline, parseMarkdown, safeLink } from '../src/lib/noteMarkdown'
import { useStore } from '../src/lib/store'
import { connect, disconnect } from '../src/lib/ws'

/* The client keeps notes inside `canvas`; the socket's note messages and a
   frame's removal or drag are the only things that change them from outside. */

const actor: Actor = { name: 'Claude', kind: 'agent', color: '#000' }

const frame = (id: string, x = 500, y = 200, pageId?: string): Frame => ({
  id,
  canvasId: 'c1',
  name: id,
  x,
  y,
  width: 300,
  height: 200,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'u',
  ...(pageId ? { pageId } : {}),
})

const note = (id: string, over: Partial<CanvasNote> = {}): CanvasNote => ({
  id,
  canvasId: 'c1',
  x: 0,
  y: 0,
  width: 240,
  height: 180,
  markdown: id,
  color: 'yellow',
  createdBy: 'Claude',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Claude',
  ...over,
})

class FakeSocket {
  static OPEN = 1
  static last: FakeSocket
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  sent: string[] = []
  constructor() {
    FakeSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  deliver(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

function seed(over: Partial<Canvas> = {}) {
  const canvas: Canvas = { id: 'c1', name: 'C', createdAt: 0, updatedAt: 0, frames: [frame('f1')], ...over }
  useStore.setState({ canvas, activePageId: `${canvas.id}:page1` })
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  seed()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useStore.setState({ canvas: null, editingNoteId: null, foldedNotes: {} })
})

describe('note messages from the socket', () => {
  const deliver = (msg: ServerMessage) => {
    connect('c1')
    FakeSocket.last.deliver(msg)
    disconnect()
  }

  it('note:upsert adds a note, then replaces it in place', () => {
    deliver({ type: 'note:upsert', note: note('n1', { markdown: 'first' }), actor })
    deliver({ type: 'note:upsert', note: note('n2'), actor })
    deliver({ type: 'note:upsert', note: note('n1', { markdown: 'second', x: 9 }), actor })
    const notes = useStore.getState().canvas?.notes
    expect(notes?.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(notes?.[0]).toMatchObject({ markdown: 'second', x: 9 })
  })

  it('note:upsert for another canvas is ignored', () => {
    deliver({ type: 'note:upsert', note: note('n1', { canvasId: 'other' }), actor })
    expect(useStore.getState().canvas?.notes).toBeUndefined()
  })

  it('note:delete removes the note and closes its editor', () => {
    deliver({ type: 'note:upsert', note: note('n1'), actor })
    useStore.getState().setEditingNote('n1')
    deliver({ type: 'note:delete', id: 'n1', actor })
    expect(useStore.getState().canvas?.notes).toEqual([])
    expect(useStore.getState().editingNoteId).toBeNull()
  })

  it('a peer dragging a frame carries its attached notes along live', () => {
    seed({ notes: [note('attached', { frameId: 'f1', x: 236, y: 200 }), note('free', { x: 7, y: 7 })] })
    deliver({ type: 'frame:drag', clientId: 'peer', frameId: 'f1', x: 560, y: 150, width: 300, height: 200 })
    const byId = Object.fromEntries((useStore.getState().canvas?.notes ?? []).map((n) => [n.id, n]))
    expect(byId.attached).toMatchObject({ x: 296, y: 150 })
    expect(byId.free).toMatchObject({ x: 7, y: 7 })
  })

  it('deleting a frame drops the notes attached to it', () => {
    seed({ notes: [note('attached', { frameId: 'f1' }), note('free')] })
    deliver({ type: 'frame:deleted', frameId: 'f1', actor })
    expect(useStore.getState().canvas?.notes?.map((n) => n.id)).toEqual(['free'])
  })
})

describe('notePageId', () => {
  it('puts an attached note on its frame page, a free one on its own, a bare one on the first', () => {
    const canvas: Canvas = {
      id: 'c1',
      name: 'C',
      createdAt: 0,
      updatedAt: 0,
      pages: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' },
      ],
      frames: [frame('f2', 0, 0, 'p2')],
    }
    expect(notePageId(canvas, note('a', { frameId: 'f2', pageId: 'p1' }))).toBe('p2')
    expect(notePageId(canvas, note('b', { pageId: 'p2' }))).toBe('p2')
    expect(notePageId(canvas, note('c'))).toBe('p1')
  })
})

describe('note markdown', () => {
  it('reads headings, lists, tasks, quotes and code into blocks', () => {
    const blocks = parseMarkdown('# Title\n\n- one\n- [x] two\n\n> quoted\n\n```\ncode\n```')
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'list', 'quote', 'code'])
    const list = blocks[1]
    expect(list?.t === 'list' && list.items.map((i) => i.checked)).toEqual([undefined, true])
  })

  it('turns goto: links into frame jumps and keeps http links', () => {
    expect(parseInline('see [the hero](goto:abc_123)')[1]).toMatchObject({ t: 'goto', frameId: 'abc_123' })
    expect(parseInline('[docs](https://doop.dev/x)')[0]).toMatchObject({ t: 'link', href: 'https://doop.dev/x' })
  })

  it('never lets a script or data link through, and shows raw HTML as text', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('data:text/html,<b>x</b>')).toBeNull()
    const refused = parseInline('[x](javascript:alert(1))')
    expect(refused.every((node) => node.t === 'text')).toBe(true)
    const [para] = parseMarkdown('<img src=x onerror=alert(1)>')
    expect(para).toMatchObject({ t: 'paragraph', children: [{ t: 'text', text: '<img src=x onerror=alert(1)>' }] })
  })

  it('leaves snake_case and stray markers alone', () => {
    expect(parseInline('use my_var_name and 2 * 3')).toEqual([{ t: 'text', text: 'use my_var_name and 2 * 3' }])
  })
})
