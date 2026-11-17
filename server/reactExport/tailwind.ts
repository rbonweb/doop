import { jsString, type ExportIssue } from './issues.ts'
import { splitComponentCss, type CssModuleSplit } from './cssSplit.ts'

/*
 * CSS to Tailwind v4 for the React export's Tailwind mode.
 *
 * Decision (no new dependency): an in-house mapper. A converter library would have to be trusted with untrusted
 * canvas CSS and would still not know our safety rules (unsafe urls, quote characters, composes); the supported
 * scope is small and table driven, so the mapper stays here, deterministic and tested against Tailwind itself.
 *
 * The CSS goes through `splitComponentCss` first, so unsafe and unparsable CSS is dropped exactly as in the CSS Modules
 * mode, and the sheet read here is its normalised, well formed output. Whatever does not convert is written back and
 * split again, so `leftover` has the same shape and guarantees as `splitComponentCss`.
 *
 * Variant choices: a root's variant attribute on an ancestor is `in-data-[x=v]:` (Tailwind's `in-*` needs no `group`
 * class on the root); the same attribute on the element itself is `data-[x=v]:`.
 */

export interface TailwindSplit {
  /** class -> utility classes that replace its rules (in order), for classes fully or partly converted */
  utilities: Map<string, string[]>
  /** what did not convert, as a CSS Modules split (same shape and safety as splitComponentCss) */
  leftover: CssModuleSplit
  issues: ExportIssue[]
}

export interface TailwindOptions {
  rootClass?: string
  rewriteUrl?: (url: string) => string
}

/* ---------- reading the normalised sheet ---------- */

interface Item {
  prelude: string
  body: string | null
}

function skipString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') i += 2
    else if (text[i] === quote) return i + 1
    else i++
  }
  return text.length
}

function parseItems(text: string): Item[] {
  const items: Item[] = []
  let start = 0
  let paren = 0
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (char === '"' || char === "'") i = skipString(text, i)
    else if (char === '\\') i += 2
    else if (char === '(' || char === '[') {
      paren++
      i++
    } else if (char === ')' || char === ']') {
      paren = Math.max(0, paren - 1)
      i++
    } else if (paren === 0 && char === ';') {
      const prelude = text.slice(start, i).trim()
      if (prelude) items.push({ prelude, body: null })
      i++
      start = i
    } else if (paren === 0 && char === '{') {
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        const c = text[j]!
        if (c === '"' || c === "'") j = skipString(text, j)
        else if (c === '\\') j += 2
        else {
          if (c === '{') depth++
          else if (c === '}') depth--
          j++
        }
      }
      items.push({ prelude: text.slice(start, i).trim(), body: text.slice(i + 1, depth === 0 ? j - 1 : j) })
      i = j
      start = i
    } else i++
  }
  const tail = text.slice(start).trim()
  if (tail) items.push({ prelude: tail, body: null })
  return items
}

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = skipString(text, i) - 1
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/* ---------- values ---------- */

