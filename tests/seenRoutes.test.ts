import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Canvas, Frame } from '../shared/types.ts'

/* An in-memory stand-in for the two tables, with the same rules as the real upserts: the seen timestamp only ever
   grows, and the first visit fixes the baseline. */
const seenRows = new Map<string, number>()
const visits = new Map<string, number>()
vi.mock('../server/db/persist.ts', () => ({
  saveFrameSeen: async (userId: string, canvasId: string, frameId: string, at: number) => {
    const key = `${userId}|${canvasId}|${frameId}`
    seenRows.set(key, Math.max(seenRows.get(key) ?? 0, at))
  },
  listFrameSeen: async (userId: string, canvasId: string) =>
    [...seenRows]
      .filter(([key]) => key.startsWith(`${userId}|${canvasId}|`))
      .map(([key, seenUpdatedAt]) => ({ frameId: key.split('|')[2]!, seenUpdatedAt })),
  ensureCanvasVisit: async (userId: string, canvasId: string, now: number) => {
    const key = `${userId}|${canvasId}`
    if (!visits.has(key)) visits.set(key, now)
    return visits.get(key)!
  },
}))

const { store } = await import('../server/store.ts')
const { seenRouter, MAX_SEEN_PER_REQUEST } = await import('../server/seenRoutes.ts')

const frame = (id: string, canvasId: string, updatedAt: number): Frame => ({
  id,
  canvasId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt,
  updatedBy: 'alice',
})
const PRIVATE: Canvas = { id: 'c1', name: 'Private', ownerId: 'owner', createdAt: 0, updatedAt: 0, frames: [] }
const OTHER: Canvas = { id: 'c2', name: 'Other', ownerId: 'owner', createdAt: 0, updatedAt: 0, frames: [] }
const FRAMES = new Map([
  ['f1', frame('f1', 'c1', 500)],
  ['f2', frame('f2', 'c1', 900)],
  ['elsewhere', frame('elsewhere', 'c2', 500)],
])

let userId: string | undefined = 'owner'
let server: Server
let origin: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = userId ? ({ id: userId } as typeof req.user) : undefined
    next()
  })
  app.use('/api/canvases', seenRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  userId = 'owner'
  seenRows.clear()
  visits.clear()
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => [PRIVATE, OTHER].find((c) => c.id === id))
  vi.spyOn(store, 'getFrame').mockImplementation((id) => FRAMES.get(id))
})
afterEach(() => {
  vi.restoreAllMocks()
})

const get = (canvasId = 'c1') => fetch(`${origin}/api/canvases/${canvasId}/seen`)
const post = (body: unknown, canvasId = 'c1') =>
  fetch(`${origin}/api/canvases/${canvasId}/seen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/canvases/:id/seen', () => {
  it('records the seen version of each frame and returns it on the next read', async () => {
    const res = await post({ frames: { f1: 400, f2: 900 } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, saved: 2 })
    expect((await (await get()).json()).seen).toEqual({ f1: 400, f2: 900 })
  })

  it('keeps the larger value, so a stale tab cannot make a frame new again', async () => {
    await post({ frames: { f1: 450 } })
    await post({ frames: { f1: 300 } })
    expect((await (await get()).json()).seen).toEqual({ f1: 450 })
    await post({ frames: { f1: 500 } })
    expect((await (await get()).json()).seen).toEqual({ f1: 500 })
  })

  it("clamps a claim to the frame's own updatedAt, so a change that has not happened cannot be marked seen", async () => {
    await post({ frames: { f1: 99999 } })
    expect((await (await get()).json()).seen).toEqual({ f1: 500 })
  })

  it('ignores frames that belong to another canvas or do not exist', async () => {
    const res = await post({ frames: { elsewhere: 500, nope: 1, f1: 100 } })
    expect(await res.json()).toEqual({ ok: true, saved: 1 })
    expect((await (await get()).json()).seen).toEqual({ f1: 100 })
  })

  it('keeps each person’s state apart', async () => {
    await post({ frames: { f1: 500 } })
    userId = 'carol'
    PRIVATE.memberIds = ['carol']
    try {
      expect((await (await get()).json()).seen).toEqual({})
    } finally {
      delete PRIVATE.memberIds
    }
  })

  it('refuses someone without access to the canvas and writes nothing', async () => {
    userId = 'stranger'
    expect((await post({ frames: { f1: 500 } })).status).toBe(403)
    expect(seenRows.size).toBe(0)
  })

  it('refuses a guest with no account, writes nothing, and 404s a canvas that is not there', async () => {
    userId = undefined
    expect((await post({ frames: { f1: 500 } })).status).toBe(401)
    expect((await get()).status).toBe(401)
    expect(seenRows.size).toBe(0)
    userId = 'owner'
    expect((await post({ frames: { f1: 500 } }, 'missing')).status).toBe(404)
  })

  it('rejects a body that is not a map of frame id to a number', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ frames: [] })).status).toBe(400)
    expect((await post({ frames: { f1: 'soon' } })).status).toBe(400)
    expect((await post({ frames: { f1: -1 } })).status).toBe(400)
    const many = Object.fromEntries(Array.from({ length: MAX_SEEN_PER_REQUEST + 1 }, (_, i) => [`x${i}`, 1]))
    expect((await post({ frames: many })).status).toBe(400)
    expect(seenRows.size).toBe(0)
  })
})

describe('GET /api/canvases/:id/seen', () => {
  it('starts the baseline on the first read and keeps it on every later one', async () => {
    const before = Date.now()
    const first = await (await get()).json()
    expect(first.baselineAt).toBeGreaterThanOrEqual(before)
    expect(first.seen).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await (await get()).json()).baselineAt).toBe(first.baselineAt)
  })

  it('refuses someone without access, and does not start a baseline for them', async () => {
    userId = 'stranger'
    expect((await get()).status).toBe(403)
    expect(visits.size).toBe(0)
  })
})
