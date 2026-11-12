/* Colour maths for design linting: CSS colour parsing, source-over compositing and WCAG 2.x contrast. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const channelHex = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, '0')

function parseHex(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex.slice(0, 1).repeat(2), 16)
    const g = parseInt(hex.slice(1, 2).repeat(2), 16)
    const b = parseInt(hex.slice(2, 3).repeat(2), 16)
    const a = hex.length === 4 ? parseInt(hex.slice(3, 4).repeat(2), 16) / 255 : 1
    return { r, g, b, a }
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  return null
}

function parseAlpha(part: string | undefined): number | null {
  if (part === undefined) return 1
  const text = part.trim()
  if (text === '') return 1
  const percent = text.endsWith('%')
  const value = Number(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return null
  return clamp(percent ? value / 100 : value, 0, 1)
}

function parseRgbArgs(args: string): Rgba | null {
  const [channelPart = '', slashAlpha, extra] = args.split('/')
  if (extra !== undefined) return null
  const parts = channelPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  let alphaPart = slashAlpha
  let channels = parts
  if (slashAlpha === undefined && parts.length === 4) {
    channels = parts.slice(0, 3)
    alphaPart = parts[3]
  }
  if (channels.length !== 3) return null
  const [r, g, b] = channels.map(Number)
  if (r === undefined || g === undefined || b === undefined) return null
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  const a = parseAlpha(alphaPart)
  if (a === null) return null
  return {
    r: Math.round(clamp(r, 0, 255)),
    g: Math.round(clamp(g, 0, 255)),
    b: Math.round(clamp(b, 0, 255)),
    a,
  }
}

/** Parses `rgb()`/`rgba()` (comma or space separated, optional `/` alpha), hex 3/4/6/8 and `transparent`. */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (text.startsWith('#')) return parseHex(text.slice(1))
  const match = /^rgba?\(([^)]*)\)$/.exec(text)
  const args = match?.[1]
  if (args === undefined) return null
  return parseRgbArgs(args)
}

/** `#rrggbb` when opaque, else `#rrggbbaa` with the alpha rounded to 0-255. */
export function toHex(c: Rgba): string {
  const base = `#${channelHex(c.r)}${channelHex(c.g)}${channelHex(c.b)}`
  return c.a === 1 ? base : `${base}${channelHex(c.a * 255)}`
}

export function normalizeColor(value: string): string | null {
  const parsed = parseCssColor(value)
  return parsed ? toHex(parsed) : null
}

/** Source-over: the top layer painted over the bottom one. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

/** WCAG 2.x relative luminance, alpha ignored. */
export function relativeLuminance(c: Rgba): number {
  const linear = (value: number) => {
    const s = clamp(value, 0, 255) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/** WCAG 2.x contrast ratio, 2 decimals; a translucent fg is composited over bg first. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const front = fg.a < 1 ? composite(fg, bg) : fg
  const one = relativeLuminance(front)
  const two = relativeLuminance(bg)
  const high = Math.max(one, two)
  const low = Math.min(one, two)
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100
}
