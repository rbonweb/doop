import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* Component work queued when the server stops is picked up when it starts again. The first server holds its queue
   (DOOP_PROPAGATION_PAUSED), so the work is queued and stored but no frame is visited: the stop comes before the
   queue drains, with nothing timed. The second boots on the same database and finishes it. */

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

let server: Server
let owner: Client
let canvasId = ''
let chipCanvasId = ''
let tagId = ''
let waitingFrameId = ''
let chipFrameId = ''
let strayCanvasId = ''

/** the rows the queue table holds, read from the stopped server's database */
async function storedRows(dir: string): Promise<{ frame_id: string; task: string; canvas_id: string }[]> {
  const db = new PGlite(path.join(dir, 'data', 'pg'))
  try {
    return (
      await db.query<{ frame_id: string; task: string; canvas_id: string }>(
        'SELECT frame_id, task, canvas_id FROM component_propagation_queue ORDER BY frame_id, task',
      )
    ).rows
  } finally {
    await db.close()
  }
}

async function frameHtml(canvas: string, frameId: string): Promise<string> {
  const loaded = (await (await owner.get(`/api/canvases/${canvas}`)).json()) as {
    frames: { id: string; html: string }[]
  }
  return loaded.frames.find((f) => f.id === frameId)!.html
}

beforeAll(async () => {
  const first = await startServer({ DOOP_PROPAGATION_PAUSED: 'true' })
  owner = await new Client(first).signUp('queue@test.dev', 'Queue Owner')

  /* a canvas whose Tag main changes: a second frame uses it */
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Tags' })).json()) as { id: string }).id
  const source = (await (
    await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Source',
      html: doc('<span class="tag" data-doop-id="tagone">One</span>'),
    })
  ).json()) as { id: string }
  const made = await owner.post(`/api/canvases/${canvasId}/components`, {
    name: 'Tag',
    frameId: source.id,
    element: 'tagone',
  })
  expect(made.status).toBe(200)
  tagId = ((await made.json()) as { component: { id: string } }).component.id
  waitingFrameId = (
    (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'User',
        html: doc('<doop-use component="Tag"></doop-use>'),
      })
    ).json()) as { id: string }
  ).id

  /* a canvas whose Chip instances are to be cut loose */
  chipCanvasId = ((await (await owner.post('/api/canvases', { name: 'Chips' })).json()) as { id: string }).id
  const chipSource = (await (
    await owner.post(`/api/canvases/${chipCanvasId}/frames`, {
      name: 'Source',
      html: doc('<span class="chip" data-doop-id="chipone">One</span>'),
    })
  ).json()) as { id: string }
  const chip = await owner.post(`/api/canvases/${chipCanvasId}/components`, {
    name: 'Chip',
    frameId: chipSource.id,
    element: 'chipone',
  })
  expect(chip.status).toBe(200)
  const chipId = ((await chip.json()) as { component: { id: string } }).component.id
  chipFrameId = (
    (await (
      await owner.post(`/api/canvases/${chipCanvasId}/frames`, {
        name: 'Chips',
        html: doc('<doop-use component="Chip"></doop-use>'),
      })
    ).json()) as { id: string }
  ).id
  strayCanvasId = chipCanvasId

  /* both are queued; neither is visited */
  expect(
    (
      await owner.patch(`/api/canvases/${canvasId}/components/${tagId}`, {
        find: 'class="tag"',
        replace: 'class="tag after-restart"',
      })
    ).status,
  ).toBe(200)
  expect((await owner.post(`/api/canvases/${chipCanvasId}/components/${chipId}/detach-instances`, {})).status).toBe(200)

  /* the room is told the queued frame is waiting */
  const init = await new Promise<{ catchingUp?: string[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${first.port}/ws`, { headers: { Cookie: owner.header() } })
    const timer = setTimeout(() => reject(new Error('no init')), 8000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'queue-test', name: 'q', kind: 'user' })),
    )
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string; catchingUp?: string[] }
      if (msg.type !== 'init') return
      clearTimeout(timer)
      ws.close()
      resolve(msg)
    })
  })
  expect(init.catchingUp).toContain(waitingFrameId)

  /* nothing has been visited */
  expect(await frameHtml(canvasId, waitingFrameId)).not.toContain('after-restart')
  expect(await frameHtml(chipCanvasId, chipFrameId)).toContain('data-doop-instance')
  const health = (await (await fetch(`${first.base}/healthz/propagation`)).json()) as {
    frames: number
    paused: boolean
  }
  expect(health.paused).toBe(true)
  expect(health.frames).toBeGreaterThan(0)

  first.stop({ keepData: true })
  await first.stopped
  server = first
}, 120_000)

afterAll(() => server?.stop())

it('stores the queued work, one row per frame and task, before the server stops', async () => {
  const rows = await storedRows(server.dataDir)
  expect(rows.some((row) => row.frame_id === waitingFrameId && row.task === 'propagate')).toBe(true)
  expect(rows.some((row) => row.frame_id === chipFrameId && row.task === 'detach')).toBe(true)
  expect(new Set(rows.map((row) => `${row.task}:${row.frame_id}`)).size).toBe(rows.length)
})

it('finishes the work after a restart, clears the rows, and drops a row whose frame is gone', async () => {
  /* a row left behind by a frame that no longer exists, and one for a canvas that is gone */
  const db = new PGlite(path.join(server.dataDir, 'data', 'pg'))
  try {
    await db.query(
      `INSERT INTO component_propagation_queue (frame_id, task, canvas_id, component_ids, actor, queued_at) VALUES
       ('ghost-frame', 'propagate', $1, '["x"]', '{"name":"Ghost","kind":"user","color":"#000"}', 1),
       ('ghost-frame-2', 'detach', 'ghost-canvas', '["x"]', '{"name":"Ghost","kind":"user","color":"#000"}', 1)`,
      [strayCanvasId],
    )
  } finally {
    await db.close()
  }

  const second = await startServer({}, server.dataDir)
  server = second
  owner = new Client(second)
  const signIn = await owner.post('/api/auth/sign-in/email', { email: 'queue@test.dev', password: 'password12345' })
  expect(signIn.status).toBe(200)

  /* the queue is picked up at boot: both frames reach their state without any write of their own */
  await expect
    .poll(async () => frameHtml(canvasId, waitingFrameId), { timeout: 30_000, interval: 250 })
    .toContain('after-restart')
  await expect
    .poll(async () => frameHtml(chipCanvasId, chipFrameId), { timeout: 30_000, interval: 250 })
    .not.toContain('data-doop-instance')
  await expect
    .poll(
      async () => ((await (await fetch(`${second.base}/healthz/propagation`)).json()) as { frames: number }).frames,
      {
        timeout: 30_000,
        interval: 250,
      },
    )
    .toBe(0)

  second.stop({ keepData: true })
  await second.stopped
  expect(await storedRows(second.dataDir)).toEqual([])
}, 120_000)
