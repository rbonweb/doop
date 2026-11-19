import { restoreFrameStyles } from './frameIsolation.ts'
import { nestedExclusion } from './componentCss.ts'
import { createHash } from 'node:crypto'
import { indexOfAscii } from '../shared/asciiSearch.ts'
import {
  defaultTreeAdapter,
  html as parse5Html,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes as Tree,
} from 'parse5'
import { parse, parseFragment } from './workBudget.ts'
import {
  ATTR_IF_ATTR,
  BIND_ATTR,
  COMPONENT_ATTR,
  CSS_ATTR,
  DETACHED_ATTR,
  DETACHED_CSS_ATTR,
  EACH_ATTR,
  IF_ATTR,
  HEAD_ATTR,
  INSTANCE_ATTR,
  ITEM_ATTR,
  MAX_INSTANCE_DEPTH,
  MAX_LIST_FIELDS,
  MAX_LIST_TEXT,
  MAX_NESTING_DEPTH,
  OVERRIDES_ATTR,
  PART_ATTR,
  PROPS_ATTR,
  REV_ATTR,
  SLOT_ATTR,
  SLOT_SUGGEST_ATTR,
  USE_TAG,
  conditionHolds,
  isDeleted,
  isHollow,
  isListFieldName,
  isPropName,
  attrsToRemove,
  listFieldsText,
  listJson,
  readList,
  parseAttrConditions,
  parseBindings,
  parseCondition,
  parseStyle,
  propValueProblem,
  serializeStyle,
  stableJson,
  toPropName,
  type ComponentDef,
  type ComponentIssue,
  type ComponentProp,
  type ComponentSlot,
  type InstanceOverrides,
  type ListField,
  type ListFieldType,
  type ListItem,
  type PartOverride,
  styleText,
  unsafeBindingTarget,
  unsafeUrl,
  URL_TARGETS,
  COMPONENT_REF,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR, isElementId, newElementId } from '../shared/elementId.ts'
import { describeRemoved, safeName, sanitizeRichText, shown } from './richText.ts'

/**
 * The component engine: pure string-and-tree work with no store behind it.
 * - render: a component's template plus an instance's state → full markup
 * - read: an instance's full markup → its state
 * - reconcile: markup somebody edited → the state that explains the edit, by
 *   diffing it against what the instance's own revision would have rendered,
 *   so a save from a client holding an older main is merged, not mistaken for
 *   overrides
 * - compact / expand: full markup ↔ `<doop-use>`
 */

type Element = Tree.Element
type ChildNode = Tree.ChildNode
type ParentNode = Tree.ParentNode

export type Revision = Pick<ComponentDef, 'id' | 'name' | 'template' | 'props' | 'rev'>

export interface EngineContext {
  /** a component by id or name */
  find(ref: string): ComponentDef | undefined
  /** a component as it was at a revision, when that revision is still kept */
  atRev(id: string, rev: number): Revision | undefined
  issues: ComponentIssue[]
}

export interface InstanceState {
  instanceId: string
  componentId: string
  rev: number
  overrides: InstanceOverrides
}

export const isElement = (node: ChildNode | ParentNode): node is Element => 'tagName' in node

export const attrOf = (el: Element, name: string): string | undefined =>
  el.attrs.find((attr) => attr.name === name)?.value

export function setAttr(el: Element, name: string, value: string | null) {
  const at = el.attrs.findIndex((attr) => attr.name === name)
  if (value === null) {
    if (at !== -1) el.attrs.splice(at, 1)
  } else if (at === -1) el.attrs.push({ name, value })
  else el.attrs[at]!.value = value
}

const elementKids = (node: ParentNode): Element[] => node.childNodes.filter(isElement)

function setText(el: Element, value: string) {
  el.childNodes = [{ nodeName: '#text', value, parentNode: el } as Tree.TextNode]
}

/** A bound text prop's value: the element's own text nodes only, so `<a><svg/>Label</a>` keeps its
 *  icon. The value takes the place of the first text node with something in it (else it is appended)
 *  and other text with something in it goes; spaces between children stay. With no element inside
 *  this is `setText`. */
function setOwnText(el: Element, value: string) {
  if (!el.childNodes.some(isElement)) return setText(el, value)
  const node = { nodeName: '#text', value, parentNode: el } as Tree.TextNode
  const hasText = (child: ChildNode) => child.nodeName === '#text' && (child as Tree.TextNode).value.trim() !== ''
  const at = el.childNodes.findIndex(hasText)
  const kept: ChildNode[] = []
  el.childNodes.forEach((child, index) => {
    if (index === at) kept.push(node)
    else if (!hasText(child)) kept.push(child)
  })
  if (at === -1) kept.push(node)
  el.childNodes = kept
}

/** HTML's boolean attributes: present means on, absent means off, and a value of "false" still means on. */
const BOOLEAN_ATTRS = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'formnovalidate',
  'hidden',
  'inert',
  'ismap',
  'itemscope',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
])

/** A boolean prop's state as an instance carries it: "false" is off, anything else on. */
const isOn = (value: string) => (value === 'false' ? 'false' : 'true')

const reflects = (prop: ComponentProp) => prop.type === 'enum' || (prop.type === 'boolean' && prop.reflect === true)

