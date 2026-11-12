import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* Disk mode with an isolated data dir: DISK_DIR is computed from
 * process.cwd() at module load, so pin cwd to a temp dir before importing. */
let tmp: string
let storage: typeof import('../server/storage.ts')
let renderStore: typeof import('../server/renderStore.ts')

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-render-store-'))
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  storage = await import('../server/storage.ts')
  renderStore = await import('../server/renderStore.ts')
})

afterAll(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

const renderDir = () => path.join(tmp, 'data', 'assets', 'render')

beforeEach(async () => {
  await fs.rm(renderDir(), { recursive: true, force: true })
})

const put = (frameId: string, version: number, hash: string, body: string, ext: 'png' | 'jpg' | 'webp' = 'png') =>
  storage.putObject(renderStore.renderKey(frameId, version, hash, ext), Buffer.from(body), `image/${ext}`)

describe('render keys', () => {
  it('round-trips a key, including frame ids with _ and -', () => {
    const key = renderStore.renderKey('frame_a-b', 12345, 'abc123', 'webp')
    expect(key).toBe(`render/frame_a-b_${(12345).toString(36)}_abc123.webp`)
    expect(renderStore.parseRenderKey(key)).toEqual({
      frameId: 'frame_a-b',
      version: 12345,
      paramsHash: 'abc123',
      ext: 'webp',
    })
  })

  it('splits the name from the right so underscores in a frame id survive', () => {
    expect(renderStore.parseRenderKey('render/a_b_c_1_hash1.png')).toEqual({
      frameId: 'a_b_c',
      version: 1,
      paramsHash: 'hash1',
      ext: 'png',
    })
  })

  it('throws on a malformed frame id', () => {
    expect(() => renderStore.renderKey('a/b', 1, 'h', 'png')).toThrow(/malformed frame id/)
    expect(() => renderStore.renderKey('a.b', 1, 'h', 'png')).toThrow(/malformed frame id/)
  })

  it('returns null for unparseable keys', () => {
    expect(renderStore.parseRenderKey('render/noext')).toBeNull()
    expect(renderStore.parseRenderKey('render/a.png')).toBeNull()
    expect(renderStore.parseRenderKey('thumb/a_1_h.png')).toBeNull()
  })
})

describe('stored renders', () => {
  it('puts and gets the exact bytes', async () => {
    await renderStore.putStoredRender('f1', 7, 'h1', 'png', Buffer.from('bytes'))
    const got = await renderStore.getStoredRender('f1', 7, 'h1', 'png')
    expect(got?.toString()).toBe('bytes')
  })

  it('returns null for a render that was never stored', async () => {
    expect(await renderStore.getStoredRender('f1', 1, 'nope', 'png')).toBeNull()
  })

  it('deletes the older object when a newer version of the same frame and hash is put', async () => {
    await renderStore.putStoredRender('f2', 1, 'h1', 'png', Buffer.from('old'))
    await renderStore.putStoredRender('f2', 2, 'h1', 'png', Buffer.from('new'))
    expect((await renderStore.getStoredRender('f2', 2, 'h1', 'png'))?.toString()).toBe('new')
    await vi.waitFor(async () => {
      expect(await renderStore.getStoredRender('f2', 1, 'h1', 'png')).toBeNull()
    })
  })

  it('purges only the renders of the named frame', async () => {
    await renderStore.putStoredRender('purge-me', 1, 'h1', 'png', Buffer.from('a'))
    await renderStore.putStoredRender('purge-me', 1, 'h2', 'jpg', Buffer.from('b'))
    await renderStore.putStoredRender('keep-me', 1, 'h1', 'png', Buffer.from('c'))
    expect(await renderStore.purgeFrameRenders('purge-me')).toBe(2)
    expect(await storage.listObjects('render/')).toHaveLength(1)
    expect(await renderStore.getStoredRender('keep-me', 1, 'h1', 'png')).not.toBeNull()
  })
})

describe('sweepRenders', () => {
  const live =
    (frameId: string, version = 99) =>
    (id: string) =>
      id === frameId ? version : undefined

  it('deletes renders of unknown frames and keeps the newest version per frame and hash', async () => {
    await put('live', 1, 'h1', 'one')
    await put('live', 3, 'h1', 'three')
    await put('gone', 1, 'h1', 'orphan')
    const res = await renderStore.sweepRenders(live('live'))
    expect(res.deleted).toBe(2)
    expect(res.kept).toBe(1)
    expect(await storage.listObjects('render/')).toHaveLength(1)
    expect((await renderStore.getStoredRender('live', 3, 'h1', 'png'))?.toString()).toBe('three')
  })

  it('enforces maxPerFrame with the newest modified objects first', async () => {
    for (const [i, hash] of ['h1', 'h2', 'h3', 'h4'].entries()) {
      await renderStore.putStoredRender('frame', 1, hash, 'png', Buffer.from(`x${i}`))
      const at = new Date(1_700_000_000_000 + i * 1000)
      await fs.utimes(path.join(renderDir(), `frame_1_${hash}.png`), at, at)
    }
    const res = await renderStore.sweepRenders(live('frame'), { maxPerFrame: 2 })
    expect(res.deleted).toBe(2)
    expect(res.kept).toBe(2)
    const left = (await storage.listObjects('render/')).map((o) => o.key).sort()
    expect(left).toEqual(['render/frame_1_h3.png', 'render/frame_1_h4.png'])
  })

  it('deletes unparseable render names', async () => {
    await fs.mkdir(renderDir(), { recursive: true })
    await fs.writeFile(path.join(renderDir(), 'badname.png'), 'x')
    await put('ok', 1, 'h1', 'fine')
    const res = await renderStore.sweepRenders(live('ok'))
    expect(res.deleted).toBe(1)
    expect(res.kept).toBe(1)
    expect((await storage.listObjects('render/')).map((o) => o.key)).toEqual(['render/ok_1_h1.png'])
  })
})

describe('listObjects', () => {
  it('returns [] when the render directory does not exist', async () => {
    expect(await storage.listObjects('render/')).toEqual([])
  })

  it('lists size and modification time', async () => {
    await put('f1', 1, 'h1', 'four')
    const [o] = await storage.listObjects('render/')
    expect(o?.key).toBe('render/f1_1_h1.png')
    expect(o?.size).toBe(4)
    expect(o?.modified).toBeGreaterThan(0)
  })
})

describe('storage keys for renders', () => {
  it.each(['render/../x.png', 'render/a/b.png'])('rejects malformed render key %s', async (key) => {
    await expect(storage.putObject(key, Buffer.from('x'), 'image/png')).rejects.toThrow(/malformed storage key/)
  })
})
