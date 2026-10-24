import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Sharing roles, access requests, @mentions, guest links and password links,
 * end to end against the REAL server (see ./harness.ts): a child process on a
 * fresh PGlite database, driven over HTTP and WebSocket like the browser.
 * Every role is exercised through every kind of entry point that matters:
 * REST routes, the realtime socket, and the public endpoints a signed-out
 * visitor reaches.
 */

let server: Server

type Msg = { type: string; [key: string]: unknown }

/** A canvas room connection that records everything the server says. */
class Room {
  messages: Msg[] = []
  init: Msg | null = null
  closedWith: Promise<number>
  private ws: WebSocket
  private ready: Promise<void>

  constructor(canvasId: string, cookie: string, name = 'tester') {
    this.ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: cookie } })
    this.closedWith = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)))
    this.ready = new Promise((resolve) => {
      this.ws.on('open', () =>
        this.ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name, kind: 'user' })),
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

  /** resolves once the server answered the join: with init, or by closing */
  async joined(): Promise<Msg | null> {
    await this.ready
    return this.init
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

  /** a short quiet period, to prove something did NOT arrive */
  async settle(ms = 400) {
    await new Promise((r) => setTimeout(r, ms))
  }

  close() {
    this.ws.close()
  }
}

/** a signed-out visitor at a chosen address (the server trusts one proxy hop), so tests do not share a rate-limit budget */
class At extends Client {
  constructor(
    server: Server,
    private ip: string,
  ) {
    super(server)
  }

  override req(pathname: string, init: RequestInit = {}) {
    return super.req(pathname, { ...init, headers: { 'X-Forwarded-For': this.ip, ...init.headers } })
  }
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>

beforeAll(async () => {
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
  })
}, 70_000)

afterAll(() => server?.stop())