function directText(el: Element): string {
  return el.childNodes
    .map((child) => (child.nodeName === '#text' ? (child as Tree.TextNode).value : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function setChildrenFromHtml(el: Element, markup: string) {
  const fragment = fragmentIn(markup, el.tagName)
  el.childNodes = fragment.childNodes
  for (const child of el.childNodes) child.parentNode = el
}

export function parseTemplateRoot(template: string): Element | undefined {
  return elementKids(rootFragment(template))[0]
}

/* where a table part can stand: the HTML parser drops a <td> anywhere but in a row */
const TABLE_PARENT: Record<string, string> = {
  td: 'tr',
  th: 'tr',
  tr: 'tbody',
  tbody: 'table',
  thead: 'table',
  tfoot: 'table',
  caption: 'table',
  colgroup: 'table',
  col: 'colgroup',
}

const contextElements = new Map<string, Element>()

function contextElement(tag: string): Element {
  let el = contextElements.get(tag)
  if (!el) {
    el = defaultTreeAdapter.createElement(tag, parse5Html.NS.HTML, []) as Element
    contextElements.set(tag, el)
  }
  return el
}

/** Markup parsed as the content of a `parentTag`: a row's cells stay cells. */
export function fragmentIn(markup: string, parentTag: string | undefined) {
  const parent = parentTag?.toLowerCase()
  return parent && TABLE_CONTEXTS.has(parent) ? parseInContext(contextElement(parent), markup) : parseFragment(markup)
}

/* parse5's other form of parseFragment: the markup read as the content of `context` */
const parseInContext = parseFragment as unknown as (context: Element, markup: string) => Tree.DocumentFragment

const TABLE_CONTEXTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'colgroup'])

/** The first element's tag, past any leading whitespace and comments. */
function leadingTag(markup: string): string | undefined {
  return /^(?:\s|<!--[\s\S]*?-->)*<([a-z][\w-]*)/i.exec(markup)?.[1]?.toLowerCase()
}

/** Can this markup's root stand where `parentTag` holds it? A table part only in its own table
 *  context; anything else nowhere a table part must be (the parser moves it out of a row). */
export function fitsIn(markup: string, parentTag: string): boolean {
  const tag = leadingTag(markup)
  const parent = parentTag.toLowerCase()
  if (tag && TABLE_PARENT[tag]) return ALLOWED_PARENTS[tag]?.has(parent) ?? false
  return !TABLE_CONTEXTS.has(parent)
}

/* every parent a table part may stand in: a row in any section of a table, or straight in one */
const ALLOWED_PARENTS: Record<string, Set<string>> = {
  td: new Set(['tr']),
  th: new Set(['tr']),
  tr: new Set(['tbody', 'thead', 'tfoot', 'table']),
  tbody: new Set(['table']),
  thead: new Set(['table']),
  tfoot: new Set(['table']),
  caption: new Set(['table']),
  colgroup: new Set(['table']),
  col: new Set(['colgroup', 'table']),
}

/** Is `tag` an element whose children the parser keeps to table parts? */
export function isTableContext(tag: string): boolean {
  return TABLE_CONTEXTS.has(tag.toLowerCase())
}

/** Is this markup's root a table part (a cell, a row, a section of a table)? */
export function isTablePart(markup: string): boolean {
  const tag = leadingTag(markup)
  return !!tag && !!TABLE_PARENT[tag]
}

/** One element's markup parsed where it can stand: a table part inside what holds it. */
export function rootFragment(markup: string) {
  const tag = leadingTag(markup)
  return fragmentIn(markup, tag ? TABLE_PARENT[tag] : undefined)
}

/** What a table part needs around it to be a page's markup at all, for a main of its own. */
export function tableScaffold(markup: string): (inner: string) => string {
  const tag = leadingTag(markup)
  const chain: string[] = []
  for (let parent = tag && TABLE_PARENT[tag]; parent; parent = TABLE_PARENT[parent]) chain.unshift(parent)
  if (!tag || !TABLE_PARENT[tag]) return (inner) => inner
  if (chain[0] !== 'table') chain.unshift('table')
  return (inner) =>
    chain.map((t) => `<${t}>`).join('') +
    inner +
    [...chain]
      .reverse()
      .map((t) => `</${t}>`)
      .join('')
}

const JSON_OBJECT = (value: string | undefined): Record<string, unknown> => {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') record[key] = entry
  return record
}

/** Part overrides from untrusted JSON: a part that is not an object (`null`, written to mean
 *  "remove it") is no override at all, rather than something to trip over later. */
function asPartRecord(value: Record<string, unknown>): Record<string, PartOverride> {
  const record: Record<string, PartOverride> = {}
  for (const [key, entry] of Object.entries(value))
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const part = entry as PartOverride
      /* a swap is a component id: anything else in the marker is no swap */
      if (part.swap !== undefined && (typeof part.swap !== 'string' || !part.swap)) {
        const { swap: _swap, ...rest } = part
        record[key] = rest
      } else record[key] = part
    }
  return record
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

interface RenderOptions {
  ctx: EngineContext
  /** template ids on the way down: a component inside itself renders nothing below that point.
   *  Slot and override content start a stack of their own: that is instance data, not template. */
  stack: string[]
  /** instances on the way down, whatever put them there: the one bound slot content has */
  depth?: number
  /** diff base: nested instances stay stubs and slots stay empty, each read from the DOM on its own */
  shallow?: boolean
  /** the instance being rendered: what a nested instance's id is derived from */
  ownerId?: string
  /** a whole write: nothing more is coming, so an unclosed <doop-use> in slot or override content is placed too */
  final?: boolean
}

/** A nested instance has no place of its own to keep an id: the template owns its markup, and the
 *  short form leaves it out. So the id follows from where it sits, and every render agrees on it. */
function nestedInstanceId(ownerId: string | undefined, partKey: string | undefined): string {
  if (!ownerId || !partKey) return ''
  const digest = createHash('sha256').update(`${ownerId}:${partKey}`).digest()
  return Array.from(digest.subarray(0, 6), (byte) => ELEMENT_ID_CHARS[byte % ELEMENT_ID_CHARS.length]).join('')
}

const ELEMENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function propValue(def: Revision, overrides: InstanceOverrides, name: string): string | undefined {
  return overrides.props?.[name] ?? def.props.find((prop) => prop.name === name)?.default
}

const isRichProp = (def: Pick<Revision, 'props'>, name: string) =>
  def.props.find((prop) => prop.name === name)?.type === 'richtext'

/** A rich-text prop's value in its one safe form. The issue says what was removed, never the value itself. */
export function cleanRichValue(def: Pick<Revision, 'name'>, prop: string, value: string, ctx: EngineContext): string {
  const { html, removed } = sanitizeRichText(value)
  if (removed.length)
    ctx.issues.push({
      code: 'richtext_sanitized',
      message: `${def.name}: ${prop} is rich text, a safe subset of inline markup (b, i, strong, em, br, a with an https address, span with a class); removed from it: ${describeRemoved(removed)}`,
    })
  return html
}

/** The props with every rich-text and list value in its one safe form: the same object when nothing changed. A list value
 *  that cannot be read is dropped (the prop's default shows) and reported. */
export function cleanPropValues(
  def: Pick<Revision, 'name' | 'props' | 'template'>,
  props: Record<string, string> | undefined,
  ctx: EngineContext,
): Record<string, string> | undefined {
  if (!props || !def.props.some((prop) => prop.type === 'richtext' || prop.type === 'list')) return props
  let next: Record<string, string> | undefined
  for (const [name, value] of Object.entries(props)) {
    const prop = def.props.find((candidate) => candidate.name === name)
    if (prop?.type === 'richtext') {
      const clean = cleanRichValue(def, name, value, ctx)
      if (clean !== value) (next ??= { ...props })[name] = clean
    } else if (prop?.type === 'list' && value !== '') {
      const clean = cleanListValue(def, prop, value, ctx)
      if (clean === undefined) {
        next ??= { ...props }
        delete next[name]
      } else if (clean !== value) (next ??= { ...props })[name] = clean
    }
  }
  return next ?? props
}

/** A list prop's value in its one stored form (key-sorted JSON of declared fields only), or `undefined` with an issue when
 *  it cannot be read. Fields the list does not declare are dropped and reported. The issue never quotes the value. */
export function cleanListValue(
  def: Pick<Revision, 'name' | 'template'>,
  prop: ComponentProp,
  value: string,
  ctx: EngineContext,
): string | undefined {
  const read = readList(prop, value)
  if (read.problem || !read.items) {
    ctx.issues.push({
      code: 'invalid_prop_value',
      message: `${def.name}: ${prop.name} was not set — ${read.problem ?? 'it is not a list'}`,
    })
    return undefined
  }
  const unsafe = read.items.some((item) =>
    Object.entries(item).some(
      ([field, value]) =>
        typeof value === 'string' && unsafeStyleValue(value) && styleBound(def.template, field, prop.name),
    ),
  )
  if (unsafe) {
    ctx.issues.push({
      code: 'invalid_prop_value',
      message: `${def.name}: ${prop.name} was not set — a field is bound to a style, and ${STYLE_VALUE_RULE}`,
    })
    return undefined
  }
  if (read.dropped.length)
    ctx.issues.push({
      code: 'list_field_dropped',
      message: `${def.name}: ${prop.name} gave ${read.dropped.length} value${read.dropped.length === 1 ? '' : 's'} the list has no field for, dropped (${read.dropped.slice(0, 5).join(', ')}${read.dropped.length > 5 ? `, and ${read.dropped.length - 5} more` : ''}); its fields are ${listFieldsText(prop.fields)}`,
    })
  return listJson(read.items)
}

/** A value bound to a style property or custom property is one value: a `;` or a brace would add declarations, and a
 *  function that loads makes the viewer's browser fetch an address the value chose. */
/** A binding target that writes CSS: one property (`style.color`), a custom property (`--x`) or the whole `style` attribute. */
const isStyleTarget = (target: string) => target === 'style' || target.startsWith('style.') || target.startsWith('--')

export const unsafeStyleValue = (value: string) =>
  /[;{}\\]|\/\*|\b(?:url|image-set|-webkit-image-set|src|image)\s*\(/i.test(value)

/** The wording shared by a refusal at write time and the render's own guard. */
export const STYLE_VALUE_RULE =
  'a style value takes one value, with no ; { } \\ /* or loading function (url, image-set, src, image)'

/** Is this prop (or, with `list`, a field of that list) bound to a style property or custom property somewhere in the template? */
export function styleBound(template: string, name: string, list?: string): boolean {
  for (const info of partsOf(template).values()) {
    if ((info.inEach ?? undefined) !== list) continue
    if ([...info.styleProps.values()].includes(name) || info.attrProps.get('style') === name) return true
  }
  return false
}

function applyBindings(el: Element, def: Revision, overrides: InstanceOverrides, ctx: EngineContext) {
  const raw = attrOf(el, BIND_ATTR)
  if (raw === undefined) return
  setAttr(el, BIND_ATTR, null)
  for (const { target, prop } of parseBindings(raw, el.tagName)) {
    if (target !== null && BOOLEAN_ATTRS.has(target) && def.props.find((p) => p.name === prop)?.type === 'boolean') {
      /* present when on, gone when off: the value string of a boolean attribute means nothing */
      const on = propValue(def, overrides, prop)
      if (on !== undefined) setAttr(el, target, on === 'false' ? null : '')
      continue
    }
    const scoped = itemScopes.get(overrides)
    /* inside a list item a field the item leaves out is empty, not the template's sample */
    const value = overrides.props?.[prop] ?? (scoped?.has(prop) ? '' : undefined)
    if (value === undefined) continue
    /* a bound value is instance data: it never becomes an event handler, and an address it sets cannot run code */
    if (target !== null && el.tagName !== USE_TAG && unsafeBindingTarget(target, el.tagName)) {
      ctx.issues.push({
        code: 'ignored_attribute',
        message: `${prop} is bound to ${target}, which a component never sets (event handlers, srcdoc and an animation's attributeName stay out of instances)`,
      })
      continue
    }
    if (scoped?.has(prop) && value === '' && target !== null) {
      /* an empty field leaves no address, title or the like behind; a style or custom property keeps the template's */
      if (!isStyleTarget(target)) setAttr(el, target, null)
      continue
    }
    if (target !== null && isStyleTarget(target) && unsafeStyleValue(value)) {
      ctx.issues.push({
        code: 'invalid_prop_value',
        message: `${prop} was not set as ${target}: ${STYLE_VALUE_RULE}`,
      })
      continue
    }
    if (target !== null && URL_TARGETS.has(target.toLowerCase()) && unsafeUrl(value)) {
      ctx.issues.push({
        code: 'invalid_prop_value',
        message: `"${shown(value, 60)}" was not set as ${target}: a javascript:, vbscript: or data:text/html address is refused`,
      })
      continue
    }
    if (target === null && el.tagName !== USE_TAG && isRichProp(def, prop)) {
      /* rich text replaces the element's children, and only ever with the sanitised subset */
      setChildrenFromHtml(el, sanitizeRichText(value).html)
    } else if (target === null) setOwnText(el, value)
    else if (target.startsWith('style.') || target.startsWith('--')) {
      const styles = parseStyle(attrOf(el, 'style'))
      styles.set(target.startsWith('--') ? target : target.slice('style.'.length), value)
      setAttr(el, 'style', serializeStyle(styles))
    } else setAttr(el, target, value)
  }
}

/** `data-doop-attr-if`: drop the template's literal attributes whose conditions do not hold for this instance's props, then the marker itself. */
function applyAttrConditions(el: Element, def: Revision, overrides: InstanceOverrides) {
  const raw = attrOf(el, ATTR_IF_ATTR)
  if (raw === undefined) return
  setAttr(el, ATTR_IF_ATTR, null)
  const gone = new Set(attrsToRemove(raw, (prop) => propValue(def, overrides, prop)).map((name) => name.toLowerCase()))
  /* the editor's own bookkeeping is never conditional (the sanitizer refuses such entries too) */
  for (const name of gone) if (name.startsWith('data-doop-')) gone.delete(name)
  if (gone.size) el.attrs = el.attrs.filter((attr) => !gone.has(attr.name.toLowerCase()))
}

/** The attributes a part's template conditions on its props: what an instance's markup shows for them follows the props, so a read-back never takes them as edits. */
function conditionedAttrs(el: Element | undefined): Set<string> {
  const raw = el ? attrOf(el, ATTR_IF_ATTR) : undefined
  return new Set(raw === undefined ? [] : parseAttrConditions(raw).map((entry) => entry.attr.toLowerCase()))
}

const TAG_NAME = /^[a-z][a-z0-9-]*$/

function applyPartOverride(el: Element, part: PartOverride) {
  if (part.tag && TAG_NAME.test(part.tag)) {
    el.tagName = part.tag
    el.nodeName = part.tag
  }
  for (const [name, value] of Object.entries(part.attrs ?? {})) setAttr(el, name, value)
  if (part.style && Object.keys(part.style).length) {
    const styles = parseStyle(attrOf(el, 'style'))
    for (const [name, value] of Object.entries(part.style)) {
      if (value === null) styles.delete(name)
      else styles.set(name, value)
    }
    setAttr(el, 'style', styles.size ? serializeStyle(styles) : null)
  }
  if (part.text !== undefined) setText(el, part.text)
}

/* ------------------------------------------------------------------ */
/* List props: data-doop-each                                          */
/* ------------------------------------------------------------------ */

const listPropOf = (def: Pick<Revision, 'props'>, name: string): ComponentProp | undefined => {
  const prop = def.props.find((candidate) => candidate.name === name)
  return prop?.type === 'list' && prop.fields && Object.keys(prop.fields).length ? prop : undefined
}

/** The scopes an item is rendered in, with the field names each one answers for: inside one an empty field is
 *  empty, and a nested list is an ordinary element. */
const itemScopes = new WeakMap<InstanceOverrides, ReadonlySet<string>>()

/** The one item a main's own content stands for: what its bound elements hold, so a fresh instance shows the sample. */
function sampleItem(el: Element, prop: ComponentProp): ListItem {
  const fields = prop.fields ?? {}
  const item: ListItem = {}
  const stack: Element[] = [el]
  const order: Element[] = []
  for (let node = stack.pop(); node; node = stack.pop()) {
    order.push(node)
    if (node.tagName !== USE_TAG) stack.push(...elementKids(node).reverse())
  }
  for (const node of order) {
    for (const { target, prop: name } of parseBindings(attrOf(node, BIND_ATTR) ?? '', node.tagName)) {
      const field = Object.hasOwn(fields, name) ? fields[name] : undefined
      if (!field || field.type === 'boolean' || Object.hasOwn(item, name)) continue
      if (target !== null && isStyleTarget(target)) continue
      const value = target === null ? directText(node) : attrOf(node, target)
      if (!value || (field.type !== 'text' && unsafeUrl(value))) continue
      item[name] = value
    }
    const condition = node === el ? undefined : parseCondition(attrOf(node, IF_ATTR) ?? '')
    if (condition?.equals === undefined && condition && fields[condition.prop]?.type === 'boolean')
      if (!Object.hasOwn(item, condition.prop)) item[condition.prop] = !condition.negate
  }
  return item
}

/** The items an instance shows: its own, else the prop's declared default, else the one item the main's content is. */
function listItemsOf(prop: ComponentProp, overrides: InstanceOverrides, el: Element): ListItem[] {
  /* an empty value is no value: the default, as for any prop */
  const source = overrides.props?.[prop.name] || prop.default
  return source !== undefined ? (readList(prop, source).items ?? []) : [sampleItem(el, prop)]
}

/** What an item's elements read: the component's props, with each field the item answers for in front of the prop of that name. */
function itemScope(
  def: Revision,
  prop: ComponentProp,
  overrides: InstanceOverrides,
  item: ListItem,
): { def: Revision; overrides: InstanceOverrides } {
  const fields = prop.fields ?? {}
  const names = new Set(Object.keys(fields))
  const props: Record<string, string> = {}
  for (const [name, value] of Object.entries(overrides.props ?? {})) if (!names.has(name)) props[name] = value
  for (const name of names) {
    const value = Object.hasOwn(item, name) ? item[name] : undefined
    if (value !== undefined) props[name] = typeof value === 'boolean' ? String(value) : value
  }
  const scoped: InstanceOverrides = { props }
  itemScopes.set(scoped, names)
  const fieldProps: ComponentProp[] = Object.entries(fields).map(([name, field]) => ({ name, type: field.type }))
  return {
    def: { ...def, props: [...fieldProps, ...def.props.filter((candidate) => !names.has(candidate.name))] },
    overrides: scoped,
  }
}

const COPY_KEY = /^(.*)-(\d+)$/

/** Every element of a copy keyed `<key>-<index>`, so an item's parts never collide with another's or with the template's. */
function keyCopy(root: Element, index: number) {
  const stack: Element[] = [root]
  for (let node = stack.pop(); node; node = stack.pop()) {
    const key = attrOf(node, PART_ATTR)
    if (key) setAttr(node, PART_ATTR, `${key}-${index}`)
    stack.push(...elementKids(node))
  }
}

/** The element once per item, in order, each marked `data-doop-item`. */
function renderEachCopies(
  el: Element,
  parent: ParentNode,
  prop: ComponentProp,
  items: readonly ListItem[],
  def: Revision,
  overrides: InstanceOverrides,
  options: RenderOptions,
): Element[] {
  const markup = serializeOuter(el)
  const copies: Element[] = []
  for (const [index, item] of items.entries()) {
    const copy = elementKids(rootFragment(markup))[0]
    if (!copy) continue
    keyCopy(copy, index)
    setAttr(copy, EACH_ATTR, null)
    setAttr(copy, ITEM_ATTR, String(index))
    const scope = itemScope(def, prop, overrides, item)
    renderPart(copy, scope.def, scope.overrides, undefined, options)
    copy.parentNode = parent
    copies.push(copy)
  }
  return copies
}

function renderEach(
  el: Element,
  parent: ParentNode,
  prop: ComponentProp,
  def: Revision,
  overrides: InstanceOverrides,
  options: RenderOptions,
): Element[] {
  return renderEachCopies(el, parent, prop, listItemsOf(prop, overrides, el), def, overrides, options)
}

function renderNode(el: Element, def: Revision, overrides: InstanceOverrides, options: RenderOptions) {
  const kept: ChildNode[] = []
  for (const child of el.childNodes) {
    if (!isElement(child)) {
      kept.push(child)
      continue
    }
    const key = attrOf(child, PART_ATTR)
    const part = key ? overrides.parts?.[key] : undefined
    const condition = attrOf(child, IF_ATTR)
    if (condition !== undefined) {
      const parsed = parseCondition(condition)
      if (parsed && !conditionHolds(parsed, propValue(def, overrides, parsed.prop))) continue
      setAttr(child, IF_ATTR, null)
    }
    const list = child.tagName === USE_TAG ? undefined : listPropOf(def, (attrOf(child, EACH_ATTR) ?? '').trim())
    if (list && !itemScopes.has(overrides)) {
      kept.push(...renderEach(child, el, list, def, overrides, options))
      continue
    }
    /* named no list prop, or inside an item (a list is not nested): an ordinary element */
    if (attrOf(child, EACH_ATTR) !== undefined && child.tagName !== USE_TAG) setAttr(child, EACH_ATTR, null)
    if (part?.hidden) continue
    if (child.tagName === USE_TAG) {
      if (options.shallow) {
        kept.push(child)
        continue
      }
      const rendered = renderUseElement(child, part, options, key, { def, overrides })
      if (rendered) {
        rendered.parentNode = el
        kept.push(rendered)
      }
      continue
    }
    renderPart(child, def, overrides, part, options)
    kept.push(child)
  }
  el.childNodes = kept
}

function renderPart(
  el: Element,
  def: Revision,
  overrides: InstanceOverrides,
  part: PartOverride | undefined,
  options: RenderOptions,
) {
  applyBindings(el, def, overrides, options.ctx)
  applyAttrConditions(el, def, overrides)
  setAttr(el, SLOT_SUGGEST_ATTR, null)
  if (part) applyPartOverride(el, part)
  const isSlot = attrOf(el, SLOT_ATTR) !== undefined
  const content = (html: string) => expandUses(html, options.ctx, [], options.depth, { final: options.final })
  if (part?.html !== undefined) {
    setChildrenFromHtml(el, options.shallow ? part.html : content(part.html))
    return
  }
  if (isSlot) {
    if (options.shallow) el.childNodes = []
    else if (part?.slot !== undefined) setChildrenFromHtml(el, content(part.slot))
    else renderNode(el, def, overrides, options)
    return
  }
  if (part?.text !== undefined) return
  renderNode(el, def, overrides, options)
}

/** The outer instance a nested `<doop-use>` sits in: what its forwarded props are read from. */
interface Outer {
  def: Revision
  overrides: InstanceOverrides
}

function renderUseElement(
  use: Element,
  part: PartOverride | undefined,
  options: RenderOptions,
  outerKey: string | undefined,
  outer?: Outer,
): Element | undefined {
  const { ctx } = options
  const forward = outer ? forwardingOf(use, outer.def, outer.overrides.props, ctx, true) : undefined
  const literalRef = attrOf(use, 'component') ?? ''
  /* the instance's own swap, then the outer prop's pick, then what the template wrote */
  const swap = typeof part?.swap === 'string' ? swapTarget(part.swap, outer?.def, ctx) : undefined
  const ref = swap?.id ?? forward?.component ?? literalRef
  const nested = ctx.find(ref)
  if (!nested) {
    ctx.issues.push({ code: 'unknown_component', message: `no component “${ref}” on this canvas` })
    return undefined
  }
  /* a use that forwards nothing renders exactly as it always has: the nested instance's own state, else the literal */
  const literalNested = ctx.find(literalRef)
  const swapped = literalNested?.id !== nested.id
  const own = swap && part?.use ? fittingState(part.use, nested) : part?.use
  const state = forward?.bindings.length
    ? forwardedState(use, nested, own, forward, options, swapped)
    : (own ?? literalState(use, nested, ctx, swapped))
  const id = attrOf(use, ELEMENT_ID_ATTR) ?? nestedInstanceId(options.ownerId, outerKey)
  const rendered = renderInstance(nested, nested, state, id, options)
  if (rendered && outerKey) setAttr(rendered, PART_ATTR, outerKey)
  return rendered
}

/** The nested use's attributes read against `nested`, which an instance's swap may have made another
 *  component than the one they were written for: then only what it has carries over, and quietly. */
function literalState(use: Element, nested: ComponentDef, ctx: EngineContext, swapped: boolean): InstanceOverrides {
  if (!swapped) return stateFromUseAttrs(use, nested, ctx, true).overrides
  return fittingState(stateFromUseAttrs(use, nested, silent(ctx), true).overrides, nested)
}

/** The component an instance's swap names, when it can stand in: one that is gone, or that would put
 *  the outer component inside itself, is reported and the template's own component renders instead. */
function swapTarget(ref: string, outer: Revision | undefined, ctx: EngineContext): ComponentDef | undefined {
  const target = ctx.find(ref)
  if (!target) {
    ctx.issues.push({
      code: 'unknown_component',
      message: `the swap names no component “${ref}” on this canvas, so the nested component the template names renders`,
    })
    return undefined
  }
  if (outer && nestsComponent(ctx, target.id, outer.id)) {
    ctx.issues.push({
      code: 'nesting_cycle',
      message: `component “${outer.name}” cannot contain itself: swapping in “${target.name}” would, so that swap was ignored`,
    })
    return undefined
  }
  return target
}

/** What a nested `<doop-use>` takes from the component that holds it. `bindings` are the live ones
 *  (the outer prop exists), whether or not the outer instance has a value for it yet. */
interface Forward {
  bindings: { target: string; outer: string }[]
  /** nested prop → the outer prop it takes and the value the outer instance has for it */
  props: Map<string, { outer: string; value: string }>
  /** the component the outer instance picked for the nested one, when it picked one */
  component?: string
}

/** Read a nested `<doop-use>`'s `data-doop-prop="inner:outer"` bindings against the outer component.
 *  The outer value is the instance's own, else the prop's declared default; with neither, nothing is
 *  forwarded and the nested instance keeps what the template wrote. `report` says what does not bind. */
function forwardingOf(
  use: Element,
  outer: Revision,
  outerProps: Record<string, string> | undefined,
  ctx: EngineContext,
  report: boolean,
): Forward {
  const forward: Forward = { bindings: [], props: new Map() }
  const raw = attrOf(use, BIND_ATTR)
  if (raw === undefined) return forward
  const name = attrOf(use, 'component') ?? ''
  const skip = (why: string) => {
    if (report)
      ctx.issues.push({
        code: 'ignored_attribute',
        message: `${BIND_ATTR}="${raw}" on <${USE_TAG} component="${name}"> forwards nothing for one binding: ${why}. ${FORWARD_GRAMMAR}`,
      })
  }
  for (const { target, prop } of parseBindings(raw, use.tagName)) {
    if (target === null) {
      skip(`“${prop}” names no prop of “${outer.name}”’s nested component; write inner:outer, as label:${prop}`)
      continue
    }
    const outerProp = outer.props.find((candidate) => candidate.name === prop)
    if (!outerProp) {
      skip(`“${outer.name}” has no prop “${safeName(prop)}”, so there is nothing to forward`)
      continue
    }
    if (target === 'component' && outerProp.type !== 'instance') {
      skip(`“${prop}” must be an instance prop to pick the component`)
      continue
    }
    forward.bindings.push({ target, outer: prop })
    const value = propValue(outer, { props: outerProps }, prop)
    if (value === undefined) continue
    if (target === 'component') {
      const problem = propValueProblem(outerProp, value, ctx.find)
      if (problem) {
        if (report)
          ctx.issues.push({
            code: 'invalid_prop_value',
            message: `${outer.name}: "${shown(value)}" is not a value of ${prop} — ${problem}`,
          })
        continue
      }
      if (nestsComponent(ctx, value, outer.id)) {
        if (report)
          ctx.issues.push({
            code: 'invalid_prop_value',
            message: `${outer.name}: "${shown(value)}" would put “${outer.name}” inside itself, so ${prop} was ignored and the component written in the template renders`,
          })
        continue
      }
      forward.component = value
    } else forward.props.set(target, { outer: prop, value })
  }
  return forward
}

/** The component a nested `<doop-use>` shows before any swap: the one the outer instance forwards, else the one the template names. */
export function effectiveComponent(
  use: Element,
  outer: Revision,
  outerProps: Record<string, string> | undefined,
  ctx: EngineContext,
): ComponentDef | undefined {
  const forward = forwardingOf(use, outer, outerProps, silent(ctx), false)
  return ctx.find(forward.component ?? attrOf(use, 'component') ?? '')
}

/** Does this component, or one it is built from, hold the component `targetId`? */
export function nestsComponent(ctx: EngineContext, ref: string, targetId: string): boolean {
  const seen = new Set<string>()
  const stack = [ref]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const def = ctx.find(next)
    if (!def || seen.has(def.id)) continue
    if (def.id === targetId) return true
    seen.add(def.id)
    for (const match of def.template.matchAll(COMPONENT_REF)) stack.push(match[1]!)
  }
  return false
}

const FORWARD_GRAMMAR =
  'Forward with data-doop-prop="inner:outer" (label:cta passes this component’s prop cta to the nested prop label; component:icon lets an instance prop icon pick the nested component).'

/** A forwarding use's nested state: the template's literal attributes, then the values forwarded from
 *  the outer instance, then what the outer instance overrode on that nested part itself. */
function forwardedState(
  use: Element,
  nested: ComponentDef,
  own: InstanceOverrides | undefined,
  forward: Forward,
  options: RenderOptions,
  swapped: boolean,
): InstanceOverrides {
  const { ctx } = options
  /* attributes written for the literal component may not fit the one picked: quiet then, or when `own` stands in */
  const quiet = swapped || own !== undefined
  const literal = stateFromUseAttrs(use, nested, quiet ? silent(ctx) : ctx, true).overrides
  const props: Record<string, string> = { ...literal.props }
  for (const [target, { value }] of forward.props) {
    const prop = nested.props.find((candidate) => candidate.name === target)
    if (!prop) {
      /* a swapped-in component need not have every prop the literal one had */
      if (!swapped)
        ctx.issues.push({
          code: 'ignored_attribute',
          message: `${BIND_ATTR} on <${USE_TAG} component="${nested.name}"> forwards to “${safeName(target)}”, which “${nested.name}” does not have (it has ${nested.props.map((p) => p.name).join(', ') || 'no props'})`,
        })
      continue
    }
    const problem = propValueProblem(prop, value, ctx.find)
    if (problem) {
      ctx.issues.push({
        code: 'invalid_prop_value',
        message: `${nested.name}: "${shown(value)}" is not a value of ${target} — ${problem}`,
      })
      continue
    }
    props[target] = value
  }
  const usable = own && forward.component !== undefined ? fittingState(own, nested) : own
  Object.assign(props, usable?.props)
  return clean({ props, parts: usable?.parts ?? literal.parts })
}

/** State read from one component, handed to another the outer instance swapped in: only what that one has. */
export function fittingState(own: InstanceOverrides, nested: ComponentDef): InstanceOverrides {
  const names = new Set(nested.props.map((prop) => prop.name))
  const keys = new Set(partsOf(nested.template).keys())
  return clean({
    props: Object.fromEntries(Object.entries(own.props ?? {}).filter(([name]) => names.has(name))),
    parts: Object.fromEntries(Object.entries(own.parts ?? {}).filter(([key]) => keys.has(key))),
  })
}

/** The same lookups with the issues thrown away: a literal read only to know what it would say. */
const silent = (ctx: EngineContext): EngineContext => ({ find: ctx.find, atRev: ctx.atRev, issues: [] })

function markRoot(root: Element, def: Revision, instanceId: string, overrides: InstanceOverrides) {
  setAttr(root, INSTANCE_ATTR, def.id)
  setAttr(root, REV_ATTR, String(def.rev))
  setAttr(root, ELEMENT_ID_ATTR, instanceId)
  for (const prop of def.props) {
    if (!reflects(prop)) continue
    const value = propValue(def, overrides, prop.name)
    if (value !== undefined) setAttr(root, `data-${prop.name}`, prop.type === 'boolean' ? isOn(value) : value)
  }
  const props = overrides.props ?? {}
  setAttr(root, PROPS_ATTR, Object.keys(props).length ? stableJson(props) : null)
  const persisted = persistedParts(overrides.parts)
  setAttr(root, OVERRIDES_ATTR, Object.keys(persisted).length ? stableJson(persisted) : null)
}

/** Slot content and nested state live in the DOM below the instance; repeating them in the marker would double it. */
function persistedParts(parts: InstanceOverrides['parts']): Record<string, PartOverride> {
  const kept: Record<string, PartOverride> = {}
  for (const [key, part] of Object.entries(parts ?? {})) {
    const { slot: _slot, use: _use, ...rest } = part
    if (Object.keys(rest).length) kept[key] = rest
  }
  return kept
}

/** `def` is the component whose props and id mark the root; `revision` supplies the markup. */
export function renderInstance(
  def: Pick<ComponentDef, 'id'> & Partial<ComponentDef>,
  revision: Revision,
  overrides: InstanceOverrides,
  instanceId: string,
  options: RenderOptions,
): Element | undefined {
  if (options.stack.includes(revision.id) || options.stack.length >= MAX_NESTING_DEPTH) {
    options.ctx.issues.push({
      code: 'nesting_cycle',
      message: `component “${revision.name}” cannot contain itself; that nested copy was skipped`,
    })
    return undefined
  }
  const depth = options.depth ?? 0
  if (depth >= MAX_INSTANCE_DEPTH) {
    options.ctx.issues.push({
      code: 'too_deep',
      message: `instances are nested more than ${MAX_INSTANCE_DEPTH} deep; the copy of “${revision.name}” below that was skipped`,
    })
    return undefined
  }
  const root = parseTemplateRoot(revision.template)
  if (!root) {
    options.ctx.issues.push({
      code: 'empty_template',
      message: `component “${revision.name}” has no markup in its main, so its instance rendered nothing. Give it markup with update_component html.`,
    })
    return undefined
  }
  /* the root is the component itself: it cannot repeat */
  if (attrOf(root, EACH_ATTR) !== undefined) setAttr(root, EACH_ATTR, null)
  const cleanProps = cleanPropValues(revision, overrides.props, options.ctx)
  if (cleanProps !== overrides.props) overrides = { ...overrides, props: cleanProps }
  const id = instanceId || newElementId()
  const inner: RenderOptions = { ...options, stack: [...options.stack, revision.id], depth: depth + 1, ownerId: id }
  const key = attrOf(root, PART_ATTR)
  renderPart(root, revision, overrides, key ? overrides.parts?.[key] : undefined, inner)
  markRoot(root, revision, id, overrides)
  return root
}

export function renderInstanceHtml(
  def: ComponentDef,
  state: Omit<InstanceState, 'rev' | 'componentId'>,
  ctx: EngineContext,
) {
  const root = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack: [] })
  return root ? serializeOuter(root) : ''
}