const SAFE_VALUE = /^[A-Za-z0-9%#.,/()+*\- ]+$/

/** A value that may sit inside `[...]` of a utility: characters that cannot end the class, start a variant or an escape, and no underscore (it would read as a space). Spaces become underscores. */
function arbitrary(value: string): string | null {
  const text = value
    .trim()
    .replace(/\s*([,/])\s*/g, '$1')
    .replace(/\s+/g, ' ')
  if (!text || text.length > 200 || !SAFE_VALUE.test(text) || !parensBalanced(text)) return null
  if (/url\(|expression|javascript|image-set|src\(/i.test(text)) return null
  return text.replace(/ /g, '_')
}

function parensBalanced(text: string): boolean {
  let depth = 0
  for (const char of text) {
    if (char === '(') depth++
    else if (char === ')' && --depth < 0) return false
  }
  return depth === 0
}

const VAR_RE = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/

function plainVar(value: string): string | null {
  return VAR_RE.exec(value.trim())?.[1] ?? null
}

const NUMBER = '-?(?:\\d+\\.?\\d*|\\.\\d+)'
const LENGTH_RE = new RegExp(`^(${NUMBER})(px|rem)?$`)

/** A length as rem (16px to the rem), or null for anything but a plain px, rem or zero. */
function toRem(value: string): number | null {
  const match = LENGTH_RE.exec(value.trim())
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n)) return null
  if (match[2] === 'px') return n / 16
  if (match[2] === 'rem') return n
  return n === 0 ? 0 : null
}

const SPACING_SCALE = new Set([
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64,
  72, 80, 96,
])

/** `4` for 1rem or 16px when that is on Tailwind's spacing scale, `px` for 1px. */
function spacingKey(value: string): string | null {
  if (/^1px$/i.test(value.trim())) return 'px'
  const rem = toRem(value)
  if (rem === null) return null
  const steps = Math.round(Math.abs(rem) * 4 * 1000) / 1000
  return SPACING_SCALE.has(steps) ? String(steps) : null
}

const FRACTIONS = new Map<string, string>()
for (const [den, max] of [
  [2, 1],
  [3, 2],
  [4, 3],
  [5, 4],
  [6, 5],
  [12, 11],
] as const) {
  for (let num = 1; num <= max; num++) {
    const percent = Math.round((num / den) * 1e6) / 1e4
    if (!FRACTIONS.has(`${percent}%`)) FRACTIONS.set(`${percent}%`, `${num}/${den}`)
  }
}

interface LengthOptions {
  /** `auto` and other keywords: CSS value to utility suffix */
  keywords?: Record<string, string>
  fractions?: boolean
  /** a negative value becomes `-prefix-key` (named) or an arbitrary negative */
  negative?: boolean
}

/** The utility for a length-like value: `p-4`, `p-[13px]`, `w-1/2`, `mt-auto`, `m-(--gap)`; null when it cannot be written safely. */
function lengthUtility(prefix: string, raw: string, options: LengthOptions = {}): string | null {
  const value = raw.trim()
  const keyword = options.keywords?.[value.toLowerCase()]
  if (keyword !== undefined) return `${prefix}-${keyword}`
  const name = plainVar(value)
  if (name) return `${prefix}-(${name})`
  if (options.fractions) {
    const fraction = FRACTIONS.get(value)
    if (fraction) return `${prefix}-${fraction}`
  }
  const key = spacingKey(value)
  if (key !== null) {
    if (/^-/.test(value) && key !== '0') return options.negative ? `-${prefix}-${key}` : `${prefix}-[${value}]`
    return `${prefix}-${key}`
  }
  const text = arbitrary(value)
  return text ? `${prefix}-[${text}]` : null
}

const SIZE_KEYWORDS: Record<string, string> = {
  auto: 'auto',
  '100%': 'full',
  'min-content': 'min',
  'max-content': 'max',
  'fit-content': 'fit',
}

function sizeUtility(prefix: string, value: string, extra: Record<string, string> = {}): string | null {
  const viewport = prefix === 'w' || prefix === 'min-w' || prefix === 'max-w' ? 'vw' : 'vh'
  const keywords = {
    ...SIZE_KEYWORDS,
    [`100${viewport}`]: 'screen',
    ...(viewport === 'vh' ? { '100dvh': 'dvh', '100svh': 'svh', '100lvh': 'lvh' } : { '100dvw': 'dvw' }),
    ...extra,
  }
  return lengthUtility(prefix, value, { keywords, fractions: true })
}

const CONTAINERS = new Map<number, string>([
  [20, 'xs'],
  [24, 'sm'],
  [28, 'md'],
  [32, 'lg'],
  [36, 'xl'],
  [42, '2xl'],
  [48, '3xl'],
  [56, '4xl'],
  [64, '5xl'],
  [72, '6xl'],
  [80, '7xl'],
])

function maxWidthUtility(value: string): string | null {
  const keyword = value.trim().toLowerCase()
  if (keyword === 'none') return 'max-w-none'
  if (keyword === 'auto') return null
  const rem = toRem(value)
  const name = rem === null ? undefined : CONTAINERS.get(rem)
  if (name) return `max-w-${name}`
  return sizeUtility('max-w', value)
}

/* ---------- colours ---------- */

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen ' +
    'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue ' +
    'darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick ' +
    'floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink ' +
    'indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue ' +
    'lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange ' +
    'orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna ' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet ' +
    'wheat whitesmoke yellow yellowgreen'
  ).split(' '),
)
const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix|color)\(/i
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** The utility for a colour with `prefix` (`bg`, `text`, `border`, ...). */
function colorUtility(prefix: string, raw: string): string | null {
  const value = raw.trim()
  const lower = value.toLowerCase()
  if (lower === 'transparent') return `${prefix}-transparent`
  if (lower === 'currentcolor') return `${prefix}-current`
  if (lower === 'inherit') return `${prefix}-inherit`
  if (lower === 'white' || lower === '#fff' || lower === '#ffffff') return `${prefix}-white`
  if (lower === 'black' || lower === '#000' || lower === '#000000') return `${prefix}-black`
  const name = plainVar(value)
  if (name) return `${prefix}-(${name})`
  const text = arbitrary(value)
  if (!text) return null
  if (HEX.test(value)) return `${prefix}-[${text}]`
  if (COLOR_FUNCTION.test(value)) return `${prefix}-[${text}]`
  if (NAMED_COLORS.has(lower)) return `${prefix}-[color:${lower}]`
  if (/^var\(/i.test(value)) return `${prefix}-[color:${text}]`
  return null
}

function isColor(value: string): boolean {
  const lower = value.trim().toLowerCase()
  return (
    HEX.test(value.trim()) ||
    COLOR_FUNCTION.test(value.trim()) ||
    NAMED_COLORS.has(lower) ||
    ['transparent', 'currentcolor', 'white', 'black'].includes(lower) ||
    VAR_RE.test(value.trim())
  )
}

/* ---------- declaration table ---------- */

type Mapper = (value: string, rule: Map<string, string>) => string[] | null

function keyword(prefix: string, table: Record<string, string>): Mapper {
  return (value) => {
    const suffix = table[value.trim().toLowerCase()]
    return suffix === undefined ? null : [suffix === '' ? prefix : `${prefix}-${suffix}`]
  }
}

function standalone(table: Record<string, string>): Mapper {
  return (value) => {
    const name = table[value.trim().toLowerCase()]
    return name === undefined ? null : [name]
  }
}

function one(build: (value: string) => string | null): Mapper {
  return (value) => {
    const utility = build(value)
    return utility ? [utility] : null
  }
}

/** One to four values around a box (`margin`, `padding`, `border-radius` shapes). */
function boxValues(value: string): [string, string, string, string] | null {
  const parts = splitTop(value, ' ')
  if (parts.length < 1 || parts.length > 4) return null
  const a = parts[0]!
  const b = parts[1] ?? a
  const c = parts[2] ?? a
  return [a, b, c, parts[3] ?? b]
}

interface BoxNames {
  all: string
  y: string
  x: string
  top: string
  right: string
  bottom: string
  left: string
}

const MARGIN_NAMES: BoxNames = { all: 'm', y: 'my', x: 'mx', top: 'mt', right: 'mr', bottom: 'mb', left: 'ml' }
const PADDING_NAMES: BoxNames = { all: 'p', y: 'py', x: 'px', top: 'pt', right: 'pr', bottom: 'pb', left: 'pl' }
const INSET_NAMES: BoxNames = {
  all: 'inset',
  y: 'inset-y',
  x: 'inset-x',
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
}

function boxMapper(names: BoxNames, options: LengthOptions): Mapper {
  return (value) => {
    const sides = boxValues(value)
    if (!sides) return null
    const [top, right, bottom, left] = sides
    const make = (name: string, v: string) => lengthUtility(name, v, options)
    const out =
      top === right && right === bottom && bottom === left
        ? [make(names.all, top)]
        : top === bottom && right === left
          ? [make(names.y, top), make(names.x, right)]
          : [make(names.top, top), make(names.right, right), make(names.bottom, bottom), make(names.left, left)]
    return out.every((entry) => entry !== null) ? (out as string[]) : null
  }
}

function sideMapper(prefix: string, options: LengthOptions): Mapper {
  return one((value) => lengthUtility(prefix, value, options))
}

const SPACE: LengthOptions = { negative: false }
const MARGIN: LengthOptions = { keywords: { auto: 'auto' }, negative: true }
const INSET: LengthOptions = { keywords: { auto: 'auto', '100%': 'full' }, fractions: true, negative: true }

const FLEX_NUMBERS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])

