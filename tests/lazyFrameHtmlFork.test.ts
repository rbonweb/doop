import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, CanvasNote, CanvasPageInfo, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/* The fork's own ways in to a canvas, after a restart and again after the canvas went idle and gave its frame HTML
   back (store.evictIdle): duplicating a page, moving a frame to another canvas, restoring a version over REST and
   MCP, a guest comment, the deck PDF. Each must load the canvas first and write through the store, so the edit is
   still there after the next restart. CANVAS_IDLE_MS is short so the sweep runs every second. */

const env = { CANVAS_IDLE_MS: '1500' }
const EMAIL = 'forklazy@test.dev'
const CARD_ONE = '<h1 id="t">first</h1>'
const SLIDE_ONE = '<p>slide</p>'
/* far from the first design, so the edit files a version of its own instead of joining the open burst of tweaks */
const CARD_TWO = '<section><div>an entirely different card</div></section>'
const SLIDE_TWO = '<main><ul><li>an entirely different slide</li></ul></main>'

let server: Server
let owner: Client
let canvasA: Canvas
let canvasB: Canvas
let card: Frame
let slide: Frame
let pageId: string

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBeLessThan(300)
  return (await res.json()) as T
}

const canvasOf = async (id: string) => json<Canvas>(await owner.get(`/api/canvases/${id}`))

/** canvases with frame HTML in memory, as /healthz/store reports it */
async function loadedCanvases(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
}

/** wait for every canvas to be dropped, which also means every write has landed (a dirty frame keeps its canvas) */
const untilIdle = (timeout = 15_000) => expect.poll(loadedCanvases, { timeout, interval: 250 }).toBe(0)

async function restart() {
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer(env, server.dataDir)
  owner = new Client(server)
  const signIn = await owner.post('/api/auth/sign-in/email', { email: EMAIL, password: 'password12345' })
  expect(signIn.status).toBe(200)
}

beforeAll(async () => {
  server = await startServer(env)
  owner = await new Client(server).signUp(EMAIL, 'Fork Lazy')
  canvasA = await json<Canvas>(await owner.post('/api/canvases', { name: 'Fork A' }))
  canvasB = await json<Canvas>(await owner.post('/api/canvases', { name: 'Fork B' }))
  pageId = canvasA.pages![0]!.id
  card = await json<Frame>(await owner.post(`/api/canvases/${canvasA.id}/frames`, { name: 'Card', html: CARD_ONE }))
  slide = await json<Frame>(
    await owner.post(`/api/canvases/${canvasA.id}/frames`, { name: 'Slide', html: SLIDE_ONE, slide: true }),
  )
  /* two designs on each frame, so each has a version to restore */
  for (const [frame, html] of [
    [card, CARD_TWO],
    [slide, SLIDE_TWO],
  ] as const) {
    expect((await owner.patch(`/api/frames/${frame.id}`, { html })).status).toBe(200)
  }
  expect((await owner.put(`/api/canvases/${canvasA.id}/guides/g1`, { pageId, axis: 'v', at: 40 })).status).toBe(200)
  expect((await owner.put(`/api/canvases/${canvasA.id}/pages/${pageId}/background`, { color: '#112233' })).status).toBe(
    200,
  )
  await json(await owner.post(`/api/canvases/${canvasA.id}/notes`, { markdown: 'beside the card', frameId: card.id }))
  expect(
    (await owner.patch(`/api/canvases/${canvasA.id}`, { linkAccess: 'comment', linkAudience: 'anyone' })).status,
  ).toBe(200)
  /* a restart: nothing has its HTML in memory */
  await restart()
}, 120_000)

afterAll(() => server?.stop())

it('duplicates a page of an idle canvas with its html, guides, background and notes, and keeps the copy', async () => {
  await untilIdle()
  const copy = await json<{ page: CanvasPageInfo; frames: Frame[]; notes: CanvasNote[] }>(
    await owner.post(`/api/canvases/${canvasA.id}/pages/${pageId}/duplicate`),
  )
  expect(copy.page.background).toBe('#112233')
  expect(copy.frames.map((frame) => frame.html).sort()).toEqual([CARD_TWO, SLIDE_TWO].sort())
  expect(copy.notes).toHaveLength(1)
  await untilIdle()
  await restart()
  const stored = await canvasOf(canvasA.id)
  expect(
    stored.frames
      .filter((frame) => frame.pageId === copy.page.id)
      .map((frame) => frame.html)
      .sort(),
  ).toEqual([CARD_TWO, SLIDE_TWO].sort())
  expect(stored.guides?.filter((guide) => guide.pageId === copy.page.id)).toHaveLength(1)
  expect(stored.pages?.find((page) => page.id === copy.page.id)?.background).toBe('#112233')
  expect(stored.notes).toHaveLength(2)
}, 60_000)