/* ------------------------------------------------------------------ */
/* Reading state back from markup                                      */
/* ------------------------------------------------------------------ */

function readMarker(el: Element): InstanceState | undefined {
  const componentId = attrOf(el, INSTANCE_ATTR)
  if (!componentId) return undefined
  const props = asStringRecord(JSON_OBJECT(attrOf(el, PROPS_ATTR)))
  const parts = asPartRecord(JSON_OBJECT(attrOf(el, OVERRIDES_ATTR)))
  const id = attrOf(el, ELEMENT_ID_ATTR)
  return {
    instanceId: isElementId(id) ? id : newElementId(),
    componentId,
    rev: Number(attrOf(el, REV_ATTR)) || 0,
    overrides: clean({ props, parts }),
  }
}

function clean(overrides: InstanceOverrides): InstanceOverrides {
  const out: InstanceOverrides = {}
  if (overrides.props && Object.keys(overrides.props).length) out.props = overrides.props
  if (overrides.parts && Object.keys(overrides.parts).length) out.parts = overrides.parts
  return out
}

/** The compact markup of a node list: instances collapse to `<doop-use>`, the rest serializes as it stands. */
function compactChildren(el: ParentNode, ctx: EngineContext): string {
  const clone = fragmentIn(serialize(el), isElement(el) ? el.tagName : undefined)
  compactInTree(clone, ctx)
  return serialize(clone)
}

function compactInTree(node: ParentNode, ctx: EngineContext, inTemplate = false) {
  node.childNodes = node.childNodes.map((child) => {
    if (!isElement(child)) return child
    if (attrOf(child, INSTANCE_ATTR)) return useElementFor(child, ctx, node, inTemplate)
    compactInTree(child, ctx, inTemplate)
    return child
  })
}

/* stored markup (a template, a slot, an html override) names components by id, so a rename cannot break it */
function useElementFor(
  el: Element,
  ctx: EngineContext,
  parent: ParentNode,
  inTemplate: boolean,
  reconcile = false,
): ChildNode {
  const html = useTagFor(el, ctx, inTemplate, true, reconcile)
  const use = elementKids(parseFragment(html))[0]
  if (!use) return el
  use.parentNode = parent
  return use
}

/** A template's element keys, with the bindings each one carries. */
export interface PartInfo {
  el: Element
  textProp?: string
  attrProps: Map<string, string>
  styleProps: Map<string, string>
  isSlot: boolean
  isUse: boolean
  /** a `data-doop-each` element that is not inside another: the list prop it repeats for */
  each?: string
  /** this part is, or is inside, the template of one list item: its bindings name the item's fields, not the component's props */
  inEach?: string
}

export function partsOf(template: string): Map<string, PartInfo> {
  const parts = new Map<string, PartInfo>()
  const root = parseTemplateRoot(template)
  if (!root) return parts
  const stack: [Element, string | undefined][] = [[root, undefined]]
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [el, within] = entry
    const own = el !== root && el.tagName !== USE_TAG ? attrOf(el, EACH_ATTR)?.trim() : undefined
    const inEach = within ?? own
    const key = attrOf(el, PART_ATTR)
    if (key) {
      const info: PartInfo = {
        el,
        attrProps: new Map(),
        styleProps: new Map(),
        isSlot: attrOf(el, SLOT_ATTR) !== undefined,
        isUse: el.tagName === USE_TAG,
        ...(within === undefined && own ? { each: own } : {}),
        ...(inEach ? { inEach } : {}),
      }
      for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '', el.tagName)) {
        if (target === null) info.textProp = prop
        else if (target.startsWith('style.')) info.styleProps.set(target.slice('style.'.length), prop)
        else if (target.startsWith('--')) info.styleProps.set(target, prop)
        else info.attrProps.set(target, prop)
      }
      parts.set(key, info)
    }
    stack.push(...elementKids(el).map((kid): [Element, string | undefined] => [kid, inEach]))
  }
  return parts
}

