/** Root-relative paths Doop serves itself: assets, icons, stock photos, renders and fonts. */
const DOOP_PATH = /^\/(?:a|icons|photos|i|fonts)\//

export interface UrlRewriter {
  /** the one rewrite rule: a root-relative Doop path becomes absolute on the asset origin, anything else is returned as it came. It is the function passed to htmlToJsx and splitComponentCss as `rewriteUrl`. */
  url(value: string): string
}

/** `origin` must be an absolute http(s) origin; a trailing slash is ignored. Throws on anything else, since it ends up in generated files. */
export function makeUrlRewriter(origin: string): UrlRewriter {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('assetOrigin must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('assetOrigin must be an http(s) URL')
  const root = parsed.origin
  return { url: (value) => (DOOP_PATH.test(value) ? `${root}${value}` : value) }
}
