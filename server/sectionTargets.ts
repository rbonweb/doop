import { selectAll } from 'css-select'
import { parse } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'
import { z } from 'zod'
import type { AnyNode, ChildNode, Document, Element, ParentNode } from 'domhandler'

/**
 * Turning a section target (`{ element_id }`, `{ label }` or `{ selector }`)
 * into source ranges in a frame's HTML, so tools splice by offset instead of
 * re-serializing the document.
 */

export type SectionTarget = { element_id: string } | { label: string } | { selector: string }

export interface SourceRange {
  start: number
  end: number
}

export interface ResolvedTarget {
  tagName: string
  start: number
  end: number
  startTag: SourceRange
  endTag?: SourceRange
  inner: SourceRange
  attrs: Record<string, SourceRange & { value: string }>
  elementId?: string
  label?: string
  isInstance: boolean
  insideInstance: boolean
  path: string
  text: string
}

export type TargetErrorCode = 'bad_target' | 'bad_selector' | 'not_found' | 'ambiguous' | 'no_source'

export interface TargetCandidate {
  path: string
  elementId?: string
  text: string
}

export type ResolveResult =
  | { ok: true; matches: ResolvedTarget[] }
  | { ok: false; code: TargetErrorCode; error: string; candidates?: TargetCandidate[] }

export interface FrameDocument {
  html: string
  doc: Document
}

export const sectionTargetSchema = z
  .union([
    z.object({ element_id: z.string().min(1) }).strict(),
    z.object({ label: z.string().min(1) }).strict(),
    z.object({ selector: z.string().min(1).max(500) }).strict(),
  ])
  .describe(
    'Target one section by element_id (its data-doop-id), by label (its data-doop-label or heading text), or by selector (a CSS selector); use exactly one form.',
  )

const ELEMENT_ID_ATTR = 'data-doop-id'
const LABEL_ATTR = 'data-doop-label'
const INSTANCE_ATTR = 'data-doop-instance'

const BLOCK_TAGS = new Set(['section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'div', 'form'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'template', 'noscript'])

/** The runtime bits of parse5's location that its domhandler types leave out. */
interface OffsetLocation {
  startOffset: number
  endOffset: number
}

interface TagLocation extends OffsetLocation {
  startTag?: OffsetLocation
  endTag?: OffsetLocation
  attrs?: Record<string, OffsetLocation>
}

/** Where an element's source really ends. parse5 closes an element with no end tag of its own (a
 *  `<footer>` left open when `</body>` arrives, or at the end of the file) at the end of the
 *  document, which would swallow `</body></html>` and whatever follows; its content ends where
 *  its last child does. */
function sourceEnd(el: Element): number {
  let current: AnyNode = el
  for (;;) {
    const location = current.sourceCodeLocation as TagLocation | null | undefined
    if (!location) return 0
    if (location.endTag) return location.endOffset
    const children: ChildNode[] = 'children' in current ? current.children : []
    const last = [...children].reverse().find((child) => child.sourceCodeLocation)
    if (!last) return location.startTag ? Math.min(location.endOffset, location.startTag.endOffset) : location.endOffset
    current = last
  }
}

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
}

function elementChildren(node: ParentNode): Element[] {
  const out: Element[] = []
  for (const child of node.children) if (isElement(child)) out.push(child)
  return out
}

/** Every element below `node` in document order, with an explicit stack: frame HTML is untrusted. */
function* walk(node: ParentNode): Generator<Element> {
  const stack = elementChildren(node).reverse()
  for (let next = stack.pop(); next; next = stack.pop()) {
    yield next
    const children = elementChildren(next)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function parseFrameDocument(html: string): FrameDocument {
  const doc = parse(html, { treeAdapter: adapter, sourceCodeLocationInfo: true })
  return { html, doc }
}

export function visibleText(el: Element, max = 120): string {
  let text = ''
  const stack: Array<{ node: ChildNode; inSvg: boolean }> = []
  const svg = el.name.toLowerCase() === 'svg'
  for (let i = el.children.length - 1; i >= 0; i--) stack.push({ node: el.children[i]!, inSvg: svg })
  for (let next = stack.pop(); next; next = stack.pop()) {
    const node = next.node
    if (isElement(node)) {
      const tag = node.name.toLowerCase()
      if (SKIP_TEXT_TAGS.has(tag)) continue
      if (tag === 'title' && next.inSvg) continue
      const inSvg = next.inSvg || tag === 'svg'
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, inSvg })
    } else if (node.type === 'text') {
      text += node.data
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function sectionLabel(el: Element): string | undefined {
  const own = el.attribs[LABEL_ATTR]
  if (own !== undefined) return own.trim()
  if (HEADING_TAGS.has(el.name.toLowerCase())) return visibleText(el, 80) || undefined
  for (const child of walk(el)) {
    if (HEADING_TAGS.has(child.name.toLowerCase())) return visibleText(child, 80) || undefined
  }
  return undefined
}

/** First heading text per element in one bottom-up pass; `null` marks a heading with no text and `undefined` no heading. */
function firstHeadingLabels(root: ParentNode): Map<Element, string | null | undefined> {
  const labels = new Map<Element, string | null | undefined>()
  const stack: Array<{ el: Element; entered: boolean }> = []
  const children = elementChildren(root)
  for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i]!, entered: false })
  while (stack.length) {
    const frame = stack[stack.length - 1]!
    if (!frame.entered) {
      frame.entered = true
      const kids = elementChildren(frame.el)
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i]!, entered: false })
      continue
    }
    stack.pop()
    const el = frame.el
    let first: string | null | undefined
    if (HEADING_TAGS.has(el.name.toLowerCase())) {
      first = visibleText(el, 80) || null
    } else {
      for (const child of elementChildren(el)) {
        const text = labels.get(child)
        if (text !== undefined) {
          first = text
          break
        }
      }
    }
    labels.set(el, first)
  }
  return labels
}

