import { createHash } from 'node:crypto'
import { env } from './env.ts'
import type { Frame } from '../shared/types.ts'
import { fitExportScale } from '../shared/exportScale.ts'
import * as thumbs from './thumbs.ts'
import { store } from './store.ts'
import type { RenderParams } from './renderTypes.ts'
import { normalizeRenderParams, renderExt, renderParamsHash, renderParamsKey } from './renderParams.ts'
import { getStoredRender, purgeFrameRenders, putStoredRender } from './renderStore.ts'

/**
 * Everything behind GET /i/<frameId>.<ext> except HTTP: the in-process
 * image cache, the render rate limit, and the dispatch between the three
 * ways an image can be produced (persisted thumbnail, preview render,
 * full-size render). The route stays thin — params, auth callback,
 * headers — and this module stays testable without a server.
 *
 * Freshness model, one layer per lifetime:
 *  - imgCache: per-process, ~minutes. Holds the render *promise*, not the
 *    buffer, so concurrent requests for the same key share one render.
 *    May serve a just-revalidated thumb's previous bytes for up to
 *    IMG_CACHE_MS — accepted, previews only claim minutes-freshness.
 *  - thumbs (previews only): persisted across deploys, stale-while-
 *    revalidate. See thumbs.ts.
 *  - a full-size render is never persisted; it exists for og:image embeds
 *    and downloads, and is only ever cached here.
 */

const imgCache = new Map<string, { buf: Promise<Buffer>; updatedAt: number; at: number }>()
/* the renders of `getRender`: promise of bytes plus their strong ETag, keyed by frame and normalized params */
interface Render {
  buf: Buffer
  etag: string
}
const renderCache = new Map<string, { render: Promise<Render>; updatedAt: number; at: number }>()
const IMG_CACHE_MS = 5 * 60_000
const IMG_CACHE_MAX = 200

/* Renders boot Chromium pages; cached serves and persisted-thumb serves are
   cheap and never metered. The budget is per IP because its purpose is
   anonymous hotlink abuse — authenticated users bypass it (verified by the
   caller, and only checked when the budget is actually exhausted). */
const renderHits = new Map<string, number[]>()
const RENDERS_PER_MIN = env.PREVIEW_RENDERS_PER_MIN

export interface ImageRequest {
  ext: 'png' | 'jpg'
  /** output density, already parsed and fitted (shared/exportScale.ts) */
  scale: number
  quality: number
  /** dashboard-card variant: small, clipped, jpeg, persisted. Only
   *  meaningful for jpg — a png?preview would serve jpeg bytes under an
   *  image/png content-type, so the flag is ignored there. */
  preview: boolean
  ip: string
  /** consulted only when the render budget is exhausted */
  isAuthenticated: () => Promise<boolean>
}

export type ImageResult = { status: 'ok'; buf: Buffer } | { status: 'rate-limited' }

/** May reject when the render itself fails — the caller owns the 500. */
export async function getImage(frame: Frame, req: ImageRequest): Promise<ImageResult> {
  const preview = req.preview && req.ext === 'jpg'
  /* the callers fit the scale already; fitting again changes nothing for them and keeps any other caller inside the render limits */
  const scale = fitExportScale(frame, req.scale)
  const key = imageKey(frame.id, req.ext, scale, req.ext === 'jpg' ? req.quality : '', preview)
  /* an invalidation while a render is in flight makes its result stale: it is served to the request that asked, never cached */
  const generation = thumbs.generation(frame.id)
  const cached = imgCache.get(key)
  let pending =
    cached && cached.updatedAt === frame.updatedAt && Date.now() - cached.at < IMG_CACHE_MS ? cached.buf : null

  /* previews first try the persisted thumbnail: survives redeploys, serves
     instantly even when stale (thumbs revalidates in the background), and
     costs no Chromium boot — so it isn't metered either */
  if (!pending && preview) {
    const stored = await thumbs.getStored(frame)
    if (stored) {
      pending = Promise.resolve(stored)
      if (thumbs.generation(frame.id) === generation) remember(key, pending, frame.updatedAt)
    }
  }

  if (!pending) {
    if (!(await consumeRenderBudget(req.ip, req.isAuthenticated))) return { status: 'rate-limited' }
    const started = thumbs.generation(frame.id)
    pending = preview
      ? /* renders AND persists — the next cold start serves from storage */
        thumbs.create(frame)
      : loadScreenshot().then(async ({ renderFrame }) =>
          renderFrame(await store.renderSource(frame), scale, {
            type: req.ext === 'jpg' ? 'jpeg' : 'png',
            quality: req.quality,
          }),
        )
    remember(key, pending, frame.updatedAt, () => thumbs.generation(frame.id) === started)
  }

  return { status: 'ok', buf: await pending }
}

function imageKey(id: string, ext: 'png' | 'jpg', scale: number, quality: number | '', preview: boolean): string {
  return `${id}:${ext}:${scale}:${quality}:${preview ? 'p' : ''}`
}

export interface RenderRequest {
  ip: string
  /** consulted only when the render budget is exhausted */
  isAuthenticated: () => Promise<boolean>
}

export type RenderResult = { status: 'ok'; buf: Buffer; etag: string } | { status: 'rate-limited' }

