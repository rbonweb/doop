import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'

/**
 * Pure search and replace over one frame's HTML, the logic behind `find_frames` and `replace_in_frames`.
 * Frame HTML is untrusted, so every tree walk here uses an explicit stack instead of recursion.
 */

export interface TextNodeInfo {
  start: number
  end: number
  raw: string
  text: string
  locked: boolean
}

export interface Hit {
  start: number
  end: number
  snippet: string
  locked?: boolean
}

export type Query = { ok: true; re: RegExp } | { ok: false; error: string }

const MAX_FIND = 500
const DEFAULT_LIMIT = 50
const LOCK_ATTR = 'data-doop-locked'
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'template', 'noscript', 'textarea'])
/* a quantified group that itself contains a quantifier: `(a+)+`, `(?:x*) {2}` */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}]\)\s*[+*{]/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi

/** `compileQuery` turns the caller's find string into the global regex every search takes. */
export function compileQuery(find: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): Query {
  if (find.length === 0) return { ok: false, error: 'find is empty' }
  if (find.length > MAX_FIND) return { ok: false, error: `find is longer than ${MAX_FIND} characters` }
  const flags = opts.caseSensitive ? 'g' : 'gi'
  if (!opts.regex) return { ok: true, re: new RegExp(find.replace(REGEX_SPECIALS, '\\$&'), flags) }
  if (NESTED_QUANTIFIER.test(find)) return { ok: false, error: 'pattern can backtrack catastrophically' }
  try {
    return { ok: true, re: new RegExp(find, flags) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function isElement(node: Tree.ChildNode): node is Tree.Element {
  return 'tagName' in node
}

function hasLock(el: Tree.Element): boolean {
  return el.attrs.some((attr) => attr.name === LOCK_ATTR)
}

function attr(el: Tree.Element, name: string): string | undefined {
  for (const candidate of el.attrs) {
    const full = candidate.prefix ? `${candidate.prefix}:${candidate.name}` : candidate.name
    if (full === name) return candidate.value
  }
  return undefined
}

function textOf(el: Tree.Element): string {
  let text = ''
  for (const child of el.childNodes) if ('value' in child) text += child.value
  return text
}

interface TextVisit {
  node: Tree.ChildNode
  locked: boolean
}

/** The `<body>` and whether an ancestor already locks everything below it. */
function textRoot(doc: Tree.Document): { node: Tree.Element; locked: boolean } | undefined {
  let html: Tree.Element | undefined
  let locked = false
  for (const child of doc.childNodes) {
    if (isElement(child) && child.tagName === 'html') {
      html = child
      locked = hasLock(child)
      break
    }
  }
  if (!html) return undefined
  for (const child of html.childNodes) {
    if (isElement(child) && child.tagName === 'body') return { node: child, locked: locked || hasLock(child) }
  }
  return undefined
}

function pushChildren(stack: TextVisit[], parent: Tree.ParentNode, locked: boolean): void {
  for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
    const child = parent.childNodes[index]
    if (child) stack.push({ node: child, locked })
  }
}

/** Every text node of the body, in document order, skipping executable and raw-text containers. */
export function textNodes(html: string): TextNodeInfo[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const root = textRoot(doc)
  const nodes: TextNodeInfo[] = []
  if (!root) return nodes
  const stack: TextVisit[] = []
  pushChildren(stack, root.node, root.locked)
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const node = visit.node
    if ('value' in node) {
      const location = node.sourceCodeLocation
      if (!location) continue
      nodes.push({
        start: location.startOffset,
        end: location.endOffset,
        raw: html.slice(location.startOffset, location.endOffset),
        text: node.value,
        locked: visit.locked,
      })
      continue
    }
    if (!isElement(node) || SKIP_TEXT_TAGS.has(node.tagName)) continue
    pushChildren(stack, node, visit.locked || hasLock(node))
  }
  return nodes
}

/** Non-empty matches of a global regex, advancing past zero-length matches so a loop always ends. */
function* matchesOf(query: RegExp, source: string): Generator<{ start: number; end: number }> {
  query.lastIndex = 0
  for (;;) {
    const match = query.exec(source)
    if (!match) return
    const start = match.index
    const end = start + match[0].length
    yield { start, end }
    if (start === end) query.lastIndex = start + 1
  }
}

function countMatches(query: RegExp, source: string): number {
  let count = 0
  for (const _match of matchesOf(query, source)) count += 1
  return count
}

/** Matches inside each text node's decoded text: a match never spans nodes. */
export function findInText(html: string, query: RegExp, limit = DEFAULT_LIMIT): Hit[] {
  const hits: Hit[] = []
  if (limit <= 0) return hits
  for (const node of textNodes(html)) {
    for (const match of matchesOf(query, node.text)) {
      if (hits.length >= limit) return hits
      const hit: Hit = { start: node.start, end: node.end, snippet: snippetAround(node.text, match.start, match.end) }
      if (node.locked) hit.locked = true
      hits.push(hit)
    }
  }
  return hits
}

/** Matches over the raw source, so markup and skipped containers are searchable too. */
export function findInHtml(html: string, query: RegExp, limit = DEFAULT_LIMIT): Hit[] {
  const hits: Hit[] = []
  if (limit <= 0) return hits
  for (const match of matchesOf(query, html)) {
    hits.push({ start: match.start, end: match.end, snippet: snippetAround(html, match.start, match.end) })
    if (hits.length >= limit) break
  }
  return hits
}

function srcsetUrls(value: string): string[] {
  const urls: string[] = []
  for (const candidate of value.split(',')) {
    const url = candidate.trim().split(/\s+/)[0] ?? ''
    if (url) urls.push(url)
  }
  return urls
}

function cssUrls(source: string): string[] {
  const urls: string[] = []
  for (const match of source.matchAll(CSS_URL)) urls.push((match[1] ?? match[2] ?? match[3] ?? '').trim())
  return urls
}

/** Every image URL the document references, deduplicated, in document order. */
export function imageSources(html: string): string[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const urls: string[] = []
  const seen = new Set<string>()
  const add = (url: string | undefined): void => {
    const value = url?.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    urls.push(value)
  }
  const stack: Tree.ChildNode[] = [...doc.childNodes].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    const tag = node.tagName.toLowerCase()
    if (tag === 'img') {
      add(attr(node, 'src'))
      for (const url of srcsetUrls(attr(node, 'srcset') ?? '')) add(url)
    } else if (tag === 'source') {
      for (const url of srcsetUrls(attr(node, 'srcset') ?? '')) add(url)
    } else if (tag === 'video') {
      add(attr(node, 'poster'))
    } else if (tag === 'image') {
      add(attr(node, 'href'))
      add(attr(node, 'xlink:href'))
    } else if (tag === 'style') {
      for (const url of cssUrls(textOf(node))) add(url)
    }
    for (const url of cssUrls(attr(node, 'style') ?? '')) add(url)
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index]
      if (child) stack.push(child)
    }
  }
  return urls
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;')
}

