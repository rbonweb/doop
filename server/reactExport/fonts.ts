import { WEB_FONT_LINK_ATTR, withWebFontLinks } from '../../shared/webFonts.ts'

/** Doop's hosted font roster is one Google Fonts stylesheet link; it is the only stylesheet link an export can carry. */
export function googleFontsUrl(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' || url.hostname !== 'fonts.googleapis.com') return null
    if (url.username || url.password || url.port || !/^\/css2?$/.test(url.pathname)) return null
    return url.href
  } catch {
    return null
  }
}

/** A CSS string token: quotes, backslashes and control characters escaped, so the URL can never end the string. */
export function cssString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\' || char === '"') out += `\\${char}`
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `
    else out += char
  }
  return `${out}"`
}

/** `src/fonts.css`: one `@import` per hosted font stylesheet, sorted so two runs agree. */
export function fontsCss(urls: Iterable<string>): string {
  return `${[...new Set(urls)]
    .sort()
    .map((url) => `@import url(${cssString(url)});`)
    .join('\n')}\n`
}

/** The hosted-font stylesheet a document needs, by the rule that writes the link into a frame (`withWebFontLinks`): every roster family its CSS names and does not load itself. Null when it needs none; the address still passes `googleFontsUrl`. */
export function hostedFontUrl(html: string): string | null {
  const link = new RegExp(`<link\\b[^>]*\\b${WEB_FONT_LINK_ATTR}\\b[^>]*>`, 'i').exec(withWebFontLinks(html))
  const href = link ? /href\s*=\s*["']([^"']*)["']/i.exec(link[0])?.[1] : undefined
  return href === undefined ? null : googleFontsUrl(href.replace(/&amp;/g, '&'))
}

/** A component's own CSS and markup as a document, so `hostedFontUrl` can read what fonts it names. */
export const componentDocument = (template: string, css: string): string =>
  `<!doctype html><html><head></head><body>${template}<style>${css}</style></body></html>`
