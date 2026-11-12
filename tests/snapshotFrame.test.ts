import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../server/db/schema.ts'
import type { Frame } from '../shared/types.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'

/* Real Chromium, real asset row: the PGlite database and the object store are
   the only stand-ins, so provenance and tags are read back the way the /a/
   route reads them. */
const held = vi.hoisted(() => ({ db: undefined as unknown, objects: new Map<string, Buffer>() }))

vi.mock('../server/db/index.ts', () => ({
  get db() {
    return held.db
  },
}))
vi.mock('../server/storage.ts', () => ({
  putObject: async (key: string, buf: Buffer) => void held.objects.set(key, buf),
  getObject: async (key: string) => held.objects.get(key) ?? null,
}))
vi.mock('../server/store.ts', () => ({
  store: { renderSource: async (frame: Frame) => frame },
}))

const { snapshotFrame } = await import('../server/snapshots.ts')
const { getAsset } = await import('../server/assets.ts')
const { TargetError } = await import('../server/renderTargets.ts')

const BAND = 200

function bandedFrame(): Frame {
  const colours = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4']
  let bands = ''
  for (let i = 0; i < 6; i++) {
    bands += `<div style="height:${BAND}px;background:${colours[i]}"></div>`
  }
  return {
    id: 'frame-snapshot',
    canvasId: 'canvas-snapshot',
    name: 'Snapshot',
    x: 0,
    y: 0,
    width: 400,
    height: 1200,
    html: `<!doctype html><html><head><style>*{margin:0}</style></head><body>${bands}<div data-doop-id="el-hero" style="position:absolute;top:400px;left:40px;width:200px;height:100px;background:#fff"></div></body></html>`,
    createdAt: 1,
    updatedAt: 7,
    updatedBy: 'test',
  }
}

let client: PGlite

beforeAll(async () => {
  client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'server/db/migrations') })
  held.db = db
}, 60_000)

afterAll(async () => {
  await client.close()
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe.skipIf(!findBrowserPath())('snapshotFrame', { timeout: 60_000 }, () => {
  it('snapshots a region to webp and records its provenance and tags', async () => {
    const started = Date.now()
    const out = await snapshotFrame({
      frame: bandedFrame(),
      region: { x: 0, y: 200, w: 200, h: 200 },
      tags: ['Hero', 'hero', ' report '],
      agentName: 'Snapshot Agent',
    })
    console.info(`snapshotFrame region 200x200 webp: ${Date.now() - started} ms, ${out.bytes} bytes`)
    expect([out.width, out.height]).toEqual([200, 200])
    expect(out.format).toBe('webp')
    expect(out.url).toMatch(/\/a\/[A-Za-z0-9_-]+\.webp$/)
    expect(out.source).toEqual({
      kind: 'frame',
      frame_id: 'frame-snapshot',
      region: { x: 0, y: 200, w: 200, h: 200 },
      frame_version: 7,
      agent: 'Snapshot Agent',
    })
    expect(out.tags).toEqual(['hero', 'report'])
    const stored = await getAsset(out.asset_id)
    expect(stored?.meta).toMatchObject({ mime: 'image/webp', tags: ['hero', 'report'], source: out.source })
    expect(stored?.meta.size).toBe(out.bytes)
  })

  it('snapshots one element and records its data-doop-id', async () => {
    const out = await snapshotFrame({
      frame: bandedFrame(),
      target: { element_id: 'el-hero' },
      agentName: 'Snapshot Agent',
    })
    expect([out.width, out.height]).toEqual([200, 100])
    expect(out.source.element).toBe('el-hero')
    expect(out.source.region).toEqual({ x: 40, y: 400, w: 200, h: 100 })
  })

  it('snapshots the whole frame by default', async () => {
    const out = await snapshotFrame({ frame: bandedFrame(), agentName: 'Snapshot Agent' })
    expect([out.width, out.height]).toEqual([400, 1200])
    expect(out.source.region).toEqual({ x: 0, y: 0, w: 400, h: 1200 })
    expect(out.source.element).toBeUndefined()
  })

  it('refuses a region and a target together', async () => {
    await expect(
      snapshotFrame({
        frame: bandedFrame(),
        region: { x: 0, y: 0, w: 10, h: 10 },
        target: { element_id: 'el-hero' },
        agentName: 'Snapshot Agent',
      }),
    ).rejects.toThrow('pass region or target, not both')
  })

  it('answers a missing element with a TargetError', async () => {
    await expect(
      snapshotFrame({ frame: bandedFrame(), target: { element_id: 'nope' }, agentName: 'Snapshot Agent' }),
    ).rejects.toBeInstanceOf(TargetError)
  })
})