/** A strong ETag of the bytes: the first 27 base64url characters of their sha1. */
function etagOf(buf: Buffer): string {
  return `"${createHash('sha1').update(buf).digest('base64url').slice(0, 27)}"`
}

/** The image of one frame version at normalized params, from the cheapest source: this process, the render store (free, not metered), or a metered render that is then persisted. May reject when the render fails. */
export async function getRender(frame: Frame, params: RenderParams, req: RenderRequest): Promise<RenderResult> {
  const key = `${frame.id}:${renderParamsKey(params)}`
  const generation = thumbs.generation(frame.id)
  const cached = renderCache.get(key)
  let pending =
    cached && cached.updatedAt === frame.updatedAt && Date.now() - cached.at < IMG_CACHE_MS ? cached.render : null

  if (!pending) {
    const hash = renderParamsHash(params)
    const stored = await getStoredRender(frame.id, frame.updatedAt, hash, renderExt(params.format))
    if (stored) {
      pending = Promise.resolve({ buf: stored, etag: etagOf(stored) })
      if (thumbs.generation(frame.id) === generation) rememberRender(key, pending, frame.updatedAt)
    }
  }

  if (!pending) {
    if (!(await consumeRenderBudget(req.ip, req.isAuthenticated))) return { status: 'rate-limited' }
    const started = thumbs.generation(frame.id)
    const { crop } = params
    const rendering = loadScreenshot()
      .then(async ({ captureFrame }) =>
        captureFrame(await store.renderSource(frame), {
          format: params.format,
          scale: params.scale,
          quality: params.quality,
          clip: crop ? { x: crop.x, y: crop.y, width: crop.w, height: crop.h } : undefined,
        }),
      )
      .then(({ buf }) => {
        /* persist only a render nothing invalidated while it ran, and never fail the request on it */
        if (thumbs.generation(frame.id) === started) {
          void putStoredRender(frame.id, frame.updatedAt, renderParamsHash(params), renderExt(params.format), buf)
        }
        return { buf, etag: etagOf(buf) }
      })
    pending = rendering
    rememberRender(key, pending, frame.updatedAt, () => thumbs.generation(frame.id) === started)
  }

  const { buf, etag } = await pending
  return { status: 'ok', buf, etag }
}

/** Seeds the cache with a render another path already paid for. The MCP
 *  screenshot tool renders through `renderFrame` directly, and the ChatGPT
 *  preview card loads `/i/<id>.png` right after it from a cookie-less sandbox
 *  iframe — anonymous, so metered. Priming turns that load into a free
 *  cached serve instead of a second render against the per-IP budget. */
export function primeImage(frame: Frame, scale: number, png: Buffer): void {
  remember(imageKey(frame.id, 'png', scale, '', false), Promise.resolve(png), frame.updatedAt)
  /* the same bytes are what `/i/<id>.png?scale=` now asks `getRender` for */
  rememberRender(
    `${frame.id}:${renderParamsKey(normalizeRenderParams(frame, { format: 'png', scale }))}`,
    Promise.resolve({ buf: png, etag: etagOf(png) }),
    frame.updatedAt,
  )
}

/** Drops every cached render of a frame, for a change the frame's own html and updatedAt do not show (a stylesheet it links was replaced). The persisted dashboard thumbnail is marked stale, so the next preview request serves it and re-renders in the background. */
export function invalidateFrameImages(frameId: string): void {
  for (const key of imgCache.keys()) if (key.startsWith(`${frameId}:`)) imgCache.delete(key)
  for (const key of renderCache.keys()) if (key.startsWith(`${frameId}:`)) renderCache.delete(key)
  thumbs.invalidate(frameId)
  void purgeFrameRenders(frameId)
}

function remember(key: string, pending: Promise<Buffer>, updatedAt: number, stillCurrent: () => boolean = () => true) {
  imgCache.set(key, { buf: pending, updatedAt, at: Date.now() })
  /* a failed render must not be served for IMG_CACHE_MS — drop it so the
     next request retries */
  const drop = () => {
    if (imgCache.get(key)?.buf === pending) imgCache.delete(key)
  }
  pending.then(() => {
    /* the frame was invalidated while this rendered: its pixels are from before the change */
    if (!stillCurrent()) drop()
  }, drop)
  if (imgCache.size > IMG_CACHE_MAX) {
    const oldest = [...imgCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) imgCache.delete(oldest[0])
  }
}

function rememberRender(
  key: string,
  pending: Promise<Render>,
  updatedAt: number,
  stillCurrent: () => boolean = () => true,
) {
  renderCache.set(key, { render: pending, updatedAt, at: Date.now() })
  const drop = () => {
    if (renderCache.get(key)?.render === pending) renderCache.delete(key)
  }
  pending.then(() => {
    if (!stillCurrent()) drop()
  }, drop)
  if (renderCache.size > IMG_CACHE_MAX) {
    const oldest = [...renderCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) renderCache.delete(oldest[0])
  }
}

async function consumeRenderBudget(ip: string, isAuthenticated: () => Promise<boolean>): Promise<boolean> {
  const now = Date.now()
  const hits = (renderHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= RENDERS_PER_MIN) return isAuthenticated()
  hits.push(now)
  renderHits.set(ip, hits)
  return true
}

/* lazy so dev never pays for puppeteer-core until the first render;
   single-flight because concurrent import() of one module can serialize */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))
