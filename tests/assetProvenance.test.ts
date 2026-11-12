import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as schema from '../server/db/schema.ts'
import type { AssetSource } from '../shared/assetSource.ts'

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

const { getAsset, storeAsset } = await import('../server/assets.ts')

const MIGRATION = 'server/db/migrations/0057_agent_speed_asset_provenance.sql'
const SOURCE: AssetSource = {
  kind: 'frame',
  frame_id: 'f1',
  region: { x: 0, y: 120, w: 1440, h: 900 },
  element: 'el-1',
  frame_version: 1_794_000_000_000,
  agent: 'Claude',
}

let client: PGlite

beforeAll(async () => {
  client = new PGlite()
  const db = drizzle(client, { schema })
  /* the whole journal on a fresh database, as boot applies it */
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'server/db/migrations') })
  held.db = db
})

afterAll(async () => {
  await client.close()
})

it('adds nullable source and tags columns to assets, and the migration runs again harmlessly', async () => {
  const sql = await readFile(MIGRATION, 'utf8')
  await client.exec(sql)
  await client.exec(sql)
  const columns = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'assets' AND column_name IN ('source', 'tags') ORDER BY column_name",
  )
  expect(columns.rows).toEqual([
    { column_name: 'source', data_type: 'jsonb', is_nullable: 'YES' },
    { column_name: 'tags', data_type: 'ARRAY', is_nullable: 'YES' },
  ])
})

it('leaves an asset stored without provenance null on both', async () => {
  const asset = await storeAsset(Buffer.from('x'), { mime: 'image/png', ext: 'png' }, { uploadedBy: 'Test' })
  expect(asset.source).toBeUndefined()
  const [row] = await (held.db as ReturnType<typeof drizzle>)
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.id, asset.id))
  expect(row).toMatchObject({ source: null, tags: null })
  expect((await getAsset(asset.id))?.meta.source).toBeUndefined()
})

it('round-trips the source and tags an asset is stored with', async () => {
  const stored = await storeAsset(
    Buffer.from('png bytes'),
    { mime: 'image/png', ext: 'png' },
    { uploadedBy: 'Claude', source: SOURCE, tags: ['hero', 'store-screenshot'] },
  )
  expect(stored).toMatchObject({ source: SOURCE, tags: ['hero', 'store-screenshot'] })
  const read = await getAsset(stored.id)
  expect(read?.meta).toMatchObject({ id: stored.id, source: SOURCE, tags: ['hero', 'store-screenshot'] })
})