/** Read an instance's whole state from its markup: the marker's props and overrides,
 *  plus slot content and nested instances found in place. Nothing is diffed here. */
export function readInstance(el: Element, def: Revision | undefined, ctx: EngineContext): InstanceState | undefined {
  const state = readMarker(el)
  if (!state) return undefined
  if (!def) return state
  const parts = partsOf(def.template)
  const merged: Record<string, PartOverride> = { ...state.overrides.parts }
  /* by the template's key: a nested root wears the outer component's on it */
  const rootKey = attrOf(parseTemplateRoot(def.template) ?? el, PART_ATTR)
  if (rootKey && parts.get(rootKey)?.isSlot) {
    merged[rootKey] = { ...merged[rootKey], slot: compactChildren(el, ctx) }
    return { ...state, overrides: clean({ ...state.overrides, parts: merged }) }
  }
  const stack = elementKids(el)
  for (let child = stack.pop(); child; child = stack.pop()) {
    const key = attrOf(child, PART_ATTR)
    const info = key ? parts.get(key) : undefined
    if (key && info?.isUse && attrOf(child, INSTANCE_ATTR)) {
      const nestedDef = ctx.atRev(attrOf(child, INSTANCE_ATTR)!, Number(attrOf(child, REV_ATTR)) || 0)
      const nested = readInstance(child, nestedDef, ctx)
      if (nested) {
        const use = withoutForwarded(nested.overrides, info.el, def, state.overrides.props, nestedDef, ctx)
        /* a forwarding use merges its own state over the literal, so nothing left to say is not a state */
        if (use === nested.overrides || Object.keys(use).length) merged[key] = { ...merged[key], use }
      }
      continue
    }
    if (attrOf(child, INSTANCE_ATTR)) continue
    if (key && info?.isSlot) {
      merged[key] = { ...merged[key], slot: compactChildren(child, ctx) }
      continue
    }
    stack.push(...elementKids(child))
  }
  return { ...state, overrides: clean({ ...state.overrides, parts: merged }) }
}

/** A nested instance's state without what the outer instance hands it: its marker holds the
 *  forwarded values it was rendered with (that is what keeps its own diff honest), but they are
 *  the outer instance's to give, not overrides of the nested part. A value the template's literal
 *  already says is no override either, so a prop forwarded later still reaches it. */
function withoutForwarded(
  overrides: InstanceOverrides,
  use: Element,
  outer: Revision,
  outerProps: Record<string, string> | undefined,
  nested: Revision | undefined,
  ctx: EngineContext,
): InstanceOverrides {
  const forward = forwardingOf(use, outer, outerProps, ctx, false)
  if (!forward.bindings.length || !nested) return overrides
  const literal = stateFromUseAttrs(use, nested, silent(ctx), true).overrides
  const props = { ...overrides.props }
  for (const [name, value] of Object.entries(props))
    if (value === literal.props?.[name] || value === forward.props.get(name)?.value) delete props[name]
  const sameParts = stableJson(overrides.parts ?? {}) === stableJson(literal.parts ?? {})
  return clean({ props, parts: sameParts ? undefined : overrides.parts })
}

/* ------------------------------------------------------------------ */
/* Reconcile: what did this edit change?                               */
/* ------------------------------------------------------------------ */

/** What a template's nested `<doop-use>` says beyond which component it is: forwarded props and a
 *  condition. In a main the instance element stands for the use, so it carries them until the
 *  template is read back from it. */
export const CARRIED_ATTRS = [BIND_ATTR, IF_ATTR]

const INTERNAL_ATTRS = new Set([INSTANCE_ATTR, REV_ATTR, PROPS_ATTR, OVERRIDES_ATTR, PART_ATTR])

const isTracked = (name: string) => !INTERNAL_ATTRS.has(name) && !name.startsWith('data-v-')

function diffStyle(
  base: Element,
  incoming: Element,
  info: PartInfo | undefined,
  state: InstanceOverrides,
  into: PartOverride,
) {
  const before = parseStyle(attrOf(base, 'style'))
  const after = parseStyle(attrOf(incoming, 'style'))
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const value = after.get(name)
    if (before.get(name) === value) continue
    const prop = info?.styleProps.get(name)
    if (prop && value !== undefined) (state.props ??= {})[prop] = value
    else (into.style ??= {})[name] = value ?? null
  }
}

function diffAttrs(
  base: Element,
  incoming: Element,
  info: PartInfo | undefined,
  def: Revision,
  isRoot: boolean,
  state: InstanceOverrides,
  into: PartOverride,
) {
  const names = new Set([...base.attrs, ...incoming.attrs].map((attr) => attr.name))
  const conditioned = conditionedAttrs(info?.el)
  for (const name of names) {
    if (!isTracked(name) || name === 'style' || conditioned.has(name.toLowerCase())) continue
    if (isRoot && name === ELEMENT_ID_ATTR) continue
    const before = attrOf(base, name)
    const after = attrOf(incoming, name)
    if (before === after) continue
    const boundName = info?.attrProps.get(name)
    if (boundName && BOOLEAN_ATTRS.has(name) && def.props.find((prop) => prop.name === boundName)?.type === 'boolean') {
      /* a removed attribute is off, a present one on, except the old `disabled="false"` */
      ;(state.props ??= {})[boundName] = after === undefined ? 'false' : isOn(after)
      continue
    }
    const reflected =
      isRoot && name.startsWith('data-')
        ? def.props.find((prop) => reflects(prop) && `data-${prop.name}` === name)
        : undefined
    if (reflected && after !== undefined)
      (state.props ??= {})[reflected.name] = reflected.type === 'boolean' ? isOn(after) : after
    else if (info?.attrProps.has(name) && after !== undefined) (state.props ??= {})[info.attrProps.get(name)!] = after
    else (into.attrs ??= {})[name] = after ?? null
  }
}

function canonicalInner(el: Element): string {
  const clone = fragmentIn(serialize(el), el.tagName)
  const strip = (node: ParentNode) => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue
      setAttr(child, PART_ATTR, null)
      strip(child)
    }
  }
  strip(clone)
  return serialize(clone).replace(/\s+/g, ' ').trim()
}

function diffPart(
  base: Element,
  incoming: Element,
  key: string,
  parts: Map<string, PartInfo>,
  def: Revision,
  isRoot: boolean,
  state: InstanceOverrides,
  ctx: EngineContext,
  origin: Record<string, string> | undefined,
) {
  const info = parts.get(key)
  const into: PartOverride = {}
  /* the same part as another element: a <button> made an <a> stays an <a> */
  if (base.tagName !== incoming.tagName && TAG_NAME.test(incoming.tagName)) into.tag = incoming.tagName
  diffAttrs(base, incoming, info, def, isRoot, state, into)
  diffStyle(base, incoming, info, state, into)

  const existing = state.parts?.[key]
  if (info?.isSlot && existing?.html === undefined) {
    /* the slot's own attributes were diffed above; its content is the instance's */
    const inner = compactChildren(incoming, ctx)
    const defaultInner = compactChildren(info.el, ctx)
    const same = inner.replace(/\s+/g, ' ') === defaultInner.replace(/\s+/g, ' ')
    mergeInto(state, key, into, { slot: same ? undefined : inner })
    return
  }
  if (existing?.html !== undefined) {
    if (canonicalInner(base) !== canonicalInner(incoming)) into.html = compactChildren(incoming, ctx)
    mergeInto(state, key, into)
    return
  }

  const richProp = info?.textProp && isRichProp(def, info.textProp) ? info.textProp : undefined
  if (richProp) {
    /* a rich-text element's content is its prop's value: an edit becomes the sanitised markup, never a part override */
    if (canonicalInner(base) !== canonicalInner(incoming)) {
      const edited = serialize(incoming)
      const problem = propValueProblem({ name: richProp, type: 'richtext' }, edited)
      if (problem)
        ctx.issues.push({
          code: 'invalid_prop_value',
          message: `${def.name}: ${richProp} was not changed — ${problem}`,
        })
      else (state.props ??= {})[richProp] = cleanRichValue(def, richProp, edited, ctx)
    }
    mergeInto(state, key, into)
    return
  }
  const baseKids = elementKids(base)
  const incomingKids = elementKids(incoming)
  if (baseKids.length === 0 && incomingKids.length === 0) {
    const before = directText(base)
    const after = directText(incoming)
    if (before !== after) {
      if (info?.textProp) (state.props ??= {})[info.textProp] = after
      else into.text = after
    }
    mergeInto(state, key, into)
    return
  }

  const baseKeys = baseKids.map((kid) => attrOf(kid, PART_ATTR))
  const incomingKeys = incomingKids.map((kid) => attrOf(kid, PART_ATTR))
  const baseSet = new Set(baseKeys)
  const keysKnown = incomingKeys.every((kidKey) => kidKey && baseSet.has(kidKey))
  let order = 0
  const inOrder = incomingKeys.every((kidKey) => {
    const at = baseKeys.indexOf(kidKey, order)
    if (at === -1) return false
    order = at + 1
    return true
  })
  /* the text a prop fills, edited beside children that stayed: the prop takes it, not an html override */
  const textEdited = directText(base) !== directText(incoming)
  const textProp = textEdited && keysKnown && inOrder ? info?.textProp : undefined
  if (!keysKnown || !inOrder || (textEdited && !textProp)) {
    /* moved, added or rewritten children: keep exactly what they made,
       for this element alone. The instance stays linked everywhere else. */
    into.html = compactChildren(incoming, ctx)
    mergeInto(state, key, into)
    return
  }
  if (textProp) (state.props ??= {})[textProp] = directText(incoming)
  mergeInto(state, key, into)
  for (const baseKid of baseKids) {
    const kidKey = attrOf(baseKid, PART_ATTR)
    if (!kidKey) continue
    const match = incomingKids.find((kid) => attrOf(kid, PART_ATTR) === kidKey)
    if (!match) {
      mergeInto(state, kidKey, { hidden: true })
      continue
    }
    if (baseKid.tagName === USE_TAG) {
      diffNested(match, kidKey, parts, state, ctx, def, origin)
      continue
    }
    diffPart(baseKid, match, kidKey, parts, def, false, state, ctx, origin)
  }
}

function diffNested(
  incoming: Element,
  key: string,
  parts: Map<string, PartInfo>,
  state: InstanceOverrides,
  ctx: EngineContext,
  outer: Revision,
  origin: Record<string, string> | undefined,
) {
  const reconciled = reconcileInstance(incoming, ctx)
  const use = parts.get(key)?.el
  if (!reconciled || !use) return
  const nested = ctx.find(reconciled.componentId)
  const forward = forwardingOf(use, outer, origin, ctx, false)
  /* the component the template (and what the outer instance forwards) would put here: another one is a swap */
  const expected = ctx.find(forward.component ?? attrOf(use, 'component') ?? '')
  const swap = nested && expected && nested.id !== expected.id ? nested.id : undefined
  if (forward.bindings.length) {
    diffForwarding(incoming, key, use, nested, reconciled, forward, state, ctx)
  } else {
    const swapped = !!nested && ctx.find(attrOf(use, 'component') ?? '')?.id !== nested.id
    const defaults = nested ? literalState(use, nested, ctx, swapped) : {}
    const same = stableJson(defaults) === stableJson(reconciled.overrides)
    mergeInto(state, key, {}, { use: same ? undefined : reconciled.overrides })
  }
  mergeInto(state, key, {}, { swap })
}

/** A nested instance that takes props from the one holding it. What it shows of a forwarded value is
 *  the outer instance's, so a person retyping the nested label sets the outer prop (`cta`) and no
 *  override is kept; a value the nested instance already overrode on its own stays its override. */
function diffForwarding(
  incoming: Element,
  key: string,
  use: Element,
  nested: ComponentDef | undefined,
  reconciled: InstanceState,
  forward: Forward,
  state: InstanceOverrides,
  ctx: EngineContext,
) {
  const swapped = !!nested && ctx.find(attrOf(use, 'component') ?? '')?.id !== nested.id
  const literal = nested ? stateFromUseAttrs(use, nested, swapped ? silent(ctx) : ctx, true).overrides : {}
  const marker = readMarker(incoming)?.overrides.props ?? {}
  const props = { ...reconciled.overrides.props }
  for (const { target, outer } of forward.bindings) {
    const value = props[target]
    if (value === undefined) continue
    const given = forward.props.get(target)?.value
    const before = marker[target]
    if (value !== before && (before === undefined || before === given || before === literal.props?.[target])) {
      /* an edit of what the outer instance gave: it is the outer prop's new value */
      ;(state.props ??= {})[outer] = value
      delete props[target]
    } else if (value === given) delete props[target]
  }
  /* what the literal says is not an override either */
  for (const [name, value] of Object.entries(props)) if (literal.props?.[name] === value) delete props[name]
  const parts = reconciled.overrides.parts
  const same = !Object.keys(props).length && stableJson(literal.parts ?? {}) === stableJson(parts ?? {})
  mergeInto(state, key, {}, { use: same ? undefined : clean({ props, parts }) })
}

function mergeInto(
  state: InstanceOverrides,
  key: string,
  part: PartOverride,
  extra: { slot?: string | undefined; use?: InstanceOverrides | undefined; swap?: string | undefined } = {},
) {
  const parts = (state.parts ??= {})
  const merged: PartOverride = { ...parts[key] }
  if (part.attrs) merged.attrs = { ...merged.attrs, ...part.attrs }
  if (part.style) merged.style = { ...merged.style, ...part.style }
  if (part.tag !== undefined) merged.tag = part.tag
  if (part.text !== undefined) merged.text = part.text
  if (part.html !== undefined) {
    merged.html = part.html
    delete merged.text
  }
  if (part.hidden !== undefined) merged.hidden = part.hidden
  if ('slot' in extra) {
    if (extra.slot === undefined) delete merged.slot
    else merged.slot = extra.slot
  }
  if ('use' in extra) {
    if (extra.use === undefined) delete merged.use
    else merged.use = extra.use
  }
  if ('swap' in extra) {
    if (extra.swap === undefined) delete merged.swap
    else merged.swap = extra.swap
  }
  if (Object.keys(merged).length) parts[key] = merged
  else delete parts[key]
}

