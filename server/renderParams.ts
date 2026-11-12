/** Normalized render parameters of one frame image: the `/i/` query, the render tools' arguments and the render store all meet here. Pure, so the server and the tests read a query the same way. */

import { createHash } from 'node:crypto'
import type { Frame } from '../shared/types.ts'
import { fitExportScale, MAX_EXPORT_SCALE, MIN_EXPORT_SCALE, parseExportScale } from '../shared/exportScale.ts'
import type { RenderCrop, RenderFormat, RenderParams } from './renderTypes.ts'

/** The quality a format starts at when the caller names none; png is lossless. */
export const DEFAULT_QUALITY: Record<RenderFormat, number> = { png: 0, jpg: 90, webp: 80 }

/** What the `/i/` route and the render tools hand in, before defaults and limits. */
export interface RenderInput {
  format?: RenderFormat
  scale?: number
  quality?: number
  width?: number
  crop?: RenderCrop
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Express repeats a query key as an array; every caller here wants the first value. */
function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

/** A query value as text; numbers (MCP arguments) count as their decimal spelling. */
function queryText(value: unknown): string | undefined {
  const first = firstValue(value)
  if (typeof first === 'string') return first
  if (typeof first === 'number' && Number.isFinite(first)) return String(first)
  return undefined
}

/** A query value as a finite number, or undefined when it is missing or unreadable. */
function queryNumber(value: unknown): number | undefined {
  const text = queryText(value)
  if (text === undefined || text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

function isRenderFormat(value: unknown): value is RenderFormat {
  return value === 'png' || value === 'jpg' || value === 'webp'
}

/** Defaults, crop clamping, the export limits, a downscale-only `width` and the quality rule, in one place. */
export function normalizeRenderParams(frame: Pick<Frame, 'width' | 'height'>, input: RenderInput): RenderParams {
  const format = input.format ?? 'png'
  const frameW = Math.max(1, Math.ceil(frame.width))
  const frameH = Math.max(1, Math.ceil(frame.height))
  let areaW = frame.width
  let areaH = frame.height
  let crop: RenderCrop | undefined
  if (input.crop) {
    /* round the edges out to whole pixels, then keep them on the frame */
    const x = Math.max(0, Math.floor(input.crop.x))
    const y = Math.max(0, Math.floor(input.crop.y))
    const w = Math.min(Math.ceil(input.crop.w), frameW - x)
    const h = Math.min(Math.ceil(input.crop.h), frameH - y)
    if (w < 1 || h < 1) throw new RangeError('crop is outside the frame')
    areaW = w
    areaH = h
    /* a crop of the whole frame is no crop at all: same cache key as none */
    if (x !== 0 || y !== 0 || w !== frameW || h !== frameH) crop = { x, y, w, h }
  }
  let scale = fitExportScale(
    { width: areaW, height: areaH },
    clamp(input.scale ?? 1, MIN_EXPORT_SCALE, MAX_EXPORT_SCALE),
  )
  /* width only ever lowers the scale: asking for a wider image than the area cannot invent pixels */
  if (input.width !== undefined && input.width > 0 && input.width < areaW * scale) scale = input.width / areaW
  /* the precision and floor parseExportScale accepts, so renderUrlQuery output parses back to equal params */
  scale = Math.max(MIN_EXPORT_SCALE, Math.round(scale * 100) / 100)
  const quality = format === 'png' ? 0 : Math.round(clamp(input.quality ?? DEFAULT_QUALITY[format], 1, 100))
  return { format, scale, quality, ...(crop ? { crop } : {}) }
}

/** The `/i/<id>.<ext>` query as normalized params, or the message to answer with. */
export function parseRenderQuery(
  frame: Pick<Frame, 'width' | 'height'>,
  ext: string,
  query: Record<string, unknown>,
): RenderParams | { error: string } {
  if (!isRenderFormat(ext)) return { error: 'unsupported format' }
  let format: RenderFormat = ext
  const asked = queryText(query.format)
  if (asked !== undefined && asked.trim() !== '') {
    if (asked === 'jpeg') format = 'jpg'
    else if (isRenderFormat(asked)) format = asked
    else return { error: 'unsupported format' }
  }
  /* missing or unreadable scale is 1x, exactly as the route has always read it */
  const scale = parseExportScale(firstValue(query.scale)) ?? 1
  /* q is the short spelling the new tools and URLs use; quality stays the old name */
  const quality = queryNumber(query.q) ?? queryNumber(query.quality)
  const widthText = queryText(query.width)?.trim()
  const width =
    widthText !== undefined && /^\d+$/.test(widthText) && Number(widthText) > 0 ? Number(widthText) : undefined
  const cropKeys = ['x', 'y', 'w', 'h'] as const
  const present = cropKeys.filter((key) => query[key] !== undefined)
  let crop: RenderCrop | undefined
  if (present.length > 0) {
    if (present.length < cropKeys.length) return { error: 'crop needs x, y, w and h' }
    const x = queryNumber(query.x)
    const y = queryNumber(query.y)
    const w = queryNumber(query.w)
    const h = queryNumber(query.h)
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      return { error: 'crop needs x, y, w and h' }
    }
    if (x < 0 || y < 0 || w <= 0 || h <= 0) return { error: 'crop needs x, y, w and h' }
    crop = { x, y, w, h }
  }
  try {
    return normalizeRenderParams(frame, { format, scale, quality, width, crop })
  } catch (e) {
    if (e instanceof RangeError) return { error: e.message }
    throw e
  }
}

/** The stable cache key of one render: every field a different image depends on. */
export function renderParamsKey(p: RenderParams): string {
  const base = `${p.format}|s${p.scale}|q${p.quality}`
  return p.crop ? `${base}|c${p.crop.x},${p.crop.y},${p.crop.w},${p.crop.h}` : base
}

/** A short file-name-safe digest of the key. */
export function renderParamsHash(p: RenderParams): string {
  return createHash('sha1').update(renderParamsKey(p)).digest('hex').slice(0, 16)
}

/** The HTTP content type of a rendered image. */
export function renderMime(format: RenderFormat): string {
  return format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : 'image/webp'
}

/** The file extension of a rendered image, as the `/i/` route spells it. */
export function renderExt(format: RenderFormat): 'png' | 'jpg' | 'webp' {
  return format
}

/** The query string that reproduces these params on `/i/<id>.<ext>`, without the `?`. */
export function renderUrlQuery(p: RenderParams, version?: number): string {
  const parts = [`scale=${p.scale}`]
  if (p.format !== 'png') parts.push(`q=${p.quality}`)
  if (p.crop) parts.push(`x=${p.crop.x}`, `y=${p.crop.y}`, `w=${p.crop.w}`, `h=${p.crop.h}`)
  if (version !== undefined) parts.push(`v=${version}`)
  return parts.join('&')
}
