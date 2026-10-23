import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { CanvasNote, ElementComment, Frame, FrameVersionInfo } from '../shared/types.ts'

/**
 * Roles on the entry points that frame history, sticky notes, comment anchors, review marks and pages added, against
 * the REAL server (see ./harness.ts): reading takes view, healing a pin takes comment, anything that changes the design
 * takes edit, and the realtime socket shows view-only people the notes without letting them send a change.
 */

const PORT = 5072

let server: Server

type Msg = { type: string; [key: string]: unknown }

/** a canvas room connection that records everything the server says */
class Room {
  messages: Msg[] = []
  init: Msg | null = null
  private ws: WebSocket
  private ready: Promise<void>

  constructor(canvasId: string, cookie: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } })
    this.ready = new Promise((resolve) => {
      this.ws.on('open', () =>
        this.ws.send(
          JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 'tester', kind: 'user' }),
        ),
      )
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Msg
        this.messages.push(msg)
        if (msg.type === 'init') {
          this.init = msg
          resolve()
        }
      })
      this.ws.on('close', () => resolve())
      this.ws.on('error', () => {})
    })
  }

  joined() {
    return this.ready
  }

  send(msg: Msg) {
    this.ws.send(JSON.stringify(msg))
  }

  async waitFor(type: string, ms = 2000): Promise<Msg | undefined> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = this.messages.find((m) => m.type === type)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 25))
    }
    return undefined
  }

  async settle(ms = 400) {
    await new Promise((r) => setTimeout(r, ms))
  }

  close() {
    this.ws.close()
  }
}

const json = async <T>(res: Response) => (await res.json()) as T

let owner: Client
let viewer: Client
let commenter: Client
let editor: Client
let stranger: Client
let anonymous: Client
let canvasId: string
let frameId: string
let versionId: string
let commentId: string
let noteId: string

beforeAll(async () => {
  server = await startServer(PORT, {
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
  })
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  viewer = await new Client(server).signUp('viewer@test.dev', 'Viewer')
  commenter = await new Client(server).signUp('commenter@test.dev', 'Commenter')
  editor = await new Client(server).signUp('editor@test.dev', 'Editor')
  stranger = await new Client(server).signUp('stranger@test.dev', 'Stranger')
  anonymous = new Client(server)
  canvasId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Enforcement' }))).id
  const frame = await json<Frame>(
    await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero', html: '<h1>v0</h1>' }),
  )
  frameId = frame.id
  for (const [email, role] of [
    ['viewer@test.dev', 'view'],
    ['commenter@test.dev', 'comment'],
    ['editor@test.dev', 'edit'],
  ]) {
    expect((await owner.post(`/api/canvases/${canvasId}/members`, { email, role })).status).toBe(200)
  }
  // two edits so the first one leaves a saved version behind
  expect((await owner.patch(`/api/frames/${frameId}`, { html: '<h1>v1</h1>' })).status).toBe(200)
  const versions = await json<FrameVersionInfo[]>(await owner.get(`/api/frames/${frameId}/versions`))
  versionId = versions[0]!.id
  commentId = (
    await json<ElementComment>(
      await commenter.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'pin' }),
    )
  ).id
  noteId = (
    await json<CanvasNote>(await editor.post(`/api/canvases/${canvasId}/notes`, { markdown: 'first', x: 10, y: 10 }))
  ).id
}, 70_000)

afterAll(() => server?.stop())

const frameNow = async () =>
  (await json<{ frames: Frame[] }>(await owner.get(`/api/canvases/${canvasId}`))).frames.find((f) => f.id === frameId)!

describe('frame history', () => {
  it('lets view, comment and edit read the version list and a version', async () => {
    for (const who of [viewer, commenter, editor, owner]) {
      expect((await who.get(`/api/frames/${frameId}/versions`)).status).toBe(200)
      expect((await who.get(`/api/frames/${frameId}/versions/${versionId}`)).status).toBe(200)
    }
  })

  it('refuses restore to view and comment, and leaves the frame untouched', async () => {
    for (const who of [viewer, commenter]) {
      const res = await who.post(`/api/frames/${frameId}/versions/${versionId}/restore`)
      expect(res.status).toBe(403)
    }
    expect((await frameNow()).html).toBe('<h1>v1</h1>')
  })

  it('refuses a stranger and a signed-out caller everywhere', async () => {
    for (const [who, status] of [
      [stranger, 403],
      [anonymous, 401],
    ] as const) {
      expect((await who.get(`/api/frames/${frameId}/versions`)).status).toBe(status)
      expect((await who.get(`/api/frames/${frameId}/versions/${versionId}`)).status).toBe(status)
      expect((await who.post(`/api/frames/${frameId}/versions/${versionId}/restore`)).status).toBe(status)
    }
  })

  it('lets an editor restore', async () => {
    const res = await editor.post(`/api/frames/${frameId}/versions/${versionId}/restore`)
    expect(res.status).toBe(200)
    expect((await frameNow()).html).toBe('<h1>v0</h1>')
  })
})