const LINE_HEIGHTS: Record<string, string> = {
  '1': 'none',
  '1.25': 'tight',
  '1.375': 'snug',
  '1.5': 'normal',
  '1.625': 'relaxed',
  '2': 'loose',
}
const FONT_SIZES: Record<string, string> = {
  '0.75': 'xs',
  '0.875': 'sm',
  '1': 'base',
  '1.125': 'lg',
  '1.25': 'xl',
  '1.5': '2xl',
  '1.875': '3xl',
  '2.25': '4xl',
  '3': '5xl',
  '3.75': '6xl',
  '4.5': '7xl',
  '6': '8xl',
  '8': '9xl',
}
const FONT_WEIGHTS: Record<string, string> = {
  '100': 'thin',
  '200': 'extralight',
  '300': 'light',
  '400': 'normal',
  '500': 'medium',
  '600': 'semibold',
  '700': 'bold',
  '800': 'extrabold',
  '900': 'black',
  normal: 'normal',
  bold: 'bold',
}
const TRACKING: Record<string, string> = {
  '-0.05em': 'tighter',
  '-0.025em': 'tight',
  '0': 'normal',
  '0em': 'normal',
  '0.025em': 'wide',
  '0.05em': 'wider',
  '0.1em': 'widest',
}
const RADII = new Map<number, string>([
  [0.125, 'xs'],
  [0.25, 'sm'],
  [0.375, 'md'],
  [0.5, 'lg'],
  [0.75, 'xl'],
  [1, '2xl'],
  [1.5, '3xl'],
  [2, '4xl'],
])

function radiusUtility(prefix: string, value: string): string | null {
  const v = value.trim()
  const lower = v.toLowerCase()
  if (lower === '0' || lower === '0px') return `${prefix}-none`
  const rem = toRem(v)
  if (rem !== null && rem > 0 && RADII.has(rem)) return `${prefix}-${RADII.get(rem)}`
  if (rem !== null && rem >= 624) return `${prefix}-full`
  const name = plainVar(v)
  if (name) return `${prefix}-(${name})`
  const text = arbitrary(v)
  return text ? `${prefix}-[${text}]` : null
}

function radiusMapper(prefix: string): Mapper {
  return one((value) => radiusUtility(prefix, value))
}

function opacityUtility(value: string): string | null {
  const v = value.trim()
  let n: number
  if (/^\d+(?:\.\d+)?%$/.test(v)) n = Number.parseFloat(v)
  else if (/^(?:\d+\.?\d*|\.\d+)$/.test(v)) n = Number(v) * 100
  else {
    const name = plainVar(v)
    return name ? `opacity-(${name})` : null
  }
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n * 1000) / 1000
  if (Number.isInteger(rounded) && rounded % 5 === 0 && rounded >= 0 && rounded <= 100) return `opacity-${rounded}`
  const text = arbitrary(v)
  return text ? `opacity-[${text}]` : null
}

function borderWidthUtility(prefix: string, value: string): string | null {
  const rem = toRem(value)
  if (rem === 0) return `${prefix}-0`
  if (rem !== null) {
    const px = Math.round(rem * 16 * 1000) / 1000
    if (px === 1) return prefix
    if ([2, 4, 8].includes(px)) return `${prefix}-${px}`
  }
  const name = plainVar(value)
  if (name) return `${prefix}-(length:${name})`
  const text = arbitrary(value)
  return text ? `${prefix}-[${text}]` : null
}

const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'none'])

/** `border: 1px solid #ccc` and the one-sided forms: width, style and colour in any order. */
function borderShorthand(side: string): Mapper {
  return (value) => {
    const parts = splitTop(value, ' ')
    if (parts.length === 0 || parts.length > 3) return null
    const out: string[] = []
    let width: string | null = null
    let style: string | null = null
    let color: string | null = null
    for (const part of parts) {
      const lower = part.toLowerCase()
      if (BORDER_STYLES.has(lower) && style === null) style = lower
      else if (width === null && (toRem(part) !== null || /^(?:thin|medium|thick)$/i.test(part))) width = part
      else if (color === null && isColor(part)) color = part
      else return null
    }
    if (width !== null && /^(?:thin|medium|thick)$/i.test(width)) return null
    if (style === 'none') return [side === 'border' ? 'border-0' : `${side}-0`]
    const widthClass = borderWidthUtility(side, width ?? '1px')
    if (!widthClass) return null
    out.push(widthClass)
    if (style) out.push(`border-${style}`)
    if (color !== null) {
      const colorClass = colorUtility(side === 'border' ? 'border' : side, color)
      if (!colorClass) return null
      out.push(colorClass)
    }
    return out
  }
}

function bgImageUtility(value: string): string | null {
  const v = value.trim()
  if (v.toLowerCase() === 'none') return 'bg-none'
  if (!/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(v)) return null
  const text = arbitrary(v)
  return text ? `bg-[${text}]` : null
}

