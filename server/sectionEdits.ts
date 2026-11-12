import { parse, parseFragment } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'
import { sourceEnd } from './sectionTargets.ts'
import type { SourceRange } from './sectionTargets.ts'

export interface EditableElement {
  tagName: string
  start: number
  end: number
  startTag: SourceRange
  endTag?: SourceRange
  inner: SourceRange
  attrs: Record<string, SourceRange & { value: string }>
}

export interface Edit {
  start: number
  end: number
  text: string
}

export type OpBody =
  | { op: 'set_text'; text: string }
  | { op: 'set_attr'; name: string; value: string }
  | { op: 'remove_attr'; name: string }
  | { op: 'set_style'; style: Record<string, string | null> }
  | { op: 'insert_before'; html: string }
  | { op: 'insert_after'; html: string }
  | { op: 'remove' }
  | { op: 'replace'; html: string }

export type EditResult = { ok: true; edits: Edit[] } | { ok: false; error: string }

export interface OutlineSection {
  elementId?: string
  tag: string
  label?: string
  /** the section's whole source span, start tag to end tag */
  bytes: number
  text: string
  path: string
}

export interface Outline {
  bytes: number
  container: string
  sections: OutlineSection[]
  truncated?: number
  styles: { bytes: number; marker?: string }[]
  scripts: number
}

export const PROTECTED_ATTRS: readonly string[] = ['data-doop-id', 'data-doop-instance', 'data-doop-component']

const FATAL_PARSE_ERRORS = new Set([
  'eof-in-tag',
  'eof-in-comment',
  'eof-before-tag-name',
  'end-tag-without-matching-open-element',
  'missing-end-tag-name',
  'incorrectly-opened-comment',
  'unexpected-question-mark-instead-of-tag-name',
  'cdata-in-html-content',
  'eof-in-cdata',
  'abrupt-closing-of-empty-comment',
  'incorrectly-closed-comment',
  'nested-comment',
])

const VOID_TAGS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const OPTIONAL_END_TAGS = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'option',
  'optgroup',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'colgroup',
  'caption',
  'rt',
  'rp',
])

const OUTLINE_IGNORED = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta'])
const DESCEND_STOP = new Set(['p', 'img', 'doop-use', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const TEXT_IGNORED = new Set(['script', 'style', 'template', 'noscript'])

const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/
const MAX_SECTIONS = 60

interface TreeLocation {
  startOffset: number
  endOffset: number
  startLine: number
  startCol: number
  startTag?: { startOffset: number; endOffset: number }
  endTag?: { startOffset: number; endOffset: number }
  attrs?: Record<string, TreeLocation>
}

interface TreeNode {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: TreeNode[]
  content?: TreeNode
  parentNode?: TreeNode | null
  sourceCodeLocation?: TreeLocation | null
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function tagOf(node: TreeNode): string {
  return (node.tagName ?? node.nodeName).toLowerCase()
}

function isElement(node: TreeNode): boolean {
  return typeof node.tagName === 'string'
}

function parseTree(html: string): TreeNode {
  return parse(html, { sourceCodeLocationInfo: true }) as unknown as TreeNode
}

function findBody(document: TreeNode): TreeNode | undefined {
  const html = (document.childNodes ?? []).find((node) => isElement(node) && tagOf(node) === 'html')
  if (!html) return undefined
  return (html.childNodes ?? []).find((node) => isElement(node) && tagOf(node) === 'body')
}

function elementChildren(node: TreeNode, ignored?: Set<string>): TreeNode[] {
  return (node.childNodes ?? []).filter((child) => isElement(child) && !(ignored && ignored.has(tagOf(child))))
}

function attrValue(node: TreeNode, name: string): string | undefined {
  return node.attrs?.find((attr) => attr.name.toLowerCase() === name)?.value
}

function pushChildren(stack: TreeNode[], node: TreeNode): void {
  const children = node.childNodes ?? []
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child) stack.push(child)
  }
  if (node.content?.childNodes) {
    for (let index = node.content.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.content.childNodes[index]
      if (child) stack.push(child)
    }
  }
}

function visibleText(node: TreeNode): string {
  const parts: string[] = []
  const stack: TreeNode[] = []
  pushChildren(stack, node)
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current)) {
      if (TEXT_IGNORED.has(tagOf(current))) continue
      pushChildren(stack, current)
    } else if (current.nodeName === '#text') {
      parts.push(current.value ?? '')
    }
  }
  return collapse(parts.join(' '))
}