/** An override set back to the template's own value is no override at all. */
function pruneOverrides(
  overrides: InstanceOverrides,
  parts: Map<string, PartInfo>,
  def: Revision,
  ctx: EngineContext,
): InstanceOverrides {
  const out: InstanceOverrides = {}
  const props: Record<string, string> = {}
  for (const [name, value] of Object.entries(overrides.props ?? {})) {
    const prop = def.props.find((candidate) => candidate.name === name)
    if (prop?.default !== undefined && prop.default === value) continue
    if (
      prop &&
      (prop.type === 'text' ||
        prop.type === 'image' ||
        prop.type === 'link' ||
        prop.type === 'number' ||
        prop.type === 'color' ||
        prop.type === 'richtext' ||
        prop.type === 'list')
    ) {
      if (templateValueOf(name, parts, prop) === value) continue
    }
    props[name] = value
  }
  if (Object.keys(props).length) out.props = props
  const kept: Record<string, PartOverride> = {}
  for (const [key, part] of Object.entries(overrides.parts ?? {})) {
    const info = parts.get(key)
    const next: PartOverride = { ...part }
    if (info) {
      if (next.attrs) {
        const attrs = Object.entries(next.attrs).filter(([name, value]) => (attrOf(info.el, name) ?? null) !== value)
        if (attrs.length) next.attrs = Object.fromEntries(attrs)
        else delete next.attrs
      }
      if (next.style) {
        const template = parseStyle(attrOf(info.el, 'style'))
        const styles = Object.entries(next.style).filter(([name, value]) => (template.get(name) ?? null) !== value)
        if (styles.length) next.style = Object.fromEntries(styles)
        else delete next.style
      }
      if (next.text !== undefined && next.text === directText(info.el)) delete next.text
      if (next.tag !== undefined && next.tag === info.el.tagName) delete next.tag
      if (next.hidden === false) delete next.hidden
      /* a swap to the component the template already names is no swap */
      if (next.swap !== undefined && ctx.find(next.swap)?.id === effectiveComponent(info.el, def, props, ctx)?.id)
        delete next.swap
    }
    if (Object.keys(next).length) kept[key] = next
  }
  if (Object.keys(kept).length) out.parts = kept
  return out
}

function templateValueOf(prop: string, parts: Map<string, PartInfo>, declared?: ComponentProp): string | undefined {
  if (declared?.type === 'list') {
    const info = [...parts.values()].find((candidate) => candidate.each === prop)
    return info ? listJson([sampleItem(info.el, declared)]) : undefined
  }
  for (const info of parts.values()) {
    /* an item's bindings name its fields, which a component prop of the same name is not */
    if (info.inEach) continue
    if (info.textProp === prop)
      return declared?.type === 'richtext' ? sanitizeRichText(serialize(info.el)).html : directText(info.el)
    for (const [target, name] of info.attrProps) if (name === prop) return attrOf(info.el, target)
    for (const [target, name] of info.styleProps)
      if (name === prop) return parseStyle(attrOf(info.el, 'style')).get(target)
  }
  return undefined
}

/** The state that explains this instance's markup: its marker, plus whatever
 *  was edited relative to what its own revision would have rendered. When that
 *  revision is gone there is nothing to diff against and the marker stands. */
export function reconcileInstance(el: Element, ctx: EngineContext, inMain = false): InstanceState | undefined {
  if (inMain) {
    /* a main's nested instance wears the template's own data-doop-prop / data-doop-if (see CARRIED_ATTRS):
       they are not the instance's attributes, so they are not read as edits of it */
    const carried = el.attrs.filter((attr) => CARRIED_ATTRS.includes(attr.name))
    if (carried.length) {
      el.attrs = el.attrs.filter((attr) => !CARRIED_ATTRS.includes(attr.name))
      try {
        return reconcileInstance(el, ctx)
      } finally {
        el.attrs.push(...carried)
      }
    }
  }
  const marker = readMarker(el)
  if (!marker) return undefined
  const revision = ctx.atRev(marker.componentId, marker.rev)
  const current = ctx.find(marker.componentId)
  const known = revision ?? current
  if (!known) return marker
  const read = readInstance(el, known, ctx) ?? marker
  if (!revision) return read
  const parts = partsOf(revision.template)
  /* the base holds the marker's overrides; slots and nested instances are read from the DOM */
  const base = renderInstance(revision, revision, marker.overrides, marker.instanceId, {
    ctx,
    stack: [],
    shallow: true,
  })
  if (!base) return read
  const state: InstanceOverrides = {
    ...(read.overrides.props ? { props: { ...read.overrides.props } } : {}),
    ...(read.overrides.parts ? { parts: { ...read.overrides.parts } } : {}),
  }
  const rootKey = attrOf(base, PART_ATTR)
  /* the items of a list are read back into its prop, and their copies stay out of the diff: nothing else in one is kept */
  const restore = readLists(base, el, parts, revision, marker, state, ctx)
  try {
    /* a nested root carries the outer component's key on it */
    if (rootKey || attrOf(parseTemplateRoot(revision.template)!, PART_ATTR)) {
      const key = attrOf(parseTemplateRoot(revision.template)!, PART_ATTR) ?? rootKey!
      setAttr(base, PART_ATTR, key)
      diffPart(base, el, key, parts, revision, true, state, ctx, marker.overrides.props)
    }
  } finally {
    restore()
  }
  return { ...read, overrides: pruneOverrides(state, parts, revision, ctx) }
}

/* ------------------------------------------------------------------ */
/* Reconcile: list items                                               */
/* ------------------------------------------------------------------ */

/** The elements below `root` (not through a nested instance) that are copies of one of these list templates, in document order. */
function copiesOf(root: Element, keys: ReadonlySet<string>, parts: ReadonlyMap<string, PartInfo>): Element[] {
  const found: Element[] = []
  const walk = (node: Element) => {
    for (const kid of elementKids(node)) {
      const key = attrOf(kid, PART_ATTR)
      /* `<template key>-<index>`; a key the template itself has (an authored `x-1` beside `x`) is that element, not a copy */
      const template = key === undefined || parts.has(key) ? undefined : COPY_KEY.exec(key)?.[1]
      if (template !== undefined && keys.has(template)) found.push(kid)
      else if (!attrOf(kid, INSTANCE_ATTR)) walk(kid)
    }
  }
  walk(root)
  return found
}

/** Take the copies out of the tree, and give back what puts them where they were. */
function withoutNodes(root: Element, gone: ReadonlySet<Element>): () => void {
  const changed: [Element, ChildNode[]][] = []
  const walk = (node: Element) => {
    if (node.childNodes.some((kid) => isElement(kid) && gone.has(kid))) {
      changed.push([node, node.childNodes])
      node.childNodes = node.childNodes.filter((kid) => !(isElement(kid) && gone.has(kid)))
    }
    for (const kid of elementKids(node)) if (!attrOf(kid, INSTANCE_ATTR)) walk(kid)
  }
  walk(root)
  return () => {
    for (const [node, kids] of changed) node.childNodes = kids
  }
}

/** A copy as only its content shows: no bookkeeping attributes, text trimmed and collapsed, a nested instance as a stub. */
function copyShape(copy: Element): string {
  const clone = rootFragment(serializeOuter(copy))
  const walk = (node: ParentNode) => {
    node.childNodes = node.childNodes.flatMap((child): ChildNode[] => {
      if (child.nodeName === '#text') {
        const text = (child as Tree.TextNode).value.replace(/\s+/g, ' ').trim()
        return text ? [{ ...(child as Tree.TextNode), value: text }] : []
      }
      if (!isElement(child)) return []
      if (child.tagName === USE_TAG || attrOf(child, INSTANCE_ATTR))
        return [defaultTreeAdapter.createElement('x-nested', parse5Html.NS.HTML, [])]
      child.attrs = child.attrs
        .filter((attr) => !attr.name.startsWith('data-doop-'))
        .sort((a, b) => a.name.localeCompare(b.name))
      walk(child)
      return [child]
    })
  }
  walk(clone)
  return serialize(clone)
}

/** What one copy's bound elements say about its item: each field's value, for the fields whose element is still there. */
function readCopy(
  copy: Element,
  prop: ComponentProp,
  parts: Map<string, PartInfo>,
  ctx: EngineContext,
  def: Pick<Revision, 'name'>,
): Map<string, string> {
  const fields = prop.fields ?? {}
  const byKey = new Map<string, Element>()
  const stack: Element[] = [copy]
  for (let node = stack.pop(); node; node = stack.pop()) {
    const key = attrOf(node, PART_ATTR)
    if (key !== undefined) {
      const template = COPY_KEY.exec(key)?.[1] ?? key
      if (!byKey.has(template)) byKey.set(template, node)
    }
    if (!attrOf(node, INSTANCE_ATTR)) stack.push(...elementKids(node).reverse())
  }
  const values = new Map<string, string>()
  const take = (name: string, value: string | undefined) => {
    const field = Object.hasOwn(fields, name) ? fields[name] : undefined
    if (value === undefined || !field || field.type === 'boolean' || values.has(name)) return
    if (value.length > MAX_LIST_TEXT || (field.type !== 'text' && unsafeUrl(value))) {
      ctx.issues.push({
        code: 'invalid_prop_value',
        message: `${def.name}: the edit to ${name} in a ${prop.name} item was not kept — ${propValueProblem({ name, type: field.type }, value) ?? 'it is too long'}`,
      })
      return
    }
    values.set(name, value)
  }
  for (const [key, info] of parts) {
    if (info.inEach !== prop.name) continue
    const el = byKey.get(key)
    if (!el) continue
    if (info.textProp) take(info.textProp, directText(el))
    for (const [target, name] of info.attrProps) take(name, attrOf(el, target))
  }
  return values
}

/** Read an edited instance's list items back into their props, and take their copies out of the diff.
 *  The edits that count are the ones a field says: text, an address, an image. Copies removed by hand remove
 *  their items, one duplicated (or written without an index) adds an item, and anything else is reported
 *  and left to the template. Returns what puts the copies back. */
function readLists(
  base: Element,
  incoming: Element,
  parts: Map<string, PartInfo>,
  def: Revision,
  marker: InstanceState,
  state: InstanceOverrides,
  ctx: EngineContext,
): () => void {
  const lists = [...parts].flatMap(([key, info]) => {
    const prop = info.each ? listPropOf(def, info.each) : undefined
    return prop ? [{ key, info, prop }] : []
  })
  if (!lists.length) return () => {}
  const keys = new Set(lists.map((list) => list.key))
  const copies = copiesOf(incoming, keys, parts)
  const baseCopies = copiesOf(base, keys, parts)
  const gone = new Set(copies)
  for (const { key, info, prop } of lists) {
    const mine = copies.filter((copy) => COPY_KEY.exec(attrOf(copy, PART_ATTR) ?? '')?.[1] === key)
    const current = listItemsOf(prop, marker.overrides, info.el)
    /* its items were never rendered (a false condition on it or around it, a hidden part): there is nothing to read back */
    if (current.length && !baseCopies.some((copy) => COPY_KEY.exec(attrOf(copy, PART_ATTR) ?? '')?.[1] === key))
      continue
    const next: ListItem[] = []
    for (const copy of mine) {
      /* the place in the list is the key's suffix: it follows the copy when it is moved, and a duplicate shares it */
      const at = Number(COPY_KEY.exec(attrOf(copy, PART_ATTR) ?? '')?.[2])
      const known = Number.isInteger(at) && at >= 0 && at < current.length
      /* a copy duplicated by hand carries the same index: it starts from that item and adds one */
      const item: ListItem = known ? { ...current[at] } : {}
      for (const [name, value] of readCopy(copy, prop, parts, ctx, def)) {
        const before = item[name]
        /* what the page shows is the text with its spaces collapsed: that is no edit of the stored text */
        if (before === value || (typeof before === 'string' && before.replace(/\s+/g, ' ').trim() === value)) continue
        if (value === '' && before === undefined) continue
        if (value === '') delete item[name]
        else item[name] = value
      }
      next.push(item)
    }
    const read = readList(prop, next)
    if (read.problem || !read.items) {
      ctx.issues.push({
        code: 'invalid_prop_value',
        message: `${def.name}: the edit to ${prop.name} was not kept — ${read.problem ?? 'it is not a list'}`,
      })
      continue
    }
    const items = read.items
    if (listJson(items) !== listJson(current)) (state.props ??= {})[prop.name] = listJson(items)
    /* what the copies show beyond their fields is the template's: say so when an edit was dropped */
    const options: RenderOptions = { ctx: silent(ctx), stack: [], shallow: true, ownerId: marker.instanceId }
    const parent: ParentNode = (info.el.parentNode as ParentNode | null) ?? base
    const reference = renderEachCopies(info.el, parent, prop, items, def, marker.overrides, options)
    const dropped = mine.filter(
      (copy, index) => !reference[index] || copyShape(copy) !== copyShape(reference[index]!),
    ).length
    if (dropped)
      ctx.issues.push({
        code: 'list_item_edit_dropped',
        message: `${def.name}: ${dropped} item${dropped === 1 ? '' : 's'} of ${prop.name} had edits that are not one of its fields (${listFieldsText(prop.fields)}), which a list does not keep: change the component's template, or edit the field values`,
      })
  }
  const undoBase = withoutNodes(base, new Set(baseCopies))
  const undoIncoming = withoutNodes(incoming, gone)
  return () => {
    undoIncoming()
    undoBase()
  }
}

/* ------------------------------------------------------------------ */
/* Compact form                                                        */
/* ------------------------------------------------------------------ */

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function attrText(name: string, value: string): string {
  return ` ${name}="${escapeAttr(value)}"`
}

/** The `<doop-use>` tag for an instance element, children and all. `reconcile` reads the state
 *  an edit to the markup implies, not only what the marker says: what a main's template needs,
 *  so a change inside a nested instance of the main lands in the same write. */
export function useTagFor(
  el: Element,
  ctx: EngineContext,
  inTemplate = false,
  byId = false,
  reconcile = false,
  withId = false,
): string {
  const marker = readMarker(el)
  if (!marker) return serializeOuter(el)
  const def = ctx.find(marker.componentId)
  const revision = ctx.atRev(marker.componentId, marker.rev) ?? def
  const state =
    (reconcile ? reconcileInstance(el, ctx, inTemplate) : undefined) ?? readInstance(el, revision, ctx) ?? marker
  const ref = byId ? marker.componentId : (def?.name ?? marker.componentId)
  const carried = inTemplate
    ? CARRIED_ATTRS.flatMap((name) => (attrOf(el, name) === undefined ? [] : [[name, attrOf(el, name)!] as const]))
    : []
  return useMarkup(ref, state, revision, inTemplate ? attrOf(el, PART_ATTR) : undefined, withId, carried)
}