const TRANSITION_PROPS: Record<string, string> = { all: 'transition-all', none: 'transition-none' }
const EASINGS: Record<string, string> = {
  linear: 'ease-linear',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
}

function timeUtility(prefix: string, value: string): string | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/i.exec(value.trim())
  if (!match) return null
  const ms = Math.round(Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1) * 1000) / 1000
  return Number.isInteger(ms) ? `${prefix}-${ms}` : `${prefix}-[${match[0]}]`
}

function easingUtility(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (EASINGS[v]) return EASINGS[v]!
  const text = arbitrary(v)
  return text && /^(?:cubic-bezier|steps|ease)\b/.test(v) ? `ease-[${text}]` : null
}

/** `transition: opacity 150ms ease-out`: one part becomes utilities, several stay as one arbitrary property. */
const transitionShorthand: Mapper = (value) => {
  const text = arbitrary(value)
  if (!text) return null
  const parts = splitTop(value, ',')
  if (parts.length === 1) {
    const tokens = splitTop(parts[0]!, ' ')
    const times: string[] = []
    let property: string | null = null
    let easing: string | null = null
    for (const token of tokens) {
      if (/^[\d.]+m?s$/i.test(token)) times.push(token)
      else if (easing === null && easingUtility(token) !== null) easing = token
      else if (property === null && /^[a-z][a-z-]*$/i.test(token)) property = token.toLowerCase()
      else return null
    }
    if (times.length > 2) return null
    const out: string[] = []
    if (property === null) property = 'all'
    out.push(TRANSITION_PROPS[property] ?? `transition-[${property}]`)
    const duration = times[0] === undefined ? 'duration-0' : timeUtility('duration', times[0])
    if (!duration) return null
    out.push(duration)
    if (easing !== null) out.push(easingUtility(easing)!)
    if (times[1] !== undefined) {
      const delay = timeUtility('delay', times[1])
      if (!delay) return null
      out.push(delay)
    }
    return out
  }
  return [`[transition:${text}]`]
}

function transitionProperty(value: string): string[] | null {
  const v = value.trim().toLowerCase()
  if (TRANSITION_PROPS[v]) return [TRANSITION_PROPS[v]!]
  if (!/^[a-z][a-z,-]*(?:,\s*[a-z][a-z-]*)*$/.test(v)) return null
  const text = arbitrary(v)
  return text ? [`transition-[${text}]`] : null
}

const GRID_COLS = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/i

function gridTemplate(prefix: string): Mapper {
  return (value) => {
    const v = value.trim()
    if (v.toLowerCase() === 'none') return [`${prefix}-none`]
    const named = GRID_COLS.exec(v)
    if (named && FLEX_NUMBERS.has(named[1]!)) return [`${prefix}-${named[1]}`]
    const text = arbitrary(v)
    return text ? [`${prefix}-[${text}]`] : null
  }
}

const OVERFLOW = ['auto', 'hidden', 'visible', 'scroll', 'clip']
const overflow = (axis: string): Mapper =>
  keyword(axis, Object.fromEntries(OVERFLOW.map((name) => [name, name]))) as Mapper

const CURSORS = [
  'auto',
  'default',
  'pointer',
  'wait',
  'text',
  'move',
  'help',
  'not-allowed',
  'grab',
  'grabbing',
  'crosshair',
]

const ALIGN = (prefix: string, extra: Record<string, string> = {}): Mapper =>
  standalone(
    Object.fromEntries(
      Object.entries({
        'flex-start': 'start',
        start: 'start',
        'flex-end': 'end',
        end: 'end',
        center: 'center',
        stretch: 'stretch',
        baseline: 'baseline',
        ...extra,
      }).map(([css, name]) => [css, `${prefix}-${name}`]),
    ),
  )

function aspectRatio(value: string): string[] | null {
  const v = value.trim().replace(/\s*\/\s*/g, '/')
  if (v === '1/1') return ['aspect-square']
  if (v === '16/9') return ['aspect-video']
  if (v.toLowerCase() === 'auto') return ['aspect-auto']
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(v)) return null
  return [`aspect-[${v}]`]
}

function fontFamily(value: string): string[] | null {
  const name = plainVar(value)
  if (name) return [`font-(family-name:${name})`]
  const text = arbitrary(value)
  return text && /^[A-Za-z][A-Za-z0-9 ,-]*$/.test(value.trim()) ? [`font-[family-name:${text}]`] : null
}

