import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as schema from '../server/db/schema.ts'
import { MAX_ASSET_TAG_LENGTH, MAX_ASSET_TAGS, normalizeAssetTags, type AssetSource } from '../shared/assetSource.ts'

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

const { beginTicketUpload, createAsset, createUploadTicket, imageDetailsForFrame, listCanvasAssets, getAsset } =
  await import('../server/assets.ts')
const { assetSourceSchema, assetTagsSchema } = await import('../server/assetSourceSchema.ts')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FRAME_SOURCE: AssetSource = {
  kind: 'frame',
  frame_id: 'f1',
  region: { x: 0, y: 10, w: 400, h: 300 },
  element: 'el-1',
  frame_version: 1_794_000_000_000,
  agent: 'Claude',
}

let client: PGlite
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'server/db/migrations') })
  held.db = db
})

afterAll(async () => {
  await client.close()
})

it('normalizes tags: trims, lowercases, drops empties and duplicates, caps length and count', () => {
  expect(normalizeAssetTags(['  Hero ', 'hero', '', '  ', 'CTA'])).toEqual(['hero', 'cta'])
  expect(normalizeAssetTags([])).toBeUndefined()
  expect(normalizeAssetTags(undefined)).toBeUndefined()
  expect(normalizeAssetTags(['x'.repeat(MAX_ASSET_TAG_LENGTH + 10)])?.[0]).toHaveLength(MAX_ASSET_TAG_LENGTH)
  const many = Array.from({ length: MAX_ASSET_TAGS + 5 }, (_, i) => `t${i}`)
  expect(normalizeAssetTags(many)).toHaveLength(MAX_ASSET_TAGS)
})

it('accepts and rejects provenance and tags through the schemas', () => {
  expect(assetSourceSchema.parse(FRAME_SOURCE)).toEqual(FRAME_SOURCE)
  expect(assetSourceSchema.safeParse({ kind: 'ols' }).success).toBe(false)
  expect(assetSourceSchema.safeParse({ kind: 'url', url: 'not a url' }).success).toBe(false)
  expect(assetSourceSchema.safeParse({ kind: 'url', url: `https://x.test/${'a'.repeat(2000)}` }).success).toBe(false)
  expect(assetSourceSchema.safeParse({ kind: 'frame', region: { x: -1, y: 0, w: 1, h: 1 } }).success).toBe(false)
  expect(assetSourceSchema.safeParse({ kind: 'store', name: 'x'.repeat(501) }).success).toBe(false)
  expect(assetTagsSchema.safeParse(['hero']).success).toBe(true)
  expect(assetTagsSchema.safeParse(['']).success).toBe(false)
  expect(assetTagsSchema.safeParse(['x'.repeat(MAX_ASSET_TAG_LENGTH + 1)]).success).toBe(false)
  expect(assetTagsSchema.safeParse(Array.from({ length: MAX_ASSET_TAGS + 1 }, (_, i) => `t${i}`)).success).toBe(false)
})

it('createAsset stores source and normalized tags, visible through getAsset', async () => {
  const asset = await createAsset(PNG, {
    canvasId: 'c-one',
    uploadedBy: 'Claude',
    source: FRAME_SOURCE,
    tags: [' Hero ', 'hero'],
  })
  const read = await getAsset(asset.id)
  expect(read?.meta).toMatchObject({ source: FRAME_SOURCE, tags: ['hero'] })
})

it('carries source and tags through an upload ticket', async () => {
  const { token } = createUploadTicket({
    canvasId: 'c-one',
    uploadedBy: 'Claude',
    source: FRAME_SOURCE,
    tags: ['store'],
  })
  const ticket = beginTicketUpload(token)
  expect(ticket).toMatchObject({ source: FRAME_SOURCE, tags: ['store'] })
})

async function insertAsset(opts: {
  id: string
  canvasId: string | null
  mime?: string
  ext?: string
  source?: AssetSource | null
  tags?: string[]
  createdAt: number
}) {
  await db.insert(schema.assets).values({
    id: opts.id,
    canvasId: opts.canvasId,
    mime: opts.mime ?? 'image/png',
    ext: opts.ext ?? 'png',
    size: 1234,
    uploadedBy: 'Claude',
    createdAt: opts.createdAt,
    description: `about ${opts.id}`,
    source: opts.source ?? null,
    tags: opts.tags ?? null,
  })
}