export function useMarkup(
  name: string,
  state: InstanceState,
  def: Revision | undefined,
  part: string | undefined,
  /** with a part: the element id too. A frame's copy of a main keeps both; a stored template never an id */
  withId = false,
  /** a main's own attributes on the nested use: forwarded props and a condition */
  carried: readonly (readonly [string, string])[] = [],
): string {
  const rest: Record<string, PartOverride> = {}
  const slotChildren: string[] = []
  const slotParts = def ? partsOf(def.template) : new Map<string, PartInfo>()
  for (const [key, override] of Object.entries(state.overrides.parts ?? {})) {
    const { slot, ...others } = override
    if (slot !== undefined) {
      const slotName = attrOf(slotParts.get(key)?.el ?? ({ attrs: [] } as unknown as Element), SLOT_ATTR) ?? key
      slotChildren.push(`<template slot="${escapeAttr(slotName)}">${slot}</template>`)
    }
    if (Object.keys(others).length) rest[key] = others
  }
  let tag = `<${USE_TAG}${attrText('component', name)}`
  if (part) tag += attrText(PART_ATTR, part)
  if ((!part || withId) && isElementId(state.instanceId)) tag += attrText('id', state.instanceId)
  for (const [prop, value] of Object.entries(state.overrides.props ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    tag += attrText(prop, value)
  if (Object.keys(rest).length) tag += attrText('overrides', stableJson(rest))
  for (const [attr, value] of carried) tag += attrText(attr, value)
  return `${tag}>${slotChildren.join('')}</${USE_TAG}>`
}

/* Attributes that mean something on a template's own element and nothing on a `<doop-use>`: the
   nested instance is written out in the main, so one of these would only ride along as an
   attribute override on its root. Each says what to write instead. Inside a component's main (`inTemplate`)
   data-doop-prop forwards the outer component's props and data-doop-if shows or hides the nested
   instance, so those two are the template's own and raise nothing. */
const TEMPLATE_ONLY_ATTRS: Record<string, string> = {
  [BIND_ATTR]: `it forwards a prop of the component that holds this <doop-use>, so it only works inside a component's main. In a frame give the component fixed values (label="…"). ${FORWARD_GRAMMAR}`,
  [IF_ATTR]:
    "it shows or hides a <doop-use> inside a component's main, so it only works there. In a frame, put it on an element wrapped around the <doop-use>",
  [ATTR_IF_ATTR]:
    'it removes an attribute from the element that carries it, and a <doop-use> has no attributes of its own to condition: put it on an element wrapped around the <doop-use>',
  [SLOT_ATTR]: 'put it on an element wrapped around the <doop-use>, which is then the slot’s default content',
  [SLOT_SUGGEST_ATTR]: 'it belongs on the element that carries data-doop-slot',
}

/** Build an instance's overrides from a `<doop-use>`'s attributes, reporting what does not fit. */
export function stateFromUseAttrs(use: Element, def: Revision, ctx: EngineContext, inTemplate = false): InstanceState {
  const props: Record<string, string> = {}
  let parts: Record<string, PartOverride> = {}
  const root = parseTemplateRoot(def.template)
  const rootKey = root ? attrOf(root, PART_ATTR) : undefined
  const addRoot = (patch: PartOverride) => {
    if (!rootKey) return
    const existing = parts[rootKey] ?? {}
    parts[rootKey] = {
      ...existing,
      ...patch,
      ...(patch.attrs ? { attrs: { ...existing.attrs, ...patch.attrs } } : {}),
    }
  }
  for (const attr of use.attrs) {
    const name = attr.name
    if (name === 'component' || name === 'id' || name === PART_ATTR || name === ELEMENT_ID_ATTR) continue
    if (inTemplate && (name === BIND_ATTR || name === IF_ATTR)) continue
    const instead = TEMPLATE_ONLY_ATTRS[name]
    if (instead) {
      ctx.issues.push({
        code: 'ignored_attribute',
        message: `${name} on <${USE_TAG} component="${def.name}"> does nothing and was dropped: ${instead}.`,
      })
      continue
    }
    if (name === 'overrides') {
      parts = { ...parts, ...asPartRecord(JSON_OBJECT(attr.value)) }
      continue
    }
    if (name === 'style') {
      addRoot({ style: Object.fromEntries(parseStyle(attr.value)) })
      continue
    }
    if (name === 'class') {
      addRoot({ attrs: { class: [root ? attrOf(root, 'class') : '', attr.value].filter(Boolean).join(' ') } })
      continue
    }
    const prop = def.props.find((candidate) => candidate.name === name)
    if (prop) {
      const problem = propValueProblem(prop, attr.value, ctx.find)
      if (problem) {
        ctx.issues.push({
          code: 'invalid_prop_value',
          message:
            prop.type === 'list'
              ? `${def.name}: ${name} was not set — ${problem}`
              : `${def.name}: "${shown(attr.value)}" is not a value of ${name} — ${problem}`,
        })
        continue
      }
      if (prop.type !== 'list' && unsafeStyleValue(attr.value) && styleBound(def.template, name)) {
        ctx.issues.push({
          code: 'invalid_prop_value',
          message: `${def.name}: ${name} was not set — it is bound to a style, and ${STYLE_VALUE_RULE}`,
        })
        continue
      }
      if (prop.type === 'list') {
        const clean = cleanListValue(def, prop, attr.value, ctx)
        if (clean !== undefined) props[name] = clean
      } else props[name] = prop.type === 'richtext' ? cleanRichValue(def, name, attr.value, ctx) : attr.value
      continue
    }
    if (name.startsWith('data-') || name.startsWith('aria-')) {
      addRoot({ attrs: { [name]: attr.value } })
      continue
    }
    ctx.issues.push({
      code: 'unknown_prop',
      message: `${def.name} has no prop “${safeName(name)}” — it has ${def.props.map((p) => p.name).join(', ') || 'no props'}`,
    })
  }
  /* `<template slot="x">` and plain children go to their slots */
  assignSlots(use, def, parts, ctx)
  const rawId = attrOf(use, 'id') ?? attrOf(use, ELEMENT_ID_ATTR)
  return {
    instanceId: isElementId(rawId) ? rawId : newElementId(),
    componentId: def.id,
    rev: def.rev,
    overrides: clean({ props, parts }),
  }
}

function assignSlots(use: Element, def: Revision, parts: Record<string, PartOverride>, ctx: EngineContext) {
  const slotParts = [...partsOf(def.template)].filter(([, info]) => info.isSlot && !info.inEach)
  if (!slotParts.length) return
  const byName = new Map(slotParts.map(([key, info]) => [attrOf(info.el, SLOT_ATTR) ?? '', key]))
  const fallback = slotParts[0]![0]
  /* a component with one slot takes everything without comment; with several, content that names no slot is a guess worth reporting */
  const several = slotParts.length > 1
  const names = [...byName.keys()].map((name) => safeName(name) || 'default')
  /* where unnamed content has always gone: the first slot the template walk finds */
  const fallbackName = safeName(attrOf(slotParts[0]![1].el, SLOT_ATTR) ?? '') || 'default'
  const unknown = new Set<string>()
  const unnamed: string[] = []
  for (const child of use.childNodes) {
    if (isElement(child)) {
      const slotName = attrOf(child, 'slot')
      if (slotName !== undefined) {
        const known = byName.has(slotName)
        if (!known && several) unknown.add(safeName(slotName))
        const key = byName.get(slotName) ?? fallback
        const content = child.tagName === 'template' ? templateInner(child) : serializeOuterWithoutSlot(child)
        const existing = parts[key]?.slot
        parts[key] = { ...parts[key], slot: existing ? `${existing}${content}` : content }
        continue
      }
      unnamed.push(serializeOuter(child))
    } else if (child.nodeName === '#text' && (child as Tree.TextNode).value.trim()) {
      unnamed.push((child as Tree.TextNode).value)
    }
  }
  if (unnamed.length) {
    const existing = parts[fallback]?.slot
    parts[fallback] = { ...parts[fallback], slot: `${existing ?? ''}${unnamed.join('')}` }
    if (several)
      ctx.issues.push({
        code: 'unnamed_slot_content',
        message: `${def.name} has several slots (${names.join(', ')}) and some content in <${USE_TAG}> names none, so it went into “${fallbackName}”. Wrap each part in <template slot="name">…</template> to say where it goes.`,
      })
  }
  for (const name of unknown)
    ctx.issues.push({
      code: 'unknown_slot',
      message: `${def.name} has no slot “${name}” (it has ${names.join(', ')}), so that content went into “${fallbackName}”.`,
    })
}

function templateInner(el: Element): string {
  const content = (el as Tree.Template).content
  return content ? serialize(content) : serialize(el)
}

function serializeOuterWithoutSlot(el: Element): string {
  setAttr(el, 'slot', null)
  return serializeOuter(el)
}

/* ------------------------------------------------------------------ */
/* Expanding `<doop-use>` at string level: a parser would foster-parent */
/* one out of a <table>, and the rest of the document stays byte-exact. */
/* ------------------------------------------------------------------ */

const OPAQUE = /<(script|style|textarea|title)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi

function opaqueRanges(html: string): [number, number][] {
  return [...html.matchAll(OPAQUE)].map((match) => [match.index, match.index + match[0].length])
}

function tagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from; i < html.length; i++) {
    const char = html[i]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '>') return i
  }
  return -1
}

interface UseSpan {
  start: number
  end: number
  openEnd: number
  closeStart: number
  selfClosing: boolean
  /** read leniently: an open tag whose end never came, taken as empty */
  unclosed?: boolean
}

/** The next complete `<doop-use>` from `from`. `lenient` (a whole write, nothing more to come)
 *  takes an open tag whose end never came as empty, so the ones after it still expand. */
function nextUse(html: string, from: number, opaque: [number, number][], lenient = false): UseSpan | undefined {
  const open = `<${USE_TAG}`
  const close = `</${USE_TAG}`
  let start = indexOfAscii(html, open, from)
  while (start !== -1) {
    const at = start
    const following = html[at + open.length]
    if (following && /[\s/>]/.test(following) && !opaque.some(([a, b]) => at >= a && at < b)) break
    start = indexOfAscii(html, open, at + 1)
  }
  if (start === -1) return undefined
  const openEnd = tagEnd(html, start)
  if (openEnd === -1) return undefined
  if (html[openEnd - 1] === '/') {
    return { start, end: openEnd + 1, openEnd, closeStart: openEnd + 1, selfClosing: true }
  }
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0) {
    const nextOpen = indexOfAscii(html, open, cursor)
    const nextClose = indexOfAscii(html, close, cursor)
    if (nextClose === -1)
      return lenient
        ? { start, end: openEnd + 1, openEnd, closeStart: openEnd + 1, selfClosing: true, unclosed: true }
        : undefined
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const innerEnd = tagEnd(html, nextOpen)
      if (innerEnd === -1) return undefined
      if (html[innerEnd - 1] !== '/') depth++
      cursor = innerEnd + 1
    } else {
      depth--
      const closeEnd = html.indexOf('>', nextClose)
      if (closeEnd === -1) return undefined
      if (depth === 0) return { start, end: closeEnd + 1, openEnd, closeStart: nextClose, selfClosing: false }
      cursor = closeEnd + 1
    }
  }
  return undefined
}

/** Every complete `<doop-use>` in the HTML, written out in full. One still missing
 *  its end (mid-stream) stays as it is until a later pass; on a whole write (`final`)
 *  nothing more is coming, so it is taken as empty and reported. */
export function expandUses(
  html: string,
  ctx: EngineContext,
  stack: string[] = [],
  depth = 0,
  { final = false }: { final?: boolean } = {},
): string {
  if (indexOfAscii(html, `<${USE_TAG}`) === -1) return html
  const opaque = opaqueRanges(html)
  /* only a use that forwards props or carries a condition needs to know whether it stands in a main */
  let mains: Located[] | undefined
  const inMain = (span: UseSpan) => {
    if (!CARRIED_ATTRS.some((name) => html.slice(span.start, span.openEnd + 1).includes(name))) return false
    mains ??= findMarked(html, COMPONENT_ATTR)
    return mains.some((main) => span.start >= main.start && span.start < main.end)
  }
  let out = ''
  let cursor = 0
  for (let span = nextUse(html, 0, opaque, final); span; span = nextUse(html, cursor, opaque, final)) {
    out += html.slice(cursor, span.start)
    if (span.unclosed) {
      const ref = /\bcomponent\s*=\s*["']([^"']*)["']/i.exec(html.slice(span.start, span.openEnd))?.[1] ?? ''
      ctx.issues.push({
        code: 'unclosed_use',
        message: `<${USE_TAG} component="${ref}"> was never closed with </${USE_TAG}>, so it was placed with no slot content. Close every <${USE_TAG}>, or write it self-closing.`,
      })
    }
    out += expandOne(html, span, ctx, stack, depth, final, inMain(span))
    cursor = span.end
  }
  return out + html.slice(cursor)
}

function expandOne(
  html: string,
  span: UseSpan,
  ctx: EngineContext,
  stack: string[],
  depth: number,
  final: boolean,
  inMain: boolean,
): string {
  const openTag = html.slice(span.start, span.openEnd + 1).replace(/\/>$/, '>')
  const inner = span.selfClosing ? '' : html.slice(span.openEnd + 1, span.closeStart)
  const use = elementKids(parseFragment(`${openTag}${inner}</${USE_TAG}>`))[0]
  if (!use) {
    ctx.issues.push({ code: 'unknown_component', message: `a <${USE_TAG}> could not be read, so it was left out` })
    return ''
  }
  const ref = attrOf(use, 'component') ?? ''
  const def = ctx.find(ref)
  if (!def) {
    ctx.issues.push({ code: 'unknown_component', message: `no component “${ref}” on this canvas` })
    return ''
  }
  /* a deleted component takes no new use. One a template already holds (it wears its part
     key) is not new: a component built from a deleted one keeps rendering as it did */
  if (isDeleted(def) && attrOf(use, PART_ATTR) === undefined) {
    ctx.issues.push({
      code: 'deleted_component',
      message: `“${def.name}” was deleted from this canvas, so it was not placed. Restore it (restore_component) to use it again, or use another component.`,
    })
    return ''
  }
  const state = stateFromUseAttrs(use, def, ctx, inMain)
  const root = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack, depth, final })
  if (!root) return ''
  /* in a main the instance stands for the template's `<doop-use>`, and keeps what that said beyond the
     component: its forwarded props and its condition, or the next read of the main would lose them */
  if (inMain) {
    for (const name of CARRIED_ATTRS) setAttr(root, name, attrOf(use, name) ?? null)
    for (const { target, prop } of parseBindings(attrOf(use, BIND_ATTR) ?? '', use.tagName))
      if (target === null)
        ctx.issues.push({
          code: 'ignored_attribute',
          message: `${BIND_ATTR}="${prop}" on <${USE_TAG} component="${def.name}"> forwards nothing: write inner:outer, as label:${prop}. ${FORWARD_GRAMMAR}`,
        })
  }
  /* a template read back by update_component keeps the nested instance's key, and its overrides
     with it. One that names none gets no key from the component it renders: that is the
     component's own root key, the same for every use of it, so a second keyless use in a main
     took the key of the first (agent reports, 2026-11-11). The main gives it one of its own */
  setAttr(root, PART_ATTR, attrOf(use, PART_ATTR) ?? null)
  return serializeOuter(root)
}

