import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'

type Element = Tree.Element
import {
  ATTR_IF_ATTR,
  BIND_ATTR,
  IF_ATTR,
  INSTANCE_ATTR,
  PART_ATTR,
  PROPS_ATTR,
  SOURCE_CSS_ATTR,
  formatAttrConditions,
  isPropName,
  parseAttrConditions,
  parseBindings,
  parseCondition,
  styleText,
  variantAttrs,
  type Condition,
  type ComponentDef,
  type ComponentProp,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR, isElementId } from '../shared/elementId.ts'
import type { Actor } from '../shared/types.ts'
import {
  ComponentError,
  changeInstances,
  findComponent,
  updateComponent,
  usageOf,
  type InstanceChange,
  type UpdateResult,
} from './componentActions.ts'
import {
  MANAGED_STYLE_ATTRS,
  parseCss,
  selectorBelongsTo,
  serializeNodes,
  splitTopLevel,
  type CssNode,
} from './componentCss.ts'
import { attrOf, findAllMarked, kidsOf, parseTemplateRoot, partsOf, setAttr } from './componentEngine.ts'
import { atomic } from './journal.ts'
import { store } from './store.ts'
import type { VariantOp } from '../shared/componentSchemas.ts'

/**
 * Variant authoring on a component's main: enum values, boolean variants and the style of each combination,
 * written the way a person would write them by hand (a prop on the component, `[data-<prop>="<value>"]` rules in its
 * stylesheet), so everything that reads variants (instances, the React export, the Design tab) sees one thing.
 * One call is one main write: one revision, normal propagation, and the instances that held a changed value are
 * rewritten in the same operation. Spec: .context/specs/components.md.
 */

export type { VariantOp }

export const MAX_VARIANT_OPS = 40
const VALUE = /^[A-Za-z0-9_][\w .-]{0,39}$/
const PROPERTY = /^(?:--[\w-]+|-?[a-z][a-z-]*)$/
const MAX_DECLARATION_VALUE = 400
const ROOT_ELEMENT = 'root'
const PART_KEY = /^[\w-]+$/

const fail = (message: string): never => {
  throw new ComponentError(message)
}

type PropsMap = (props: Record<string, string>) => Record<string, string>

interface Work {
  def: ComponentDef
  props: ComponentProp[]
  /** the props before the call: a rule written for a prop an edit renames or removes is still this main's */
  initialProps: ComponentProp[]
  propsChanged: boolean
  /** the main frame's stylesheets, in document order: the component's own source block and any block of the design the main came from */
  blocks: string[]
  /** where a new rule goes: the source block (a virtual one when the main has none yet) */
  target: number
  cssChanged: boolean
  template: string
  templateChanged: boolean
  maps: PropsMap[]
}

/** A variant rule as the editor and agents read it. `custom` rules are hand-written ones that name a variant attribute. */
export interface VariantRule {
  selector: string
  /** the variant combination, prop -> value */
  when: Record<string, string>
  /** the part key the rule styles, `null` for the main root, absent on a custom rule */
  element?: string | null
  declarations: Record<string, string>
  custom?: true
}

export interface VariantProp {
  name: string
  type: 'enum' | 'boolean'
  options: string[]
  default?: string
  description?: string
}

export interface VariantResult extends Omit<UpdateResult, 'component'> {
  component: ComponentDef
  props: VariantProp[]
  rules: VariantRule[]
  /** instances whose stored value was rewritten (or would be, on a dry run) */
  instances_updated: number
  frames_updated: number
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const isVariantProp = (prop: ComponentProp) =>
  prop.type === 'enum' || (prop.type === 'boolean' && prop.reflect === true)

export function variantProps(props: readonly ComponentProp[]): VariantProp[] {
  return props.filter(isVariantProp).map((prop) => ({
    name: prop.name,
    type: prop.type === 'enum' ? 'enum' : 'boolean',
    options: prop.type === 'enum' ? [...(prop.options ?? [])] : ['true', 'false'],
    ...(prop.default !== undefined ? { default: prop.default } : {}),
    ...(prop.description ? { description: prop.description } : {}),
  }))
}

function declarationMap(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const piece of splitTopLevel(body, ';')) {
    const colon = piece.indexOf(':')
    if (colon <= 0) continue
    map.set(piece.slice(0, colon).trim(), piece.slice(colon + 1).trim())
  }
  return map
}