/** Replaces inside decoded text, re-encoding only the nodes that matched; locked nodes are left alone. */
export function replaceInText(
  html: string,
  query: RegExp,
  replacement: string,
): { html: string; count: number; lockedSkipped: number } {
  let out = ''
  let cursor = 0
  let count = 0
  let lockedSkipped = 0
  for (const node of textNodes(html)) {
    const matches = countMatches(query, node.text)
    if (matches === 0) continue
    if (node.locked) {
      lockedSkipped += matches
      continue
    }
    query.lastIndex = 0
    out += html.slice(cursor, node.start) + escapeText(node.text.replace(query, replacement))
    cursor = node.end
    count += matches
  }
  out += html.slice(cursor)
  return { html: out, count, lockedSkipped }
}

/** Replaces over the raw source, `$1`-style references included. */
export function replaceInHtml(html: string, query: RegExp, replacement: string): { html: string; count: number } {
  const count = countMatches(query, html)
  query.lastIndex = 0
  return { html: html.replace(query, replacement), count }
}

/** Up to `radius` characters of context each side, whitespace collapsed, `…` where the source was cut. */
export function snippetAround(source: string, start: number, end: number, radius = 40): string {
  const from = Math.max(0, start - radius)
  const to = Math.min(source.length, end + radius)
  const body = source.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${body}${to < source.length ? '…' : ''}`
}
