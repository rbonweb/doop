import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as storage from './storage.ts'
import { store } from './store.ts'

/**
 * Uploaded assets: images, plus CSS stylesheets for the callers that opt in. Bytes live in object storage (server/storage.ts), one metadata row per asset in the assets table (including the canvas it was uploaded for). Frame HTML is the ground truth for which assets are still in use, tracked as a projection in asset_refs: every durable frame write re-extracts that frame's /a/<id> references (db/persist.ts), and boot rebuilds the whole table from hydrated frames — so a failed fire-and-forget write self-heals. Nothing is ever deleted; if cleanup is wanted some day, asset_refs is the ledger to build it on.
 *
 * Images are immutable. A stylesheet can be replaced in place (replaceAsset): same id and URL, a bumped `version`. Version 1 stays at `<id>.<ext>`; version n > 1 lives at `<id>-v<n>.<ext>`. An object served under a version number is never overwritten, so `?v=<n>` is safe to cache forever.
 */

export const MAX_ASSET_BYTES = 5 * 1024 * 1024

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'text/css': 'css',
} as const

type AssetMime = keyof typeof MIME_EXT

const CSS_MIME = 'text/css'

/** What a caller is willing to store. Images are always accepted; a stylesheet only when the caller opts in, as the agent upload paths do so a theme stylesheet can be linked from frame HTML. Routes and pipelines that promise images (browser paste, repo transplants, generated images) keep that promise by leaving it off. */
export interface AssetAcceptance {
  stylesheets?: boolean
}

const IMAGES_ONLY_ERROR = 'unsupported file type — png, jpg, webp, gif and svg are accepted'
const WITH_CSS_ERROR = 'unsupported file type — png, jpg, webp, gif, svg and css are accepted'

/* trust the bytes, not the sender: content sniffing decides the type */
export function sniffMime(buf: Buffer, accept: AssetAcceptance = {}): AssetMime | undefined {
  return sniffImage(buf) ?? (accept.stylesheets && looksLikeCss(buf) ? CSS_MIME : undefined)
}

function sniffImage(buf: Buffer): AssetMime | undefined {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1500)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return undefined
}

/* Every pattern below is linear in the input: a 5 MB upload must not be able to stall the event loop with backtracking. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const BINARY_CONTROL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/
const MARKUP_TAG = /<(?:script|html|!doctype|body|iframe)\b/i
const CSS_AT_RULE =
  /(?:^|[\s;{}])@(?:charset|import|namespace|font-face|media|layer|supports|keyframes|-webkit-keyframes|property|container|page|counter-style|font-feature-values|scope|starting-style)\b/i
const DECLARATION = /(?:^|[{;\s])-{0,2}[a-z][\w-]*\s*:/i

/** True when the bytes are a stylesheet and nothing else: strict UTF-8 text without binary control characters, not markup, and shaped like CSS — an at-rule, or a `selector { property: value }` block. */
export function looksLikeCss(buf: Buffer): boolean {
  let text: string
  try {
    /* fatal: invalid UTF-8 throws instead of decoding to U+FFFD. A leading BOM is dropped here, and trimStart() below drops any stray one. */
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return false
  }
  if (BINARY_CONTROL.test(text) || MARKUP_TAG.test(text)) return false
  const start = text.trimStart()
  if (!start || start.startsWith('<')) return false
  const css = stripCssComments(start)
  return CSS_AT_RULE.test(css) || hasRuleBlock(css)
}

function stripCssComments(css: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = css.indexOf('/*', from)
    if (open < 0) return out + css.slice(from)
    out += css.slice(from, open) + ' '
    const close = css.indexOf('*/', open + 2)
    if (close < 0) return out // an unterminated comment runs to the end
    from = close + 2
  }
}

/* The first block must read as a rule: a selector before `{`, and a body that is empty or holds declarations (`color: red`), as a nested rule does too. JSON (`{"a": 1}`, `[{"a": 1}]`) fails both. */
function hasRuleBlock(css: string): boolean {
  const open = css.indexOf('{')
  if (open < 0) return false
  const close = css.indexOf('}', open)
  if (close < 0) return false
  const selector = css.slice(css.lastIndexOf(';', open) + 1, open).trim()
  if (!selector) return false
  const body = css.slice(open + 1, close)
  return !body.trim() || DECLARATION.test(body)
}

/** Which revision of an asset a response carries. A stylesheet can be replaced in place, so unless the request pinned a version (`?v=<n>`) it is revalidated against a strong ETag of `<id>-<version>` instead of cached forever. */
export interface AssetRevision {
  id: string
  version: number
  /** the request named a version: those bytes never change */
  pinned?: boolean
}

