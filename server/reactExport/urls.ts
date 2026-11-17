import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

/** Root-relative paths Doop serves itself: assets, icons, stock photos, renders and fonts. */
const DOOP_PATH = /^\/(?:a|icons|photos|i|fonts)\//
const CSS_URL = /url\(\s*(["']?)(\/(?:a|icons|photos|i|fonts)\/[^)"']*)\1\s*\)/gi
const URL_ATTRS = new Set(['href', 'src', 'poster', 'xlink:href', 'action'])

export interface UrlRewriter {
  /** one URL value: a root-relative Doop path becomes absolute on the asset origin, anything else is returned as it came */
  url(value: string): string
  /** a stylesheet's `url(/a/…)` references */
  css(text: string): string
  /** every URL attribute, `srcset` entry and `style` url() under a node, in place */
  tree(node: Tree.ParentNode): void
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
  const url = (value: string): string => (DOOP_PATH.test(value) ? `${root}${value}` : value)
  const css = (text: string): string =>
    text.replace(CSS_URL, (_all, quote: string, path: string) => `url(${quote}${root}${path}${quote})`)
  const srcset = (value: string): string =>
    value
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim()
        const space = trimmed.search(/\s/)
        return space === -1 ? url(trimmed) : `${url(trimmed.slice(0, space))}${trimmed.slice(space)}`
      })
      .join(', ')
  const fix = (el: Tree.Element): void => {
    for (const attr of el.attrs) {
      const name = attr.name.toLowerCase()
      if (URL_ATTRS.has(name)) attr.value = url(attr.value)
      else if (name === 'srcset') attr.value = srcset(attr.value)
      else if (name === 'style') attr.value = css(attr.value)
    }
  }
  const tree = (node: Tree.ParentNode): void => {
    const stack: Tree.ParentNode[] = [node]
    for (let next = stack.pop(); next; next = stack.pop()) {
      if ('tagName' in next) fix(next)
      for (const child of next.childNodes) if ('tagName' in child) stack.push(child)
    }
  }
  return { url, css, tree }
}