function rawText(node: TreeNode): string {
  const parts: string[] = []
  const stack: TreeNode[] = []
  pushChildren(stack, node)
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current)) pushChildren(stack, current)
    else if (current.nodeName === '#text') parts.push(current.value ?? '')
  }
  return parts.join('')
}

function firstHeadingText(node: TreeNode): string | undefined {
  const stack: TreeNode[] = []
  pushChildren(stack, node)
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current) && /^h[1-6]$/.test(tagOf(current))) {
      const text = visibleText(current)
      if (text) return text
      continue
    }
    if (isElement(current)) pushChildren(stack, current)
  }
  return undefined
}

function pathOf(element: TreeNode): string {
  const segments: string[] = []
  let current: TreeNode | undefined = element
  while (current && current.nodeName !== '#document' && current.nodeName !== '#document-fragment') {
    if (!isElement(current)) break
    const tag = tagOf(current)
    const parent: TreeNode | undefined = current.parentNode ?? undefined
    let index = 0
    if (parent) {
      const siblings = elementChildren(parent)
      let sameTag = 0
      for (const sibling of siblings) {
        if (tagOf(sibling) === tag) sameTag += 1
        if (sibling === current) break
      }
      index = sameTag
    }
    segments.push(index > 1 ? `${tag}:nth-of-type(${index})` : tag)
    if (tag === 'body') break
    current = parent
  }
  return segments.reverse().join(' > ')
}

function styleEntries(document: TreeNode): { bytes: number; marker?: string }[] {
  const entries: { bytes: number; marker?: string }[] = []
  const stack: TreeNode[] = [document]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current) && tagOf(current) === 'style') {
      const marker = current.attrs?.find((attr) => attr.name.startsWith('data-doop-'))?.name
      entries.push(marker ? { bytes: rawText(current).length, marker } : { bytes: rawText(current).length })
      continue
    }
    pushChildren(stack, current)
  }
  return entries
}

function countTags(document: TreeNode, tag: string): number {
  let count = 0
  const stack: TreeNode[] = [document]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current) && tagOf(current) === tag) count += 1
    pushChildren(stack, current)
  }
  return count
}

export function mergeStyle(existing: string, patch: Record<string, string | null>): string {
  const order: string[] = []
  const names = new Map<string, string>()
  const values = new Map<string, string>()
  for (const declaration of splitDeclarations(existing)) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!values.has(key)) order.push(key)
    names.set(key, name)
    values.set(key, declaration.slice(colon + 1).trim())
  }
  for (const [rawName, rawValue] of Object.entries(patch)) {
    const name = rawName.trim()
    const key = name.toLowerCase()
    if (!key) continue
    if (rawValue === null) {
      values.delete(key)
      continue
    }
    if (!values.has(key)) order.push(key)
    names.set(key, name)
    values.set(key, rawValue.trim())
  }
  return order
    .filter((key) => values.has(key))
    .map((key) => `${names.get(key) ?? key}: ${values.get(key) ?? ''}`)
    .join('; ')
}

function splitDeclarations(style: string): string[] {
  const declarations: string[] = []
  let depth = 0
  let quote = ''
  let chunk = ''
  for (let index = 0; index < style.length; index += 1) {
    const char = style[index] ?? ''
    if (quote) {
      chunk += char
      if (char === '\\') {
        const next = style[index + 1]
        if (next !== undefined) {
          chunk += next
          index += 1
        }
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      chunk += char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ';' && depth === 0) {
      declarations.push(chunk)
      chunk = ''
      continue
    }
    chunk += char
  }
  if (chunk) declarations.push(chunk)
  return declarations
}

export function checkFragment(html: string, contextTag?: string): { ok: true } | { ok: false; error: string } {
  const errors: { code: string; line: number; col: number }[] = []
  const options = {
    sourceCodeLocationInfo: true,
    onParseError: (error: { code: string; startLine: number; startCol: number }) => {
      errors.push({ code: error.code, line: error.startLine, col: error.startCol })
    },
  }
  let fragment: TreeNode
  if (contextTag) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(contextTag)) {
      return { ok: false, error: `invalid context tag <${contextTag}>` }
    }
    const context = {
      nodeName: contextTag.toLowerCase(),
      tagName: contextTag.toLowerCase(),
      attrs: [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      childNodes: [],
      parentNode: null,
    }
    fragment = parseFragment(
      context as unknown as DefaultTreeAdapterTypes.Element,
      html,
      options,
    ) as unknown as TreeNode
  } else {
    fragment = parseFragment(html, options) as unknown as TreeNode
  }
  const fatal = errors.find((error) => FATAL_PARSE_ERRORS.has(error.code))
  if (fatal) return { ok: false, error: `${fatal.code} at line ${fatal.line}, column ${fatal.col}` }
  const stray = strayEndTag(html)
  if (stray) {
    const line = lineCol(html, stray.offset)
    if (!stray.tag) return { ok: false, error: `missing-end-tag-name at line ${line.line}, column ${line.col}` }
    return {
      ok: false,
      error: `end-tag-without-matching-open-element </${stray.tag}> at line ${line.line}, column ${line.col}`,
    }
  }
  const unclosed = findUnclosed(fragment)
  if (unclosed) {
    return {
      ok: false,
      error: `<${unclosed.tag}> at line ${unclosed.line}, column ${unclosed.col} has no closing tag`,
    }
  }
  return { ok: true }
}