describe('sharing roles', () => {
  let owner: Client
  let viewer: Client
  let commenter: Client
  let editor: Client
  let stranger: Client
  let other: Client
  const ids: Record<string, string> = {}
  let canvasId: string
  let frameId: string
  let pageId: string

  beforeAll(async () => {
    owner = await new Client(server).signUp('owner@test.dev', 'Owner')
    viewer = await new Client(server).signUp('viewer@test.dev', 'Viewer')
    commenter = await new Client(server).signUp('commenter@test.dev', 'Commenter')
    editor = await new Client(server).signUp('editor@test.dev', 'Editor')
    stranger = await new Client(server).signUp('stranger@test.dev', 'Stranger')
    other = await new Client(server).signUp('other@test.dev', 'Other')
    for (const [key, client] of Object.entries({ owner, viewer, commenter, editor, stranger, other })) {
      ids[key] = (await json(await client.get('/api/me'))).id as string
    }
    const created = await json(await owner.post('/api/canvases', { name: 'Roles' }))
    canvasId = created.id as string
    pageId = (created.pages as { id: string }[])[0]!.id
    frameId = (await json(await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F1', html: '<h1>Hi</h1>' })))
      .id as string
    for (const [client, role] of [
      ['viewer@test.dev', 'view'],
      ['commenter@test.dev', 'comment'],
      ['editor@test.dev', 'edit'],
    ]) {
      const res = await owner.post(`/api/canvases/${canvasId}/members`, { email: client, role })
      expect(res.status).toBe(200)
      expect((await json(res)).role).toBe(role)
    }
  })

  it('refuses a bad role on invite', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/members`, { email: 'stranger@test.dev', role: 'boss' })
    expect(res.status).toBe(400)
  })

  it('a view role reads everything and changes nothing', async () => {
    expect((await viewer.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect((await viewer.get(`/api/canvases/${canvasId}/sync-flow`)).status).toBe(200)
    const writes: [string, string, unknown][] = [
      ['POST', `/api/canvases/${canvasId}/frames`, { name: 'x' }],
      ['PATCH', `/api/frames/${frameId}`, { name: 'hacked' }],
      ['POST', `/api/frames/${frameId}/append`, { html_chunk: '<p/>' }],
      ['DELETE', `/api/frames/${frameId}`, undefined],
      ['PUT', `/api/canvases/${canvasId}/pages`, { pages: [{ id: 'p', name: 'P' }], expectedPages: [] }],
      ['PUT', `/api/canvases/${canvasId}/guidelines/brand`, { markdown: 'x' }],
      ['POST', `/api/canvases/${canvasId}/references`, { frameId }],
      ['POST', `/api/canvases/${canvasId}/cards`, { title: 'do it' }],
      ['POST', `/api/canvases/${canvasId}/import`, { url: 'https://example.com' }],
      ['PATCH', `/api/canvases/${canvasId}`, { name: 'renamed' }],
      ['POST', `/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'hello' }],
      ['POST', `/api/canvases/${canvasId}/comments`, { pageId, x: 1, y: 1, text: 'hello' }],
      ['POST', `/api/canvases/${canvasId}/duplicate`, undefined],
      ['GET', `/api/canvases/${canvasId}/sync-keys`, undefined],
    ]
    for (const [method, path, body] of writes) {
      const res = await viewer.req(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    const after = await json(await owner.get(`/api/canvases/${canvasId}`))
    expect((after.frames as { html: string; name: string }[])[0]).toMatchObject({ name: 'F1', html: '<h1>Hi</h1>' })
    expect(after.name).toBe('Roles')
  })

  let rootId: string
  it('a comment role comments, replies and resolves, but cannot edit', async () => {
    const created = await commenter.post(`/api/frames/${frameId}/comments`, {
      selector: 'h1',
      snippet: '',
      text: 'nice',
    })
    expect(created.status).toBe(200)
    rootId = (await json(created)).id as string
    expect((await commenter.post(`/api/comments/${rootId}/replies`, { text: 'really nice' })).status).toBe(200)
    expect((await commenter.patch(`/api/frames/${frameId}`, { name: 'hacked' })).status).toBe(403)
    expect((await commenter.post(`/api/canvases/${canvasId}/cards`, { title: 'do it' })).status).toBe(403)
    expect((await commenter.post(`/api/canvases/${canvasId}/frames`, { name: 'x' })).status).toBe(403)
    expect((await commenter.post(`/api/comments/${rootId}/retry`)).status).toBe(403)
    expect(
      (await commenter.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 1, y: 1, text: 'a plain pin is fine' }))
        .status,
    ).toBe(200)
    expect((await commenter.post(`/api/comments/${rootId}/resolve`)).status).toBe(200)
  })

  it('a comment role @mentioning an agent leaves a plain comment and is told why', async () => {
    const created = await commenter.post(`/api/frames/${frameId}/comments`, {
      selector: 'h1',
      snippet: '',
      text: '@Doop make this blue',
    })
    expect(created.status).toBe(200)
    const body = await json(created)
    expect(body.notice).toBe('Only editors can ask agents to make changes.')
    expect(body.text).toBe('@Doop make this blue')
    expect(body.forAgent).toBeUndefined()
    const reply = await json(
      await commenter.post(`/api/comments/${body.id as string}/replies`, { text: '@ux and this too' }),
    )
    expect(reply.notice).toBeDefined()
    expect(reply.forAgent).toBeUndefined()
    const pin = await json(
      await commenter.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 2, y: 2, text: '@Doop hello' }),
    )
    expect(pin.notice).toBe('Only editors can ask agents to make changes.')
    expect(pin.forAgent).toBeUndefined()
  })

  it('an edit role does what editors always did', async () => {
    expect((await editor.patch(`/api/frames/${frameId}`, { name: 'F1 by editor' })).status).toBe(200)
    expect(
      (await editor.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'ok' })).status,
    ).toBe(200)
    expect((await editor.post(`/api/canvases/${canvasId}/duplicate`)).status).toBe(200)
  })

  it('shows addresses to the owner only, and each member their role', async () => {
    const asOwner = (await (await owner.get(`/api/canvases/${canvasId}/members`)).json()) as {
      email: string
      role: string
      name: string
    }[]
    expect(asOwner.map((p) => [p.name, p.email, p.role])).toEqual([
      ['Owner', 'owner@test.dev', 'owner'],
      ['Viewer', 'viewer@test.dev', 'view'],
      ['Commenter', 'commenter@test.dev', 'comment'],
      ['Editor', 'editor@test.dev', 'edit'],
    ])
    const asCommenter = (await (await commenter.get(`/api/canvases/${canvasId}/members`)).json()) as {
      email: string
      name: string
    }[]
    expect(asCommenter.map((p) => p.name)).toContain('Owner')
    expect(asCommenter.filter((p) => p.name !== 'Commenter').every((p) => p.email === '')).toBe(true)
  })

  it('only the owner changes roles', async () => {
    expect((await editor.patch(`/api/canvases/${canvasId}/members/${ids.viewer}`, { role: 'edit' })).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}/members/${ids.viewer}`, { role: 'nope' })).status).toBe(400)
    expect((await owner.patch(`/api/canvases/${canvasId}/members/${ids.stranger}`, { role: 'view' })).status).toBe(404)
  })

  it('answers the join with the role and withholds the team conversation from view-only members', async () => {
    const asViewer = new Room(canvasId, viewer.header())
    const asEditor = new Room(canvasId, editor.header())
    try {
      const v = await asViewer.joined()
      const e = await asEditor.joined()
      expect(v!.role).toBe('view')
      expect(e?.role).toBe('edit')
      expect((v!.tasks as unknown[]).length).toBe(0)
      expect((v!.comments as unknown[]).length).toBeGreaterThan(0)
    } finally {
      asViewer.close()
      asEditor.close()
    }
  })

  it('refuses a view-only member’s frame drag with one error and never broadcasts it', async () => {
    const asOwner = new Room(canvasId, owner.header())
    const asViewer = new Room(canvasId, viewer.header())
    const asCommenter = new Room(canvasId, commenter.header())
    try {
      await Promise.all([asOwner.joined(), asViewer.joined(), asCommenter.joined()])
      asViewer.send({ type: 'frame:drag', frameId, x: 5, y: 5, width: 300, height: 200 })
      asCommenter.send({ type: 'frame:drag', frameId, x: 6, y: 6, width: 300, height: 200 })
      expect((await asViewer.waitFor('error'))?.message).toMatch(/not change/)
      expect(await asCommenter.waitFor('error')).toBeDefined()
      await asOwner.settle()
      expect(asOwner.messages.some((m) => m.type === 'frame:drag')).toBe(false)
      /* cursors are fine for a viewer, and an editor's drag does broadcast */
      asViewer.send({ type: 'cursor', x: 1, y: 2 })
      expect(await asOwner.waitFor('cursor')).toBeDefined()
      const asEditor = new Room(canvasId, editor.header())
      await asEditor.joined()
      asEditor.send({ type: 'frame:drag', frameId, x: 9, y: 9, width: 300, height: 200 })
      expect(await asOwner.waitFor('frame:drag')).toBeDefined()
      asEditor.close()
    } finally {
      asOwner.close()
      asViewer.close()
      asCommenter.close()
    }
  })

  it('tells a connected member when their role changes, and closes them out when it is taken away', async () => {
    const asViewer = new Room(canvasId, viewer.header())
    await asViewer.joined()
    try {
      expect((await owner.patch(`/api/canvases/${canvasId}/members/${ids.viewer}`, { role: 'comment' })).status).toBe(
        200,
      )
      expect((await asViewer.waitFor('role'))?.role).toBe('comment')
      expect(
        (await viewer.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'now I can' }))
          .status,
      ).toBe(200)
      expect((await owner.delete(`/api/canvases/${canvasId}/members/${ids.viewer}`)).status).toBe(200)
      expect(await asViewer.closedWith).toBe(4403)
      expect((await viewer.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    } finally {
      asViewer.close()
    }
  })

  it('keeps @mentions of people who can view the canvas and silently drops the rest', async () => {
    const asCommenter = new Room(canvasId, commenter.header())
    await asCommenter.joined()
    try {
      const posted = await json(
        await owner.post(`/api/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'Looks good @Commenter, can @Stranger and @Editor weigh in? Ping @Ghost too.',
          mentions: [ids.commenter, ids.stranger, ids.editor, 'nobody-with-this-id', ids.commenter],
        }),
      )
      /* stranger cannot view; the Ghost id does not exist; the duplicate collapses; order is kept */
      expect(posted.mentions).toEqual([ids.commenter, ids.editor])
      const live = await asCommenter.waitFor('mention')
      expect((live!.comment as { id: string }).id).toBe(posted.id)
      /* an id whose @name is not in the text is not a mention */
      const quiet = await json(
        await owner.post(`/api/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'no names here',
          mentions: [ids.commenter],
        }),
      )
      expect(quiet.mentions).toBeUndefined()
      /* a comment-only member can mention too, and the reply path validates the same way */
      const reply = await json(
        await commenter.post(`/api/comments/${posted.id as string}/replies`, {
          text: 'thanks @Owner and @Stranger',
          mentions: [ids.owner, ids.stranger],
        }),
      )
      expect(reply.mentions).toEqual([ids.owner])
    } finally {
      asCommenter.close()
    }
  })

  it('offers the mention picker only people who can see the canvas, without addresses', async () => {
    const res = await commenter.get(`/api/canvases/${canvasId}/people`)
    expect(res.status).toBe(200)
    const people = (await res.json()) as { userId: string; name: string; email?: string }[]
    expect(people.map((p) => p.name).sort()).toEqual(['Commenter', 'Editor', 'Owner'])
    expect(people.every((p) => p.email === undefined)).toBe(true)
    expect((await stranger.get(`/api/canvases/${canvasId}/people`)).status).toBe(403)
  })

  describe('access requests', () => {
    it('lets someone without access ask once, and tells the owner live', async () => {
      const asOwner = new Room(canvasId, owner.header())
      await asOwner.joined()
      try {
        expect(await json(await stranger.get(`/api/canvases/${canvasId}/gate`))).toMatchObject({
          access: false,
          requested: false,
        })
        const res = await stranger.post(`/api/canvases/${canvasId}/access-requests`, {
          message: 'Hi, I am on the checkout team',
        })
        expect(res.status).toBe(200)
        const live = await asOwner.waitFor('access:request')
        expect(live!.request).toMatchObject({
          userId: ids.stranger,
          name: 'Stranger',
          message: 'Hi, I am on the checkout team',
        })
        /* one pending row per person per canvas: asking again changes nothing */
        expect((await stranger.post(`/api/canvases/${canvasId}/access-requests`, { message: 'again' })).status).toBe(
          200,
        )
        await asOwner.settle()
        expect(asOwner.messages.filter((m) => m.type === 'access:request')).toHaveLength(1)
        const list = (await (await owner.get(`/api/canvases/${canvasId}/access-requests`)).json()) as {
          userId: string
          message?: string
          email: string
        }[]
        expect(list).toHaveLength(1)
        expect(list[0]).toMatchObject({
          userId: ids.stranger,
          message: 'Hi, I am on the checkout team',
          email: 'stranger@test.dev',
        })
        expect(await json(await stranger.get(`/api/canvases/${canvasId}/gate`))).toMatchObject({ requested: true })
      } finally {
        asOwner.close()
      }
    })

    it('keeps the inbox and the decision to the owner, and refuses people who already have access', async () => {
      expect((await stranger.get(`/api/canvases/${canvasId}/access-requests`)).status).toBe(403)
      expect((await editor.get(`/api/canvases/${canvasId}/access-requests`)).status).toBe(403)
      expect(
        (await stranger.post(`/api/canvases/${canvasId}/access-requests/${ids.stranger}/approve`, { role: 'edit' }))
          .status,
      ).toBe(403)
      expect((await editor.post(`/api/canvases/${canvasId}/access-requests`, {})).status).toBe(409)
      expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    })

    it('approving adds the member with the chosen role and clears the request', async () => {
      expect(
        (await owner.post(`/api/canvases/${canvasId}/access-requests/${ids.stranger}/approve`, { role: 'sudo' }))
          .status,
      ).toBe(400)
      const approved = await owner.post(`/api/canvases/${canvasId}/access-requests/${ids.stranger}/approve`, {
        role: 'comment',
      })
      expect(approved.status).toBe(200)
      expect(
        ((await owner.get(`/api/canvases/${canvasId}/access-requests`).then((r) => r.json())) as unknown[]).length,
      ).toBe(0)
      expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      expect((await stranger.patch(`/api/frames/${frameId}`, { name: 'nope' })).status).toBe(403)
      expect(
        (await stranger.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'in!' })).status,
      ).toBe(200)
      const members = (await (await owner.get(`/api/canvases/${canvasId}/members`)).json()) as {
        name: string
        role: string
      }[]
      expect(members.find((m) => m.name === 'Stranger')?.role).toBe('comment')
      expect(
        (await owner.post(`/api/canvases/${canvasId}/access-requests/${ids.stranger}/approve`, { role: 'edit' }))
          .status,
      ).toBe(404)
    })

    it('declines silently: the asker cannot tell, and cannot get in', async () => {
      expect((await other.post(`/api/canvases/${canvasId}/access-requests`, {})).status).toBe(200)
      expect((await owner.post(`/api/canvases/${canvasId}/access-requests/${ids.other}/decline`)).status).toBe(200)
      expect(
        ((await owner.get(`/api/canvases/${canvasId}/access-requests`).then((r) => r.json())) as unknown[]).length,
      ).toBe(0)
      expect((await other.post(`/api/canvases/${canvasId}/access-requests`, {})).status).toBe(200)
      expect(
        ((await owner.get(`/api/canvases/${canvasId}/access-requests`).then((r) => r.json())) as unknown[]).length,
      ).toBe(0)
      expect((await other.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    })
  })

  describe('domain sharing', () => {
    it('is the owner’s to manage and validates its input', async () => {
      const path = `/api/canvases/${canvasId}/domains`
      expect((await editor.get(path)).status).toBe(403)
      expect(
        (await editor.req(path, { method: 'PUT', body: JSON.stringify({ domain: 'test.dev', role: 'view' }) })).status,
      ).toBe(403)
      for (const domain of ['', 'nodot', 'bad_domain.com', 'a b.com', 'x@y.com']) {
        const res = await owner.req(path, { method: 'PUT', body: JSON.stringify({ domain, role: 'view' }) })
        expect(res.status, domain).toBe(400)
      }
      expect(
        (await owner.req(path, { method: 'PUT', body: JSON.stringify({ domain: 'test.dev', role: 'boss' }) })).status,
      ).toBe(400)
    })

    it('stores grants, and does not open the canvas to an unverified address', async () => {
      const path = `/api/canvases/${canvasId}/domains`
      const saved = await owner.req(path, {
        method: 'PUT',
        body: JSON.stringify({ domain: '@Test.DEV', role: 'comment' }),
      })
      expect(saved.status).toBe(200)
      expect(await json(saved)).toMatchObject({ domain: 'test.dev', role: 'comment' })
      const listed = (await json(await owner.get(path))).grants as { domain: string }[]
      expect(listed.map((g) => g.domain)).toEqual(['test.dev'])
      /* this server has no mailer, so no address is ever verified: the grant must not apply */
      expect((await json(await other.get(`/api/canvases/${canvasId}/gate`))).access).toBe(false)
      expect((await other.get(`/api/canvases/${canvasId}`)).status).toBe(403)
      expect((await owner.delete(`${path}/test.dev`)).status).toBe(200)
      expect((await owner.delete(`${path}/test.dev`)).status).toBe(404)
    })
  })

  describe('the share link', () => {
    let linkCanvas: string
    let linkFrame: string
    beforeAll(async () => {
      linkCanvas = (await json(await owner.post('/api/canvases', { name: 'Link' }))).id as string
      linkFrame = (await json(await owner.post(`/api/canvases/${linkCanvas}/frames`, { name: 'LF', html: '<p>x</p>' })))
        .id as string
    })

    it('grants exactly the role it names to any signed-in visitor', async () => {
      expect((await other.get(`/api/canvases/${linkCanvas}`)).status).toBe(403)
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAccess: 'view' })).status).toBe(200)
      expect((await other.get(`/api/canvases/${linkCanvas}`)).status).toBe(200)
      expect(
        (await other.post(`/api/frames/${linkFrame}/comments`, { selector: 'p', snippet: '', text: 'x' })).status,
      ).toBe(403)
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAccess: 'comment' })).status).toBe(200)
      expect(
        (await other.post(`/api/frames/${linkFrame}/comments`, { selector: 'p', snippet: '', text: 'x' })).status,
      ).toBe(200)
      expect((await other.patch(`/api/frames/${linkFrame}`, { name: 'no' })).status).toBe(403)
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAccess: 'edit' })).status).toBe(200)
      expect((await other.patch(`/api/frames/${linkFrame}`, { name: 'yes' })).status).toBe(200)
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAccess: 'none' })).status).toBe(200)
      expect((await other.get(`/api/canvases/${linkCanvas}`)).status).toBe(403)
    })

    it('validates the settings and keeps them the owner’s', async () => {
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAccess: 'admin' })).status).toBe(400)
      expect((await owner.patch(`/api/canvases/${linkCanvas}`, { linkAudience: 'friends' })).status).toBe(400)
      expect((await editor.patch(`/api/canvases/${linkCanvas}`, { linkAudience: 'anyone' })).status).toBe(403)
      expect((await other.patch(`/api/canvases/${linkCanvas}`, { linkPassword: 'whatever123' })).status).toBe(403)
    })

    /* the image route renders with headless Chrome, which a CI runner launches slowly */
    it('leaves the public frame image route as it was', async () => {
      const anon = new Client(server)
      expect((await anon.get('/i/no-such-frame.png')).status).toBe(404)
      /* private canvas, no session: the route has never asked for one */
      expect([401, 403]).not.toContain((await anon.get(`/i/${linkFrame}.png`)).status)
    }, 30_000)
  })
})

describe('guest links (anyone with the link, no sign-in)', () => {
  let owner: Client
  let member: Client
  let canvasId: string
  let frameId: string
  let ownerRoom: Room

  beforeAll(async () => {
    owner = await new Client(server).signUp('gowner@test.dev', 'Guest Owner')
    member = await new Client(server).signUp('gmember@test.dev', 'Member')
    canvasId = (await json(await owner.post('/api/canvases', { name: 'Public' }))).id as string
    frameId = (await json(await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'PF', html: '<h1>Pub</h1>' })))
      .id as string
    ownerRoom = new Room(canvasId, owner.header())
    await ownerRoom.joined()
  })
  afterAll(() => ownerRoom.close())

  it('says "sign in" for private and missing canvases alike', async () => {
    const anon = new At(server, '10.1.0.1')
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'signin' })
    expect(await json(await anon.get('/api/public/canvas/nope-nope'))).toEqual({ mode: 'signin' })
    expect(await anon.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4401 })
  })

  it('does not admit guests through a signed-in-only link, whatever it grants', async () => {
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })
    const anon = new At(server, '10.1.0.1')
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'signin' })
    expect(await anon.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4401 })
    expect(
      (
        await anon.post(`/api/public/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'hi',
          name: 'Pat',
        })
      ).status,
    ).toBe(403)
  })

  it('opens the canvas to a signed-out visitor, capped at comment', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAudience: 'anyone' })).status).toBe(200)
    const anon = new At(server, '10.1.0.1')
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'open' })
    const room = new Room(canvasId, anon.header(), 'Pat')
    try {
      const init = await room.joined()
      expect(init?.role).toBe('comment') // the link says edit; a guest never edits
      expect(init?.guest).toBe(true)
      const canvas = init?.canvas as Record<string, unknown>
      expect(canvas.memberIds).toBeUndefined()
      expect(canvas.ownerId).toBeUndefined()
      expect((canvas.frames as unknown[]).length).toBe(1)
      /* presence works, marked as a guest */
      const joined = await ownerRoom.waitFor('presence:join')
      expect((joined!.presence as { name: string; guest?: boolean }).name).toBe('Pat (guest)')
      expect((joined!.presence as { guest?: boolean }).guest).toBe(true)
      room.send({ type: 'cursor', x: 3, y: 4 })
      expect(await ownerRoom.waitFor('cursor')).toBeDefined()
      /* an anonymous drag is refused and not broadcast */
      room.send({ type: 'frame:drag', frameId, x: 1, y: 1, width: 10, height: 10 })
      expect(await room.waitFor('error')).toBeDefined()
      await ownerRoom.settle()
      expect(ownerRoom.messages.some((m) => m.type === 'frame:drag')).toBe(false)
    } finally {
      room.close()
    }
  })

  it('reaches no signed-in route without a session, and cannot edit', async () => {
    const anon = new At(server, '10.1.0.1')
    expect((await anon.get(`/api/canvases/${canvasId}`)).status).toBe(401)
    expect((await anon.patch(`/api/frames/${frameId}`, { name: 'x' })).status).toBe(401)
    expect(
      (await anon.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'x' })).status,
    ).toBe(401)
    expect((await anon.post(`/api/canvases/${canvasId}/comments`, { pageId: 'p', x: 0, y: 0, text: 'x' })).status).toBe(
      401,
    )
    expect((await anon.post('/mcp', {})).status).toBe(401)
  })

  it('records a guest comment under a marked name with no account', async () => {
    const anon = new At(server, '10.1.0.1')
    const noName = await anon.post(`/api/public/frames/${frameId}/comments`, {
      selector: 'h1',
      snippet: '',
      text: 'hi',
    })
    expect(noName.status).toBe(400)
    const res = await anon.post(`/api/public/frames/${frameId}/comments`, {
      selector: 'h1',
      snippet: '<h1>Pub</h1>',
      text: 'Love the headline',
      name: '  Pat   (GUEST)  ',
    })
    expect(res.status).toBe(200)
    const comment = await json(res)
    expect(comment.from).toBe('Pat (guest)')
    expect(comment.fromUserId).toBeUndefined()
    const pushed = await ownerRoom.waitFor('comment')
    expect((pushed!.comment as { from: string }).from).toBe('Pat (guest)')
    /* a guest may reply, but not resolve, and an @agent mention stays plain text */
    const reply = await json(
      await anon.post(`/api/public/comments/${comment.id as string}/replies`, { text: '@Doop do it', name: 'Pat' }),
    )
    expect(reply.notice).toBe('Only editors can ask agents to make changes.')
    expect(reply.forAgent).toBeUndefined()
    expect(reply.fromUserId).toBeUndefined()
    expect((await anon.post(`/api/comments/${comment.id as string}/resolve`)).status).toBe(401)
  })

  it('a name cannot impersonate a member: the marker is always appended by the server', async () => {
    const anon = new At(server, '10.1.0.1')
    const res = await json(
      await anon.post(`/api/public/frames/${frameId}/comments`, {
        selector: 'h1',
        snippet: '',
        text: 'x',
        name: 'Guest Owner‮\u0000',
      }),
    )
    expect(res.from).toBe('Guest Owner (guest)')
  })

  it('rate-limits anonymous comments per address', async () => {
    const anon = new At(server, '10.1.0.2')
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (
          await anon.post(`/api/public/frames/${frameId}/comments`, {
            selector: 'h1',
            snippet: '',
            text: `spam ${i}`,
            name: 'Bot',
          })
        ).status,
      )
    }
    expect(statuses).toContain(429)
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(6)
    const limited = await anon.post(`/api/public/frames/${frameId}/comments`, {
      selector: 'h1',
      snippet: '',
      text: 'again',
      name: 'Bot',
    })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('closes the door again when the owner turns the link back to signed-in only', async () => {
    const anon = new At(server, '10.1.0.3')
    const room = new Room(canvasId, anon.header(), 'Pat')
    await room.joined()
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAudience: 'signed-in' })).status).toBe(200)
    expect(await room.closedWith).toBe(4403)
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'signin' })
    expect(
      (
        await anon.post(`/api/public/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'late',
          name: 'Pat',
        })
      ).status,
    ).toBe(403)
    /* signed-in people still get the link's role */
    expect((await member.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  })
})

describe('password links', () => {
  let owner: Client
  let visitor: Client
  let canvasId: string
  let frameId: string

  beforeAll(async () => {
    owner = await new Client(server).signUp('powner@test.dev', 'Pw Owner')
    visitor = await new Client(server).signUp('pvisitor@test.dev', 'Pw Visitor')
    canvasId = (await json(await owner.post('/api/canvases', { name: 'Locked' }))).id as string
    frameId = (
      await json(await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'LF', html: '<h1>Secret</h1>' }))
    ).id as string
  })

  it('needs a real password before the link can be password-protected', async () => {
    expect(
      (await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment', linkAudience: 'password' })).status,
    ).toBe(400)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkPassword: 'short' })).status).toBe(400)
    const set = await owner.patch(`/api/canvases/${canvasId}`, {
      linkAccess: 'comment',
      linkAudience: 'password',
      linkPassword: 'correct horse battery',
    })
    expect(set.status).toBe(200)
    expect(await json(set)).toMatchObject({ linkAccess: 'comment', linkAudience: 'password', hasLinkPassword: true })
  })

  it('never reveals the password or its hash', async () => {
    const canvas = JSON.stringify(await json(await owner.get(`/api/canvases/${canvasId}`)))
    expect(canvas).toContain('"hasLinkPassword":true')
    expect(canvas).not.toMatch(/scrypt|correct horse/)
  })

  it('keeps everyone out until they present the password', async () => {
    const anon = new At(server, '10.2.0.1')
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'password' })
    expect(await anon.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4401 })
    expect(
      (
        await anon.post(`/api/public/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'hi',
          name: 'Pat',
        })
      ).status,
    ).toBe(403)
    /* a signed-in visitor is gated too, and the gate says a password would help */
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(await visitor.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
    expect(await json(await visitor.get(`/api/canvases/${canvasId}/gate`))).toMatchObject({ passwordRequired: true })
  })

  it('rejects a wrong password and sets a scoped HttpOnly cookie for the right one', async () => {
    const anon = new At(server, '10.2.0.1')
    expect((await anon.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'wrong' })).status).toBe(401)
    expect(anon.cookies.size).toBe(0)
    const ok = await anon.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'correct horse battery' })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith(`doop_lp_${canvasId}=`))
    expect(cookie).toBeDefined()
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).toMatch(/Expires=|Max-Age=/i)
    expect(cookie).not.toMatch(/Secure/i) // plain http here; https deployments add it
    expect(await json(await anon.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'open' })
  })

  it('treats the cookie as satisfying the link floor, for guests and signed-in visitors alike', async () => {
    const guest = new At(server, '10.2.0.1')
    await guest.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'correct horse battery' })
    const room = new Room(canvasId, guest.header(), 'Pat')
    try {
      const init = await room.joined()
      expect(init?.role).toBe('comment')
      expect(init?.guest).toBe(true)
    } finally {
      room.close()
    }
    expect(
      (
        await guest.post(`/api/public/frames/${frameId}/comments`, {
          selector: 'h1',
          snippet: '',
          text: 'hello',
          name: 'Pat',
        })
      ).status,
    ).toBe(200)

    await visitor.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'correct horse battery' })
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(
      (await visitor.post(`/api/frames/${frameId}/comments`, { selector: 'h1', snippet: '', text: 'signed in' }))
        .status,
    ).toBe(200)
    expect((await visitor.patch(`/api/frames/${frameId}`, { name: 'no' })).status).toBe(403)
    expect(await visitor.joinWs(canvasId)).toEqual({ kind: 'init' })
  })

  it('a cookie for one canvas opens no other', async () => {
    const other = (await json(await owner.post('/api/canvases', { name: 'Other locked' }))).id as string
    await owner.patch(`/api/canvases/${other}`, {
      linkAccess: 'view',
      linkAudience: 'password',
      linkPassword: 'another password',
    })
    const cookie = [...visitor.cookies.entries()].filter(([k]) => k.startsWith('doop_lp_'))
    expect(cookie.length).toBeGreaterThan(0)
    expect((await visitor.get(`/api/canvases/${other}`)).status).toBe(403)
  })

  it('changing the password signs out everyone who knew the old one', async () => {
    const guest = new At(server, '10.2.0.1')
    await guest.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'correct horse battery' })
    const room = new Room(canvasId, guest.header(), 'Pat')
    await room.joined()
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkPassword: 'a brand new password' })).status).toBe(200)
    expect(await room.closedWith).toBe(4403)
    expect(await json(await guest.get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'password' })
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(
      (await guest.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'correct horse battery' })).status,
    ).toBe(401)
    expect(
      (await guest.post(`/api/public/canvas/${canvasId}/unlock`, { password: 'a brand new password' })).status,
    ).toBe(200)
  })

  it('removing the password returns the link to signed-in people', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkPassword: null })).status).toBe(200)
    const state = await json(await owner.get(`/api/canvases/${canvasId}`))
    expect(state.hasLinkPassword).toBeUndefined()
    expect(state.linkAudience).toBeUndefined()
    expect(await json(await new Client(server).get(`/api/public/canvas/${canvasId}`))).toEqual({ mode: 'signin' })
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(200) // the comment link still admits signed-in people
  })

  it('rate-limits password attempts per address and canvas', async () => {
    const target = (await json(await owner.post('/api/canvases', { name: 'Brute' }))).id as string
    await owner.patch(`/api/canvases/${target}`, {
      linkAccess: 'view',
      linkAudience: 'password',
      linkPassword: 'unguessable one',
    })
    const attacker = new At(server, '10.2.0.2')
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      statuses.push((await attacker.post(`/api/public/canvas/${target}/unlock`, { password: `guess ${i}` })).status)
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(statuses.slice(8)).toEqual([429, 429])
    /* even the right password is refused while the budget is spent */
    const blocked = await attacker.post(`/api/public/canvas/${target}/unlock`, { password: 'unguessable one' })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    /* an unknown canvas looks exactly like a wrong password */
    expect((await new Client(server).post('/api/public/canvas/no-such-canvas/unlock', { password: 'x' })).status).toBe(
      401,
    )
  })
})