/** Blocks whose heading label matches `wanted`, keeping only the innermost one of each nested group. */
function headingCandidates(
  root: ParentNode,
  wanted: string,
  labels: Map<Element, string | null | undefined>,
): Element[] {
  const found = new Set<Element>()
  const stack: Array<{ el: Element; ancestor?: Element }> = []
  const children = elementChildren(root)
  for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i]! })
  while (stack.length) {
    const { el, ancestor } = stack.pop()!
    const text = labels.get(el)
    const match =
      BLOCK_TAGS.has(el.name.toLowerCase()) &&
      el.attribs[LABEL_ATTR] === undefined &&
      typeof text === 'string' &&
      normalize(text) === wanted
    let nextAncestor = ancestor
    if (match) {
      if (ancestor) found.delete(ancestor)
      found.add(el)
      nextAncestor = el
    }
    const kids = elementChildren(el)
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i]!, ancestor: nextAncestor })
  }
  return [...found]
}

function hasInstance(el: Element): boolean {
  return el.attribs[INSTANCE_ATTR] !== undefined
}

function isInsideInstance(el: Element): boolean {
  for (let node = el.parent; node; node = node.parent) {
    if (isElement(node) && hasInstance(node)) return true
  }
  return false
}

type PathIndex = Map<ParentNode, Map<string, Map<Element, number>>>

/** Positions of each tag among a parent's element children, built once per parent so paths are linear. */
function typePositions(parent: ParentNode, tag: string, index: PathIndex): Map<Element, number> {
  let byTag = index.get(parent)
  if (!byTag) {
    byTag = new Map()
    index.set(parent, byTag)
  }
  let positions = byTag.get(tag)
  if (!positions) {
    positions = new Map()
    let position = 0
    for (const child of elementChildren(parent)) {
      if (child.name.toLowerCase() === tag) positions.set(child, ++position)
    }
    byTag.set(tag, positions)
  }
  return positions
}

function pathOf(el: Element, index: PathIndex): string {
  const parts: string[] = []
  for (let node: Element | undefined = el; node;) {
    const tag = node.name.toLowerCase()
    const parent: ParentNode | null = node.parent
    let step = tag
    if (parent) {
      const positions = typePositions(parent, tag, index)
      if (positions.size > 1) step += `:nth-of-type(${positions.get(node)})`
    }
    parts.unshift(step)
    if (tag === 'body') break
    node = parent && isElement(parent) ? parent : undefined
  }
  return parts.join(' > ')
}

export function toResolved(fd: FrameDocument, el: Element, index: PathIndex = new Map()): ResolvedTarget | undefined {
  const loc = el.sourceCodeLocation as TagLocation | null | undefined
  const startTag = loc?.startTag
  if (!loc || !startTag) return undefined
  const endTag = loc.endTag
  const end = sourceEnd(el)
  const attrs: ResolvedTarget['attrs'] = {}
  for (const [name, range] of Object.entries(loc.attrs ?? {})) {
    const key = name.toLowerCase()
    attrs[key] = {
      start: range.startOffset,
      end: range.endOffset,
      value: el.attribs[name] ?? el.attribs[key] ?? '',
    }
  }
  const elementId = el.attribs[ELEMENT_ID_ATTR] || undefined
  const label = sectionLabel(el)
  return {
    tagName: el.name.toLowerCase(),
    start: loc.startOffset,
    end,
    startTag: { start: startTag.startOffset, end: startTag.endOffset },
    ...(endTag ? { endTag: { start: endTag.startOffset, end: endTag.endOffset } } : {}),
    inner: { start: startTag.endOffset, end: endTag ? endTag.startOffset : end },
    attrs,
    ...(elementId ? { elementId } : {}),
    ...(label !== undefined ? { label } : {}),
    isInstance: hasInstance(el),
    insideInstance: isInsideInstance(el),
    path: pathOf(el, index),
    text: visibleText(el, 120),
  }
}