function lineCol(html: string, offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (let index = 0; index < offset && index < html.length; index += 1) {
    if (html[index] === '\n') {
      line += 1
      col = 1
    } else {
      col += 1
    }
  }
  return { line, col }
}

function strayEndTag(html: string): { tag: string; offset: number } | undefined {
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()
  let index = 0
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open < 0) break
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4)
      index = close < 0 ? html.length : close + 3
      continue
    }
    let cursor = open + 1
    let quote = ''
    while (cursor < html.length) {
      const char = html[cursor] ?? ''
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
      cursor += 1
    }
    const raw = html.slice(open + 1, cursor)
    if (raw.startsWith('/')) {
      const match = /^\/\s*([a-zA-Z][^\s/>]*)/.exec(raw)
      if (!match?.[1]) {
        if (/^\/\s*$/.test(raw)) return { tag: '', offset: open }
      } else {
        const name = match[1].toLowerCase()
        const opened = starts.get(name) ?? 0
        const closed = ends.get(name) ?? 0
        if (opened <= closed) return { tag: name, offset: open }
        ends.set(name, closed + 1)
      }
    } else if (!raw.startsWith('!') && !raw.startsWith('?')) {
      const match = /^([a-zA-Z][^\s/>]*)/.exec(raw)
      if (match?.[1]) {
        const name = match[1].toLowerCase()
        starts.set(name, (starts.get(name) ?? 0) + 1)
      }
    }
    index = cursor + 1
  }
  return undefined
}

function findUnclosed(node: TreeNode): { tag: string; line: number; col: number } | undefined {
  const stack: TreeNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (isElement(current)) {
      const tag = tagOf(current)
      const location = current.sourceCodeLocation
      if (!VOID_TAGS.has(tag) && !OPTIONAL_END_TAGS.has(tag) && location && !location.endTag) {
        return { tag, line: location.startLine, col: location.startCol }
      }
    }
    pushChildren(stack, current)
  }
  return undefined
}

export function editsForOp(html: string, el: EditableElement, op: OpBody, parentTag?: string): EditResult {
  switch (op.op) {
    case 'set_text': {
      if (el.tagName.toLowerCase() === 'script' || el.tagName.toLowerCase() === 'style') {
        return {
          ok: false,
          error: `<${el.tagName}> holds raw CSS or JavaScript that escaping would corrupt; use replace_section`,
        }
      }
      if (VOID_TAGS.has(el.tagName.toLowerCase()) || !el.endTag) {
        return {
          ok: false,
          error: `<${el.tagName}> cannot hold text; target an inner element or use replace_section`,
        }
      }
      if (html.slice(el.inner.start, el.inner.end).includes('data-doop-id=')) {
        return {
          ok: false,
          error: `<${el.tagName}> contains anchored descendants; target the inner element or use replace_section`,
        }
      }
      return { ok: true, edits: [{ start: el.inner.start, end: el.inner.end, text: escapeText(op.text) }] }
    }
    case 'set_attr': {
      const name = op.name
      if (!ATTR_NAME.test(name)) return { ok: false, error: `invalid attribute name ${JSON.stringify(name)}` }
      if (PROTECTED_ATTRS.includes(name.toLowerCase())) {
        return { ok: false, error: `attribute ${name} is protected` }
      }
      return setAttr(html, el, name, op.value)
    }
    case 'remove_attr': {
      const name = op.name.toLowerCase()
      if (PROTECTED_ATTRS.includes(name)) return { ok: false, error: `attribute ${op.name} is protected` }
      const range = el.attrs[name]
      if (!range) return { ok: true, edits: [] }
      return { ok: true, edits: [{ start: spaceBefore(html, range.start), end: range.end, text: '' }] }
    }
    case 'set_style': {
      const merged = mergeStyle(el.attrs.style?.value ?? '', op.style)
      if (merged === '') {
        const range = el.attrs.style
        if (!range) return { ok: true, edits: [] }
        return { ok: true, edits: [{ start: spaceBefore(html, range.start), end: range.end, text: '' }] }
      }
      return setAttr(html, el, 'style', merged)
    }
    case 'insert_before': {
      const check = checkFragment(op.html, parentTag)
      if (!check.ok) return check
      return { ok: true, edits: [{ start: el.start, end: el.start, text: op.html }] }
    }
    case 'insert_after': {
      const check = checkFragment(op.html, parentTag)
      if (!check.ok) return check
      return { ok: true, edits: [{ start: el.end, end: el.end, text: op.html }] }
    }
    case 'remove':
      return { ok: true, edits: [{ start: el.start, end: el.end, text: '' }] }
    case 'replace': {
      const check = checkFragment(op.html, parentTag)
      if (!check.ok) return check
      return { ok: true, edits: [{ start: el.start, end: el.end, text: op.html }] }
    }
  }
}