/* ------------------------------------------------------------------ */
/* Whole-document passes                                               */
/* ------------------------------------------------------------------ */

export interface Located {
  el: Element
  start: number
  end: number
}

/** Outermost elements with a marker, by source range. Nothing below a found one is visited. */
export function findMarked(html: string, attribute: string): Located[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const found: Located[] = []
  const stack: ChildNode[] = [...doc.childNodes].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    const location = node.sourceCodeLocation
    if (attrOf(node, attribute) !== undefined && location) {
      found.push({ el: node, start: location.startOffset, end: location.endOffset })
      continue
    }
    for (const child of [...node.childNodes].reverse()) stack.push(child)
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Every element with a marker, nested ones too, by source range. */
export function findAllMarked(html: string, attribute: string): Located[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const found: Located[] = []
  const stack: ChildNode[] = [...doc.childNodes]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    const location = node.sourceCodeLocation
    if (attrOf(node, attribute) !== undefined && location)
      found.push({ el: node, start: location.startOffset, end: location.endOffset })
    stack.push(...node.childNodes)
  }
  return found
}

/** The ones with no other of them inside: a batch of these can be replaced without overlapping. */
export function innermost(found: Located[]): Located[] {
  return found.filter((el) => !found.some((other) => other !== el && other.start >= el.start && other.end <= el.end))
}

/** An instance as plain markup. It keeps a marker of its own, for the stylesheet below to hold on to. */
export function detachedMarkup(el: Element, def: Pick<ComponentDef, 'id' | 'rev'> | undefined): string {
  for (const name of [INSTANCE_ATTR, REV_ATTR, PROPS_ATTR, OVERRIDES_ATTR]) setAttr(el, name, null)
  if (def) setAttr(el, DETACHED_ATTR, detachedKey(def))
  const stack: Element[] = [el]
  for (let node = stack.pop(); node; node = stack.pop()) {
    setAttr(node, PART_ATTR, null)
    stack.push(...elementKids(node).filter((kid) => !attrOf(kid, INSTANCE_ATTR)))
  }
  return serializeOuter(el)
}

const detachedKey = (def: Pick<ComponentDef, 'id' | 'rev'>) => `${def.id}.${def.rev}`

/** The component's rules at the revision that was detached, for elements that no longer follow it.
 *  One copy per revision per frame, however many instances were cut loose. The fonts and
 *  frameworks it brought stay too, as the frame's own tags: `syncComponentHead` drops the
 *  component's marked copies once nothing linked uses them. */
export function withDetachedCss(html: string, def: Pick<ComponentDef, 'id' | 'rev' | 'css' | 'head'>): string {
  const own = def.head.filter((tag) => !html.includes(tag))
  if (own.length) html = insertIntoHead(html, own.join('\n'))
  const key = detachedKey(def)
  if (!def.css.trim() || html.includes(`${DETACHED_CSS_ATTR}="${key}"`)) return html
  /* what is cut loose holds no instances: the containment of the isolating form has nothing to do here */
  const css = def.css
    .replaceAll(nestedExclusion(`[${INSTANCE_ATTR}="${def.id}"]`), '')
    .replaceAll(`[${INSTANCE_ATTR}="${def.id}"]`, `[${DETACHED_ATTR}="${key}"]`)
    .replaceAll(`__${def.id}`, `__${def.id}-${def.rev}`)
  return insertIntoHead(html, `<style ${DETACHED_CSS_ATTR}="${key}">\n${styleText(css)}\n</style>`)
}

export function splice(html: string, edits: { start: number; end: number; text: string }[]): string {
  let out = html
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/** Short form of a whole document: instances as `<doop-use>`, their CSS copies gone.
 *  What agents read: a screen of 40 buttons costs 40 lines rather than 40 subtrees. */
export function compactDocument(html: string, ctx: EngineContext): string {
  if (!html.includes(INSTANCE_ATTR) && !html.includes(CSS_ATTR)) return restoreFrameStyles(html)
  /* an instance of a deleted component stays written out: as <doop-use> it would be a new
     use of it when the frame is written back, and those are refused. One of a hollow
     component too, with its stylesheet: written back as <doop-use> it would render nothing */
  const hollow = hollowIds(html, ctx)
  const instances = findInstancesEverywhere(html).filter(
    (found) => !isDeleted(ctx.find(attrOf(found.el, INSTANCE_ATTR) ?? '')) && !holdsHollow(found.el, ctx),
  )
  /* one inside a main keeps the key the main gave it (its place there, which the main's
     instances' overrides name) and its element id (what comments and links name): saved back
     without them, it would get new ones */
  const edits = instances.map((found) => ({
    start: found.start,
    end: found.end,
    text: insideMain(found.el) ? useTagFor(found.el, ctx, true, false, false, true) : useTagFor(found.el, ctx),
  }))
  return restoreFrameStyles(stripComponentHead(splice(html, edits), hollow))
}

/** Outermost instances, also those below a main: the main itself is not an instance. */
export function findInstancesEverywhere(html: string): Located[] {
  return findMarked(html, INSTANCE_ATTR)
}

function insideMain(el: Element): boolean {
  for (let node = el.parentNode; node && isElement(node); node = node.parentNode)
    if (attrOf(node, COMPONENT_ATTR) !== undefined) return true
  return false
}

/** Is this instance, or one nested anywhere inside it, of a hollow component? Rendered again
 *  (or read back as <doop-use>) it would lose that instance, so it is left as written. */
export function holdsHollow(el: Element, ctx: EngineContext): boolean {
  const stack: Element[] = [el]
  for (let node = stack.pop(); node; node = stack.pop()) {
    const id = attrOf(node, INSTANCE_ATTR)
    if (id !== undefined && isHollow(ctx.find(id))) return true
    stack.push(...elementKids(node))
  }
  return false
}

/** The hollow components this document has instances of. */
function hollowIds(html: string, ctx: EngineContext): Set<string> {
  return new Set([...usedComponentIds(html)].filter((id) => isHollow(ctx.find(id))))
}

/** Everything a component put in the head: its stylesheet, and the links and scripts it brought.
 *  The stylesheets of the components in `keep` stay. */
export function stripComponentHead(html: string, keep: ReadonlySet<string> = new Set()): string {
  return html
    .replace(
      new RegExp(`<style[^>]*\\b${CSS_ATTR}="([^"]*)"[^>]*>[\\s\\S]*?</style>\\n?`, 'gi'),
      (block, id: string) => (keep.has(id) ? block : ''),
    )
    .replace(new RegExp(`<script[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>][^>]*>[\\s\\S]*?</script>\\n?`, 'gi'), '')
    .replace(new RegExp(`<link[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>/][^>]*>\\n?`, 'gi'), '')
}

/** A head tag with the mark that says a component brought it, so `frameHeadTags` and the next
 *  `syncComponentHead` can tell it from the frame's own. */
function markedHeadTag(tag: string): string {
  return tag.replace(/^<(link|script)\b/i, `<$1 ${HEAD_ATTR}`)
}

/** Every component an instance in this document uses, nested ones included. */
export function usedComponentIds(html: string): Set<string> {
  const ids = new Set<string>()
  /* the leading space: an element's attribute, not a selector in a stylesheet */
  for (const match of html.matchAll(new RegExp(`\\s${INSTANCE_ATTR}="([^"]+)"`, 'g'))) ids.add(match[1]!)
  return ids
}

/** Put exactly the component stylesheets this document needs into its head. */
export function syncComponentHead(html: string, defs: ComponentDef[]): string {
  /* a hollow component has no stylesheet to put back: its instances keep the one they have */
  const stripped = stripComponentHead(html, new Set(defs.filter(isHollow).map((def) => def.id)))
  const blocks: string[] = []
  for (const def of defs) {
    /* a tag the frame has of its own, or one another component already brought, is not repeated */
    for (const tag of def.head) {
      const marked = markedHeadTag(tag)
      if (!stripped.includes(tag) && !blocks.includes(marked)) blocks.push(marked)
    }
    if (def.css.trim()) blocks.push(`<style ${CSS_ATTR}="${def.id}">\n${styleText(def.css)}\n</style>`)
  }
  if (!blocks.length) return stripped === html ? html : stripped
  const next = insertIntoHead(stripped, blocks.join('\n'))
  return next
}

function insertIntoHead(html: string, block: string): string {
  const close = /<\/head\s*>/i.exec(html)
  if (close) return `${html.slice(0, close.index)}${block}\n${html.slice(close.index)}`
  const open = /<head\b[^>]*>/i.exec(html)
  if (open) return `${html.slice(0, open.index + open[0].length)}\n${block}${html.slice(open.index + open[0].length)}`
  const body = /<body\b[^>]*>/i.exec(html)
  if (body) return `${html.slice(0, body.index)}<head>\n${block}\n</head>${html.slice(body.index)}`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return `${html.slice(0, at)}${block}\n${html.slice(at)}`
}

/* ------------------------------------------------------------------ */
/* Turning a main element into a template                              */
/* ------------------------------------------------------------------ */

const PART_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

export function newPartKey(taken: Set<string>): string {
  for (;;) {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    let key = ''
    for (const byte of bytes) key += PART_ALPHABET[byte % PART_ALPHABET.length]
    if (!taken.has(key)) {
      taken.add(key)
      return key
    }
  }
}

/** Key every element below (and including) a main that has none, and any second
 *  use of a key (a copy pasted inside the main). Returns whether anything changed.
 *  A `<style>` or `<script>` is keyed like any other element: reconciling needs a
 *  key on every child to match them up, and an unkeyed one would turn a byte-identical
 *  save into an `html` override on its parent. */
export function stampParts(root: Element): boolean {
  const taken = new Set<string>()
  let changed = false
  /* a list's copies are keyed `<key>-<index>`: in a main that repeats an element, an authored key of that shape is re-keyed so it can never be mistaken for one */
  const hasList = hasEachElement(root)
  const visit = (el: Element) => {
    const key = attrOf(el, PART_ATTR)
    if (!key || taken.has(key) || (hasList && COPY_KEY.test(key))) {
      setAttr(el, PART_ATTR, newPartKey(taken))
      changed = true
    } else taken.add(key)
    /* a nested instance is one part of this template; its insides are its own */
    if (attrOf(el, INSTANCE_ATTR)) return
    for (const child of elementKids(el)) visit(child)
  }
  visit(root)
  return changed
}

function hasEachElement(root: Element): boolean {
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el !== root && el.tagName !== USE_TAG && attrOf(el, EACH_ATTR) !== undefined) return true
    if (!attrOf(el, INSTANCE_ATTR)) stack.push(...elementKids(el))
  }
  return false
}

/** The main's markup as a template: no main marker, no element ids (each instance
 *  gets its own), nested instances compact. */
export function templateFromMain(main: Element, ctx: EngineContext): string {
  const clone = elementKids(rootFragment(serializeOuter(main)))[0]
  if (!clone) return ''
  setAttr(clone, COMPONENT_ATTR, null)
  const walk = (node: Element) => {
    setAttr(node, ELEMENT_ID_ATTR, null)
    compactKeepingParts(node, ctx)
    for (const child of elementKids(node)) if (child.tagName !== USE_TAG) walk(child)
  }
  walk(clone)
  return serializeOuter(clone)
}

/* reconciled: an edit inside a nested instance of the main is part of this write's template */
function compactKeepingParts(node: Element, ctx: EngineContext) {
  node.childNodes = node.childNodes.map((child) =>
    isElement(child) && attrOf(child, INSTANCE_ATTR) ? useElementFor(child, ctx, node, true, true) : child,
  )
}

/** Carry the old keys onto a rewritten template, element by element where tag and
 *  place line up, so an agent resending a main does not orphan every override. */
export function alignParts(next: Element, previous: Element | undefined) {
  const written = new Set<string>()
  const stack: Element[] = [next]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const key = attrOf(el, PART_ATTR)
    if (key) written.add(key)
    stack.push(...elementKids(el))
  }
  alignWith(next, previous, written)
}

/**
 * A child that names a key is matched to the old child with that key, never by place. One
 * that names none takes the place of an old child that nothing claimed: inserting a keyless
 * element before a keyed one used to hand it that one's key (overrides and all) and re-key
 * the owner as a duplicate (agent reports, 2026-11-11). `written` holds every key the new
 * markup names, and the keys handed out so far: none of them is handed out again.
 */
function alignWith(next: Element, previous: Element | undefined, written: Set<string>) {
  if (!previous || next.tagName !== previous.tagName) return
  if (!attrOf(next, PART_ATTR)) {
    const key = attrOf(previous, PART_ATTR)
    if (key && !written.has(key)) {
      setAttr(next, PART_ATTR, key)
      written.add(key)
    }
  }
  const oldKids = elementKids(previous)
  const oldByKey = new Map<string, Element>()
  for (const kid of oldKids) {
    const key = attrOf(kid, PART_ATTR)
    if (key) oldByKey.set(key, kid)
  }
  const free = oldKids.filter((kid) => {
    const key = attrOf(kid, PART_ATTR)
    return !key || !written.has(key)
  })
  const seenOfTag = new Map<string, number>()
  for (const kid of elementKids(next)) {
    const key = attrOf(kid, PART_ATTR)
    if (key) {
      alignWith(kid, oldByKey.get(key), written)
      continue
    }
    const index = seenOfTag.get(kid.tagName) ?? 0
    seenOfTag.set(kid.tagName, index + 1)
    alignWith(kid, free.filter((candidate) => candidate.tagName === kid.tagName)[index], written)
  }
}

