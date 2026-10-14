import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { RequestHandler } from 'express'

/**
 * Response compression for the large bodies a canvas load pulls: the hashed client bundle under /assets/ and text assets under /a/ (svg and css). Nothing in front of the app compresses (the deploy's Caddy reverse_proxy does not), so without this a 1.4 MB bundle crosses the wire as 1.4 MB. Bodies are immutable for the life of the process, so each is compressed once and kept, within a byte budget.
 */

export type ContentCoding = 'br' | 'gzip'

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

/* brotli quality 9 is about 40x faster than 11 on the bundle for a body within 10% of its size */
const BROTLI_QUALITY = 9
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** The coding to send for an Accept-Encoding header: brotli over gzip, honouring q=0 and `*`; null for identity. */
export function negotiateCoding(acceptEncoding: string | undefined): ContentCoding | null {
  const weights = new Map<string, number>()
  for (const part of (acceptEncoding ?? '').split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    weights.set(name, q ? Number(q.slice(2)) || 0 : 1)
  }
  for (const coding of ['br', 'gzip'] as const) {
    if ((weights.get(coding) ?? weights.get('*') ?? 0) > 0) return coding
  }
  return null
}

export function compress(body: Buffer, coding: ContentCoding): Promise<Buffer> {
  return coding === 'br'
    ? brotli(body, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzip(body, { level: 9 })
}

interface Entry {
  body: Promise<Buffer>
  bytes: number
}

/* Least recently used first: a Map iterates in insertion order, and a hit is re-inserted at the end. Promises are stored so concurrent requests share one compression. */
const cache = new Map<string, Entry>()
let cachedBytes = 0

/** `body` compressed with `coding`, computed once per key while it stays in the cache. */
export function compressedOnce(key: string, body: Buffer, coding: ContentCoding): Promise<Buffer> {
  const id = `${coding}:${key}`
  const hit = cache.get(id)
  if (hit) {
    cache.delete(id)
    cache.set(id, hit)
    return hit.body
  }
  const entry: Entry = { body: compress(body, coding), bytes: body.length }
  cache.set(id, entry)
  cachedBytes += entry.bytes
  entry.body.catch(() => forget(id, entry))
  for (const [oldId, old] of cache) {
    if (cachedBytes <= CACHE_BUDGET_BYTES || old === entry) break
    forget(oldId, old)
  }
  return entry.body
}

function forget(id: string, entry: Entry) {
  if (cache.get(id) !== entry) return
  cache.delete(id)
  cachedBytes -= entry.bytes
}

const COMPRESSIBLE_BUNDLE = /^\/assets\/([\w.-]+\.(?:js|css|svg|json|map))$/

/**
 * Serves Vite's hashed bundle files compressed and cached for good: their names change whenever their content does, so a browser never needs to ask again. Anything else falls through to express.static.
 */
export function compressedBundle(distDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const file = COMPRESSIBLE_BUNDLE.exec(req.path)?.[1]
    if (!file) return next()
    const coding = negotiateCoding(req.headers['accept-encoding'])
    readFile(path.join(distDir, 'assets', file))
      .then(async (raw) => {
        const body = coding ? await compressedOnce(`bundle:${file}`, raw, coding) : raw
        res.type(path.extname(file))
        res.set('Cache-Control', IMMUTABLE)
        res.vary('Accept-Encoding')
        if (coding) res.set('Content-Encoding', coding)
        res.set('Content-Length', String(body.length))
        if (req.method === 'HEAD') res.end()
        else res.end(body)
      })
      .catch(() => next())
  }
}

/** express.static header hook: hashed files under /assets/ are immutable too (images, fonts the bundle references). */
export function immutableAssets(res: { setHeader: (name: string, value: string) => void }, filePath: string): void {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE)
}