/** The ETag of a stylesheet revision. `coding` tells the compressed variants apart, because a strong validator names one exact byte sequence. */
export function assetEtag(rev: Pick<AssetRevision, 'id' | 'version'>, coding?: string): string {
  return `"${rev.id}-${rev.version}${coding ? `-${coding}` : ''}"`
}

/** Whether an If-None-Match header names this ETag (weak comparison, as for a GET). Checked here rather than through Express's `req.fresh`, which treats a request's `Cache-Control: no-cache` (what fetch() sends with a conditional request) as never fresh, although a 304 is exactly the answer a revalidation wants. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  const bare = (tag: string) => tag.trim().replace(/^W\//, '')
  return ifNoneMatch.split(',').some((tag) => bare(tag) === '*' || bare(tag) === etag)
}

/** Response headers for serving an asset. Every type gets nosniff, so a browser never second-guesses the sniffed type. Documents are neutered: an svg can script, and a stylesheet opened in a tab is a document too. Neither affects embedding, because <img>, CSS backgrounds and <link rel="stylesheet"> ignore a resource's own CSP. Stylesheets also allow any origin, so a <link crossorigin integrity> in a frame loads as well. Images are immutable and cached for a year; so is a stylesheet fetched at a pinned version, while the unpinned URL revalidates (`no-cache` plus an ETag) so a replacement shows up at once. */
export function assetResponseHeaders(mime: string, rev?: AssetRevision): Record<string, string> {
  const mutable = mime === CSS_MIME && !rev?.pinned
  const headers: Record<string, string> = {
    'Content-Type': mime === CSS_MIME ? 'text/css; charset=utf-8' : mime,
    'Cache-Control': mutable ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  }
  if (mutable && rev) headers['ETag'] = assetEtag(rev)
  if (mime === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'"
  if (mime === CSS_MIME) {
    headers['Content-Security-Policy'] = "default-src 'none'"
    headers['Access-Control-Allow-Origin'] = '*'
  }
  return headers
}

/** Assets served as text, which compress well: svg and css. */
export function isTextAsset(mime: string): boolean {
  return mime === CSS_MIME || mime === 'image/svg+xml'
}

/** The markup an agent pastes into frame HTML to use an uploaded asset. */
export function assetUsage(mime: string, url: string): string {
  return mime === CSS_MIME ? `<link rel="stylesheet" href="${url}">` : `<img src="${url}" alt="">`
}

/* One-time upload tickets: a local file can't ride an MCP tool call (every
   byte of a tool argument streams through the model — slow, and corruptible
   past a few KB), so upload_asset hands out a capability URL instead and the
   agent curls the bytes to PUT /u/<token>. In-memory on purpose: single
   process, short TTL, single use. */
const TICKET_TTL_MS = 15 * 60 * 1000

interface UploadTicket {
  canvasId: string
  ownerId?: string
  /** set when the upload replaces this stylesheet in place instead of creating an asset */
  replaceAssetId?: string
  uploadedBy: string
  expiresAt: number
  inFlight: boolean
}
const tickets = new Map<string, UploadTicket>()

export function createUploadTicket(meta: {
  canvasId: string
  ownerId?: string
  uploadedBy: string
  replaceAssetId?: string
}): {
  token: string
  expiresAt: number
} {
  for (const [k, v] of tickets) if (v.expiresAt < Date.now()) tickets.delete(k)
  const token = nanoid(24)
  const expiresAt = Date.now() + TICKET_TTL_MS
  tickets.set(token, { ...meta, expiresAt, inFlight: false })
  return { token, expiresAt }
}

/** Claim a ticket for an upload attempt. Returns null when the token is
 *  unknown, expired, already consumed, or mid-upload elsewhere. */
export function beginTicketUpload(token: string): Omit<UploadTicket, 'inFlight'> | null {
  const t = tickets.get(token)
  if (!t || t.expiresAt < Date.now() || t.inFlight) return null
  t.inFlight = true
  return t
}

/** Success consumes the ticket; failure releases it for a retry until TTL. */
export function endTicketUpload(token: string, success: boolean): void {
  if (success) tickets.delete(token)
  else {
    const t = tickets.get(token)
    if (t) t.inFlight = false
  }
}

/** Asset ids referenced by a piece of frame HTML (/a/<id>.<ext> URLs). */
export function extractAssetIds(html: string): Set<string> {
  const ids = new Set<string>()
  for (const [, id] of html.matchAll(/\/a\/([A-Za-z0-9_-]+)\.[a-z0-9]+/g)) if (id) ids.add(id)
  return ids
}

export interface AssetMeta {
  id: string
  mime: string
  ext: string
  size: number
}

export async function createAsset(
  buf: Buffer,
  meta: { canvasId?: string; ownerId?: string; uploadedBy: string },
  accept: AssetAcceptance = {},
): Promise<AssetMeta> {
  if (buf.length === 0) throw new Error('empty file')
  if (buf.length > MAX_ASSET_BYTES)
    throw new Error(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
  const mime = sniffMime(buf, accept)
  if (!mime) throw new Error(accept.stylesheets ? WITH_CSS_ERROR : IMAGES_ONLY_ERROR)
  const ext = MIME_EXT[mime]
  const id = nanoid(10)
  /* object first, row second: an orphaned object is swept later, but a row
     without bytes would serve 404s forever */
  await storage.putObject(`${id}.${ext}`, buf, mime)
  await db.insert(t.assets).values({
    id,
    canvasId: meta.canvasId ?? null,
    ownerId: meta.ownerId ?? null,
    mime,
    ext,
    size: buf.length,
    uploadedBy: meta.uploadedBy,
    createdAt: Date.now(),
  })
  return { id, mime, ext, size: buf.length }
}

/** Where a revision's bytes live: version 1 is the original upload at `<id>.<ext>`, later versions get a key of their own, so no key ever changes content once it is served. */
const revisionKey = (id: string, version: number, ext: string) =>
  version <= 1 ? `${id}.${ext}` : `${id}-v${version}.${ext}`

export type AssetVersionMeta = AssetMeta & { version: number }

/** An asset's bytes. Without `version` this is the latest. With one, a stylesheet answers that exact revision and null when the revision never existed; images have one revision and ignore it. `latest` is the newest version either way. */
export async function getAsset(
  id: string,
  version?: number,
): Promise<{ meta: AssetVersionMeta; buf: Buffer; latest: number } | null> {
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
  if (!row) return null
  const wanted = row.mime === CSS_MIME && version !== undefined ? version : row.version
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > row.version) return null
  const buf = await storage.getObject(revisionKey(row.id, wanted, row.ext))
  if (!buf) return null
  return {
    meta: { id: row.id, mime: row.mime, ext: row.ext, size: buf.length, version: wanted },
    buf,
    latest: row.version,
  }
}

/** The asset id in an uploaded asset's URL: `https://host/a/<id>.css`, `/a/<id>.css`, either with `?v=` or a fragment. */
export function assetIdFromUrl(url: string): string | undefined {
  const path = url.trim().replace(/^https?:\/\/[^/?#]+/i, '')
  return /^\/a\/([A-Za-z0-9_-]+)\.[a-z0-9]+(?:[?#].*)?$/.exec(path)?.[1]
}

/** Ids of the frames whose HTML links this asset: the asset_refs projection, plus a scan of the frames in memory. persist writes asset_refs on a debounce, so a frame created just before a replace is only in the scan. */
export async function framesReferencingAsset(id: string): Promise<string[]> {
  const rows = await db.select({ frameId: t.assetRefs.frameId }).from(t.assetRefs).where(eq(t.assetRefs.assetId, id))
  const ids = new Set(rows.map((r) => r.frameId))
  const needle = `/a/${id}.`
  for (const canvas of store.canvases.values())
    for (const frame of canvas.frames) if (frame.html.includes(needle)) ids.add(frame.id)
  return [...ids]
}

export interface AssetReplacement {
  assetId: string
  version: number
  frameIds: string[]
}

type ReplacedListener = (replacement: AssetReplacement) => void
let replacedListener: ReplacedListener | undefined

/** server/index.ts registers the one listener that tells open canvases and drops cached screenshots; assets.ts stays free of the websocket room. */
export function onAssetReplaced(listener: ReplacedListener): void {
  replacedListener = listener
}

const REPLACE_IMAGES_ERROR =
  'only stylesheets can be replaced in place — images are immutable. Upload the new image and point the frames at its URL'
const REPLACE_NOT_CSS_ERROR = 'the new file is not a stylesheet — a stylesheet can only be replaced with valid CSS'

/* Replacements of one asset run one after another within this process, so two racing updates cannot interleave their object writes. The version check on the row guards the rest. */
const replacing = new Map<string, Promise<unknown>>()

function serialized<T>(id: string, job: () => Promise<T>): Promise<T> {
  const run = (replacing.get(id) ?? Promise.resolve()).then(job, job)
  const tail = run.catch(() => {})
  replacing.set(id, tail)
  void tail.then(() => {
    if (replacing.get(id) === tail) replacing.delete(id)
  })
  return run
}

/** Replace an uploaded stylesheet's bytes in place: same id, extension and URL, `version` + 1. The new bytes are written to `<id>-v<next>.css` before the row moves, so a request never sees new bytes under an old version number; the previous versions keep their own keys and stay served at `?v=<n>`. Fires the registered listener with the frames that link it. Replacing with identical bytes changes nothing and answers `unchanged: true`. A caller that knows who is asking passes `ownerId` and/or `canvasId`: the asset may then be replaced only by its uploader, or from the canvas it was uploaded for. */
export async function replaceAsset(
  id: string,
  buf: Buffer,
  meta: { uploadedBy: string; ownerId?: string; canvasId?: string },
): Promise<{ ok: true; asset: AssetVersionMeta; unchanged: boolean } | { ok: false; error: string }> {
  return serialized(id, async () => {
    const fail = (error: string) => ({ ok: false as const, error })
    const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
    if (!row) return fail('asset not found')
    if (row.mime !== CSS_MIME) return fail(REPLACE_IMAGES_ERROR)
    /* asset URLs are public, so knowing one proves nothing: the caller must be its uploader or work on its canvas (an internal caller passes neither) */
    const internal = meta.ownerId === undefined && meta.canvasId === undefined
    const sameOwner = !!row.ownerId && row.ownerId === meta.ownerId
    const sameCanvas = !!meta.canvasId && row.canvasId === meta.canvasId
    if (!internal && !sameOwner && !sameCanvas)
      return fail('this asset belongs to someone else on another canvas — it cannot be replaced from here')
    if (buf.length === 0) return fail('empty file')
    if (buf.length > MAX_ASSET_BYTES)
      return fail(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
    if (!looksLikeCss(buf)) return fail(REPLACE_NOT_CSS_ERROR)

    const current = await storage.getObject(revisionKey(row.id, row.version, row.ext))
    if (!current) return fail('the stored stylesheet is missing')
    const asset = (version: number): AssetVersionMeta => ({
      id: row.id,
      mime: row.mime,
      ext: row.ext,
      size: buf.length,
      version,
    })
    if (current.equals(buf)) return { ok: true, asset: asset(row.version), unchanged: true }

    const next = row.version + 1
    const nextKey = revisionKey(row.id, next, row.ext)
    /* object first, row second: until the row moves nothing points at the new key, and a failed row update only leaves an object to clean up */
    await storage.putObject(nextKey, buf, row.mime)
    try {
      const moved = await db
        .update(t.assets)
        .set({ version: next, size: buf.length })
        .where(and(eq(t.assets.id, row.id), eq(t.assets.version, row.version)))
        .returning({ id: t.assets.id })
      /* another writer took this version number first, and the object at nextKey is now theirs: leave it */
      if (!moved.length) return fail('the stylesheet changed while it was being replaced — try again')
    } catch (e) {
      await storage.deleteObject(nextKey).catch(() => {})
      return fail(e instanceof Error ? e.message : 'replace failed')
    }
    const frameIds = await framesReferencingAsset(row.id).catch(() => [])
    replacedListener?.({ assetId: row.id, version: next, frameIds })
    return { ok: true, asset: asset(next), unchanged: false }
  })
}

/** Fetch a remote file through the SSRF guard, validating every redirect
 *  hop, with a hard size cap enforced while streaming. */
export async function fetchRemote(rawUrl: string): Promise<Buffer> {
  const { fetchPinnedPublicUrl, parsePublicHttpUrl } = await import('./publicUrl.ts')
  let url = parsePublicHttpUrl(rawUrl)
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchPinnedPublicUrl(url, {
      redirect: 'manual',
      headers: { accept: 'image/*,text/css;q=0.9,*/*;q=0.8', 'user-agent': 'DoopAssets/1.0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('redirect without a location')
      url = parsePublicHttpUrl(new URL(loc, url).href)
      continue
    }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
    if (Number(res.headers.get('content-length') || 0) > MAX_ASSET_BYTES) throw new Error('file exceeds the 5 MB limit')
    if (!res.body) throw new Error('empty response')
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel()
        throw new Error('file exceeds the 5 MB limit')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('too many redirects')
}

/** Rebuild the asset_refs projection from a full set of frames — called at
 *  boot with the frames hydrate just loaded (no extra I/O), which both
 *  backfills pre-existing content and heals any drift from failed
 *  write-through. Incremental upkeep afterwards lives in db/persist.ts. */
export async function reconcileAssetRefs(frames: { id: string; html: string }[]): Promise<number> {
  const rows: { assetId: string; frameId: string }[] = []
  for (const f of frames) for (const assetId of extractAssetIds(f.html)) rows.push({ assetId, frameId: f.id })
  await db.delete(t.assetRefs)
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(t.assetRefs)
      .values(rows.slice(i, i + 1000))
      .onConflictDoNothing()
  }
  return rows.length
}