/* ------------------------------------------------------------------ */
/* Props and slots from a template                                     */
/* ------------------------------------------------------------------ */

const declaredOf = (declared: ComponentProp[], name: string) => declared.find((prop) => prop.name === name)

/** The props a template actually uses, with what was declared about them.
 *  Enum props live only in the declaration: their effect is `data-<name>` on the root. */
export function derivePropsAndSlots(
  template: string,
  declared: ComponentProp[],
  /** a component by name or id: a nested `<doop-use>`'s forwarded prop takes its type from the prop it feeds */
  find?: (ref: string) => Pick<ComponentDef, 'id' | 'props'> | undefined,
): { props: ComponentProp[]; slots: ComponentSlot[] } {
  const root = parseTemplateRoot(template)
  const props = new Map<string, ComponentProp>()
  /* an enum or a reflected boolean needs no binding: its effect is `data-<name>` on the root */
  for (const prop of declared) if (reflects(prop) && isPropName(prop.name)) props.set(prop.name, prop)
  const slots: ComponentSlot[] = []
  if (!root) return { props: [...props.values()], slots }
  const stack: [Element, ReadonlySet<string> | undefined][] = [[root, undefined]]
  const order: Element[] = []
  /* a list's element and everything below it is one item: what it names that the list has as a field is the item's, not a prop */
  const fieldsAt = new Map<Element, ReadonlySet<string>>()
  const lists = new Map<Element, Record<string, ListField>>()
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [el, within] = entry
    order.push(el)
    let names = within
    if (!within && isEachElement(el, root)) {
      const known = declaredOf(declared, (attrOf(el, EACH_ATTR) ?? '').trim())
      const fields = known?.type === 'list' && known.fields ? known.fields : inferFields(el)
      lists.set(el, fields)
      names = new Set(Object.keys(fields))
    }
    if (names) fieldsAt.set(el, names)
    stack.push(
      ...elementKids(el)
        .reverse()
        .map((kid): [Element, ReadonlySet<string> | undefined] => [kid, names]),
    )
  }
  for (const el of order) {
    const fields = fieldsAt.get(el)
    const own = lists.get(el)
    const each = (attrOf(el, EACH_ATTR) ?? '').trim()
    if (own && isPropName(each) && !props.has(each)) {
      const known = declaredOf(declared, each)
      props.set(each, {
        name: each,
        type: 'list',
        fields: own,
        ...(known?.type === 'list' && known.default !== undefined ? { default: known.default } : {}),
        ...descriptionOf(known),
      })
    }
    for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '', el.tagName)) {
      if (fields?.has(prop) || props.has(prop)) continue
      const known = declaredOf(declared, prop)
      if (el.tagName === USE_TAG) {
        /* `inner:outer` on a nested use: the outer prop is the nested component's prop, handed up */
        if (target === null) continue
        const nested = find?.(attrOf(el, 'component') ?? '')
        const fed = nested?.props.find((candidate) => candidate.name === target)
        props.set(prop, {
          name: prop,
          type: known?.type ?? (target === 'component' ? 'instance' : (fed?.type ?? 'text')),
          ...(known
            ? typedFieldsOf(known)
            : target === 'component'
              ? nested
                ? { accepts: [nested.id] }
                : {}
              : fed
                ? fedFieldsOf(fed)
                : {}),
          ...descriptionOf(known),
        })
        continue
      }
      const type = target === 'src' ? 'image' : target === 'href' ? 'link' : 'text'
      props.set(prop, {
        name: prop,
        type: known?.type ?? type,
        /* a typed prop's default decides what its conditions show; text-like ones are the template's own content */
        ...typedFieldsOf(known),
        ...descriptionOf(known),
      })
    }
    const conditions = [
      parseCondition(attrOf(el, IF_ATTR) ?? ''),
      ...parseAttrConditions(attrOf(el, ATTR_IF_ATTR) ?? '').flatMap((entry) => entry.conditions),
    ]
    for (const condition of conditions) {
      if (!condition || !isPropName(condition.prop) || props.has(condition.prop) || fields?.has(condition.prop))
        continue
      const known = declaredOf(declared, condition.prop)
      props.set(condition.prop, {
        name: condition.prop,
        type: known?.type ?? 'boolean',
        default: known?.default ?? 'true',
        ...(known?.options ? { options: known.options } : {}),
        ...typedFieldsOf(known, false),
        ...descriptionOf(known),
      })
    }
    const slot = fields ? undefined : attrOf(el, SLOT_ATTR)
    if (slot !== undefined) {
      slots.push({
        name: slot || 'default',
        suggested: (attrOf(el, SLOT_SUGGEST_ATTR) ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      })
    }
  }
  return { props: [...props.values()], slots }
}

/** An element that repeats for the items of a list (never the root, which is the component itself, and never a `<doop-use>`). */
const isEachElement = (el: Element, root: Element) =>
  el !== root && el.tagName !== USE_TAG && attrOf(el, EACH_ATTR) !== undefined

/** The fields a list element's own bindings and conditions imply: an image's source an image, a link's target a link,
 *  a condition a boolean, anything else text. First seen first, at most MAX_LIST_FIELDS. */
function inferFields(el: Element): Record<string, ListField> {
  const fields: Record<string, ListField> = {}
  const add = (name: string, type: ListFieldType) => {
    if (isListFieldName(name) && !Object.hasOwn(fields, name) && Object.keys(fields).length < MAX_LIST_FIELDS)
      fields[name] = { type }
  }
  const stack: Element[] = [el]
  const order: Element[] = []
  for (let node = stack.pop(); node; node = stack.pop()) {
    order.push(node)
    if (node.tagName !== USE_TAG) stack.push(...elementKids(node).reverse())
  }
  for (const node of order) {
    for (const { target, prop } of parseBindings(attrOf(node, BIND_ATTR) ?? '', node.tagName))
      add(prop, target === 'src' ? 'image' : target === 'href' ? 'link' : 'text')
    const conditions = [
      ...(node === el ? [] : [parseCondition(attrOf(node, IF_ATTR) ?? '')]),
      ...parseAttrConditions(attrOf(node, ATTR_IF_ATTR) ?? '').flatMap((entry) => entry.conditions),
    ]
    for (const condition of conditions)
      if (condition) add(condition.prop, condition.equals === undefined ? 'boolean' : 'text')
  }
  return fields
}

/** What a forwarded prop takes from the nested prop it feeds: its limits, never its default. */
function fedFieldsOf(prop: ComponentProp): Partial<ComponentProp> {
  return {
    ...(prop.options ? { options: prop.options } : {}),
    ...(prop.min !== undefined ? { min: prop.min } : {}),
    ...(prop.max !== undefined ? { max: prop.max } : {}),
    ...(prop.step !== undefined ? { step: prop.step } : {}),
    ...(prop.accepts?.length ? { accepts: prop.accepts } : {}),
  }
}

/** What a declared prop says beyond its name and type: kept for a prop the template still uses. */
function typedFieldsOf(prop: ComponentProp | undefined, withDefault = true): Partial<ComponentProp> {
  if (
    !prop ||
    prop.type === 'text' ||
    prop.type === 'richtext' ||
    prop.type === 'image' ||
    prop.type === 'link' ||
    prop.type === 'enum'
  )
    return {}
  return {
    ...(withDefault && prop.default !== undefined ? { default: prop.default } : {}),
    ...(prop.min !== undefined ? { min: prop.min } : {}),
    ...(prop.max !== undefined ? { max: prop.max } : {}),
    ...(prop.step !== undefined ? { step: prop.step } : {}),
    ...(prop.accepts?.length ? { accepts: prop.accepts } : {}),
    ...(prop.reflect ? { reflect: true } : {}),
  }
}

const descriptionOf = (prop: ComponentProp | undefined) => (prop?.description ? { description: prop.description } : {})

/* what an element's text is called when nothing on it says: by what the element is */
const ROLE_NAMES: Record<string, string> = {
  h1: 'title',
  h2: 'title',
  h3: 'title',
  h4: 'title',
  h5: 'title',
  h6: 'title',
  button: 'label',
  a: 'label',
  label: 'label',
  summary: 'label',
  li: 'item',
  figcaption: 'caption',
  caption: 'caption',
  small: 'caption',
  blockquote: 'quote',
  time: 'date',
  th: 'heading',
  td: 'cell',
}

/* a utility class says how an element looks, not what it is: `text-sm`, `mt-2`, `md:flex` */
const UTILITY_CLASS =
  /[:[\]/.]|^-|^(flex|grid|block|inline|hidden|relative|absolute|truncate|uppercase|italic|underline|antialiased)$|^(text|font|bg|border|rounded|shadow|leading|tracking|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|gap|flex|grid|inline|items|justify|opacity|whitespace)-/

/** The name an element gives itself: its `data-name`, else its last class that is not a utility. */
function ownPropName(el: Element, fromClasses = true): string | undefined {
  const classes = (fromClasses ? (attrOf(el, 'class') ?? '') : '')
    .split(/\s+/)
    .filter((name) => name && !UTILITY_CLASS.test(name))
  const raw = attrOf(el, 'data-name') ?? classes.at(-1) ?? ''
  const name = raw && raw.length < 30 ? toPropName(raw) : 'value'
  return name === 'value' ? undefined : name
}

/** The nearest element, from this one up to the main, whose tag says what its text is. */
function roleName(el: Element, root: Element): string {
  for (let node: Element | undefined = el; node;) {
    const role = ROLE_NAMES[node.tagName]
    if (role) return role
    if (node === root) break
    const parent: ParentNode | null = node.parentNode
    node = parent && isElement(parent) ? parent : undefined
  }
  return el === root ? 'label' : 'text'
}

/** Name what a component would most likely vary: leaf text, image sources, link targets.
 *  Written onto the main as ordinary bindings, so a person or agent can see and change them.
 *  Returns the prop names it made up, in template order. */
export function inferBindings(root: Element, limit = 12, { fromClasses = true } = {}): string[] {
  const used = new Set<string>()
  let count = 0
  const take = (base: string) => {
    let candidate = base
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`
    used.add(candidate)
    return candidate
  }
  const stack: Element[] = [root]
  const order: Element[] = []
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el.tagName === 'style' || el.tagName === 'script' || el.tagName === 'svg') continue
    /* a nested component, written out or still `<doop-use>`: its content is its own */
    if (attrOf(el, INSTANCE_ATTR) || el.tagName === USE_TAG) continue
    /* a list's element: its bindings are the item's fields, named on purpose */
    if (isEachElement(el, root)) continue
    order.push(el)
    stack.push(...elementKids(el).reverse())
  }
  for (const el of order) {
    if (count >= limit || attrOf(el, BIND_ATTR) !== undefined || attrOf(el, SLOT_ATTR) !== undefined) continue
    const bindings: string[] = []
    const own = ownPropName(el, fromClasses)
    if (el.tagName === 'img' && attrOf(el, 'src')) bindings.push(`src:${take(own ?? 'image')}`)
    /* a link's target is named beside its text: `cta-link` next to `cta` */
    if (el.tagName === 'a' && attrOf(el, 'href')) bindings.push(`href:${take(own ? `${own}-link` : 'link')}`)
    if (elementKids(el).length === 0 && directText(el)) bindings.push(take(own ?? roleName(el, root)))
    if (bindings.length) {
      setAttr(el, BIND_ATTR, bindings.join(','))
      count += bindings.length
    }
  }
  return [...used]
}

/** The one piece of text a component shows, bound as its `label`: for a main that already has bindings (a captured component's variant attributes), where `inferBindings` leaves everything alone. Only when the markup holds exactly one text, in a leaf that nothing binds, and `label` is free (`taken` holds the names in use). Returns the name, or undefined when nothing was bound. */
export function inferLabel(root: Element, taken: ReadonlySet<string>): string | undefined {
  if (taken.has('label')) return undefined
  const leaves: Element[] = []
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el.tagName === 'style' || el.tagName === 'script' || el.tagName === 'svg') continue
    if (attrOf(el, INSTANCE_ATTR) || el.tagName === USE_TAG || attrOf(el, SLOT_ATTR) !== undefined) return undefined
    if (elementKids(el).length === 0 && directText(el)) leaves.push(el)
    stack.push(...elementKids(el).reverse())
  }
  const only = leaves[0]
  if (leaves.length !== 1 || !only || attrOf(only, BIND_ATTR) !== undefined) return undefined
  setAttr(only, BIND_ATTR, 'label')
  return 'label'
}

/* ------------------------------------------------------------------ */
/* Shape matching: lookalikes and repeated structures                  */
/* ------------------------------------------------------------------ */

const MAX_SHAPE_ELEMENTS = 200

export interface Measured {
  /** elements in this subtree, itself included */
  size: number
  /** undefined past MAX_SHAPE_ELEMENTS: nothing that large is one design */
  shape?: string
}

const skipsShape = (el: Element) => el.tagName === 'style' || el.tagName === 'script'

/** Every element's size and shape below a node, bottom-up and without recursion or
 *  re-walking: frame HTML is untrusted, and may nest deeper than the call stack allows.
 *  A shape is tags and classes in order, ignoring content: two elements that share one
 *  are the same design with different words in it. */
export function measureTree(root: ParentNode): Map<Element, Measured> {
  const measured = new Map<Element, Measured>()
  const order: Element[] = []
  const stack: Element[] = elementKids(root)
  if (isElement(root as ChildNode)) stack.push(root as Element)
  for (let el = stack.pop(); el; el = stack.pop()) {
    order.push(el)
    stack.push(...elementKids(el))
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const el = order[i]!
    const kids = elementKids(el)
    const kidValues = kids.map((kid) => measured.get(kid))
    const size = 1 + kidValues.reduce((total, kid) => total + (kid?.size ?? 0), 0)
    const counted = kids.flatMap((kid, index) => (skipsShape(kid) ? [] : [kidValues[index]]))
    if (size > MAX_SHAPE_ELEMENTS || counted.some((kid) => kid?.shape === undefined)) {
      measured.set(el, { size })
      continue
    }
    const classes = (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean).sort().join('.')
    const inner = counted.map((kid) => kid?.shape).join(',')
    measured.set(el, { size, shape: `${el.tagName}${classes ? `.${classes}` : ''}(${inner})` })
  }
  return measured
}

export function shapeOf(el: Element): string | undefined {
  return measureTree(el).get(el)?.shape
}

export function elementCount(el: Element): number {
  return measureTree(el).get(el)?.size ?? 1
}

export function kidsOf(el: ParentNode): Element[] {
  return elementKids(el)
}
