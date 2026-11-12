import type { RenderFormat } from './renderTypes.ts'
import * as storage from './storage.ts'

/**
 * Persisted full-size `/i/` renders: one immutable object per (frame id, frame
 * version, params hash) under `render/`, so a restart keeps serving recent
 * images instead of re-rendering. A sweep trims superseded versions and old
 * parameter sets; deleting a frame drops its renders through thumbs.purge().
 */

const MIME: Record<RenderFormat, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

const FRAME_ID = /^[A-Za-z0-9_-]+$/

/** newest put per `frameId_hash`, used to drop the previous version's object without a list call */
const latest = new Map<string, { version: number; ext: RenderFormat }>()

let getFailureLogged = false

export function renderKey(frameId: string, version: number, paramsHash: string, ext: RenderFormat): string {
  if (!FRAME_ID.test(frameId)) throw new Error(`malformed frame id: ${frameId}`)
  return `render/${frameId}_${version.toString(36)}_${paramsHash}.${ext}`
}

/** Split the name from the right: frame ids may contain `_`, and the last two parts are `<version>.<ext>` and the hash. */
export function parseRenderKey(
  key: string,
): { frameId: string; version: number; paramsHash: string; ext: string } | null {
  const name = key.startsWith('render/') ? key.slice('render/'.length) : ''
  const extAt = name.lastIndexOf('.')
  if (!name || extAt < 0) return null
  const ext = name.slice(extAt + 1)
  const stem = name.slice(0, extAt)
  const hashAt = stem.lastIndexOf('_')
  if (hashAt < 0) return null
  const paramsHash = stem.slice(hashAt + 1)
  const beforeHash = stem.slice(0, hashAt)
  const versionAt = beforeHash.lastIndexOf('_')
  if (versionAt < 0) return null
  const frameId = beforeHash.slice(0, versionAt)
  const version = Number.parseInt(beforeHash.slice(versionAt + 1), 36)
  if (!frameId || !paramsHash || !/^[A-Za-z0-9]+$/.test(ext) || !Number.isFinite(version) || version < 0) return null
  return { frameId, version, paramsHash, ext }
}

/** The stored bytes of one exact render, or null when it was never persisted or storage failed. */
export async function getStoredRender(
  frameId: string,
  version: number,
  paramsHash: string,
  ext: RenderFormat,
): Promise<Buffer | null> {
  try {
    return await storage.getObject(renderKey(frameId, version, paramsHash, ext))
  } catch (e) {
    if (!getFailureLogged) {
      getFailureLogged = true
      console.error('[renders] read failed:', e)
    }
    return null
  }
}

/** Persist one render and forget the previous version of the same frame and params. A failed persist must not fail the request. */
export async function putStoredRender(
  frameId: string,
  version: number,
  paramsHash: string,
  ext: RenderFormat,
  buf: Buffer,
): Promise<void> {
  try {
    await storage.putObject(renderKey(frameId, version, paramsHash, ext), buf, MIME[ext])
  } catch (e) {
    console.error(`[renders] persist failed for ${frameId}:`, e)
    return
  }
  const id = `${frameId}_${paramsHash}`
  const prev = latest.get(id)
  latest.set(id, { version, ext })
  if (prev && prev.version < version) {
    storage.deleteObject(renderKey(frameId, prev.version, paramsHash, prev.ext)).catch((e) => {
      console.error(`[renders] stale delete failed for ${frameId}:`, e)
    })
  }
}

/** Drop every persisted render of a frame, e.g. when the frame itself is deleted. Best-effort: never rejects. */
export async function purgeFrameRenders(frameId: string): Promise<number> {
  let deleted = 0
  let objects: Awaited<ReturnType<typeof storage.listObjects>>
  try {
    objects = await storage.listObjects(`render/${frameId}_`)
  } catch (e) {
    console.error(`[renders] purge list failed for ${frameId}:`, e)
    return 0
  }
  for (const o of objects) {
    if (parseRenderKey(o.key)?.frameId !== frameId) continue
    try {
      await storage.deleteObject(o.key)
      deleted++
    } catch (e) {
      console.error(`[renders] purge delete failed for ${o.key}:`, e)
    }
  }
  return deleted
}

/**
 * Trim storage: drop unparseable names and renders of frames that are gone,
 * then keep only the newest version per frame and parameter set, and at most
 * `maxPerFrame` parameter sets per frame (newest first).
 */
export async function sweepRenders(
  currentVersion: (frameId: string) => number | undefined,
  opts?: { maxPerFrame?: number },
): Promise<{ deleted: number; kept: number; bytes: number }> {
  const maxPerFrame = opts?.maxPerFrame ?? 40
  let deleted = 0
  const del = async (key: string): Promise<void> => {
    try {
      await storage.deleteObject(key)
      deleted++
    } catch (e) {
      console.error(`[renders] sweep delete failed for ${key}:`, e)
    }
  }
  const byFrame = new Map<
    string,
    Array<{ key: string; version: number; hash: string; size: number; modified: number }>
  >()
  for (const o of await storage.listObjects('render/')) {
    const parsed = parseRenderKey(o.key)
    if (!parsed) {
      await del(o.key)
      continue
    }
    if (currentVersion(parsed.frameId) === undefined) {
      await del(o.key)
      continue
    }
    const list = byFrame.get(parsed.frameId) ?? []
    list.push({ key: o.key, version: parsed.version, hash: parsed.paramsHash, size: o.size, modified: o.modified })
    byFrame.set(parsed.frameId, list)
  }
  let kept = 0
  let bytes = 0
  for (const list of byFrame.values()) {
    /* newest version per parameter set, then at most maxPerFrame sets */
    const newest = new Map<string, (typeof list)[number]>()
    for (const o of list) {
      const cur = newest.get(o.hash)
      if (!cur || o.version > cur.version) newest.set(o.hash, o)
    }
    for (const o of list) if (newest.get(o.hash) !== o) await del(o.key)
    const survivors = [...newest.values()].sort((a, b) => b.modified - a.modified)
    for (const o of survivors.slice(maxPerFrame)) await del(o.key)
    for (const o of survivors.slice(0, maxPerFrame)) {
      kept++
      bytes += o.size
    }
  }
  console.log(`[renders] sweep: kept ${kept} (${(bytes / 1024 / 1024).toFixed(1)} MB), deleted ${deleted}`)
  return { deleted, kept, bytes }
}

/** First sweep 60 s after boot (storage and frames are ready), then every six hours. Never started in tests. */
export function startRenderSweep(currentVersion: (frameId: string) => number | undefined): void {
  const run = () =>
    void sweepRenders(currentVersion).catch((e) => {
      console.error('[renders] sweep failed:', e)
    })
  setTimeout(run, 60_000).unref()
  setInterval(run, 6 * 60 * 60 * 1000).unref()
}