describe('sticky notes', () => {
  it('refuses create, update and delete below edit', async () => {
    for (const who of [viewer, commenter]) {
      expect((await who.post(`/api/canvases/${canvasId}/notes`, { markdown: 'nope', x: 1, y: 1 })).status).toBe(403)
      expect((await who.patch(`/api/notes/${noteId}`, { markdown: 'nope' })).status).toBe(403)
      expect((await who.delete(`/api/notes/${noteId}`)).status).toBe(403)
    }
    const canvas = await json<{ notes: CanvasNote[] }>(await owner.get(`/api/canvases/${canvasId}`))
    expect(canvas.notes.map((n) => [n.id, n.markdown])).toEqual([[noteId, 'first']])
  })

  it('refuses a stranger and a signed-out caller', async () => {
    expect((await stranger.post(`/api/canvases/${canvasId}/notes`, { markdown: 'x' })).status).toBe(403)
    expect((await stranger.patch(`/api/notes/${noteId}`, { markdown: 'x' })).status).toBe(403)
    expect((await anonymous.post(`/api/canvases/${canvasId}/notes`, { markdown: 'x' })).status).toBe(401)
  })

  it('lets everyone who can view read the notes with the canvas', async () => {
    for (const who of [viewer, commenter, editor]) {
      const canvas = await json<{ notes: CanvasNote[] }>(await who.get(`/api/canvases/${canvasId}`))
      expect(canvas.notes).toHaveLength(1)
    }
  })

  it('sends note changes to view-only and comment sockets, which cannot send changes of their own', async () => {
    const asViewer = new Room(canvasId, viewer.header())
    const asCommenter = new Room(canvasId, commenter.header())
    try {
      await asViewer.joined()
      await asCommenter.joined()
      const created = await json<CanvasNote>(
        await editor.post(`/api/canvases/${canvasId}/notes`, { markdown: 'live', x: 5, y: 5 }),
      )
      for (const room of [asViewer, asCommenter]) {
        const upsert = await room.waitFor('note:upsert')
        expect((upsert?.note as CanvasNote | undefined)?.id).toBe(created.id)
      }
      expect((await editor.delete(`/api/notes/${created.id}`)).status).toBe(200)
      for (const room of [asViewer, asCommenter]) {
        expect((await room.waitFor('note:delete'))?.id).toBe(created.id)
      }
      /* a socket cannot move a frame or invent a note message */
      asViewer.send({ type: 'frame:drag', frameId, x: 999, y: 999, width: 10, height: 10 })
      asViewer.send({ type: 'note:upsert', note: { ...created, x: 1 } })
      asViewer.send({ type: 'note:delete', id: noteId })
      expect(await asViewer.waitFor('error')).toBeDefined()
      await asViewer.settle()
      expect(asCommenter.messages.some((m) => m.type === 'frame:drag')).toBe(false)
      const canvas = await json<{ notes: CanvasNote[] }>(await owner.get(`/api/canvases/${canvasId}`))
      expect(canvas.notes.map((n) => n.id)).toEqual([noteId])
    } finally {
      asViewer.close()
      asCommenter.close()
    }
  })

  it('lets an editor update and delete', async () => {
    expect((await editor.patch(`/api/notes/${noteId}`, { markdown: 'edited' })).status).toBe(200)
    expect((await editor.delete(`/api/notes/${noteId}`)).status).toBe(200)
  })
})

describe('comment anchor heal', () => {
  const heal = (who: Client) => who.patch(`/api/comments/${commentId}/anchor`, { selector: 'body > h1' })

  it('needs the comment role', async () => {
    expect((await heal(viewer)).status).toBe(403)
    expect((await heal(commenter)).status).toBe(200)
    expect((await heal(editor)).status).toBe(200)
    expect((await heal(owner)).status).toBe(200)
  })

  it('refuses a stranger and a signed-out caller, and a viewer cannot rewrite the pin', async () => {
    expect((await heal(stranger)).status).toBe(403)
    expect((await heal(anonymous)).status).toBe(401)
    const room = new Room(canvasId, owner.header())
    try {
      await room.joined()
      const comments = room.init?.comments as ElementComment[]
      expect(comments.find((c) => c.id === commentId)?.selector).toBe('body > h1')
    } finally {
      room.close()
    }
  })
})

describe('review marks (seen)', () => {
  it('lets anyone who can view read and report what they have seen', async () => {
    for (const who of [viewer, commenter, editor, owner]) {
      expect((await who.get(`/api/canvases/${canvasId}/seen`)).status).toBe(200)
      expect((await who.post(`/api/canvases/${canvasId}/seen`, { frames: {} })).status).toBe(200)
    }
  })

  it('refuses a stranger, and tells a signed-out caller to sign in', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}/seen`)).status).toBe(403)
    expect((await stranger.post(`/api/canvases/${canvasId}/seen`, { frames: {} })).status).toBe(403)
    expect((await anonymous.get(`/api/canvases/${canvasId}/seen`)).status).toBe(401)
    expect((await anonymous.post(`/api/canvases/${canvasId}/seen`, { frames: {} })).status).toBe(401)
  })
})

describe('pages', () => {
  it('refuses the page tree to view and comment, and to a stranger', async () => {
    const body = { pages: [{ id: 'p1', name: 'One' }], expectedPages: [] }
    for (const who of [viewer, commenter, stranger]) {
      const res = await who.req(`/api/canvases/${canvasId}/pages`, { method: 'PUT', body: JSON.stringify(body) })
      expect(res.status).toBe(403)
    }
  })
})