it('restores an earlier version over REST on an idle canvas, and keeps it', async () => {
  await untilIdle()
  const versions = await json<{ id: string }[]>(await owner.get(`/api/frames/${card.id}/versions`))
  expect(versions.length).toBeGreaterThan(0)
  const restored = await json<{ frame: Frame }>(
    await owner.post(`/api/frames/${card.id}/versions/${versions[0]!.id}/restore`),
  )
  expect(restored.frame.html).toBe(CARD_ONE)
  await untilIdle()
  expect((await canvasOf(canvasA.id)).frames.find((frame) => frame.id === card.id)?.html).toBe(CARD_ONE)
}, 30_000)

it('moves a frame between two idle canvases and keeps its html', async () => {
  await untilIdle()
  const moved = await json<{ frame: Frame }>(await owner.post(`/api/frames/${card.id}/move`, { canvasId: canvasB.id }))
  expect(moved.frame.canvasId).toBe(canvasB.id)
  await untilIdle()
  await restart()
  expect((await canvasOf(canvasB.id)).frames.find((frame) => frame.id === card.id)?.html).toBe(CARD_ONE)
  expect((await canvasOf(canvasA.id)).frames.some((frame) => frame.id === card.id)).toBe(false)
}, 60_000)

it('takes a guest comment on an element of an idle canvas, stamping the id into the stored html', async () => {
  await untilIdle()
  const guest = new Client(server)
  const res = await guest.post(`/api/public/frames/${slide.id}/comments`, {
    selector: 'body > main > ul',
    snippet: '',
    text: 'looks good',
    name: 'Pat',
  })
  expect(res.status, await res.clone().text()).toBe(200)
  await untilIdle()
  await restart()
  const stored = (await canvasOf(canvasA.id)).frames.find((frame) => frame.id === slide.id)
  expect(stored?.html).toContain('data-doop-id')
  expect(stored?.html).toContain('an entirely different slide')
}, 60_000)

it('renders the deck PDF of an idle canvas from its loaded html', async () => {
  await untilIdle()
  const res = await owner.get(`/api/canvases/${canvasA.id}/pages/${encodeURIComponent(pageId)}/deck.pdf`)
  const body = res.status === 200 ? '' : await res.text()
  /* a machine without Chromium answers 500 with the renderer's own message; what must never show is the load error */
  expect(body).not.toContain('was read before')
}, 60_000)

it('lists and restores versions, and pins notes, over MCP on an idle canvas', async () => {
  await untilIdle()
  const { secret } = await json<{ secret: string }>(await owner.post('/api/agent-keys', { name: 'Fork lazy agent' }))
  const agent = new McpClient({ name: 'fork-lazy-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  try {
    const listed = await agent.callTool({
      name: 'list_frame_versions',
      arguments: { frame_id: slide.id, agent_name: 'Lazy' },
    })
    expect(listed.isError, JSON.stringify(listed.content)).toBeFalsy()
    const [{ text }] = listed.content as [{ text: string }]
    const versionId = (JSON.parse(text) as { versions: { id: string }[] }).versions[0]?.id
    expect(versionId).toBeTruthy()
    const restored = await agent.callTool({
      name: 'restore_frame_version',
      arguments: { frame_id: slide.id, version_id: versionId, agent_name: 'Lazy' },
    })
    expect(restored.isError, JSON.stringify(restored.content)).toBeFalsy()
    const note = await agent.callTool({
      name: 'create_note',
      arguments: { canvas_id: canvasA.id, text: 'pinned by an agent', frame_id: slide.id, agent_name: 'Lazy' },
    })
    expect(note.isError, JSON.stringify(note.content)).toBeFalsy()
    const moved = await agent.callTool({
      name: 'move_frame',
      arguments: { frame_id: slide.id, canvas_id: canvasB.id, agent_name: 'Lazy' },
    })
    expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy()
  } finally {
    await agent.close()
  }
  await untilIdle(60_000)
  await restart()
  const arrived = (await canvasOf(canvasB.id)).frames.find((frame) => frame.id === slide.id)
  expect(arrived?.html).toBe(SLIDE_ONE)
  expect((await canvasOf(canvasB.id)).notes?.some((n) => n.markdown === 'pinned by an agent')).toBe(true)
}, 120_000)