const TABLE: Record<string, Mapper> = {
  display: standalone({
    block: 'block',
    'inline-block': 'inline-block',
    inline: 'inline',
    flex: 'flex',
    'inline-flex': 'inline-flex',
    grid: 'grid',
    'inline-grid': 'inline-grid',
    none: 'hidden',
    contents: 'contents',
    'flow-root': 'flow-root',
    table: 'table',
  }),
  position: standalone({
    static: 'static',
    relative: 'relative',
    absolute: 'absolute',
    fixed: 'fixed',
    sticky: 'sticky',
  }),
  'z-index': one((value) => {
    const v = value.trim().toLowerCase()
    if (['0', '10', '20', '30', '40', '50'].includes(v)) return `z-${v}`
    if (v === 'auto') return 'z-auto'
    return /^-?\d{1,5}$/.test(v) ? `z-[${v}]` : null
  }),
  overflow: overflow('overflow'),
  'overflow-x': overflow('overflow-x'),
  'overflow-y': overflow('overflow-y'),
  visibility: standalone({ visible: 'visible', hidden: 'invisible', collapse: 'collapse' }),
  opacity: one(opacityUtility),
  /* spacing */
  margin: boxMapper(MARGIN_NAMES, MARGIN),
  'margin-top': sideMapper('mt', MARGIN),
  'margin-right': sideMapper('mr', MARGIN),
  'margin-bottom': sideMapper('mb', MARGIN),
  'margin-left': sideMapper('ml', MARGIN),
  padding: boxMapper(PADDING_NAMES, SPACE),
  'padding-top': sideMapper('pt', SPACE),
  'padding-right': sideMapper('pr', SPACE),
  'padding-bottom': sideMapper('pb', SPACE),
  'padding-left': sideMapper('pl', SPACE),
  gap: (value) => {
    const parts = splitTop(value, ' ')
    if (parts.length === 1) return one((v) => lengthUtility('gap', v))(value, new Map())
    if (parts.length !== 2) return null
    const out = [lengthUtility('gap-y', parts[0]!), lengthUtility('gap-x', parts[1]!)]
    return out.every((entry) => entry !== null) ? (out as string[]) : null
  },
  'row-gap': sideMapper('gap-y', SPACE),
  'column-gap': sideMapper('gap-x', SPACE),
  /* sizing */
  width: one((v) => sizeUtility('w', v)),
  height: one((v) => sizeUtility('h', v)),
  'min-width': one((v) => sizeUtility('min-w', v)),
  'min-height': one((v) => sizeUtility('min-h', v)),
  'max-width': one(maxWidthUtility),
  'max-height': one((v) => {
    const keyword = v.trim().toLowerCase()
    return keyword === 'none' ? 'max-h-none' : keyword === 'auto' ? null : sizeUtility('max-h', v)
  }),
  'aspect-ratio': aspectRatio,
  'box-sizing': standalone({ 'border-box': 'box-border', 'content-box': 'box-content' }),
  /* position and inset */
  inset: boxMapper(INSET_NAMES, INSET),
  top: sideMapper('top', INSET),
  right: sideMapper('right', INSET),
  bottom: sideMapper('bottom', INSET),
  left: sideMapper('left', INSET),
  /* flex and grid */
  'flex-direction': standalone({
    row: 'flex-row',
    column: 'flex-col',
    'row-reverse': 'flex-row-reverse',
    'column-reverse': 'flex-col-reverse',
  }),
  'flex-wrap': standalone({ wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' }),
  'justify-content': standalone({
    'flex-start': 'justify-start',
    start: 'justify-start',
    'flex-end': 'justify-end',
    end: 'justify-end',
    center: 'justify-center',
    'space-between': 'justify-between',
    'space-around': 'justify-around',
    'space-evenly': 'justify-evenly',
    stretch: 'justify-stretch',
    normal: 'justify-normal',
  }),
  'align-items': ALIGN('items'),
  'align-self': ALIGN('self', { auto: 'auto' }),
  'align-content': standalone({
    center: 'content-center',
    'flex-start': 'content-start',
    start: 'content-start',
    'flex-end': 'content-end',
    end: 'content-end',
    'space-between': 'content-between',
    'space-around': 'content-around',
    'space-evenly': 'content-evenly',
    stretch: 'content-stretch',
    normal: 'content-normal',
  }),
  flex: (value) => {
    const v = value.trim().toLowerCase().replace(/\s+/g, ' ')
    if (v === '1' || v === '1 1 0%' || v === '1 1 0') return ['flex-1']
    if (v === 'auto' || v === '1 1 auto') return ['flex-auto']
    if (v === 'none' || v === '0 0 auto') return ['flex-none']
    if (v === 'initial' || v === '0 1 auto') return ['flex-initial']
    const text = arbitrary(v)
    return text && /^[\d. %a-z]+$/.test(v) ? [`flex-[${text}]`] : null
  },
  'flex-grow': standalone({ '1': 'grow', '0': 'grow-0' }),
  'flex-shrink': standalone({ '1': 'shrink', '0': 'shrink-0' }),
  'flex-basis': one((v) => lengthUtility('basis', v, { keywords: { auto: 'auto', '100%': 'full' }, fractions: true })),
  order: one((v) => {
    const t = v.trim()
    if (FLEX_NUMBERS.has(t)) return `order-${t}`
    return /^-?\d{1,4}$/.test(t) ? `order-[${t}]` : null
  }),
  'grid-template-columns': gridTemplate('grid-cols'),
  'grid-template-rows': gridTemplate('grid-rows'),
  'grid-auto-flow': standalone({
    row: 'grid-flow-row',
    column: 'grid-flow-col',
    dense: 'grid-flow-dense',
    'row dense': 'grid-flow-row-dense',
    'column dense': 'grid-flow-col-dense',
  }),
  /* colour and background */
  color: one((v) => colorUtility('text', v)),
  'background-color': one((v) => colorUtility('bg', v)),
  background: (value) => (isColor(value) ? one((v) => colorUtility('bg', v))(value, new Map()) : null),
  'background-image': one(bgImageUtility),
  'background-size': standalone({ cover: 'bg-cover', contain: 'bg-contain', auto: 'bg-auto' }),
  'background-position': standalone({
    center: 'bg-center',
    top: 'bg-top',
    bottom: 'bg-bottom',
    left: 'bg-left',
    right: 'bg-right',
  }),
  'background-repeat': standalone({
    'no-repeat': 'bg-no-repeat',
    repeat: 'bg-repeat',
    'repeat-x': 'bg-repeat-x',
    'repeat-y': 'bg-repeat-y',
  }),
  'object-fit': standalone({
    cover: 'object-cover',
    contain: 'object-contain',
    fill: 'object-fill',
    none: 'object-none',
    'scale-down': 'object-scale-down',
  }),
  /* border and radius */
  border: borderShorthand('border'),
  'border-top': borderShorthand('border-t'),
  'border-right': borderShorthand('border-r'),
  'border-bottom': borderShorthand('border-b'),
  'border-left': borderShorthand('border-l'),
  'border-width': (value) => {
    const sides = boxValues(value)
    if (!sides) return null
    const [t, r, b, l] = sides
    const out =
      t === r && r === b && b === l
        ? [borderWidthUtility('border', t)]
        : [
            borderWidthUtility('border-t', t),
            borderWidthUtility('border-r', r),
            borderWidthUtility('border-b', b),
            borderWidthUtility('border-l', l),
          ]
    return out.every((entry) => entry !== null) ? (out as string[]) : null
  },
  'border-top-width': one((v) => borderWidthUtility('border-t', v)),
  'border-right-width': one((v) => borderWidthUtility('border-r', v)),
  'border-bottom-width': one((v) => borderWidthUtility('border-b', v)),
  'border-left-width': one((v) => borderWidthUtility('border-l', v)),
  'border-style': standalone({
    solid: 'border-solid',
    dashed: 'border-dashed',
    dotted: 'border-dotted',
    double: 'border-double',
    none: 'border-none',
  }),
  'border-color': one((v) => colorUtility('border', v)),
  'border-top-color': one((v) => colorUtility('border-t', v)),
  'border-right-color': one((v) => colorUtility('border-r', v)),
  'border-bottom-color': one((v) => colorUtility('border-b', v)),
  'border-left-color': one((v) => colorUtility('border-l', v)),
  'border-radius': (value) => {
    const parts = splitTop(value, ' ')
    if (parts.length === 1) return radiusMapper('rounded')(value, new Map())
    const text = parts.length <= 4 ? arbitrary(value) : null
    return text ? [`rounded-[${text}]`] : null
  },
  'border-top-left-radius': radiusMapper('rounded-tl'),
  'border-top-right-radius': radiusMapper('rounded-tr'),
  'border-bottom-right-radius': radiusMapper('rounded-br'),
  'border-bottom-left-radius': radiusMapper('rounded-bl'),
  'outline-color': one((v) => colorUtility('outline', v)),
  /* typography */
  'font-family': fontFamily,
  'font-weight': one((v) => {
    const t = v.trim().toLowerCase()
    if (FONT_WEIGHTS[t]) return `font-${FONT_WEIGHTS[t]}`
    if (plainVar(t)) return `font-(weight:${plainVar(t)})`
    return /^\d{1,4}$/.test(t) ? `font-[${t}]` : null
  }),
  'line-height': one((v) => {
    const t = v.trim().toLowerCase()
    if (LINE_HEIGHTS[t]) return `leading-${LINE_HEIGHTS[t]}`
    const key = spacingKey(t)
    if (key !== null && !t.startsWith('-')) return `leading-${key}`
    const name = plainVar(t)
    if (name) return `leading-(${name})`
    const text = arbitrary(t)
    return text ? `leading-[${text}]` : null
  }),
  'letter-spacing': one((v) => {
    const t = v.trim().toLowerCase()
    if (TRACKING[t]) return `tracking-${TRACKING[t]}`
    const name = plainVar(t)
    if (name) return `tracking-(${name})`
    const text = arbitrary(t)
    return text ? `tracking-[${text}]` : null
  }),
  'text-align': standalone({
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
    justify: 'text-justify',
    start: 'text-start',
    end: 'text-end',
  }),
  'text-transform': standalone({
    uppercase: 'uppercase',
    lowercase: 'lowercase',
    capitalize: 'capitalize',
    none: 'normal-case',
  }),
  'text-decoration-line': standalone({
    underline: 'underline',
    'line-through': 'line-through',
    overline: 'overline',
    none: 'no-underline',
  }),
  'text-decoration': standalone({
    underline: 'underline',
    'line-through': 'line-through',
    overline: 'overline',
    none: 'no-underline',
  }),
  'text-overflow': standalone({ ellipsis: 'text-ellipsis', clip: 'text-clip' }),
  'font-style': standalone({ italic: 'italic', normal: 'not-italic' }),
  'white-space': standalone({
    normal: 'whitespace-normal',
    nowrap: 'whitespace-nowrap',
    pre: 'whitespace-pre',
    'pre-line': 'whitespace-pre-line',
    'pre-wrap': 'whitespace-pre-wrap',
    'break-spaces': 'whitespace-break-spaces',
  }),
  cursor: standalone(Object.fromEntries(CURSORS.map((name) => [name, `cursor-${name}`]))),
  'pointer-events': standalone({ none: 'pointer-events-none', auto: 'pointer-events-auto' }),
  'user-select': standalone({ none: 'select-none', text: 'select-text', all: 'select-all', auto: 'select-auto' }),
  content: (value) =>
    /^(?:""|'')$/.test(value.trim())
      ? ["content-['']"]
      : value.trim().toLowerCase() === 'none'
        ? ['content-none']
        : null,
  /* shadow and transition */
  'box-shadow': (value) => {
    const v = value.trim()
    if (v.toLowerCase() === 'none') return ['shadow-none']
    const name = plainVar(v)
    if (name) return [`shadow-(${name})`]
    const text = arbitrary(v)
    return text ? [`shadow-[${text}]`] : null
  },
  transition: transitionShorthand,
  'transition-property': transitionProperty,
  'transition-duration': one((v) => timeUtility('duration', v)),
  'transition-delay': one((v) => timeUtility('delay', v)),
  'transition-timing-function': one(easingUtility),
}

/** The CSS properties the mapper can convert (the test guard compiles what each emits). */
export const CONVERTED_PROPERTIES: readonly string[] = [...Object.keys(TABLE), 'font-size']

/** font-size is converted with its rule: Tailwind's named sizes also set a line height, so they only stand in when the rule sets one too. */
function fontSize(value: string, rule: Map<string, string>): string[] | null {
  const v = value.trim()
  const name = plainVar(v)
  if (name) return [`text-(length:${name})`]
  const rem = toRem(v)
  const named = rem === null ? undefined : FONT_SIZES[String(Math.round(rem * 1000) / 1000)]
  if (named && rule.has('line-height')) return [`text-${named}`]
  const text = arbitrary(v)
  if (!text) return null
  return [
    /^[\d.]+(?:px|rem|em|%|vw|vh)$/.test(v) || /^(?:calc|clamp|min|max)\(/.test(v)
      ? `text-[length:${text}]`
      : `text-[${text}]`,
  ]
}
TABLE['font-size'] = fontSize

/* ---------- selectors ---------- */

const PSEUDO_CLASSES: Record<string, string> = {
  hover: 'hover',
  focus: 'focus',
  'focus-visible': 'focus-visible',
  'focus-within': 'focus-within',
  active: 'active',
  disabled: 'disabled',
  checked: 'checked',
}
const PSEUDO_ELEMENTS: Record<string, string> = { before: 'before', after: 'after' }
const BREAKPOINTS = new Map<number, string>([
  [40, 'sm'],
  [48, 'md'],
  [64, 'lg'],
  [80, 'xl'],
  [96, '2xl'],
])

interface Target {
  className: string
  /** variants in the order they are written, pseudo-elements last */
  variants: string[]
}

const IDENT = /^[A-Za-z_][\w-]*/
const ATTRIBUTE =
  /^\[\s*(data-[a-z][a-z0-9-]*)\s*(?:=\s*(?:"([A-Za-z0-9.-]+)"|'([A-Za-z0-9.-]+)'|([A-Za-z0-9.-]+))\s*)?\]/

function attributeVariant(match: RegExpExecArray, ancestor: boolean): string {
  const name = match[1]!.slice('data-'.length)
  const value = match[2] ?? match[3] ?? match[4]
  return `${ancestor ? 'in-data' : 'data'}-[${name}${value === undefined ? '' : `=${value}`}]`
}

/** The class and variants a simple selector stands for, or null when it has to stay CSS. */
function readSelector(selector: string, rootClass: string): Target | null {
  const compounds = splitTop(selector, ' ')
  if (compounds.length < 1 || compounds.length > 2) return null
  const variants: string[] = []
  if (compounds.length === 2) {
    let rest = compounds[0]!
    /* the root's variant attribute is written `.root[data-x=v]` or, as the component grammar has it, bare `[data-x=v]` */
    if (rest.startsWith('.')) {
      const root = IDENT.exec(rest.slice(1))?.[0]
      if (root !== rootClass) return null
      rest = rest.slice(1 + root.length)
    } else if (!rest.startsWith('[')) return null
    while (rest) {
      const attr = ATTRIBUTE.exec(rest)
      if (!attr) return null
      variants.push(attributeVariant(attr, true))
      rest = rest.slice(attr[0].length)
    }
  }
  let rest = compounds[compounds.length - 1]!
  if (!rest.startsWith('.')) return null
  const className = IDENT.exec(rest.slice(1))?.[0]
  if (!className) return null
  rest = rest.slice(1 + className.length)
  const own: string[] = []
  let element: string | null = null
  while (rest) {
    const attr = ATTRIBUTE.exec(rest)
    if (attr) {
      own.push(attributeVariant(attr, false))
      rest = rest.slice(attr[0].length)
      continue
    }
    const pseudo = /^(::?)([a-z-]+)/.exec(rest)
    if (!pseudo) return null
    const name = pseudo[2]!
    if (PSEUDO_ELEMENTS[name] !== undefined) {
      if (element !== null) return null
      element = PSEUDO_ELEMENTS[name]!
    } else if (pseudo[1] === ':' && PSEUDO_CLASSES[name] !== undefined) own.push(PSEUDO_CLASSES[name]!)
    else return null
    rest = rest.slice(pseudo[0].length)
  }
  return { className, variants: [...variants, ...own, ...(element ? [element] : [])] }
}

function mediaVariant(prelude: string): string | null {
  const match = /^@media\s*\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)(px|rem)\s*\)$/i.exec(
    prelude.replace(/\s+/g, ' ').trim(),
  )
  if (!match) return null
  const rem = Number(match[1]) / (match[2]!.toLowerCase() === 'px' ? 16 : 1)
  return BREAKPOINTS.get(rem) ?? null
}

/* ---------- conversion ---------- */

interface Declaration {
  property: string
  value: string
  important: boolean
  text: string
}

function readDeclarations(body: string): { declarations: Declaration[]; nested: string[] } {
  const declarations: Declaration[] = []
  const nested: string[] = []
  for (const item of parseItems(body)) {
    if (item.body !== null) {
      nested.push(`${item.prelude} {${item.body}}`)
      continue
    }
    const colon = item.prelude.indexOf(':')
    if (colon === -1) continue
    const property = item.prelude.slice(0, colon).trim().toLowerCase()
    let value = item.prelude.slice(colon + 1).trim()
    const important = /\s*!\s*important$/i.test(value)
    if (important) value = value.replace(/\s*!\s*important$/i, '').trim()
    declarations.push({ property, value, important, text: `${item.prelude};` })
  }
  return { declarations, nested }
}

interface ConvertedDeclaration {
  property: string
  utilities: string[]
  important: boolean
}

interface ConvertedRule {
  /** utilities with the variants already in front, per declaration */
  converted: ConvertedDeclaration[]
  /** declaration text that did not convert */
  residual: string[]
}

function convertDeclarations(declarations: Declaration[], variants: string[]): ConvertedRule {
  const counts = new Map<string, number>()
  for (const declaration of declarations) counts.set(declaration.property, (counts.get(declaration.property) ?? 0) + 1)
  const rule = new Map(declarations.map((declaration) => [declaration.property, declaration.value]))
  const prefix = variants.map((variant) => `${variant}:`).join('')
  const converted: ConvertedDeclaration[] = []
  const residual: string[] = []
  for (const declaration of declarations) {
    const mapper = counts.get(declaration.property) === 1 ? TABLE[declaration.property] : undefined
    const mapped = mapper ? mapper(declaration.value, rule) : null
    if (
      !mapped ||
      mapped.length === 0 ||
      mapped.some((utility) => utility !== "content-['']" && /[\s"'`\\<>]/.test(utility))
    ) {
      residual.push(declaration.text)
      continue
    }
    converted.push({
      property: `${prefix}|${declaration.property}`,
      utilities: mapped.map((utility) => `${prefix}${utility}${declaration.important ? '!' : ''}`),
      important: declaration.important,
    })
  }
  return { converted, residual }
}

/** Per class, then per variant and property: a later rule replaces an earlier one (the cascade's last-wins), unless the earlier one is `!important` and the later is not. */
interface Collector {
  utilities: Map<string, Map<string, ConvertedDeclaration>>
}

function addUtilities(collector: Collector, className: string, converted: ConvertedDeclaration[]): void {
  if (converted.length === 0) return
  const entries = collector.utilities.get(className) ?? new Map<string, ConvertedDeclaration>()
  for (const declaration of converted) {
    const earlier = entries.get(declaration.property)
    if (earlier?.important && !declaration.important) continue
    entries.delete(declaration.property)
    entries.set(declaration.property, declaration)
  }
  collector.utilities.set(className, entries)
}

/** One style rule: the converted selectors give their utilities away, the rest of the rule is returned as CSS. */
function convertRule(
  item: Item & { body: string },
  extraVariants: string[],
  rootClass: string,
  collector: Collector,
): string {
  const { declarations, nested } = readDeclarations(item.body)
  const selectors = splitTop(item.prelude, ',')
  const kept: string[] = []
  const convertible: { selector: string; target: Target }[] = []
  for (const selector of selectors) {
    const target = readSelector(selector, rootClass)
    if (target) convertible.push({ selector, target })
    else kept.push(selector)
  }
  const pieces: string[] = []
  const fullBody = [...declarations.map((declaration) => declaration.text), ...nested].join('\n  ')
  if (kept.length > 0 && fullBody) pieces.push(`${kept.join(',\n')} {\n  ${fullBody}\n}`)
  let residualShared: string[] | null = null
  const convertibleSelectors: string[] = []
  for (const { selector, target } of convertible) {
    const result = convertDeclarations(declarations, [...extraVariants, ...target.variants])
    addUtilities(collector, target.className, result.converted)
    residualShared = result.residual
    if (result.residual.length > 0 || nested.length > 0) convertibleSelectors.push(selector)
  }
  if (convertibleSelectors.length > 0 && residualShared) {
    const body = [...residualShared, ...nested].join('\n  ')
    if (body) pieces.push(`${convertibleSelectors.join(',\n')} {\n  ${body}\n}`)
  }
  return pieces.join('\n\n')
}

function convertSheet(css: string, rootClass: string, collector: Collector): string {
  const out: string[] = []
  for (const item of parseItems(css)) {
    if (item.body === null) {
      out.push(`${item.prelude};`)
    } else if (item.prelude.startsWith('@')) {
      const variant = mediaVariant(item.prelude)
      if (variant === null) {
        out.push(`${item.prelude} {${item.body}}`)
        continue
      }
      const inner: string[] = []
      for (const rule of parseItems(item.body)) {
        if (rule.body === null || rule.prelude.startsWith('@')) {
          inner.push(rule.body === null ? `${rule.prelude};` : `${rule.prelude} {${rule.body}}`)
        } else {
          const text = convertRule(rule as Item & { body: string }, [variant], rootClass, collector)
          if (text) inner.push(text)
        }
      }
      if (inner.length > 0) out.push(`${item.prelude} {\n${inner.join('\n\n')}\n}`)
    } else {
      const text = convertRule(item as Item & { body: string }, [], rootClass, collector)
      if (text) out.push(text)
    }
  }
  return out.join('\n\n')
}

/** Converts what maps cleanly onto Tailwind v4 utilities (see the module comment); everything else is returned as a CSS Modules split of what is left. Unsafe or unparsable CSS is dropped the way `splitComponentCss` drops it. */
export function cssToTailwind(css: string, options: TailwindOptions = {}): TailwindSplit {
  const rootClass = options.rootClass ?? 'root'
  const splitOptions = { rootClass, rewriteUrl: options.rewriteUrl }
  const first = splitComponentCss(css, splitOptions)
  const collector: Collector = { utilities: new Map() }
  const remaining = convertSheet(first.moduleCss, rootClass, collector)
  const second = splitComponentCss(remaining, { rootClass })
  return {
    utilities: new Map(
      [...collector.utilities].map(([name, entries]) => [
        name,
        [...new Set([...entries.values()].flatMap((declaration) => declaration.utilities))],
      ]),
    ),
    leftover: {
      moduleCss: second.moduleCss,
      classes: second.classes,
      globalCss: first.globalCss,
      issues: second.issues,
    },
    issues: first.issues,
  }
}

/** The JSX className value for a class list: the utilities and unknown classes as one string literal, classes with leftover rules as `styles["x"]`: `{"p-4 flex"}` or `{cx("p-4", styles["x"])}`. */
export function tailwindClassName(
  classes: string[],
  split: TailwindSplit,
  names: { styles?: string; cx?: string } = {},
): string {
  const styles = names.styles ?? 'styles'
  const cx = names.cx ?? 'cx'
  const tokens: string[] = []
  const modules: string[] = []
  for (const name of new Set(classes)) {
    const utilities = split.utilities.get(name)
    const inModule = split.leftover.classes.includes(name)
    if (utilities) tokens.push(...utilities)
    else if (!inModule) tokens.push(name)
    if (inModule) modules.push(`${styles}[${jsString(name)}]`)
  }
  const literal = [...new Set(tokens)].join(' ')
  const parts = literal ? [jsString(literal), ...modules] : modules
  if (parts.length === 0) return `{""}`
  if (parts.length === 1) return `{${parts[0]}}`
  return `{${cx}(${parts.join(', ')})}`
}
