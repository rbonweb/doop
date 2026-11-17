import { z } from 'zod'
import { activeComponents, type ComponentDef } from '../../shared/components.ts'
import { readingOrder } from '../../shared/frameOrder.ts'
import { canvasPages, pageFrames } from '../../shared/pages.ts'
import type { Canvas, Frame } from '../../shared/types.ts'
import { env } from '../env.ts'
import { createRateLimiter } from '../rateLimit.ts'
import { store } from '../store.ts'
import { buildReactExport, type ReactExportResult, type ReactStyling } from './index.ts'
import { fileBase, NameAllocator } from './names.ts'

/** What a JSON answer (the route's `format: 'json'`, the MCP tool's inline result) may carry in file content before it is refused or moved to a download. */
export const MAX_INLINE_EXPORT_BYTES = 300 * 1024
/** The most file content one export may hold at all, zip or not: a canvas past it needs a narrower scope. */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024
/** At most this many frames and components in one request. */
export const MAX_EXPORT_ITEMS = 200

/** One body for the route and the same arguments for the tool, validated once. */
export const reactExportRequest = z
  .object({
    frameIds: z.array(z.string().min(1).max(200)).max(MAX_EXPORT_ITEMS).optional(),
    pageId: z.string().min(1).max(200).optional(),
    componentIds: z.array(z.string().min(1).max(200)).max(MAX_EXPORT_ITEMS).optional(),
    styling: z.enum(['modules', 'tailwind']).optional(),
    tokens: z.boolean().optional(),
    format: z.enum(['zip', 'json']).optional(),
  })
  .strict()
export type ReactExportRequest = z.infer<typeof reactExportRequest>

/* Exporting is CPU work on the server's one thread: metered per account (or per address for a share-link visitor). */
const newLimiter = () => createRateLimiter({ max: env.REACT_EXPORTS_PER_MIN, windowMs: 60_000 })
let limiter = newLimiter()

/** Claim one export from `key`'s per-minute budget; false when it is spent. */
export function takeReactExportSlot(key: string): boolean {
  return limiter.take(key)
}

/** Seconds until `key` may export again (the Retry-After of a refusal). */
export function reactExportRetryAfter(key: string): number {
  return Math.max(1, limiter.retryAfter(key))
}

/** For tests: forget everyone's budget. */
export function resetReactExportBudget(): void {
  limiter = newLimiter()
}

export type CanvasExport =
  | { ok: true; result: ReactExportResult; rootDir: string; fileName: string; bytes: number }
  | { ok: false; status: 400 | 404 | 413 | 500; error: string }

const STANDALONE_SHAPE = /<body\b[^>]*\bdata-doop-canvas-element=/i

/** A frame a page export takes as a screen: not hidden, not a drawing on the paper and not product demo content. A frame holding a component's main stays a screen: a main is often an element of a real design. */
function isScreen(frame: Frame): boolean {
  return !frame.hidden && !frame.demo && !STANDALONE_SHAPE.test(frame.html)
}

function selectFrames(canvas: Canvas, request: ReactExportRequest) {
  const byId = new Map(canvas.frames.map((frame) => [frame.id, frame]))
  const chosen: Frame[] = []
  const add = (frame: Frame) => {
    if (!chosen.includes(frame)) chosen.push(frame)
  }
  for (const id of request.frameIds ?? []) {
    const frame = byId.get(id)
    if (!frame) return { ok: false as const, error: `frame ${id} is not on this canvas`, status: 404 as const }
    add(frame)
  }
  const wantsComponentsOnly = !request.pageId && !request.frameIds?.length && request.componentIds?.length
  if (request.pageId || (!request.frameIds?.length && !wantsComponentsOnly)) {
    const pages = canvasPages(canvas)
    const pageId = request.pageId ?? pages[0]?.id
    if (!pageId || !pages.some((page) => page.id === pageId)) {
      return { ok: false as const, error: `page ${request.pageId ?? ''} is not on this canvas`, status: 404 as const }
    }
    for (const frame of readingOrder(pageFrames(canvas, pageId).filter(isScreen))) add(frame)
  }
  return { ok: true as const, frames: chosen }
}

function selectComponents(requested: readonly string[], components: readonly ComponentDef[]) {
  const ids: string[] = []
  for (const ref of requested) {
    const def =
      components.find((candidate) => candidate.id === ref) ??
      components.find((candidate) => candidate.name.toLowerCase() === ref.toLowerCase())
    if (!def) return { ok: false as const, error: `component ${ref} is not on this canvas`, status: 404 as const }
    if (!ids.includes(def.id)) ids.push(def.id)
  }
  return { ok: true as const, ids }
}

/** The origin root-relative Doop asset URLs in the export point at: the server's public one, as the renderer uses. */
function assetOrigin(): string {
  return new URL(env.BETTER_AUTH_URL).origin
}

export const contentBytes = (result: ReactExportResult): number =>
  result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)

/**
 * Select what the request names on a canvas the caller may already view, and export it. With no frame, page or component named,
 * the canvas's first page (the PDF export's default) goes out with the components it uses; component ids alone export only those components.
 * Never throws for canvas content: what could not be carried is in the report.
 */
export function exportCanvasReact(canvas: Canvas, request: ReactExportRequest): CanvasExport {
  const components = activeComponents(store.getComponents(canvas.id))
  const frames = selectFrames(canvas, request)
  if (!frames.ok) return { ok: false, status: frames.status, error: frames.error }
  const wanted = selectComponents(request.componentIds ?? [], components)
  if (!wanted.ok) return { ok: false, status: wanted.status, error: wanted.error }
  if (!frames.frames.length && !wanted.ids.length) {
    return {
      ok: false,
      status: 400,
      error: 'There is nothing to export: no screens on that page and no components named',
    }
  }
  const styling: ReactStyling = request.styling ?? 'modules'
  let result: ReactExportResult
  try {
    result = buildReactExport({
      canvasName: canvas.name,
      components,
      frames: frames.frames.map((frame) => ({ id: frame.id, name: frame.name, html: frame.html })),
      componentIds: wanted.ids,
      tokens: store.getTokens(canvas.id),
      themeOrder: store.getTokenThemes(canvas.id),
      styling,
      includeTokens: request.tokens ?? true,
      assetOrigin: assetOrigin(),
    })
  } catch (e) {
    console.error('[react-export] export failed', e)
    return { ok: false, status: 500, error: 'The export failed' }
  }
  const bytes = contentBytes(result)
  if (bytes > MAX_EXPORT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'This export is too large: export one page, fewer frames or fewer components at a time',
    }
  }
  const base = fileBase(canvas.name, new NameAllocator({ caseInsensitive: true }))
  return { ok: true, result, rootDir: `${base}-react`, fileName: `${base}-react.zip`, bytes }
}