const ATTR_IN_SELECTOR = /\[\s*(data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g

/** `[data-a="x"][data-b="y"]` on the instance root, then optionally one element by part key: what `set_style` writes. */
const CANONICAL = /^((?:\[data-[\w-]+="[^"]*"\])+)(?: \[data-doop-part="([^"]+)"\])?$/

function ruleOf(selector: string, body: string, names: Set<string>): VariantRule | undefined {
  const when: Record<string, string> = {}
  for (const [, attr = '', quoted, single, bare] of selector.matchAll(ATTR_IN_SELECTOR)) {
    if (names.has(attr)) when[attr.slice('data-'.length)] = quoted ?? single ?? bare ?? ''
  }
  if (!Object.keys(when).length) return undefined
  const declarations = Object.fromEntries(declarationMap(body))
  const canonical = CANONICAL.exec(selector.trim())
  if (!canonical) return { selector, when, declarations, custom: true }
  return { selector, when, element: canonical[2] ?? null, declarations }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every rule of the stylesheet that names a variant attribute, at any depth of media and supports groups. */
export function variantRules(def: Pick<ComponentDef, 'props' | 'rawCss'>): VariantRule[] {
  const names = new Set(variantAttrs(def.props))
  if (!names.size || !def.rawCss) return []
  const rules: VariantRule[] = []
  const visit = (nodes: CssNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'group') visit(node.nodes)
      else if (node.kind === 'rule') {
        for (const selector of splitTopLevel(node.selector, ',')) {
          const rule = ruleOf(selector, node.body, names)
          if (rule) rules.push(rule)
        }
      }
    }
  }
  visit(parseCss(def.rawCss))
  return rules
}

export function readVariants(canvasId: string, ref: string) {
  const def = findComponent(canvasId, ref)
  if (!def) return fail(`no component “${ref}” on this canvas`)
  return { component: def, props: variantProps(def.props), rules: variantRules(def) }
}

/* ------------------------------------------------------------------ */
/* The main frame's stylesheets                                        */
/* ------------------------------------------------------------------ */

interface StyleBlock {
  start: number
  end: number
  text: string
  source: boolean
}

/** The `<style>` blocks of a frame that feed a component's stylesheet: its own source block and the design's own blocks, never another component's source or a Doop-managed block. */
function styleBlocks(html: string, id: string): StyleBlock[] {
  const blocks: StyleBlock[] = []
  for (const match of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    const attrs = match[1] ?? ''
    if ([...MANAGED_STYLE_ATTRS].some((name) => attrs.includes(name))) continue
    const own = new RegExp(`${SOURCE_CSS_ATTR}="${escapeRegExp(id)}"`).test(attrs)
    if (attrs.includes(SOURCE_CSS_ATTR) && !own) continue
    const start = match.index + '<style'.length + attrs.length + 1
    blocks.push({ start, end: start + (match[2] ?? '').length, text: match[2] ?? '', source: own })
  }
  return blocks
}

function loadBlocks(def: ComponentDef): { blocks: string[]; target: number; found: StyleBlock[] } {
  const frame = def.mainFrameId ? store.getFrame(def.mainFrameId) : undefined
  const found = frame ? styleBlocks(frame.html, def.id) : []
  const source = found.findIndex((block) => block.source)
  const blocks = found.map((block) => block.text)
  if (source >= 0) return { blocks, target: source, found }
  /* no source block yet: a new one takes new rules, and holds the component's rules outright when there is no main frame to read */
  return { blocks: [...blocks, frame ? '' : def.rawCss], target: blocks.length, found }
}

/* ------------------------------------------------------------------ */
/* Stylesheet edits                                                    */
/* ------------------------------------------------------------------ */

const attrPattern = (prop: string, value?: string) => {
  const inner =
    value === undefined ? '[^\\]]*' : `(?:"${escapeRegExp(value)}"|'${escapeRegExp(value)}'|${escapeRegExp(value)})`
  return new RegExp(`\\[\\s*data-${escapeRegExp(prop)}\\s*=\\s*${inner}\\s*\\]`, 'g')
}

/** The selector with its `:not(…)` groups taken out, to ask whether a value is wanted rather than excluded. */
const withoutNegations = (selector: string) => selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '')

const attrSelector = (prop: string, value: string) => `[data-${prop}="${value}"]`

/** Rewrite every selector of the sheet through `fn` (null drops it), dropping rules and groups left empty. */
function rewriteSelectors(nodes: CssNode[], fn: (selector: string) => string | null): CssNode[] {
  return nodes.flatMap((node): CssNode[] => {
    if (node.kind === 'group') {
      const inner = rewriteSelectors(node.nodes, fn)
      return inner.length ? [{ ...node, nodes: inner }] : []
    }
    if (node.kind !== 'rule') return [node]
    const kept = splitTopLevel(node.selector, ',').flatMap((selector) => {
      const next = selector ? fn(selector) : null
      return next === null ? [] : [next]
    })
    return kept.length ? [{ ...node, selector: kept.join(', ') }] : []
  })
}

/** Whether a rule found in a stylesheet this component does not own (its design frame's own, shared with other mains) is this main's. */
function belongsToMain(work: Work, selector: string): boolean {
  const root = parseTemplateRoot(work.template)
  return !!root && selectorBelongsTo(selector, root, variantAttrs([...work.initialProps, ...work.props]))
}

/** `fn` on every selector of the stylesheets that mention `mention`: all of the component's source block, and in a design's own
 *  blocks only the rules that belong to this main, so another main's variants in the same frame are left alone. */
function editSheet(work: Work, mention: string, fn: (selector: string) => string | null) {
  work.blocks = work.blocks.map((block, at) => {
    if (!block.includes(mention)) return block
    const next = serializeNodes(
      rewriteSelectors(parseCss(block), (selector) =>
        at === work.target || belongsToMain(work, selector) ? fn(selector) : selector,
      ),
    )
    if (next !== block) work.cssChanged = true
    return next
  })
}

function balanced(text: string): boolean {
  let depth = 0
  let quote = ''
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth < 0) return false
  }
  return depth === 0 && quote === ''
}