function setAttr(html: string, el: EditableElement, name: string, value: string): EditResult {
  const escaped = escapeAttr(value)
  const existing = el.attrs[name.toLowerCase()]
  if (existing) {
    return { ok: true, edits: [{ start: existing.start, end: existing.end, text: `${name}="${escaped}"` }] }
  }
  let insertAt = el.startTag.start + 1 + el.tagName.length
  for (const range of Object.values(el.attrs)) {
    if (range.end > insertAt) insertAt = range.end
  }
  return { ok: true, edits: [{ start: insertAt, end: insertAt, text: ` ${name}="${escaped}"` }] }
}

function spaceBefore(html: string, start: number): number {
  let index = start
  while (index > 0 && /\s/.test(html[index - 1] ?? '')) index -= 1
  return index
}

export function applyEdits(html: string, edits: Edit[]): { ok: true; html: string } | { ok: false; error: string } {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => {
      if (left.edit.start !== right.edit.start) return left.edit.start - right.edit.start
      const leftInsert = left.edit.start === left.edit.end ? 0 : 1
      const rightInsert = right.edit.start === right.edit.end ? 0 : 1
      return leftInsert - rightInsert || left.index - right.index
    })
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]
    if (!entry) continue
    const { edit } = entry
    if (edit.start < 0 || edit.end > html.length || edit.start > edit.end) {
      return { ok: false, error: `edit ${index} is outside the document` }
    }
    const previous = ordered[index - 1]?.edit
    if (previous && edit.start < previous.end) {
      const boundaryInsert = edit.start === edit.end && edit.start === previous.end
      if (!boundaryInsert) return { ok: false, error: 'edits overlap' }
    }
  }
  let result = html
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index]?.edit
    if (!edit) continue
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return { ok: true, html: result }
}

export function frameOutline(html: string): Outline {
  const document = parseTree(html)
  const body = findBody(document)
  const styles = styleEntries(document)
  const scripts = countTags(document, 'script')
  if (!body) return { bytes: html.length, container: 'body', sections: [], styles, scripts }

  let container = body
  for (;;) {
    const children = elementChildren(container, OUTLINE_IGNORED)
    const only = children[0]
    if (children.length !== 1 || !only || DESCEND_STOP.has(tagOf(only))) break
    container = only
  }

  const allSections = elementChildren(container, OUTLINE_IGNORED)
  const sections: OutlineSection[] = allSections.slice(0, MAX_SECTIONS).map((section) => {
    const location = section.sourceCodeLocation
    const tag = tagOf(section)
    const label =
      cleanLabel(attrValue(section, 'data-doop-label')) ??
      cleanLabel(firstHeadingText(section)) ??
      cleanLabel(attrValue(section, 'aria-label')) ??
      (tag === 'doop-use' ? cleanLabel(attrValue(section, 'component')) : undefined)
    const elementId = attrValue(section, 'data-doop-id')
    const entry: OutlineSection = {
      tag,
      bytes: location ? sourceEnd(section) - location.startOffset : 0,
      text: visibleText(section).slice(0, 120),
      path: pathOf(section),
    }
    if (elementId) entry.elementId = elementId
    if (label) entry.label = label
    return entry
  })
  const outline: Outline = { bytes: html.length, container: pathOf(container), sections, styles, scripts }
  if (allSections.length > MAX_SECTIONS) outline.truncated = allSections.length - MAX_SECTIONS
  return outline
}

function cleanLabel(text: string | undefined): string | undefined {
  if (!text) return undefined
  const collapsed = collapse(text)
  if (!collapsed) return undefined
  return collapsed.slice(0, 80)
}
