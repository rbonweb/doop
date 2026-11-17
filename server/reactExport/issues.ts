/** What the React export dropped, changed or could not carry over; every converter returns its own list and the export report joins them. */
export type ExportIssueKind =
  | 'script'
  | 'event-handler'
  | 'comment'
  | 'unsafe-url'
  | 'dropped-element'
  | 'dropped-attribute'
  | 'style'
  | 'css'
  | 'name'

export interface ExportIssue {
  kind: ExportIssueKind
  detail: string
  /** a short human locator such as `div > a[2]` */
  path?: string
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** True for a URL that runs code when followed or loaded: `javascript:`, `vbscript:` and any `data:` other than a raster or SVG image. Browsers ignore ASCII whitespace and control characters inside a scheme, so they are stripped before the check; callers decode HTML entities or CSS escapes first. */
export function isUnsafeUrl(value: string): boolean {
  const compact = Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
  const scheme = SCHEME.exec(compact)?.[1]?.toLowerCase()
  if (!scheme) return false
  if (scheme === 'javascript' || scheme === 'vbscript') return true
  return scheme === 'data' && !SAFE_DATA_IMAGE.test(compact)
}

/** A JavaScript string literal that is safe anywhere in a .tsx file: JSON escaping, plus `<` and the two line separators escaped so no `</script>` or line break ever appears in the source. */
export function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