/** A declaration an agent or the editor may write into a variant rule: never something that fetches, ends the rule or the style element. */
const VALUE_FUNCTIONS = new Set([
  'var',
  'env',
  'calc',
  'min',
  'max',
  'clamp',
  'minmax',
  'repeat',
  'fit-content',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'translate',
  'translatex',
  'translatey',
  'translatez',
  'translate3d',
  'scale',
  'scalex',
  'scaley',
  'scalez',
  'scale3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'skew',
  'skewx',
  'skewy',
  'matrix',
  'matrix3d',
  'perspective',
  'cubic-bezier',
  'steps',
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
])

/** A declaration an agent or the editor may write into a variant rule: never something that fetches, ends the rule or the style element.
 *  Value functions are an allowlist (colour, maths, gradient, transform, easing, filter): every other one can load a resource or run in some engine. */
export function checkDeclaration(property: string, value: string): { property: string; value: string } {
  const name = property.trim()
  if (!PROPERTY.test(name) || /^-?(?:behavior|-?moz-binding)$/i.test(name))
    fail(
      `“${property}” is not a CSS property name: use lowercase letters and hyphens (color, padding-inline) or a custom property (--gap)`,
    )
  const text = value.trim()
  if (text.length > MAX_DECLARATION_VALUE)
    fail(`the value of ${name} is longer than ${MAX_DECLARATION_VALUE} characters`)
  if ([...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f))
    fail(`the value of ${name} may not hold control characters or line breaks`)
  if (/[{};<>\\]|\/\*|\*\/|@import|javascript:|vbscript:|-moz-binding|behavior\s*:/i.test(text))
    fail(
      `the value of ${name} may not hold braces, semicolons, backslashes, comments, @import or script URLs: write one plain value (var(--token), 12px, #fff, 1px solid var(--line))`,
    )
  for (const [, fn = ''] of text.matchAll(/([a-zA-Z][\w-]*)\s*\(/g)) {
    if (!VALUE_FUNCTIONS.has(fn.toLowerCase()))
      fail(
        `the value of ${name} uses ${fn}(): only colour, maths (calc, min, max, clamp, var, env), gradient, transform, easing and filter functions are allowed; images and fonts come from the design, not from a variant rule`,
      )
  }
  if (!balanced(text)) fail(`the value of ${name} has unbalanced parentheses or quotes`)
  return { property: name.startsWith('--') ? name : name.toLowerCase(), value: text }
}

function elementsBelow(root: Element): Element[] {
  const out: Element[] = []
  const stack = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    out.push(el)
    stack.push(...kidsOf(el))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Template references                                                 */
/* ------------------------------------------------------------------ */

interface Reference {
  part: string
  where: 'condition' | 'binding'
}

function formatCondition(condition: Condition): string {
  return condition.equals === undefined
    ? `${condition.negate ? '!' : ''}${condition.prop}`
    : `${condition.prop}${condition.negate ? '!=' : '='}${condition.equals}`
}

/** Where the template mentions a prop in a condition or a binding, with an optional rewrite of the conditions that do. */
function templateReferences(
  work: Work,
  prop: string,
  rewrite?: (condition: Condition) => Condition,
): { references: Reference[]; template: string } {
  const root = parseTemplateRoot(work.template)
  if (!root) return { references: [], template: work.template }
  const references: Reference[] = []
  let changed = false
  for (const el of elementsBelow(root)) {
    const part = attrOf(el, PART_ATTR) ?? el.tagName
    const shown = attrOf(el, IF_ATTR)
    const condition = shown === undefined ? null : parseCondition(shown)
    if (condition?.prop === prop) {
      references.push({ part, where: 'condition' })
      if (rewrite) {
        const next = formatCondition(rewrite(condition))
        if (next !== shown) {
          setAttr(el, IF_ATTR, next)
          changed = true
        }
      }
    }
    const raw = attrOf(el, ATTR_IF_ATTR)
    if (raw !== undefined) {
      const entries = parseAttrConditions(raw)
      let touched = false
      for (const entry of entries) {
        entry.conditions = entry.conditions.map((one) => {
          if (one.prop !== prop) return one
          references.push({ part, where: 'condition' })
          if (!rewrite) return one
          touched = true
          return rewrite(one)
        })
      }
      if (touched) {
        setAttr(el, ATTR_IF_ATTR, formatAttrConditions(entries))
        changed = true
      }
    }
    const bindings = attrOf(el, BIND_ATTR)
    if (bindings !== undefined && parseBindings(bindings, el.tagName).some((binding) => binding.prop === prop))
      references.push({ part, where: 'binding' })
  }
  return { references, template: changed ? serializeOuter(root) : work.template }
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

function variant(work: Work, name: string): ComponentProp {
  const prop = work.props.find((candidate) => candidate.name === name)
  if (!prop) return fail(`${work.def.name} has no prop “${name}”: ${describeVariants(work.props)}`)
  if (!isVariantProp(prop))
    return fail(
      `“${name}” is a ${prop.type} prop, not a variant: only enums and booleans with reflect style instances (add_boolean on it makes a boolean one)`,
    )
  return prop
}

function describeVariants(props: readonly ComponentProp[]): string {
  const named = variantProps(props).map((prop) => `${prop.name} (${prop.options.join(' | ')})`)
  return named.length ? `its variants are ${named.join(', ')}` : 'it has no variants yet (add_enum or add_boolean)'
}

function enumProp(work: Work, name: string): ComponentProp & { options: string[] } {
  const prop = variant(work, name)
  if (prop.type !== 'enum' || !prop.options)
    return fail(`“${name}” is a boolean variant: it has no values to change (it is true or false)`)
  return prop as ComponentProp & { options: string[] }
}

function validValue(value: string, what: string): string {
  if (!VALUE.test(value))
    return fail(
      `${what} “${value}” must be a short word of letters, digits, spaces, dots, hyphens or underscores (at most 40 characters)`,
    )
  return value
}

function replaceProp(work: Work, next: ComponentProp, was = next.name) {
  const current = work.props.find((prop) => prop.name === was)
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  work.props = work.props.map((prop) => (prop.name === was ? next : prop))
  work.propsChanged = true
}

function requireNewProp(work: Work, name: string) {
  if (!isPropName(name))
    fail(
      `prop name “${name}” must be lowercase letters, digits and hyphens, and not one <doop-use> keeps for itself (component, id, class, style, overrides, slot, data-doop-*)`,
    )
  if (work.props.some((prop) => prop.name === name)) fail(`${work.def.name} already has a prop “${name}”`)
}

function whenSelector(work: Work, when: Record<string, string>): string {
  const names = Object.keys(when).sort()
  if (!names.length) fail('when needs at least one variant prop and value, e.g. { "size": "lg" }')
  return names
    .map((name) => {
      const prop = variant(work, name)
      const value = when[name]!
      const allowed = prop.type === 'enum' ? (prop.options ?? []) : ['true', 'false']
      if (!allowed.includes(value)) fail(`“${value}” is not a value of ${name}: use ${allowed.join(' | ')}`)
      /* a value stored before this tool existed may be anything: it never goes into a selector unchecked */
      if (!VALUE.test(value))
        fail(`“${value}” cannot be styled here: rename it to a short word (rename_value), then style it`)
      return attrSelector(name, value)
    })
    .join('')
}

function rootKeyOf(work: Work): string {
  const key = attrOf(parseTemplateRoot(work.template) ?? ({ attrs: [] } as never), PART_ATTR)
  if (!key) return fail(`${work.def.name} has no main markup to style yet`)
  return key
}

function partSelector(work: Work, element: string, when: string): string {
  const rootKey = rootKeyOf(work)
  if (element === ROOT_ELEMENT || element === rootKey) return when
  if (!PART_KEY.test(element) || !partsOf(work.template).has(element)) {
    const keys = [...partsOf(work.template).keys()].filter((key) => key !== rootKey)
    return fail(
      `the main has no element “${element}”: its data-doop-part keys are ${keys.join(', ') || '(none)'} (“root” is the main root)`,
    )
  }
  return `${when} [${PART_ATTR}="${element}"]`
}

function setStyle(
  work: Work,
  element: string,
  whenMap: Record<string, string>,
  declarations: Record<string, string | null>,
) {
  const selector = partSelector(work, element, whenSelector(work, whenMap))
  /* the rule is edited where it already is (a design's own stylesheet may hold it), else it goes in the source block */
  const holder = work.blocks.findIndex(
    (block, at) =>
      (at === work.target || selector.includes(PART_ATTR)) &&
      parseCss(block).some((node) => node.kind === 'rule' && node.selector.trim() === selector),
  )
  const at = holder >= 0 ? holder : work.target
  const nodes = parseCss(work.blocks[at] ?? '')
  const index = nodes.findIndex((node) => node.kind === 'rule' && node.selector.trim() === selector)
  const existing = index >= 0 ? nodes[index] : undefined
  const current = existing?.kind === 'rule' ? declarationMap(existing.body) : new Map<string, string>()
  const before = JSON.stringify([...current])
  for (const [property, value] of Object.entries(declarations)) {
    if (value === null || value.trim() === '') {
      current.delete(checkDeclaration(property, 'x').property)
      continue
    }
    const checked = checkDeclaration(property, value)
    current.set(checked.property, checked.value)
  }
  if (JSON.stringify([...current]) === before) return
  const next: CssNode | undefined = current.size
    ? {
        kind: 'rule',
        selector,
        body: `\n${[...current].map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n`,
      }
    : undefined
  if (index >= 0) nodes.splice(index, 1, ...(next ? [next] : []))
  else if (next) nodes.push(next)
  work.blocks[at] = serializeNodes(nodes)
  work.cssChanged = true
}

function clearStyle(work: Work, whenMap: Record<string, string>, element?: string) {
  const root = whenSelector(work, whenMap)
  const exact = element === undefined ? undefined : partSelector(work, element, root)
  editSheet(work, 'data-', (selector) => {
    const text = selector.trim()
    const mine = exact === undefined ? text === root || text.startsWith(`${root} [${PART_ATTR}=`) : text === exact
    return mine ? null : selector
  })
}

function apply(work: Work, op: VariantOp) {
  switch (op.op) {
    case 'add_enum': {
      requireNewProp(work, op.prop)
      const options = op.options.map((value) => validValue(value, 'value'))
      if (new Set(options).size !== options.length) fail(`the values of ${op.prop} must be different from each other`)
      const def = op.default ?? options[0]!
      if (!options.includes(def)) fail(`the default “${def}” is not one of ${options.join(' | ')}`)
      work.props = [
        ...work.props,
        {
          name: op.prop,
          type: 'enum',
          options,
          default: def,
          ...(op.description ? { description: op.description } : {}),
        },
      ]
      work.propsChanged = true
      return
    }
    case 'add_value': {
      const prop = enumProp(work, op.prop)
      validValue(op.value, 'value')
      if (prop.options.includes(op.value))
        fail(`${op.prop} already has the value “${op.value}” (${prop.options.join(' | ')})`)
      replaceProp(work, {
        ...prop,
        options: [...prop.options, op.value],
        ...(op.make_default ? { default: op.value } : {}),
      })
      return
    }
    case 'rename_value': {
      const prop = enumProp(work, op.prop)
      if (!prop.options.includes(op.from)) fail(`${op.prop} has no value “${op.from}”: use ${prop.options.join(' | ')}`)
      validValue(op.to, 'value')
      if (op.to === op.from) return
      if (prop.options.includes(op.to))
        fail(`${op.prop} already has the value “${op.to}”: remove_value “${op.from}” to merge it into that one`)
      replaceProp(work, {
        ...prop,
        options: prop.options.map((value) => (value === op.from ? op.to : value)),
        ...(prop.default === op.from ? { default: op.to } : {}),
      })
      editSheet(work, `data-${op.prop}`, (selector) =>
        selector.replace(attrPattern(op.prop, op.from), attrSelector(op.prop, op.to)),
      )
      const { template } = templateReferences(work, op.prop, (condition) =>
        condition.equals === op.from ? { ...condition, equals: op.to } : condition,
      )
      if (template !== work.template) {
        work.template = template
        work.templateChanged = true
      }
      work.maps.push((props) => (props[op.prop] === op.from ? { ...props, [op.prop]: op.to } : props))
      return
    }
    case 'remove_value': {
      const prop = enumProp(work, op.prop)
      if (!prop.options.includes(op.value))
        fail(`${op.prop} has no value “${op.value}”: use ${prop.options.join(' | ')}`)
      const rest = prop.options.filter((value) => value !== op.value)
      if (!rest.length)
        fail(
          `“${op.value}” is the last value of ${op.prop}: remove the prop instead (remove_prop), or add another value first`,
        )
      let next = prop.default
      if (prop.default === op.value || prop.default === undefined) {
        if (op.new_default === undefined)
          fail(`“${op.value}” is the default of ${op.prop}: pass new_default, one of ${rest.join(' | ')}`)
        next = op.new_default
      }
      if (next !== undefined && !rest.includes(next)) fail(`new_default “${next}” is not one of ${rest.join(' | ')}`)
      replaceProp(work, { ...prop, options: rest, ...(next !== undefined ? { default: next } : {}) })
      /* only a rule that asks for the value goes; one that excludes it (:not([data-size="sm"])) keeps matching the rest */
      editSheet(work, `data-${op.prop}`, (selector) =>
        attrPattern(op.prop, op.value).test(withoutNegations(selector)) ? null : selector,
      )
      work.maps.push((props) => {
        if (props[op.prop] !== op.value) return props
        const { [op.prop]: _gone, ...others } = props
        return others
      })
      return
    }
    case 'set_default': {
      const prop = variant(work, op.prop)
      const allowed = prop.type === 'enum' ? (prop.options ?? []) : ['true', 'false']
      if (!allowed.includes(op.value)) fail(`“${op.value}” is not a value of ${op.prop}: use ${allowed.join(' | ')}`)
      replaceProp(work, { ...prop, default: op.value })
      return
    }
    case 'add_boolean': {
      const existing = work.props.find((prop) => prop.name === op.prop)
      if (existing) {
        if (existing.type !== 'boolean')
          fail(
            `${work.def.name} already has ${/^[aeiou]/.test(existing.type) ? 'an' : 'a'} ${existing.type} prop “${op.prop}”`,
          )
        if (existing.reflect) fail(`${op.prop} is already a boolean variant`)
        replaceProp(work, {
          ...existing,
          reflect: true,
          ...(existing.default === undefined ? { default: 'false' } : {}),
        })
        return
      }
      requireNewProp(work, op.prop)
      work.props = [
        ...work.props,
        {
          name: op.prop,
          type: 'boolean',
          reflect: true,
          default: op.default ? 'true' : 'false',
          ...(op.description ? { description: op.description } : {}),
        },
      ]
      work.propsChanged = true
      return
    }
    case 'rename_prop': {
      const prop = variant(work, op.prop)
      if (op.to === op.prop) return
      requireNewProp(work, op.to)
      const found = templateReferences(work, op.prop, (condition) => ({ ...condition, prop: op.to }))
      const binding = found.references.find((reference) => reference.where === 'binding')
      if (binding)
        fail(
          `${op.prop} is bound to content at “${binding.part}” in the template: rename it with update_component (find + replace on the template, then props)`,
        )
      replaceProp(work, { ...prop, name: op.to }, op.prop)
      if (found.template !== work.template) {
        work.template = found.template
        work.templateChanged = true
      }
      editSheet(work, `data-${op.prop}`, (selector) =>
        selector.replace(new RegExp(`\\[\\s*data-${escapeRegExp(op.prop)}(?=\\s*[=\\]~|^$*])`, 'g'), `[data-${op.to}`),
      )
      work.maps.push((props) => {
        if (!(op.prop in props)) return props
        const { [op.prop]: value, ...others } = props
        return { ...others, [op.to]: value! }
      })
      return
    }
    case 'remove_prop': {
      variant(work, op.prop)
      const found = templateReferences(work, op.prop)
      if (found.references.length) {
        const first = found.references[0]!
        fail(
          `${op.prop} is used by the template (${first.where} at “${first.part}”${found.references.length > 1 ? ` and ${found.references.length - 1} more` : ''}): change those with update_component first`,
        )
      }
      work.props = work.props.filter((prop) => prop.name !== op.prop)
      work.propsChanged = true
      editSheet(work, `data-${op.prop}`, (selector) => (attrPattern(op.prop).test(selector) ? null : selector))
      work.maps.push((props) => {
        if (!(op.prop in props)) return props
        const { [op.prop]: _gone, ...others } = props
        return others
      })
      return
    }
    case 'set_style':
      setStyle(work, op.element, op.when, op.declarations)
      return
    case 'clear_style':
      clearStyle(work, op.when, op.element)
      return
  }
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

/** The frame with each of its existing stylesheets that changed rewritten, last first so the offsets hold. */
function restyleBlocks(id: string, original: StyleBlock[], next: string[]) {
  return (html: string): string => {
    const current = styleBlocks(html, id)
    let out = html
    for (let at = Math.min(current.length, original.length) - 1; at >= 0; at--) {
      const block = current[at]!
      if (next[at] === undefined || next[at] === original[at]!.text) continue
      out = `${out.slice(0, block.start)}${styleText(next[at]!)}${out.slice(block.end)}`
    }
    return out
  }
}

const asProps = (raw: string | undefined): Record<string, string> => {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

/** Rewrite the stored prop values of every instance of the component that `map` changes. */
function migrateInstances(
  canvasId: string,
  def: ComponentDef,
  map: PropsMap,
  actor: Actor,
  write: boolean,
): { instances: number; frames: number } {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return { instances: 0, frames: 0 }
  let instances = 0
  let frames = 0
  for (const used of usageOf(canvas, def.id).frames) {
    const frame = store.getFrame(used.id)
    if (!frame || !frame.html.includes(PROPS_ATTR)) continue
    const changes: InstanceChange[] = []
    for (const found of findAllMarked(frame.html, INSTANCE_ATTR)) {
      if (attrOf(found.el, INSTANCE_ATTR) !== def.id) continue
      const id = attrOf(found.el, ELEMENT_ID_ATTR)
      const props = asProps(attrOf(found.el, PROPS_ATTR))
      if (!isElementId(id) || JSON.stringify(map({ ...props })) === JSON.stringify(props)) continue
      changes.push({ instanceId: id, mapProps: map })
    }
    if (!changes.length) continue
    instances += changes.length
    frames += 1
    if (write) changeInstances(canvasId, frame.id, changes, actor)
  }
  return { instances, frames }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface VariantInput {
  ops: VariantOp[]
  expectedRev?: number
  dryRun?: boolean
}

export const editVariants = atomic(function editVariants(
  canvasId: string,
  ref: string,
  input: VariantInput,
  actor: Actor,
): VariantResult {
  const def = findComponent(canvasId, ref)
  if (!def) return fail(`no component “${ref}” on this canvas`)
  if (!input.ops.length) fail('ops is empty: pass at least one edit')
  if (input.ops.length > MAX_VARIANT_OPS) fail(`at most ${MAX_VARIANT_OPS} edits in one call`)
  if (input.expectedRev !== undefined && input.expectedRev !== def.rev)
    fail(
      `component “${def.name}” is at revision ${def.rev}, not ${input.expectedRev} — someone changed it; read it again`,
    )
  const loadedBlocks = loadBlocks(def)
  const work: Work = {
    def,
    props: def.props.map((prop) => ({ ...prop })),
    initialProps: def.props,
    propsChanged: false,
    ...loadedBlocks,
    cssChanged: false,
    template: def.template,
    templateChanged: false,
    maps: [],
  }
  input.ops.forEach((op, index) => {
    try {
      apply(work, op)
    } catch (error) {
      if (error instanceof ComponentError) throw new ComponentError(`edit ${index + 1} (${op.op}): ${error.message}`)
      throw error
    }
  })
  const map: PropsMap = (props) => work.maps.reduce((current, step) => step(current), props)
  if (input.dryRun) {
    const draft = { ...def, props: work.props, rawCss: work.blocks.join('\n'), template: work.template }
    const migrated = work.maps.length ? migrateInstances(canvasId, def, map, actor, false) : { instances: 0, frames: 0 }
    const impact = updateComponent(canvasId, def.id, { dryRun: true }, actor)
    return {
      ...impact,
      component: def,
      props: variantProps(draft.props),
      rules: variantRules(draft),
      instances_updated: migrated.instances,
      frames_updated: migrated.frames,
    }
  }
  if (!work.propsChanged && !work.cssChanged && !work.templateChanged) {
    return {
      ...updateComponent(canvasId, def.id, { dryRun: true }, actor),
      dry_run: false,
      component: def,
      props: variantProps(def.props),
      rules: variantRules(def),
      instances_updated: 0,
      frames_updated: 0,
    }
  }
  const result = updateComponent(
    canvasId,
    def.id,
    {
      ...(work.propsChanged ? { props: work.props } : {}),
      ...(work.cssChanged && work.target >= loadedBlocks.found.length && (work.blocks[work.target] || !def.mainFrameId)
        ? { css: work.blocks[work.target] }
        : {}),
      ...(work.cssChanged ? { restyle: restyleBlocks(def.id, loadedBlocks.found, work.blocks) } : {}),
      ...(work.templateChanged ? { html: work.template } : {}),
      ...(input.expectedRev !== undefined ? { expectedRev: input.expectedRev } : {}),
    },
    actor,
  )
  const migrated = work.maps.length
    ? migrateInstances(canvasId, result.component, map, actor, true)
    : { instances: 0, frames: 0 }
  const fresh = findComponent(canvasId, def.id) ?? result.component
  return {
    ...result,
    component: fresh,
    props: variantProps(fresh.props),
    rules: variantRules(fresh),
    instances_updated: migrated.instances,
    frames_updated: migrated.frames,
  }
})