function candidateOf(match: ResolvedTarget): TargetCandidate {
  return {
    path: match.path,
    ...(match.elementId ? { elementId: match.elementId } : {}),
    text: match.text,
  }
}

export function describeTarget(target: SectionTarget): string {
  if ('element_id' in target) return `element_id "${target.element_id}"`
  if ('label' in target) return `label "${target.label}"`
  return `selector "${target.selector}"`
}

function ambiguous(target: SectionTarget, matches: ResolvedTarget[]): ResolveResult {
  const first = matches[0]!
  const narrower =
    'selector' in target
      ? 'pass a narrower selector or all: true'
      : `use the element_id of one candidate${first.elementId ? ` (e.g. "${first.elementId}")` : ''}`
  return {
    ok: false,
    code: 'ambiguous',
    error: `${describeTarget(target)} matches ${matches.length} elements; ${narrower}.`,
    candidates: matches.slice(0, 5).map(candidateOf),
  }
}

function resolveElementId(fd: FrameDocument, id: string): ResolveResult {
  for (const el of walk(fd.doc)) {
    if (el.attribs[ELEMENT_ID_ATTR] !== id) continue
    const match = toResolved(fd, el, new Map())
    return match ? { ok: true, matches: [match] } : noSource(id)
  }
  return notFound(describeTarget({ element_id: id }))
}

function resolveLabel(fd: FrameDocument, label: string): ResolveResult {
  const wanted = normalize(label)
  const exact: Element[] = []
  for (const el of walk(fd.doc)) {
    const value = el.attribs[LABEL_ATTR]
    if (value !== undefined && normalize(value) === wanted) exact.push(el)
  }
  const found = exact.length ? exact : headingCandidates(fd.doc, wanted, firstHeadingLabels(fd.doc))
  const index: PathIndex = new Map()
  const matches = found.map((el) => toResolved(fd, el, index)).filter((m): m is ResolvedTarget => m !== undefined)
  if (!matches.length) {
    return found.length ? noSource(describeTarget({ label })) : notFound(describeTarget({ label }))
  }
  if (matches.length > 1) return ambiguous({ label }, matches)
  return { ok: true, matches }
}

function resolveSelector(fd: FrameDocument, selector: string, all: boolean): ResolveResult {
  let elements: Element[]
  try {
    elements = selectAll<AnyNode, Element>(selector, fd.doc)
  } catch (err) {
    return {
      ok: false,
      code: 'bad_selector',
      error: `Invalid selector "${selector}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const index: PathIndex = new Map()
  const matches = elements
    .map((el) => toResolved(fd, el, index))
    .filter((m): m is ResolvedTarget => m !== undefined)
    .sort((a, b) => a.start - b.start)
  if (!matches.length) {
    return elements.length ? noSource(describeTarget({ selector })) : notFound(describeTarget({ selector }))
  }
  if (matches.length > 1 && !all) return ambiguous({ selector }, matches)
  return { ok: true, matches }
}

function notFound(described: string): ResolveResult {
  return {
    ok: false,
    code: 'not_found',
    error: `No element matches ${described}; call get_frame with mode: 'outline' to see the frame's sections.`,
  }
}

function noSource(described: string): ResolveResult {
  return {
    ok: false,
    code: 'no_source',
    error: `${described} resolves to an element with no source location (an implied element); target one of its children instead.`,
  }
}

export function resolveTarget(
  source: string | FrameDocument,
  target: SectionTarget,
  opts: { all?: boolean } = {},
): ResolveResult {
  const parsed = sectionTargetSchema.safeParse(target)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'bad_target',
      error: 'Target must be exactly one of { element_id }, { label } or { selector } (one key, a non-empty string).',
    }
  }
  const fd = typeof source === 'string' ? parseFrameDocument(source) : source
  const valid = parsed.data
  if ('element_id' in valid) return resolveElementId(fd, valid.element_id)
  if ('label' in valid) return resolveLabel(fd, valid.label)
  return resolveSelector(fd, valid.selector, opts.all === true)
}

export function instanceRefusal(match: ResolvedTarget, write: 'content' | 'structure'): string | undefined {
  if (match.insideInstance) {
    return `The target is inside a component instance; change the component with update_component (or the instance's props) instead.`
  }
  if (match.isInstance && write === 'content') {
    return `set_text/set_attr/set_style on an instance root are reverted by the component; use update_component, or replace/remove the whole instance.`
  }
  return undefined
}
