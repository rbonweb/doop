import { assetResponseHeaders, getAsset } from './assets.ts'
import { env } from './env.ts'

/* An in-process cache for what frame renders fetch over and over: the app's own /a/ assets, Google Fonts stylesheets and font files. Every render opens a fresh browser context, so without this each one downloads them all again. Third-party hosts are never handled here; they keep going through the pinned public fetch in guardPublicPageRequests. */

export interface CachedResponse {
  status: number
  headers: Record<string, string>
  contentType: string
  body: Buffer
}

export const MAX_CACHE_BYTES = 128 * 1024 * 1024
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024
export const GOOGLE_CSS_TTL_MS = 24 * 60 * 60 * 1000

const GOOGLE_CSS_ORIGIN = 'https://fonts.googleapis.com'
const GOOGLE_FONT_ORIGIN = 'https://fonts.gstatic.com'
const FETCH_TIMEOUT_MS = 10_000
/* Google Fonts answers by user agent: without a current browser's it serves TTF, with it woff2 subsets */
const FONT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

interface Entry {
  response: CachedResponse
  bytes: number
  expiresAt: number
}

/* Map iteration order is insertion order, so re-inserting on a hit keeps the least recently used entry first */
const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<CachedResponse | undefined>>()
let totalBytes = 0
let hits = 0
let misses = 0

export function renderFetchCacheStats(): { entries: number; bytes: number; hits: number; misses: number } {
  return { entries: entries.size, bytes: totalBytes, hits, misses }
}

export function clearRenderFetchCache(): void {
  entries.clear()
  inflight.clear()
  totalBytes = 0
  hits = 0
  misses = 0
}

function remember(key: string, response: CachedResponse, ttlMs: number): void {
  const bytes = response.body.length
  if (bytes > MAX_ENTRY_BYTES) return
  const old = entries.get(key)
  if (old) {
    totalBytes -= old.bytes
    entries.delete(key)
  }
  entries.set(key, { response, bytes, expiresAt: Number.isFinite(ttlMs) ? Date.now() + ttlMs : Infinity })
  totalBytes += bytes
  for (const [oldest, entry] of entries) {
    if (totalBytes <= MAX_CACHE_BYTES) break
    entries.delete(oldest)
    totalBytes -= entry.bytes
  }
}

function recall(key: string): CachedResponse | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key)
    totalBytes -= entry.bytes
    return undefined
  }
  entries.delete(key)
  entries.set(key, entry)
  return entry.response
}

/** A response and how long it may be remembered; `ttlMs` is `Infinity` for one that never changes. */
interface Loaded {
  response: CachedResponse
  ttlMs: number
}

async function loadAsset(url: URL): Promise<Loaded | undefined> {
  const match = /^\/a\/([A-Za-z0-9_-]+)\.([a-z0-9]+)$/.exec(url.pathname)
  if (!match) return undefined
  const [, id, ext] = match
  if (!id || !ext) return undefined
  const v = url.searchParams.get('v')
  const pinnedVersion = v !== null && /^\d{1,9}$/.test(v) ? Number(v) : undefined
  /* a stylesheet can be replaced in place and only a pinned URL names one revision, so an unpinned one is never cached: the normal request path serves it */
  if (ext === 'css' && pinnedVersion === undefined) return undefined
  const found = await getAsset(id, pinnedVersion)
  if (!found || found.meta.ext !== ext) return undefined
  const { mime, version } = found.meta
  const pinned = pinnedVersion !== undefined
  const { 'Content-Type': contentType = mime, ...headers } = assetResponseHeaders(mime, { id, version, pinned })
  headers['Access-Control-Allow-Origin'] = '*'
  if (mime === 'text/css' && !pinned) return undefined
  return { response: { status: 200, headers, contentType, body: found.buf }, ttlMs: Infinity }
}

async function readBounded(response: Response, limit: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return undefined
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function loadGoogleFont(url: URL, ttlMs: number): Promise<Loaded | undefined> {
  const upstream = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': FONT_USER_AGENT, accept: 'text/css,*/*;q=0.1' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (upstream.status !== 200) {
    await upstream.body?.cancel().catch(() => {})
    return undefined
  }
  const body = await readBounded(upstream, MAX_ENTRY_BYTES)
  if (!body) return undefined
  return {
    response: {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' },
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
      body,
    },
    ttlMs,
  }
}

function loaderFor(url: URL): (() => Promise<Loaded | undefined>) | undefined {
  if (url.username || url.password) return undefined
  if (url.origin === new URL(env.BETTER_AUTH_URL).origin) {
    return url.pathname.startsWith('/a/') ? () => loadAsset(url) : undefined
  }
  if (url.origin === GOOGLE_CSS_ORIGIN) return () => loadGoogleFont(url, GOOGLE_CSS_TTL_MS)
  if (url.origin === GOOGLE_FONT_ORIGIN) return () => loadGoogleFont(url, Infinity)
  return undefined
}

/** The answer for a render's request when the cache can give one. `undefined` means the caller carries on as before: not a URL handled here, not found, or the upstream failed. */
export async function cachedRenderResponse(url: URL, method: string): Promise<CachedResponse | undefined> {
  if (method.toUpperCase() !== 'GET') return undefined
  const load = loaderFor(url)
  if (!load) return undefined
  const key = url.href
  const cached = recall(key)
  if (cached) {
    hits++
    return cached
  }
  const running = inflight.get(key)
  if (running) return running
  misses++
  const work = (async () => {
    try {
      const loaded = await load()
      if (!loaded) return undefined
      remember(key, loaded.response, loaded.ttlMs)
      return loaded.response
    } catch {
      return undefined
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, work)
  return work
}
