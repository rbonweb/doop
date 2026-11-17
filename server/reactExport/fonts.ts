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
