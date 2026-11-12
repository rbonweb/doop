import { parse, parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { ELEMENT_ID_ATTR, elementIdOf, isElementId, isReusableElementId, newElementId } from '../shared/elementId.ts'
import type { CommentAnchor } from '../shared/types.ts'

/**
 * Stamping `data-doop-id` into a frame's source. The browser hands us the
 * positional CSS path of the element someone commented on or linked to (the
 * runtime's cssPath: `body:nth-of-type(1) > main:nth-of-type(1) > …`, or
 * `#id > …` from the nearest id); we resolve it against the stored HTML the
 * way a browser would and write the attribute into the start tag by source
 * offset, so nothing else in the document is re-serialized.
 */

type Element = Tree.Element
type ParentNode = Tree.ParentNode

interface Step {
  tag: string
  nth: number
}

const STEP = /^([a-zA-Z][\w-]*)(?::nth-of-type\((\d+)\))?$/

/** CSS.escape's output back to the identifier: `\31 abc` → `1abc`, `\.` → `.`. */
function unescapeIdent(escaped: string): string {
  return escaped.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, char: string | undefined) => {
    if (!hex) return char ?? ''
    const code = parseInt(hex, 16)
    /* past U+10FFFF is not a character: CSS maps it to U+FFFD */
    return code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code)
  })
}

function isElement(node: Tree.ChildNode): node is Element {
  return 'tagName' in node
}

function elementChildren(node: ParentNode): Element[] {
  return node.childNodes.filter(isElement)
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

/** Every element below `node` in document order, without recursion: frame
 *  HTML is untrusted and may nest deeper than the call stack allows. */
function* walk(node: ParentNode): Generator<Element> {
  const stack: Element[] = elementChildren(node).reverse()
  for (let next = stack.pop(); next; next = stack.pop()) {
    yield next
    for (const child of elementChildren(next).reverse()) stack.push(child)
  }
}

function documentElement(doc: Tree.Document): Element | undefined {
  return elementChildren(doc).find((el) => el.tagName === 'html')
}

function findById(doc: Tree.Document, id: string): Element | undefined {
  for (const el of walk(doc)) if (attr(el, 'id') === id) return el
  return undefined
}

function findByElementId(doc: Tree.Document, id: string): Element | undefined {
  for (const el of walk(doc)) if (attr(el, ELEMENT_ID_ATTR) === id) return el
  return undefined
}

function nthOfType(parent: ParentNode, step: Step): Element | undefined {
  const sameTag = elementChildren(parent).filter((el) => el.tagName.toLowerCase() === step.tag)
  return sameTag[step.nth - 1]
}

/** The child steps of a path: split on `>`, except one escaped inside an
 *  identifier (`#a\>b`, as CSS.escape writes an id that holds a `>`). */
function splitPath(selector: string): string[] {
  const steps: string[] = []
  let current = ''
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\' && i + 1 < selector.length) {
      current += char + selector[++i]!
    } else if (char === '>') {
      steps.push(current.trim())
      current = ''
    } else current += char
  }
  steps.push(current.trim())
  return steps
}

function walkPath(from: ParentNode | undefined, steps: string[]): Element | undefined {
  let node: ParentNode | undefined = from
  for (const raw of steps) {
    if (!node) return undefined
    const match = STEP.exec(raw)
    if (!match) return undefined
    node = nthOfType(node, { tag: match[1]!.toLowerCase(), nth: match[2] ? Number(match[2]) : 1 })
  }
  return node && 'tagName' in node ? node : undefined
}

/** The element a runtime/Layers selector names in this document, or
 *  undefined when the path does not resolve or uses a shape we do not know. */
function resolve(doc: Tree.Document, selector: string): Element | undefined {
  const trimmed = selector.trim()
  const byId = elementIdOf(trimmed)
  if (byId) return findByElementId(doc, byId)
  const steps = splitPath(trimmed)
  const first = steps[0]
  if (!first) return undefined
  if (first.startsWith('#')) return walkPath(findById(doc, unescapeIdent(first.slice(1))), steps.slice(1))
  /* cssPath stops below <html>, so a path starts at body (or head); a
     client that sends a path from inside the body still resolves */
  const html = documentElement(doc)
  const fromRoot = walkPath(html, first.toLowerCase() === 'html' ? steps.slice(1) : steps)
  if (fromRoot) return fromRoot
  const body = html ? nthOfType(html, { tag: 'body', nth: 1 }) : undefined
  return walkPath(body, steps)
}

