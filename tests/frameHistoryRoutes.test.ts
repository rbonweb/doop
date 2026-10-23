import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Frame, FrameVersion, FrameVersionInfo } from '../shared/types.ts'

/**
 * Frame history routes against the REAL server (see ./harness.ts): the three
 * endpoints answer only to people who can edit the frame, and a restore rolls
 * the frame back while keeping what it replaced.
 */

const PORT = 5063

let server: Server
let owner: Client
let stranger: Client
let canvasId: string
let frameId: string
let otherFrameId: string

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('stranger@test.dev', 'Stranger')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'History' })).json()) as { id: string }).id
  const create = async (name: string, html: string) =>
    (await (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html })).json()) as Frame
  frameId = (await create('Hero', '<p>v0</p>')).id
  otherFrameId = (await create('Other', '<p>other</p>')).id
}, 70_000)

afterAll(() => server?.stop())

const versionsUrl = (id: string) => `/api/frames/${id}/versions`

async function frameNow(): Promise<Frame> {
  const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as { frames: Frame[] }
  return canvas.frames.find((f) => f.id === frameId)!
}

describe('frame version history routes', () => {
  it('lists no versions for a frame nobody has changed', async () => {
    const res = await owner.get(versionsUrl(frameId))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('saves the previous design when a person edits, and lists it without html', async () => {
    expect((await owner.patch(`/api/frames/${frameId}`, { html: '<p>v1</p>' })).status).toBe(200)
    expect((await owner.patch(`/api/frames/${frameId}`, { html: '<p>v2</p>' })).status).toBe(200) // coalesced

    const list = (await (await owner.get(versionsUrl(frameId))).json()) as FrameVersionInfo[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ savedBy: 'Owner', reason: 'human', frameId, canvasId })
    expect(list[0]).not.toHaveProperty('html')

    const full = (await (await owner.get(`${versionsUrl(frameId)}/${list[0]!.id}`)).json()) as FrameVersion
    expect(full.html).toBe('<p>v0</p>')
  })

  it('refuses signed-out callers and people without access to the canvas', async () => {
    const [version] = (await (await owner.get(versionsUrl(frameId))).json()) as FrameVersionInfo[]
    const anonymous = new Client(server)
    const restoreUrl = `${versionsUrl(frameId)}/${version!.id}/restore`

    for (const who of [anonymous, stranger]) {
      const expected = who === anonymous ? 401 : 403
      expect((await who.get(versionsUrl(frameId))).status).toBe(expected)
      expect((await who.get(`${versionsUrl(frameId)}/${version!.id}`)).status).toBe(expected)
      expect((await who.post(restoreUrl)).status).toBe(expected)
    }
    expect((await frameNow()).html).toBe('<p>v2</p>')
  })

  it('answers 404 for a missing frame, or a version that belongs to another frame', async () => {
    const [version] = (await (await owner.get(versionsUrl(frameId))).json()) as FrameVersionInfo[]
    expect((await owner.get(versionsUrl('nope'))).status).toBe(404)
    expect((await owner.get(`${versionsUrl(frameId)}/nope`)).status).toBe(404)
    expect((await owner.get(`${versionsUrl(otherFrameId)}/${version!.id}`)).status).toBe(404)
    expect((await owner.post(`${versionsUrl(otherFrameId)}/${version!.id}/restore`)).status).toBe(404)
  })

  it('restores a version: the current design is kept as a restore version, and the change is logged', async () => {
    const [version] = (await (await owner.get(versionsUrl(frameId))).json()) as FrameVersionInfo[]
    const res = await owner.post(`${versionsUrl(frameId)}/${version!.id}/restore`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Frame).html).toBe('<p>v0</p>')
    expect((await frameNow()).html).toBe('<p>v0</p>')

    const list = await until(async () => {
      const rows = (await (await owner.get(versionsUrl(frameId))).json()) as FrameVersionInfo[]
      return rows.length === 2 ? rows : undefined
    })
    expect(list[0]).toMatchObject({ reason: 'restore', savedBy: 'Owner' })
    const kept = (await (await owner.get(`${versionsUrl(frameId)}/${list[0]!.id}`)).json()) as FrameVersion
    expect(kept.html).toBe('<p>v2</p>')

    const activity = (await (await owner.get('/api/home/activity')).json()) as { message: string }[]
    expect(activity.map((a) => a.message)).toContain(
      'restored “Hero” to the version from ' + utcMinute(version!.savedAt),
    )
  })
})

function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

/** poll until a fire-and-forget write is visible */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the write to land')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
