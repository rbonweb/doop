import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'

/**
 * What in a stored frame could run: parsed with parse5 (never matched as text), it lists every script element, on*
 * attribute, javascript:/vbscript:/data:text/html URL, SVG animation aimed at an event handler or a link, and style
 * element whose text still holds `</style`. An empty list is a frame with nothing executable in it.
 * Used by the component importer's tests (and any importer that writes frames from untrusted input).
 */

const URL_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'poster',
  'srcset',
  'background',
  'data',
])
/** at the start of the value or of any comma-separated candidate (srcset, values) */
const SCHEME = /(?:^|[,;])(?:javascript|vbscript|data:text\/html)/

/** Whitespace and control characters out, lower case: how a browser reads the start of a URL. */
function compact(value: string): string {
  let out = ''
  for (const char of value) if ((char.codePointAt(0) ?? 0) > 0x20 && char !== '\u007f') out += char
  return out.toLowerCase()
}

export function executableParts(html: string): string[] {
  const found: string[] = []
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('content' in node && node.content) stack.push(node.content)
    if ('childNodes' in node) stack.push(...node.childNodes)
    if (!('tagName' in node)) continue
    const tag = node.tagName.toLowerCase()
    if (tag === 'script') found.push('<script> element')
    if (tag === 'style') {
      const text = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
      if (/<\/style/i.test(text)) found.push('style text with </style')
    }
    for (const attr of node.attrs) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) found.push(`<${tag} ${name}>`)
      if (URL_ATTRS.has(name) && SCHEME.test(compact(attr.value)))
        found.push(`<${tag} ${name}="${attr.value.slice(0, 40)}">`)
    }
    if (['set', 'animate', 'animatemotion', 'animatetransform'].includes(tag)) {
      const target = (node.attrs.find((attr) => attr.name.toLowerCase() === 'attributename')?.value ?? '').trim()
      if (/^(on|(xlink:)?href$)/i.test(target)) found.push(`<${tag} attributeName="${target}">`)
    }
  }
  return found
}