/** The element a selector names in a parsed document, for callers that hold the tree. */
export const resolveElement = resolve

function parseDocument(html: string): Tree.Document {
  return parse(html, { sourceCodeLocationInfo: true })
}

/** The `data-doop-id` already on the element a selector names, if any. */
export function elementIdAt(html: string, selector: string): string | undefined {
  const el = resolve(parseDocument(html), selector)
  const id = el ? attr(el, ELEMENT_ID_ATTR) : undefined
  return isReusableElementId(id) ? id : undefined
}

export interface Stamped {
  /** the frame HTML with the attribute in place; unchanged when it was there already */
  html: string
  id: string
}

export interface StampOptions {
  /** the id to write, when the element has none; a fresh one by default */
  id?: string
  /** the live element's outerHTML excerpt (the runtime's probe snippet): the
   *  saved element must wear the same tag and every attribute the saved one
   *  has, or the path has drifted (a script put another element before it)
   *  and the stamp is refused rather than landing on the wrong element */
  like?: string
}

function textOf(node: ParentNode): string {
  let text = ''
  for (const child of node.childNodes) {
    if ('value' in child && child.nodeName === '#text') text += child.value
    else if ('childNodes' in child) text += textOf(child)
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** The attributes that identify an element, keyed by their qualified name
 *  in lower case so `xlink:href` and `textLength` read the same whether the
 *  markup was parsed as SVG or as plain HTML. The runtime's own live markers
 *  (`data-v-*`) and the id being stamped are not among them. */
function identifyingAttrs(el: Element): Map<string, string> {
  const entries: Array<[string, string]> = []
  for (const a of el.attrs) {
    const name = `${a.prefix ? `${a.prefix}:` : ''}${a.name}`.toLowerCase()
    if (name !== ELEMENT_ID_ATTR && !name.startsWith('data-v-')) entries.push([name, a.value])
  }
  return new Map(entries)
}

/** Whether the element the path found in the saved HTML is the element the
 *  live document described: the same tag, the same attributes, and the same
 *  text unless the excerpt was cut short. The excerpt is parsed in the saved
 *  element's own context, so SVG content keeps its namespace. An excerpt
 *  whose start tag was cut off, or that does not parse to an element,
 *  cannot vouch, and is taken on trust. */
function matchesSnippet(el: Element, snippet: string): boolean {
  const context = el.parentNode && 'tagName' in el.parentNode ? el.parentNode : null
  const live = elementChildren(context ? parseFragment(context, snippet, {}) : parseFragment(snippet))[0]
  if (!live || !snippet.includes('>')) return true
  if (live.tagName.toLowerCase() !== el.tagName.toLowerCase()) return false
  const saved = identifyingAttrs(el)
  const seen = identifyingAttrs(live)
  if (saved.size !== seen.size || [...saved].some(([name, value]) => seen.get(name) !== value)) return false
  return snippet.endsWith('...') || textOf(live) === textOf(el)
}

/** Give the element a selector names a stable id: the one it carries, or a
 *  fresh one written into its start tag. Undefined when the selector does
 *  not resolve in this HTML (the live document had drifted, or a script made
 *  the element), the element found is not the one described by `like`, the
 *  element is an implied tag with no source of its own, or the stamped
 *  markup would not resolve the id (the start tag was malformed in a way
 *  the parser forgives but the stamp cannot repair). */
export function stampElementId(html: string, selector: string, opts: StampOptions = {}): Stamped | undefined {
  const doc = parseDocument(html)
  const el = resolve(doc, selector)
  if (!el) return undefined
  if (opts.like !== undefined && !matchesSnippet(el, opts.like)) return undefined
  return stampElement(html, doc, el, opts.id)
}

interface StampEdit {
  id: string
  /** the start-tag rewrite that carries the id; absent when the element already wears a usable one */
  edit?: { start: number; end: number; text: string }
}

/** What writing an id into an element already found in `html`'s own parse takes. An id the
 *  element already wears is kept even when this format would not mint it (the
 *  fork's `r10`): other markup and comments may name it. It is replaced only
 *  when it is unusable (empty, or holding a quote) or another element before
 *  this one carries the same id, since an id must name one element. */
function stampEdit(html: string, doc: Tree.Document, el: Element, wanted?: string): StampEdit | undefined {
  const existing = attr(el, ELEMENT_ID_ATTR)
  if (isElementId(existing)) return { id: existing }
  if (isReusableElementId(existing) && findByElementId(doc, existing) === el) return { id: existing }
  const tag = el.sourceCodeLocation?.startTag
  if (!tag) return undefined
  const id = wanted ?? newElementId()
  /* The attribute goes right after the last attribute the parser saw, or
     after the tag name: an unquoted value may end in `/` (`src=/a/b/`),
     which a `/>` check would mistake for self-closing and cut into. A stale
     attribute with a malformed value is cut out by its own source range,
     however it was spelled, rather than doubled. */
  const attrs = Object.values(el.sourceCodeLocation?.attrs ?? {})
  const stale = el.sourceCodeLocation?.attrs?.[ELEMENT_ID_ATTR]
  const insertAt = attrs.length ? Math.max(...attrs.map((a) => a.endOffset)) : tag.startOffset + 1 + el.tagName.length
  let open = html.slice(tag.startOffset, insertAt) + ` ${ELEMENT_ID_ATTR}="${id}"` + html.slice(insertAt, tag.endOffset)
  if (stale) {
    const from = stale.startOffset - tag.startOffset
    const to = stale.endOffset - tag.startOffset
    open = open.slice(0, from).replace(/\s+$/, '') + open.slice(to)
  }
  return { id, edit: { start: tag.startOffset, end: tag.endOffset, text: open } }
}

function stampElement(html: string, doc: Tree.Document, el: Element, wanted?: string): Stamped | undefined {
  const stamp = stampEdit(html, doc, el, wanted)
  if (!stamp) return undefined
  if (!stamp.edit) return { html, id: stamp.id }
  const next = html.slice(0, stamp.edit.start) + stamp.edit.text + html.slice(stamp.edit.end)
  return hasElementId(next, stamp.id) ? { html: next, id: stamp.id } : undefined
}

export interface StampedMany {
  /** the frame HTML with every stamp in place; unchanged when none was needed or the batch could not be verified */
  html: string
  /** the id of each selector's element, in order; undefined where the selector did not resolve or the batch was refused */
  ids: Array<string | undefined>
}

/** `stampElementId` for many positional selectors in one parse and one rewrite. Every start tag is
 *  edited by source offset, then the result is parsed once more: if any stamped id does not
 *  resolve, nothing is written at all, so a batch never lands half-stamped. */
export function stampElementIds(html: string, selectors: string[]): StampedMany {
  const doc = parseDocument(html)
  const found = selectors.map((selector) => {
    const el = resolve(doc, selector)
    return el ? stampEdit(html, doc, el) : undefined
  })
  const edits = found.flatMap((stamp) => (stamp?.edit ? [stamp.edit] : []))
  if (!edits.length) return { html, ids: found.map((stamp) => stamp?.id) }
  let next = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  }
  const verified = parseDocument(next)
  const present = new Set<string>()
  for (const el of walk(verified)) {
    const id = attr(el, ELEMENT_ID_ATTR)
    if (id) present.add(id)
  }
  if (found.some((stamp) => stamp && !present.has(stamp.id))) return { html, ids: found.map(() => undefined) }
  return { html: next, ids: found.map((stamp) => stamp?.id) }
}

/** Whether a stamped element is still in the HTML. */
export function hasElementId(html: string, id: string): boolean {
  /* by the parsed attribute, whatever its quoting or case in the source */
  return findByElementId(parseDocument(html), id) !== undefined
}

/* ------------------------------------------------------------------ */
/* Comments written before element ids                                 */
/* ------------------------------------------------------------------ */

const ANCHOR_START_LEN = 60
const ANCHOR_SLICE_LEN = 40

/** Whether the element is still the one a legacy comment's anchor was captured on:
 *  the same tag, role, aria-label, data-testid and, where it kept one, the quote. */
function matchesAnchor(el: Element, anchor: CommentAnchor): boolean {
  if (anchor.tag && el.tagName.toLowerCase() !== anchor.tag) return false
  if (anchor.role && attr(el, 'role') !== anchor.role) return false
  if (anchor.ariaLabel && attr(el, 'aria-label') !== anchor.ariaLabel) return false
  if (anchor.testId && attr(el, 'data-testid') !== anchor.testId) return false
  const quote = anchor.quote
  if (quote) {
    const text = textOf(el)
    const startsLikeQuote = text.indexOf(quote.slice(0, ANCHOR_START_LEN)) === 0
    const holdsHead = text.indexOf(quote.slice(0, ANCHOR_SLICE_LEN)) !== -1
    const holdsTail = quote.length > ANCHOR_SLICE_LEN && text.indexOf(quote.slice(-ANCHOR_SLICE_LEN)) !== -1
    if (!startsLikeQuote && !holdsHead && !holdsTail) return false
  }
  return true
}

const INERT_TAGS = new Set(['script', 'style', 'noscript', 'template'])

/** The innermost element below `root` whose text still contains `probe`. */
function innermostHolding(root: Element, probe: string): Element | undefined {
  if (!textOf(root).includes(probe)) return undefined
  let node = root
  for (;;) {
    const next = elementChildren(node).find((child) => !INERT_TAGS.has(child.tagName) && textOf(child).includes(probe))
    if (!next) return node
    node = next
  }
}

/** The element a legacy comment was on, found again in the saved HTML: the
 *  stored path when the element there still fits the anchor, then its
 *  data-testid, its id, a scan of same-tag elements on role, aria-label and
 *  quote, and finally the innermost element holding the quote. The path alone
 *  is not trusted once the anchor says it points elsewhere. */
function resolveAnchored(doc: Tree.Document, selector: string, anchor: CommentAnchor | undefined): Element | undefined {
  let byPath: Element | undefined
  try {
    byPath = selector ? resolve(doc, selector) : undefined
  } catch {
    /* a path that no longer parses falls through to the hints */
  }
  if (byPath && (!anchor || matchesAnchor(byPath, anchor))) return byPath
  if (!anchor) return undefined
  if (anchor.testId) {
    for (const el of walk(doc)) if (attr(el, 'data-testid') === anchor.testId && matchesAnchor(el, anchor)) return el
  }
  if (anchor.id) {
    const byId = findById(doc, anchor.id)
    if (byId && matchesAnchor(byId, anchor)) return byId
  }
  /* a bare tag identifies nothing: scanning on it alone would pin the comment to the first such element */
  if (anchor.tag && (anchor.id || anchor.testId || anchor.role || anchor.ariaLabel || anchor.quote)) {
    for (const el of walk(doc)) if (el.tagName.toLowerCase() === anchor.tag && matchesAnchor(el, anchor)) return el
  }
  if (anchor.quote) {
    const body = nthOfType(documentElement(doc) ?? doc, { tag: 'body', nth: 1 })
    const holder = body ? innermostHolding(body, anchor.quote.slice(0, ANCHOR_START_LEN)) : undefined
    /* the body itself holding the quote means no element narrows it down */
    if (holder && holder !== body) return holder
  }
  return undefined
}

/** `stampElementId` for a comment from before element ids: the stored path is
 *  checked against the fork's anchor hints (tag, role, aria-label, data-testid,
 *  quote) and, when it drifted or no longer resolves, the element is re-found
 *  by those hints, so the comment keeps its element instead of being lost or
 *  pinned to a neighbour. Without an anchor it is `stampElementId` exactly. */
export function stampLegacyCommentElement(html: string, selector: string, anchor?: CommentAnchor): Stamped | undefined {
  if (!anchor) return stampElementId(html, selector)
  const doc = parseDocument(html)
  const el = resolveAnchored(doc, selector, anchor)
  return el ? stampElement(html, doc, el) : undefined
}

/** `stampElementId` for an element named by the text it shows rather than by a
 *  path: the innermost element of the body holding `quote` (its first 60
 *  characters, whitespace collapsed). Undefined when nothing narrower than the
 *  body holds it. */
export function stampElementByQuote(html: string, quote: string): Stamped | undefined {
  const probe = quote.replace(/\s+/g, ' ').trim().slice(0, ANCHOR_START_LEN)
  if (!probe) return undefined
  const doc = parseDocument(html)
  const body = nthOfType(documentElement(doc) ?? doc, { tag: 'body', nth: 1 })
  const holder = body ? innermostHolding(body, probe) : undefined
  return holder && holder !== body ? stampElement(html, doc, holder) : undefined
}
