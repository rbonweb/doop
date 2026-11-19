import { defaultTreeAdapter, html as parse5Html, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { MAX_RICHTEXT_CHARS } from '../shared/components.ts'
import { parseFragment } from './workBudget.ts'

/**
 * The one sanitizer for a component's `richtext` prop: a safe inline HTML subset. Everything a rich-text value
 * becomes (an agent's `<doop-use title="<b>Hi</b>">`, `update_instances`, a saved edit of an instance's bound
 * element, a marker read back from stored markup) goes through here before it reaches a frame.
 *
 * The output is built from a fresh tree that holds only text and allowed elements and serialised by parse5, so
 * nothing the input said survives except through the allow-list. Allowed: text, `b`, `i`, `strong`, `em`, `br`,
 * `a` (only an absolute http or https `href`) and `span` (only a `class` of letters, digits, `_` and `-`).
 * Any other element is unwrapped to its sanitised children; script, style, template, iframe, object, svg, math
 * and the other raw-text or foreign elements are dropped with their content; comments and every other attribute
 * are dropped. Idempotent, and bounded by `MAX_RICHTEXT_CHARS` and `MAX_RICHTEXT_DEPTH`.
 */

export const MAX_RICHTEXT_DEPTH = 16
const MAX_HREF = 2000

type Element = Tree.Element
type ChildNode = Tree.ChildNode
type ParentNode = Tree.ParentNode

export interface RichTextResult {
  /** the sanitised value: inline markup, safe to put inside any element */
  html: string
  /** what was taken out, one short entry per kind ("<script> and its content", "onclick on <a>"), for an issue */
  removed: string[]
}

const KEPT = new Set(['b', 'i', 'strong', 'em', 'br', 'a', 'span'])
/** content that is code, data or foreign markup: dropped with what is inside it */
const DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'plaintext',
  'textarea',
  'title',
  'select',
  'frameset',
  'frame',
  'applet',
  'audio',
  'video',
  'canvas',
  'head',
])
const CLASS_TOKEN = /^[A-Za-z0-9_-]+$/
/* tab, newline, space and the other controls: a browser strips some of them inside a URL, so none is allowed */
const UNSAFE_URL_CHARS = /[\\<>"'`]/

function hasControlOrSpace(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

const isElement = (node: ChildNode): node is Element => 'tagName' in node

function safeHref(value: string): boolean {
  if (value.length > MAX_HREF || UNSAFE_URL_CHARS.test(value) || hasControlOrSpace(value)) return false
  if (!/^https?:\/\/[^/?#]/i.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

function text(value: string): Tree.TextNode {
  return { nodeName: '#text', value, parentNode: null } as unknown as Tree.TextNode
}

function make(tag: string, attrs: Tree.Element['attrs']): Element {
  return defaultTreeAdapter.createElement(tag, parse5Html.NS.HTML, attrs) as Element
}

interface Pass {
  removed: Set<string>
}

/** One pass over a parsed fragment: the sanitised tree, built with an explicit stack (frame HTML is untrusted). */
function pass(fragment: Tree.DocumentFragment, note: Pass): Tree.DocumentFragment {
  const out = defaultTreeAdapter.createDocumentFragment()
  interface Frame {
    source: ParentNode
    target: ParentNode
    at: number
    depth: number
  }
  const stack: Frame[] = [{ source: fragment, target: out, at: 0, depth: 0 }]
  const append = (target: ParentNode, node: ChildNode) => {
    node.parentNode = target
    target.childNodes.push(node)
  }
  while (stack.length) {
    const frame = stack[stack.length - 1]!
    const child = frame.source.childNodes[frame.at++]
    if (!child) {
      stack.pop()
      continue
    }
    if (child.nodeName === '#text') {
      const value = (child as Tree.TextNode).value
      const last = frame.target.childNodes[frame.target.childNodes.length - 1]
      if (last && last.nodeName === '#text') (last as Tree.TextNode).value += value
      else if (value !== '') append(frame.target, text(value))
      continue
    }
    if (child.nodeName === '#comment') {
      note.removed.add('comments')
      continue
    }
    if (!isElement(child)) continue
    const tag = child.tagName.toLowerCase()
    const foreign = child.namespaceURI !== parse5Html.NS.HTML
    if (foreign || DROPPED_WITH_CONTENT.has(tag)) {
      note.removed.add(`<${tag}> and its content`)
      continue
    }
    const below = child
    if (!KEPT.has(tag)) {
      note.removed.add(`<${tag}> tag`)
      stack.push({ source: below, target: frame.target, at: 0, depth: frame.depth })
      continue
    }
    for (const attr of child.attrs)
      if (!(tag === 'a' && attr.name === 'href') && !(tag === 'span' && attr.name === 'class'))
        note.removed.add(`${attr.name} attribute on <${tag}>`)
    if (tag === 'br') {
      append(frame.target, make('br', []))
      continue
    }
    const attrs: Tree.Element['attrs'] = []
    if (tag === 'a') {
      const href = child.attrs.find((attr) => attr.name === 'href')?.value
      if (href === undefined || !safeHref(href)) {
        /* no safe address: the link is its text */
        note.removed.add(href === undefined ? '<a> without an href' : `unsafe link address`)
        stack.push({ source: below, target: frame.target, at: 0, depth: frame.depth })
        continue
      }
      attrs.push({ name: 'href', value: href })
    }
    if (tag === 'span') {
      const raw = child.attrs.find((attr) => attr.name === 'class')?.value
      const tokens = raw === undefined ? [] : raw.split(/[ \t\n\f\r]+/).filter(Boolean)
      if (raw !== undefined && !tokens.every((token) => CLASS_TOKEN.test(token)))
        note.removed.add('unsafe class on <span>')
      else if (tokens.length) attrs.push({ name: 'class', value: tokens.join(' ') })
      if (!attrs.length) {
        /* a span with nothing on it says nothing */
        stack.push({ source: below, target: frame.target, at: 0, depth: frame.depth })
        continue
      }
    }
    if (frame.depth >= MAX_RICHTEXT_DEPTH) {
      note.removed.add(`nesting deeper than ${MAX_RICHTEXT_DEPTH} (flattened)`)
      stack.push({ source: below, target: frame.target, at: 0, depth: frame.depth })
      continue
    }
    const kept = make(tag, attrs)
    append(frame.target, kept)
    stack.push({ source: below, target: kept, at: 0, depth: frame.depth + 1 })
  }
  return out
}

const empty = (removed: string[]): RichTextResult => ({ html: '', removed })

function once(markup: string, note: Pass): string {
  return serialize(pass(parseFragment(markup), note))
}

/** The safe form of a rich-text value, and what had to go. `sanitizeRichText(sanitizeRichText(x).html).html` is the same string. */
export function sanitizeRichText(value: string): RichTextResult {
  if (value.length > MAX_RICHTEXT_CHARS)
    return empty([
      `the value (it is over ${MAX_RICHTEXT_CHARS.toLocaleString('en-US')} characters, so none of it was kept)`,
    ])
  if (!value.includes('<') && !value.includes('&')) return { html: serialize(textOnly(value)), removed: [] }
  const note: Pass = { removed: new Set() }
  let html = once(value, note)
  /* a fixed point: the output must read back as itself, or the parser and the serialiser disagree about it */
  for (let round = 0; round < 3; round++) {
    const again = once(html, { removed: new Set() })
    if (again === html) return { html, removed: [...note.removed] }
    html = again
  }
  return {
    html: serialize(textOnly(plainText(html))),
    removed: [...note.removed, 'markup that would not read back the same'],
  }
}

function textOnly(value: string): Tree.DocumentFragment {
  const fragment = defaultTreeAdapter.createDocumentFragment()
  if (value !== '') {
    const node = text(value)
    node.parentNode = fragment
    fragment.childNodes.push(node)
  }
  return fragment
}

/** The text of markup, tags gone (the last resort when markup will not settle). */
function plainText(markup: string): string {
  const parts: string[] = []
  const stack: ChildNode[] = [...parseFragment(markup).childNodes].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.nodeName === '#text') parts.push((node as Tree.TextNode).value)
    else if (isElement(node)) stack.push(...[...node.childNodes].reverse())
  }
  return parts.join('')
}

/** One line for an issue: what was removed, never the value itself. */
export function describeRemoved(removed: readonly string[]): string {
  return removed.slice(0, 6).join(', ') + (removed.length > 6 ? ` and ${removed.length - 6} more` : '')
}
