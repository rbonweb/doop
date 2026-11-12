import type Sharp from 'sharp'

/**
 * Join several images into one labelled sheet so an agent can look at a whole flow in a single image.
 * Cells keep their own pixels; the canvas is only as large as the laid-out cells need.
 */

export interface CompositeItem {
  buf: Buffer
  label?: string
}

export interface CompositeOptions {
  layout: 'row' | 'grid'
  /** px between cells and around the edge, default 24 */
  gap?: number
  /** px reserved above each cell for its label when any item has one, default 36 */
  labelHeight?: number
  /** the output is scaled down (never up) to fit this width, default 2400 */
  maxWidth?: number
  /** default '#f5f5f5' */
  background?: string
  format?: 'png' | 'webp'
}

interface Cell {
  buf: Buffer
  label: string | null
  width: number
  height: number
}

const MAX_ITEMS = 8
const MAX_LABEL_CHARS = 80
const LABEL_FONT_SIZE = 20
const LABEL_FAMILY = 'Inter, Helvetica, Arial, sans-serif'

/* sharp resolves its native binary from process.platform when it loads, so it loads on first use: importing this module must not need it */
async function loadSharp(): Promise<typeof Sharp> {
  return (await import('sharp')).default
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function labelText(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label
}

/* A label is one line: SVG text gives crisp glyphs at any scale and needs no font binary from sharp's side. */
function labelSvg(label: string, width: number, height: number): Buffer {
  const baseline = Math.round(height / 2 + LABEL_FONT_SIZE * 0.35)
  const text = escapeXml(labelText(label))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="0" y="${baseline}" font-family="${LABEL_FAMILY}" font-size="${LABEL_FONT_SIZE}" ` +
    `font-weight="500" fill="#111111">${text}</text></svg>`
  return Buffer.from(svg)
}

export async function composeImages(
  items: CompositeItem[],
  opts: CompositeOptions,
): Promise<{ buf: Buffer; width: number; height: number }> {
  if (items.length < 1 || items.length > MAX_ITEMS) {
    throw new RangeError(`composeImages takes 1 to ${MAX_ITEMS} images, got ${items.length}`)
  }
  const sharp = await loadSharp()
  const gap = opts.gap ?? 24
  const labelHeight = opts.labelHeight ?? 36
  const maxWidth = opts.maxWidth ?? 2400
  const background = opts.background ?? '#f5f5f5'
  const labelled = items.some((item) => !!item.label)
  const band = labelled ? labelHeight : 0

  const cells: Cell[] = []
  for (const item of items) {
    const meta = await sharp(item.buf).metadata()
    const width = meta.width
    const height = meta.height
    if (!width || !height) throw new Error('composeImages: could not read an image size')
    cells.push({ buf: item.buf, label: item.label ? item.label : null, width, height })
  }

  const n = cells.length
  const columns = opts.layout === 'grid' ? Math.ceil(Math.sqrt(n)) : n
  const rows = Math.ceil(n / columns)
  const colWidths = Array.from({ length: columns }, () => 0)
  const rowHeights = Array.from({ length: rows }, () => 0)
  cells.forEach((cell, i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    colWidths[col] = Math.max(colWidths[col] ?? 0, cell.width)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, cell.height)
  })

  const width = gap * (columns + 1) + colWidths.reduce((sum, w) => sum + w, 0)
  const height = gap * (rows + 1) + band * rows + rowHeights.reduce((sum, h) => sum + h, 0)

  const colLefts: number[] = []
  let left = gap
  for (let col = 0; col < columns; col++) {
    colLefts.push(left)
    left += (colWidths[col] ?? 0) + gap
  }
  const rowTops: number[] = []
  let top = gap
  for (let row = 0; row < rows; row++) {
    rowTops.push(top + band)
    top += band + (rowHeights[row] ?? 0) + gap
  }

  const overlays: Sharp.OverlayOptions[] = []
  cells.forEach((cell, i) => {
    const x = colLefts[i % columns] ?? gap
    const y = rowTops[Math.floor(i / columns)] ?? gap
    overlays.push({ input: cell.buf, left: x, top: y })
    if (cell.label)
      overlays.push({ input: labelSvg(cell.label, cell.width, labelHeight), left: x, top: y - labelHeight })
  })

  /* The overlay pass and the downscale are two pipelines: sharp resizes the base image before compositing, so a resize in the same pipeline would shrink the canvas under its own cells. */
  const composed = await sharp({ create: { width, height, channels: 4, background } })
    .composite(overlays)
    .png()
    .toBuffer()
  const scaled =
    width > maxWidth ? sharp(composed).resize({ width: maxWidth, withoutEnlargement: true }) : sharp(composed)
  const encoded = opts.format === 'webp' ? scaled.webp({ quality: 85, effort: 2 }) : scaled.png()
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { buf: data, width: info.width, height: info.height }
}