it('imageDetailsForFrame lists the images a frame references, with provenance, oldest first', async () => {
  await insertAsset({ id: 'img-a', canvasId: 'c-detail', createdAt: 1, source: FRAME_SOURCE, tags: ['hero'] })
  await insertAsset({ id: 'img-b', canvasId: 'c-detail', mime: 'image/svg+xml', ext: 'svg', createdAt: 2 })
  await insertAsset({ id: 'sheet', canvasId: 'c-detail', mime: 'text/css', ext: 'css', createdAt: 3 })
  await db.insert(schema.assetRefs).values([
    { assetId: 'img-b', frameId: 'f-detail' },
    { assetId: 'img-a', frameId: 'f-detail' },
    { assetId: 'sheet', frameId: 'f-detail' },
  ])
  const details = await imageDetailsForFrame('f-detail')
  expect(details.map((d) => d.asset_id)).toEqual(['img-a', 'img-b'])
  expect(details[0]).toMatchObject({
    src: '/a/img-a.png',
    mime: 'image/png',
    bytes: 1234,
    description: 'about img-a',
    source: FRAME_SOURCE,
    tags: ['hero'],
  })
  expect(details[1]).toMatchObject({ source: null, tags: [] })
  expect(await imageDetailsForFrame('f-nobody')).toEqual([])
})

it('listCanvasAssets covers owned and referenced assets, and every filter', async () => {
  const urlSource: AssetSource = { kind: 'url', url: 'https://x.test/a.png', name: 'Store' }
  await insertAsset({ id: 'mine-old', canvasId: 'c-list', createdAt: 10, tags: ['hero'], source: FRAME_SOURCE })
  await insertAsset({ id: 'mine-new', canvasId: 'c-list', createdAt: 30, tags: ['cta'], source: urlSource })
  await insertAsset({ id: 'borrowed', canvasId: 'c-other', createdAt: 20, tags: ['hero', 'cta'] })
  await insertAsset({ id: 'unrelated', canvasId: 'c-elsewhere', createdAt: 40 })
  await insertAsset({ id: 'font-file', canvasId: 'c-list', mime: 'font/woff2', ext: 'woff2', createdAt: 50 })
  await insertAsset({ id: 'sheet-list', canvasId: 'c-list', mime: 'text/css', ext: 'css', createdAt: 5 })
  await db.insert(schema.assetRefs).values([
    { assetId: 'borrowed', frameId: 'f-list-1' },
    { assetId: 'mine-old', frameId: 'f-list-2' },
  ])
  const frames = ['f-list-1', 'f-list-2']

  const all = await listCanvasAssets('c-list', frames, {})
  expect(all.map((a) => a.asset_id)).toEqual(['mine-new', 'borrowed', 'mine-old', 'sheet-list'])
  expect(all.find((a) => a.asset_id === 'borrowed')).toMatchObject({ canvas_id: 'c-other', frame_ids: ['f-list-1'] })
  expect(all.find((a) => a.asset_id === 'mine-new')).toMatchObject({ frame_ids: [], tags: ['cta'] })

  expect((await listCanvasAssets('c-list', frames, { tag: ' HERO ' })).map((a) => a.asset_id)).toEqual([
    'borrowed',
    'mine-old',
  ])
  expect((await listCanvasAssets('c-list', frames, { source_kind: 'url' })).map((a) => a.asset_id)).toEqual([
    'mine-new',
  ])
  expect((await listCanvasAssets('c-list', frames, { frame_id: 'f-list-1' })).map((a) => a.asset_id)).toEqual([
    'borrowed',
  ])
  expect(await listCanvasAssets('c-list', frames, { frame_id: 'f-not-mine' })).toEqual([])
  expect((await listCanvasAssets('c-list', frames, { limit: 2 })).map((a) => a.asset_id)).toEqual([
    'mine-new',
    'borrowed',
  ])
  expect(await listCanvasAssets('c-list', frames, { limit: 5000 })).toHaveLength(4)
})
