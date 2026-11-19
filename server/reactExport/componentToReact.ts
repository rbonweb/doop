import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import {
  BIND_ATTR,
  ATTR_IF_ATTR,
  IF_ATTR,
  SLOT_ATTR,
  USE_TAG,
  isPropName,
  parseBindings,
  parseAttrConditions,
  parseCondition,
  parseStyle,
  serializeStyle,
  type Binding,
  type ComponentDef,
  type ComponentProp,
  type Condition,
  type InstanceOverrides,
} from '../../shared/components.ts'
import { isBareSpecifier, type ComponentCode } from '../../shared/componentCode.ts'
import {
  attrOf,
  isElement,
  parseTemplateRoot,
  partsOf,
  stateFromUseAttrs,
  type EngineContext,
  type InstanceState,
} from '../componentEngine.ts'
import { moduleClassName, safeClass, safeClassCss, splitComponentCss, type CssModuleSplit } from './cssSplit.ts'
import { componentDocument, googleFontsUrl, hostedFontUrl } from './fonts.ts'
import {
  nodeToJsx,
  htmlToJsx,
  styleToJsx,
  type AttrGuards,
  type HtmlToJsxOptions,
  type JsxContext,
} from './htmlToJsx.ts'
import { isUnsafeUrl, jsString, type ExportIssue } from './issues.ts'
import { NameAllocator, componentName, isIdentifier, propName } from './names.ts'
import { cssToTailwind, tailwindClassName, type TailwindSplit } from './tailwind.ts'
import type { ReactStyling } from './report.ts'
import type { UrlRewriter } from './urls.ts'

type Element = Tree.Element

/* ------------------------------------------------------------------ */
/* Kinds: how a Doop prop is typed in the generated code               */
/* ------------------------------------------------------------------ */

export type Kind =
  { k: 'string' } | { k: 'enum'; options: string[] } | { k: 'boolean' } | { k: 'number' } | { k: 'node' }

export function kindOf(prop: Pick<ComponentProp, 'type' | 'options'>): Kind {
  switch (prop.type) {
    case 'enum':
      return prop.options?.length ? { k: 'enum', options: [...prop.options] } : { k: 'string' }
    case 'boolean':
      return { k: 'boolean' }
    case 'number':
      return { k: 'number' }
    case 'instance':
      return { k: 'node' }
    default:
      return { k: 'string' }
  }
}

export function tsType(kind: Kind): string {
  switch (kind.k) {
    case 'enum':
      return kind.options.map((option) => jsString(option)).join(' | ')
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'node':
      return 'ReactNode'
    default:
      return 'string'
  }
}

const sameKind = (a: Kind, b: Kind): boolean =>
  a.k === b.k && (a.k !== 'enum' || (b.k === 'enum' && a.options.join('\u0000') === b.options.join('\u0000')))

/** An expression of kind `from` as an expression of kind `to`; `defined` says the value can never be undefined. Returns null when the two cannot meet. */
export function convertExpr(expr: string, from: Kind, to: Kind, defined: boolean): string | null {
  if (sameKind(from, to)) return expr
  const guard = (body: string) => (defined ? body : `${expr} === undefined ? undefined : ${body}`)
  if (to.k === 'string') {
    if (from.k === 'enum') return expr
    if (from.k === 'number' || from.k === 'boolean') return guard(`String(${expr})`)
    return null
  }
  if (to.k === 'enum') {
    if (from.k === 'string' || from.k === 'enum') return `(${expr}) as ${tsType(to)} | undefined`
    return null
  }
  if (to.k === 'number') {
    if (from.k === 'string' || from.k === 'enum') return guard(`Number(${expr})`)
    return null
  }
  if (to.k === 'boolean') {
    if (from.k === 'string' || from.k === 'enum') return `${expr} !== undefined && ${expr} !== "false"`
    return null
  }
  return from.k === 'node' ? expr : `(${expr})`
}

/* ------------------------------------------------------------------ */
/* The plan: what a component becomes                                  */
/* ------------------------------------------------------------------ */

export interface PropPlan {
  prop: ComponentProp
  /** the identifier in the generated code */
  ts: string
  kind: Kind
  /** a value the component falls back to, so the prop is never undefined inside it */
  hasDefault: boolean
  /** the template's own content for a text-like prop with no declared default */
  derived?: string
}

export interface SlotPlan {
  name: string
  ts: string
}

/** An enum prop whose values are components the export takes by reference: where they come from and the export each value names (null for a value that is not a usable identifier). */
export interface ComponentValues {
  importFrom?: string
  exports: Map<string, string | null>
}

/** A component an export file imports to pass by reference: `importFrom` is where it lives, `local` the name the file uses for it. */
export interface ComponentRef {
  importFrom: string
  exportName: string
  local: string
}

export interface MappedImport {
  importFrom: string
  exportName: string
  defaultExport: boolean
  code: ComponentCode
  /** Doop prop -> the prop it is passed as; `children` for the JSX children, null when omitted or refused */
  propTargets: Map<string, string | null>
  /** Doop prop -> why an instance's value is not passed: the mapping omits it, or its own name is no JavaScript identifier and the mapping does not rename it. Reported where an instance sets one. */
  leftOut: Map<string, 'omit' | 'name'>
  /** Doop slot -> `children` or the prop that receives it, null when refused */
  slotTargets: Map<string, string | null>
  /** Doop prop -> value map, own keys only */
  values: Map<string, Map<string, string | number | boolean>>
  /** Doop prop -> its values as component references, for an enum the mapping marks `component` */
  components: Map<string, ComponentValues>
}

export interface ComponentPlan {
  def: ComponentDef
  /** the identifier components import and render; for a mapped component the local name of the import */
  name: string
  propsName: string
  /** `src/components/<name>.tsx`, absent for a mapped component */
  file?: string
  mapped?: MappedImport
  /** what was wrong with the component's code mapping: reported where the component is used (or in its own file when it falls back to being generated) */
  mappingIssues: ExportIssue[]
  props: PropPlan[]
  propByName: Map<string, PropPlan>
  slots: SlotPlan[]
  slotByName: Map<string, SlotPlan>
  /** the component's own stylesheet: the CSS Modules split, or in Tailwind mode what did not convert */
  split: CssModuleSplit
  /** Tailwind mode: the utilities each class became */
  tw?: TailwindSplit
  /** issues found turning the CSS into `split` */
  cssIssues: ExportIssue[]
  /** classes the module sheet defines (what `styles["x"]` may look up) */
  moduleClasses: Set<string>
  rootClass: string
  /** the identifier a file other than the component's own imports its module as */
  stylesIdent: string
  /** props bound to URL attributes in the template, and the nested props forwarded to */
  directUrlProps: Set<string>
  forwards: { outer: string; nestedRef: string; inner: string }[]
}

const TEXT_LIKE = new Set(['text', 'image', 'link', 'color'])
const URL_BINDING_TARGETS = new Set([
  'href',
  'src',
  'poster',
  'action',
  'formaction',
  'data',
  'cite',
  'background',
  'ping',
  'srcset',
  'xlink:href',
])
const LOCAL_NAMES = [
  'styles',
  'cx',
  'React',
  'ReactNode',
  'Fragment',
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'JSON',
  'Math',
  'Symbol',
  'Date',
  'Promise',
]

export interface SessionOptions {
  components: readonly ComponentDef[]
  urls: UrlRewriter
  styling: ReactStyling
}

/** One export's shared state: which components exist, the names handed out, the plans made on demand and the files they need. */
export class ExportSession {
  readonly names = new NameAllocator({ caseInsensitive: true, reserved: ['index', ...LOCAL_NAMES] })
  readonly urls: UrlRewriter
  readonly styling: ReactStyling
  readonly customElements = new Set<string>()
  /** hosted font stylesheets (Google Fonts) any file needs: written to `src/fonts.css` */
  readonly fontLinks = new Set<string>()
  /** components in the order they were first needed: files are emitted in this order */
  readonly order: ComponentPlan[] = []
  private readonly defs: readonly ComponentDef[]
  private readonly plans = new Map<string, ComponentPlan>()
  private readonly urlMemo = new Map<string, boolean>()
  private readonly droppedDefaults = new Set<string>()
  private readonly droppedUses = new Set<string>()
  private readonly refs = new Map<string, ComponentRef>()

  constructor(options: SessionOptions) {
    this.defs = options.components
    this.urls = options.urls
    this.styling = options.styling
  }

  /** A component a mapped prop passes by reference (an icon): imported once per export, under a name no component or earlier import has. */
  ref(importFrom: string, exportName: string): ComponentRef {
    const key = `${importFrom}\u0000${exportName}`
    const known = this.refs.get(key)
    if (known) return known
    /* a prop local is camelCase, so a capitalized import name can never be shadowed by one */
    const wanted = /^[A-Z]/.test(exportName)
      ? exportName
      : `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}`
    const ref = { importFrom, exportName, local: this.names.take(wanted) }
    this.refs.set(key, ref)
    return ref
  }

  /** A component by id, then by name (exact, then case-insensitive): how the canvas resolves a reference. */
  find = (ref: string): ComponentDef | undefined => {
    const wanted = ref.trim().toLowerCase()
    return (
      this.defs.find((def) => def.id === ref) ??
      this.defs.find((def) => def.name === ref) ??
      this.defs.find((def) => def.name.toLowerCase() === wanted)
    )
  }

  engine(): EngineContext {
    const defs = this.defs
    return {
      find: this.find,
      atRev(id, rev) {
        const def = defs.find((candidate) => candidate.id === id)
        if (!def) return undefined
        if (def.rev === rev) return def
        const snapshot = def.history.find((entry) => entry.rev === rev)
        return snapshot ? { id, name: def.name, rev, template: snapshot.template, props: snapshot.props } : undefined
      },
      issues: [],
    }
  }

  plan(def: ComponentDef): ComponentPlan {
    const known = this.plans.get(def.id)
    if (known) return known
    const plan = this.makePlan(def)
    this.plans.set(def.id, plan)
    this.order.push(plan)
    return plan
  }

  /** Does a value given for this prop end up in a URL attribute of the generated code? Then it is held to the URL safety rules. */
  isUrlProp(plan: ComponentPlan, name: string, seen = new Set<string>()): boolean {
    const key = `${plan.def.id}\u0000${name}`
    const memo = this.urlMemo.get(key)
    if (memo !== undefined) return memo
    if (seen.has(key)) return false
    seen.add(key)
    const prop = plan.propByName.get(name)?.prop
    let result = prop?.type === 'image' || prop?.type === 'link' || plan.directUrlProps.has(name)
    if (!result) {
      for (const forward of plan.forwards) {
        if (forward.outer !== name) continue
        const nested = this.find(forward.nestedRef)
        if (nested && this.isUrlProp(this.plan(nested), forward.inner, seen)) {
          result = true
          break
        }
      }
    }
    this.urlMemo.set(key, result)
    return result
  }

  /** Does rendering `from` end up rendering the component `targetId`: through nested uses and instance-prop defaults still in force? */
  reaches(from: ComponentDef, targetId: string): boolean {
    const seen = new Set<string>()
    const stack = [from]
    for (let def = stack.pop(); def; def = stack.pop()) {
      if (def.id === targetId) return true
      if (seen.has(def.id)) continue
      seen.add(def.id)
      for (const match of def.template.matchAll(/\scomponent="([^"]+)"/g)) {
        const next = this.find(match[1] ?? '')
        if (next && !this.droppedUses.has(`${def.id}\u0000${next.id}`)) stack.push(next)
      }
      for (const prop of def.props) {
        if (prop.type !== 'instance' || !prop.default || this.droppedDefaults.has(`${def.id}\u0000${prop.name}`))
          continue
        const next = this.find(prop.default)
        if (next) stack.push(next)
      }
    }
    return false
  }

  /** a template's nested use of another component that would make the two render each other: left out of the export */
  dropUse(fromId: string, toId: string): void {
    this.droppedUses.add(`${fromId}\u0000${toId}`)
  }

  dropDefault(id: string, prop: string): void {
    this.droppedDefaults.add(`${id}\u0000${prop}`)
  }

  private makePlan(def: ComponentDef): ComponentPlan {
    const { mapped, issues: mappingIssues } = resolveMapping(def)
    const name = componentName(mapped ? mapped.exportName : def.name, this.names)
    const propsName = mapped ? '' : this.names.take(`${name}Props`)
    const locals = new NameAllocator({ reserved: LOCAL_NAMES })
    const root = parseTemplateRoot(def.template)
    const derived = new Map<string, string>()
    const directUrlProps = new Set<string>()
    const forwards: ComponentPlan['forwards'] = []
    if (root) collectBindings(root, derived, directUrlProps, forwards)

    const props: PropPlan[] = []
    const seenProps = new Set<string>()
    for (const prop of def.props) {
      if (!isPropName(prop.name) || seenProps.has(prop.name)) continue
      seenProps.add(prop.name)
      const kind = kindOf(prop)
      const declared = declaredDefault(prop, kind)
      const component = prop.type === 'instance' && prop.default ? this.find(prop.default) : undefined
      const text = TEXT_LIKE.has(prop.type) && prop.default === undefined ? derived.get(prop.name) : undefined
      props.push({
        prop,
        ts: mapped ? prop.name : propName(prop.name, locals),
        kind,
        hasDefault: prop.type === 'instance' ? component !== undefined : declared !== undefined || text !== undefined,
        ...(text !== undefined ? { derived: text } : {}),
      })
    }
    const slots: SlotPlan[] = []
    const seenSlots = new Set<string>()
    for (const slot of def.slots) {
      if (seenSlots.has(slot.name)) continue
      seenSlots.add(slot.name)
      slots.push({ name: slot.name, ts: mapped ? slot.name : propName(slot.name || 'children', locals) })
    }

    const rootClass = /root/i.test(def.rawCss) || /root/i.test(def.template) ? 'doop-root' : 'root'
    const rewriteUrl = this.urls.url
    const rawCss = safeClassCss(def.rawCss)
    const tw = this.styling === 'tailwind' ? cssToTailwind(rawCss, { rootClass, rewriteUrl }) : undefined
    const split = tw ? tw.leftover : splitComponentCss(rawCss, { rootClass, rewriteUrl })
    const cssIssues = tw ? [...tw.issues, ...tw.leftover.issues] : split.issues
    const plan: ComponentPlan = {
      def,
      name,
      propsName,
      ...(mapped ? { mapped } : { file: `src/components/${name}.tsx` }),
      mappingIssues,
      props,
      propByName: new Map(props.map((entry) => [entry.prop.name, entry])),
      slots,
      slotByName: new Map(slots.map((entry) => [entry.name, entry])),
      split,
      ...(tw ? { tw } : {}),
      cssIssues,
      moduleClasses: new Set(split.classes),
      rootClass,
      stylesIdent: mapped ? '' : this.names.take(`${name}Styles`),
      directUrlProps,
      forwards,
    }
    return plan
  }
}

const TARGET_NAME = /^[A-Za-z_$][\w$]*$/
const REACT_OWNED = new Set(['key', 'ref', 'dangerouslysetinnerhtml'])

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined

/** The code mapping of a definition as the export uses it, with every part that cannot be honoured refused and reported. A mapping that cannot be imported at all is ignored and the component generated. */
function resolveMapping(def: ComponentDef): { mapped?: MappedImport; issues: ExportIssue[] } {
  const code = def.code
  const issues: ExportIssue[] = []
  if (!code?.importFrom || !code.exportName) return { issues }
  const refuse = (detail: string) => issues.push({ kind: 'dropped-attribute', detail })
  if (!isIdentifier(code.exportName)) {
    refuse('code mapping ignored: its export name is not a valid identifier, so the component is generated')
    return { issues }
  }
  if (!isBareSpecifier(code.importFrom)) {
    refuse(
      'code mapping ignored: it must import from a package name such as @scope/name, so the component is generated',
    )
    return { issues }
  }
  const used = new Set<string>()
  const propTargets = new Map<string, string | null>()
  const leftOut = new Map<string, 'omit' | 'name'>()
  const slotTargets = new Map<string, string | null>()
  const values = new Map<string, Map<string, string | number | boolean>>()
  const components = new Map<string, ComponentValues>()
  const toChildren: string[] = []
  const claim = (label: string, wanted: string, renamed: boolean): string | null => {
    const lower = wanted.toLowerCase()
    if (REACT_OWNED.has(lower)) {
      refuse(`${label} is passed as ${jsString(wanted)}, which React reserves: it was left out`)
      return null
    }
    if (renamed ? !TARGET_NAME.test(wanted) : !/^[a-z][a-z0-9-]*$/.test(wanted)) {
      refuse(`${label} is passed as ${jsString(wanted)}, which is not a prop name: it was left out`)
      return null
    }
    if (wanted === 'children') toChildren.push(label)
    else {
      if (used.has(wanted)) {
        refuse(`${label} is passed as ${jsString(wanted)}, which another prop or slot already uses: it was left out`)
        return null
      }
      used.add(wanted)
    }
    return wanted
  }
  for (const prop of def.props) {
    if (!isPropName(prop.name)) continue
    const rule = own(code.props, prop.name)
    if (rule?.omit) {
      propTargets.set(prop.name, null)
      leftOut.set(prop.name, 'omit')
      continue
    }
    if (rule?.name === undefined && !isIdentifier(prop.name)) {
      /* a Doop prop such as `text-2` is no prop the package's component has, and the type checker rejects it: it is passed only when the mapping renames it */
      propTargets.set(prop.name, null)
      leftOut.set(prop.name, 'name')
      continue
    }
    propTargets.set(prop.name, claim(`prop ${jsString(prop.name)}`, rule?.name ?? prop.name, rule?.name !== undefined))
    if (rule?.component && prop.type === 'enum') {
      const importFrom = rule.component.importFrom
      const usable = importFrom !== undefined && isBareSpecifier(importFrom)
      if (importFrom !== undefined && !usable)
        refuse(
          `prop ${jsString(prop.name)} imports its components from ${jsString(importFrom)}, which is not a package name such as @scope/name: they are left for you to import`,
        )
      const exports = new Map<string, string | null>()
      for (const option of prop.options ?? []) {
        const named = own(rule.values, option)
        const wanted = typeof named === 'string' ? named : option
        exports.set(option, isIdentifier(wanted) ? wanted : null)
      }
      components.set(prop.name, { ...(usable ? { importFrom } : {}), exports })
    } else if (rule?.values) {
      const map = new Map<string, string | number | boolean>()
      const allowed =
        prop.type === 'boolean' ? ['true', 'false'] : prop.type === 'enum' ? (prop.options ?? []) : undefined
      for (const [key, value] of Object.entries(rule.values)) {
        if (allowed && !allowed.includes(key)) {
          refuse(
            `value map of ${jsString(prop.name)} names ${jsString(key)}, which is not one of its values: it was left out`,
          )
          continue
        }
        map.set(key, value)
      }
      values.set(prop.name, map)
    }
  }
  for (const slot of def.slots) {
    const wanted = own(code.slots, slot.name) ?? slot.name
    slotTargets.set(slot.name, claim(`slot ${jsString(slot.name)}`, wanted, own(code.slots, slot.name) !== undefined))
  }
  if (toChildren.length > 1)
    refuse(
      `${toChildren.join(' and ')} are all passed as the children of ${jsString(code.exportName)}, so they render one after another: send all but one to a prop`,
    )
  return {
    mapped: {
      importFrom: code.importFrom,
      exportName: code.exportName,
      defaultExport: code.defaultExport === true,
      code,
      propTargets,
      leftOut,
      slotTargets,
      values,
      components,
    },
    issues,
  }
}

/** A declared default as the TypeScript expression it becomes, or undefined when there is none or it does not fit the prop. */
function declaredDefault(prop: ComponentProp, kind: Kind): string | undefined {
  const value = prop.default
  if (value === undefined || prop.type === 'instance') return undefined
  switch (kind.k) {
    case 'enum':
      return kind.options.includes(value) ? jsString(value) : undefined
    case 'boolean':
      return value === 'false' ? 'false' : 'true'
    case 'number': {
      const number = Number(value)
      return value.trim() !== '' && Number.isFinite(number) ? String(number) : undefined
    }
    default:
      return jsString(value)
  }
}

/** What the template says about each prop where it is bound: its first literal content (a text-like prop's default), the props that land in URL attributes, and what is forwarded to nested components. */
function collectBindings(
  root: Element,
  derived: Map<string, string>,
  urlProps: Set<string>,
  forwards: ComponentPlan['forwards'],
): void {
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const raw = attrOf(el, BIND_ATTR)
    if (raw !== undefined) {
      const isUse = el.tagName === USE_TAG
      for (const { target, prop } of parseBindings(raw, el.tagName)) {
        if (isUse) {
          if (target) forwards.push({ outer: prop, nestedRef: attrOf(el, 'component') ?? '', inner: target })
          continue
        }
        if (target === null) {
          if (!derived.has(prop)) {
            const text = ownText(el)
            if (text) derived.set(prop, text)
          }
          continue
        }
        if (URL_BINDING_TARGETS.has(target)) urlProps.add(prop)
        if (derived.has(prop)) continue
        const literal = target.startsWith('style.')
          ? parseStyle(attrOf(el, 'style')).get(target.slice(6))
          : target.startsWith('--')
            ? parseStyle(attrOf(el, 'style')).get(target)
            : attrOf(el, target)
        if (literal) derived.set(prop, literal)
      }
    }
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const child = el.childNodes[i]
      if (child && isElement(child)) stack.push(child)
    }
  }
}

/** An element's own text, the way a text binding replaces it: the first text with something in it. */
function ownText(el: Element): string {
  for (const child of el.childNodes) {
    if (child.nodeName === '#text') {
      const value = (child as Tree.TextNode).value.replace(/\s+/g, ' ').trim()
      if (value) return value
    }
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* Per-file state                                                      */
/* ------------------------------------------------------------------ */

export interface FileInlined {
  component: string
  reason: string
}

/** What one generated file used, so its imports can be written, and what the converter found in it. */
export class FileCtx {
  readonly generated = new Set<ComponentPlan>()
  readonly mapped = new Set<ComponentPlan>()
  /** components passed by reference (icons) this file imports from a package */
  readonly refs = new Map<string, ComponentRef>()
  private readonly noted = new Set<string>()
  /** module sheets this file refers to by `styles[...]` */
  readonly styleUses = new Set<ComponentPlan>()
  usesCx = false
  usesNode = false
  usesCssProps = false
  usesFonts = false
  /** a page file in Tailwind mode: the utilities its own global classes became */
  pageTw?: TailwindSplit
  readonly issues: ExportIssue[] = []
  readonly inlined: FileInlined[] = []

  constructor(
    readonly session: ExportSession,
    readonly file: string,
  ) {}

  use(plan: ComponentPlan): void {
    if (plan.mapped && !this.mapped.has(plan)) this.issues.push(...plan.mappingIssues)
    ;(plan.mapped ? this.mapped : this.generated).add(plan)
  }

  note(kind: ExportIssue['kind'], detail: string): void {
    this.issues.push({ kind, detail })
  }

  /** One report line per distinct problem, however often a file repeats it. */
  noteOnce(kind: ExportIssue['kind'], detail: string): void {
    if (this.noted.has(detail)) return
    this.noted.add(detail)
    this.note(kind, detail)
  }

  /** A component a mapped prop passes by reference, imported by this file: the name it goes by here. */
  ref(importFrom: string, exportName: string): string {
    const ref = this.session.ref(importFrom, exportName)
    this.refs.set(`${ref.importFrom}\u0000${ref.exportName}`, ref)
    return ref.local
  }

  /** the className value for classes inside `plan`'s own markup */
  className(plan: ComponentPlan, rawClasses: string[], own: boolean, withRoot: boolean): string {
    const classes = rawClasses.map(safeClass)
    const rootUsed = plan.tw
      ? plan.tw.utilities.has(plan.rootClass) || plan.moduleClasses.has(plan.rootClass)
      : plan.moduleClasses.has(plan.rootClass)
    const list = withRoot && rootUsed ? [plan.rootClass, ...classes] : classes
    const ident = own ? 'styles' : plan.stylesIdent
    const value = plan.tw
      ? tailwindClassName(list, plan.tw, { styles: ident, cx: 'cx' })
      : moduleClassName(list, plan.moduleClasses, { styles: ident, cx: 'cx' })
    if (value.startsWith('{cx(')) this.usesCx = true
    if (value.includes(`${ident}[`)) this.styleUses.add(plan)
    return value
  }
}

/* ------------------------------------------------------------------ */
/* Calls: one component used inside another file                       */
/* ------------------------------------------------------------------ */

export interface CallValue {
  /** a JavaScript expression of the inner prop's kind */
  expr: string
  /** the Doop value when it is a literal; mapped components need it to apply a value map */
  literal?: string
}

export interface UseCall {
  plan: ComponentPlan
  /** inner Doop prop name -> value */
  values: Map<string, CallValue>
  /** inner slot name -> a JSX expression */
  slots: Map<string, string>
}

/** One literal Doop value as an expression of the target prop's kind; null when it does not fit (the engine ignores such a value too). */
export function literalValue(fc: FileCtx, plan: ComponentPlan, name: string, raw: string): CallValue | null {
  const entry = plan.propByName.get(name)
  if (!entry) return null
  const { kind } = entry
  switch (kind.k) {
    case 'enum':
      return kind.options.includes(raw) ? { expr: jsString(raw), literal: raw } : null
    case 'boolean':
      return { expr: raw === 'false' ? 'false' : 'true', literal: raw }
    case 'number': {
      const number = Number(raw)
      return raw.trim() !== '' && Number.isFinite(number) ? { expr: String(number), literal: raw } : null
    }
    case 'node': {
      const def = fc.session.find(raw)
      if (!def) {
        fc.note('dropped-attribute', `instance prop ${jsString(name)} names a component that is not in the export`)
        return null
      }
      const target = fc.session.plan(def)
      fc.use(target)
      return { expr: renderUseCall(fc, { plan: target, values: new Map(), slots: new Map() }), literal: raw }
    }
    default: {
      let value = raw
      if (fc.session.isUrlProp(plan, name)) {
        if (isUnsafeUrl(value)) {
          fc.note('unsafe-url', `value of ${jsString(name)} dropped: it is a URL that would run code`)
          return null
        }
        value = fc.session.urls.url(value)
      }
      return { expr: jsString(value), literal: raw }
    }
  }
}

export function deepReasons(overrides: InstanceOverrides): string[] {
  const reasons: string[] = []
  for (const [key, part] of Object.entries(overrides.parts ?? {})) {
    const kinds: string[] = []
    if (part.attrs && Object.keys(part.attrs).length) kinds.push('attributes')
    if (part.style && Object.keys(part.style).length) kinds.push('styles')
    if (part.tag) kinds.push('tag')
    if (part.text !== undefined) kinds.push('text')
    if (part.html !== undefined) kinds.push('markup')
    if (part.hidden) kinds.push('hidden')
    if (part.swap) kinds.push('swap')
    if (part.use && (Object.keys(part.use.props ?? {}).length || Object.keys(part.use.parts ?? {}).length)) {
      kinds.push('nested instance')
    }
    if (kinds.length) reasons.push(`${key}: ${kinds.join(', ')}`)
  }
  return reasons
}

/** The slot name a template part key stands for. */
export function slotNameOf(plan: ComponentPlan, key: string): string | undefined {
  const el = partsOf(plan.def.template).get(key)?.el
  if (!el || attrOf(el, SLOT_ATTR) === undefined) return undefined
  return attrOf(el, SLOT_ATTR) ?? ''
}

const indentText = (text: string, unit = '  '): string => text.replace(/^(?=.)/gm, unit)

/** `<Name a={…} slot={…} />`, or the mapped component's import form. */
export function renderUseCall(fc: FileCtx, call: UseCall): string {
  const { plan } = call
  fc.use(plan)
  const attrs: string[] = []
  const children: string[] = []
  const mapped = plan.mapped
  const addValue = (target: string, value: string, isBare: boolean) => {
    if (target === 'children') children.push(jsxChild(value))
    else if (isBare) attrs.push(target)
    else attrs.push(`${target}={${value}}`)
  }
  if (!mapped) {
    for (const entry of plan.props) {
      const value = call.values.get(entry.prop.name)
      if (value) {
        if (entry.kind.k === 'node') fc.usesNode = true
        addValue(entry.ts, value.expr, value.expr === 'true' && entry.kind.k === 'boolean')
      }
    }
    for (const slot of plan.slots) {
      const value = call.slots.get(slot.name)
      if (value !== undefined) addValue(slot.ts, value, false)
    }
  } else {
    for (const entry of plan.props) {
      const target = mapped.propTargets.get(entry.prop.name)
      if (!target) {
        const set = call.values.get(entry.prop.name)
        const why = mapped.leftOut.get(entry.prop.name)
        if (set && why && (why === 'name' || set.literal !== (entry.prop.default ?? entry.derived)))
          reportLeftOut(fc, plan, entry.prop.name, set, why)
        continue
      }
      const value = call.values.get(entry.prop.name)
      if (!value) {
        /* an export whose children are its label has nothing to show without them: the design shows the template's own text */
        const text = target === 'children' ? (entry.derived ?? entry.prop.default) : undefined
        if (text !== undefined && text !== '') addValue(target, jsString(text), false)
        continue
      }
      const references = mapped.components.get(entry.prop.name)
      if (references) {
        addValue(target, componentValue(fc, plan, entry, references, value), false)
        continue
      }
      const mappedValue = mapValue(entry, mapped.values.get(entry.prop.name), value)
      if (target === 'children' && mappedValue === '""') continue
      addValue(target, mappedValue, mappedValue === 'true')
    }
    for (const slot of plan.slots) {
      const value = call.slots.get(slot.name)
      const target = mapped.slotTargets.get(slot.name)
      if (value === undefined || !target) continue
      addValue(target, value, false)
    }
  }
  const open = [plan.name, ...attrs]
  const oneLine = open.join(' ')
  const head = oneLine.length > 90 && attrs.length > 1 ? `${plan.name}\n${indentText(attrs.join('\n'))}\n` : oneLine
  if (children.length === 0) return `<${head}${head.endsWith('\n') ? '' : ' '}/>`
  return `<${head}>\n${indentText(children.join('\n'))}\n</${plan.name}>`
}

/** An instance sets a prop the mapped component cannot receive: it is left out and the report names it, with the value the design had. */
function reportLeftOut(fc: FileCtx, plan: ComponentPlan, prop: string, value: CallValue, why: 'omit' | 'name'): void {
  const shown = value.literal ?? value.expr
  const set = shown.length > 40 ? `${shown.slice(0, 40)}…` : shown
  const reason =
    why === 'omit'
      ? 'the code mapping omits it'
      : `${jsString(prop)} is not a JavaScript identifier, so it cannot be a prop of ${plan.mapped?.exportName ?? plan.name}`
  fc.noteOnce(
    'dropped-attribute',
    `${plan.name}: prop ${jsString(prop)} was set to ${jsString(set)} on an instance and left out: ${reason}. Map it in code.props[${jsString(prop)}] (a name, or children) if the component takes it`,
  )
}

/** A string literal child as JSX text when it needs no escaping, else as the `{"…"}` expression. */
function jsxChild(expr: string): string {
  if (expr.startsWith('"')) {
    try {
      const text: unknown = JSON.parse(expr)
      if (typeof text === 'string' && /^[^\s{}<>&"'`\\]+(?: [^\s{}<>&"'`\\]+)*$/u.test(text)) return text
    } catch {
      /* not a plain literal: the expression form */
    }
  }
  return `{${expr}}`
}

/** An enum prop whose values are components, as what the export receives: the component itself, imported. A value with no known package, or no usable export name, is left for the developer: `undefined` with the value in a comment, and a report line naming the component, the prop and the value. */
function componentValue(
  fc: FileCtx,
  plan: ComponentPlan,
  entry: PropPlan,
  references: ComponentValues,
  value: CallValue,
): string {
  const { importFrom } = references
  const left = (option: string): string => {
    const exported = references.exports.get(option)
    fc.noteOnce(
      'dropped-attribute',
      `${plan.name}: prop ${jsString(entry.prop.name)} is ${jsString(option)}, a component${importFrom ? '' : ' with no known package'}: it was left for you to pass${exported ? ` (import ${exported} and pass it)` : ''}. Set code.props[${jsString(entry.prop.name)}].component.importFrom on the component to export it`,
    )
    return exported ? `undefined /* TODO: pass ${exported} */` : 'undefined'
  }
  const known = (option: string): string | undefined => {
    const exported = references.exports.get(option)
    return importFrom && exported ? exported : undefined
  }
  if (value.literal !== undefined) {
    const exported = known(value.literal)
    return exported && importFrom ? fc.ref(importFrom, exported) : left(value.literal)
  }
  /* a value known only when the component runs: a lookup over every option, or the placeholder when any cannot be passed */
  const options = entry.kind.k === 'enum' ? entry.kind.options : []
  const missing = options.filter((option) => !known(option))
  if (!options.length || missing.length || !importFrom) {
    for (const option of missing.length ? missing : options) left(option)
    return 'undefined'
  }
  const table = options.map((option) => `${jsString(option)}: ${fc.ref(importFrom, known(option) ?? option)}`)
  const lookup = `({ ${table.join(', ')} } as const)[${value.expr}]`
  return entry.hasDefault ? lookup : `${value.expr} === undefined ? undefined : ${lookup}`
}

/** The expression passed for a value a mapping may rewrite: literals go through the map directly, a runtime value through a lookup that covers every option. */
function mapValue(
  entry: PropPlan,
  values: Map<string, string | number | boolean> | undefined,
  value: CallValue,
): string {
  if (!values) return value.expr
  const asJs = (mapped: string | number | boolean): string =>
    typeof mapped === 'string' ? jsString(mapped) : String(mapped)
  if (value.literal !== undefined) {
    const mapped = values.get(value.literal)
    return mapped === undefined ? value.expr : asJs(mapped)
  }
  if (entry.kind.k === 'enum') {
    const table = entry.kind.options
      .map((option) => `${jsString(option)}: ${asJs(values.get(option) ?? option)}`)
      .join(', ')
    return entry.hasDefault
      ? `({ ${table} } as const)[${value.expr}]`
      : `${value.expr} === undefined ? undefined : ({ ${table} } as const)[${value.expr}]`
  }
  if (entry.kind.k === 'boolean') {
    return `(${value.expr}) ? ${asJs(values.get('true') ?? true)} : ${asJs(values.get('false') ?? false)}`
  }
  return value.expr
}

/* ------------------------------------------------------------------ */
/* Conditions and bindings                                             */
/* ------------------------------------------------------------------ */

export function condExpr(plan: ComponentPlan, condition: Condition): string {
  const entry = plan.propByName.get(condition.prop)
  const wrap = (holds: string): string => {
    if (!condition.negate) return holds
    if (holds === 'true' || holds === 'false') return holds === 'true' ? 'false' : 'true'
    if (/^[\w$]+$/.test(holds)) return `!${holds}`
    const equality = /^([\w$]+) === (.+)$/.exec(holds)
    return equality ? `${equality[1]} !== ${equality[2]}` : `!(${holds})`
  }
  if (!entry) return wrap('false')
  const { ts, kind } = entry
  if (condition.equals !== undefined) {
    const equals = condition.equals
    switch (kind.k) {
      case 'enum':
        return wrap(kind.options.includes(equals) ? `${ts} === ${jsString(equals)}` : 'false')
      case 'boolean':
        return wrap(equals === 'true' || equals === 'false' ? `${ts} === ${equals}` : 'false')
      case 'number':
        return wrap(`String(${ts}) === ${jsString(equals)}`)
      case 'node':
        return wrap('false')
      default:
        return wrap(`${ts} === ${jsString(equals)}`)
    }
  }
  switch (kind.k) {
    case 'boolean':
      return wrap(ts)
    case 'number':
      return wrap(`${ts} !== undefined`)
    case 'node':
      return wrap(`${ts} !== undefined && ${ts} !== null`)
    case 'enum':
      return wrap(kind.options.includes('false') ? `${ts} !== undefined && ${ts} !== "false"` : `${ts} !== undefined`)
    default:
      return wrap(`${ts} !== undefined && ${ts} !== "false"`)
  }
}

/** `data-doop-attr-if` as one JS condition per attribute (lowercased name): each entry's conditions joined with `&&`, a condition that always holds left out and one that never holds making it `'false'`. Undefined when the element has none. */
function attrGuards(plan: ComponentPlan, el: Element): AttrGuards | undefined {
  const raw = attrOf(el, ATTR_IF_ATTR)
  if (raw === undefined) return undefined
  const terms = new Map<string, string[] | 'false'>()
  for (const { attr, conditions } of parseAttrConditions(raw)) {
    const key = attr.toLowerCase()
    const held = terms.get(key) ?? []
    if (held === 'false') continue
    const next: string[] = []
    for (const condition of conditions) {
      const expr = condExpr(plan, condition)
      if (expr === 'false') {
        next.length = 0
        terms.set(key, 'false')
        break
      }
      if (expr !== 'true') next.push(expr)
    }
    if (terms.get(key) !== 'false') terms.set(key, [...held, ...next])
  }
  const guards: Record<string, string> = {}
  for (const [key, held] of terms) guards[key] = held === 'false' ? 'false' : held.length ? held.join(' && ') : 'true'
  return Object.keys(guards).length ? guards : undefined
}

/** A `"name": value` spread entry under its guard: unchanged, dropped (an empty list) or `"name": cond ? value : undefined`. */
function guardSpreadEntry(entry: string, guards: AttrGuards | undefined): string[] {
  if (!guards) return [entry]
  const at = entry.indexOf(':')
  const name = (JSON.parse(entry.slice(0, at)) as string).toLowerCase()
  const cond = guards[name]
  if (cond === undefined || cond === 'true') return [entry]
  if (cond === 'false') return []
  return [`${entry.slice(0, at)}: ${cond} ? ${entry.slice(at + 1).trim()} : undefined`]
}

/** A style attribute holding custom properties as a JSX attribute override: React's `CSSProperties` has no `--x` keys, so the object is asserted to it. */
export function customPropertyStyle(fc: FileCtx, el: Element): Record<string, string> | undefined {
  const style = attrOf(el, 'style')
  if (!style || !style.includes('--')) return undefined
  const object = styleToJsx(style, [], fc.session.urls.url)
  if (!object || !object.includes('"--')) return undefined
  fc.usesCssProps = true
  return { style: `{${object.slice(1, -1)} as CSSProperties}` }
}

/* ------------------------------------------------------------------ */
/* Attributes the element's intrinsic type does not accept             */
/* ------------------------------------------------------------------ */

/* React types an element's attributes per tag, so `size` on an `<i>` fails strict type-checking even though it is fine at
   runtime. Such attributes are written as a spread of an object literal, which the type checker accepts anywhere. */
const GLOBAL_ATTRS = new Set(
  'id title lang dir role tabindex hidden slot draggable contenteditable spellcheck translate accesskey inputmode autofocus itemprop itemscope itemtype itemid itemref nonce is part exportparts enterkeyhint autocapitalize'.split(
    ' ',
  ),
)
const TAG_ATTRS: Record<string, string> = {
  a: 'href target rel download hreflang type referrerpolicy ping media',
  img: 'src srcset alt width height loading decoding crossorigin sizes usemap referrerpolicy fetchpriority ismap',
  input:
    'type value checked name placeholder disabled readonly required min max step minlength maxlength pattern size multiple accept autocomplete list form formaction formmethod formtarget formenctype formnovalidate src alt width height capture',
  textarea: 'name placeholder disabled readonly required rows cols minlength maxlength wrap form autocomplete',
  select: 'name disabled required multiple size form autocomplete',
  option: 'value selected disabled label',
  optgroup: 'disabled label',
  button: 'type name value disabled form formaction formmethod formtarget formenctype formnovalidate',
  label: 'for form',
  form: 'action method target enctype autocomplete novalidate accept-charset',
  fieldset: 'disabled form name',
  video: 'src poster controls autoplay loop muted preload playsinline width height crossorigin',
  audio: 'src controls autoplay loop muted preload crossorigin',
  source: 'src srcset type media sizes width height',
  track: 'src kind srclang label default',
  iframe: 'src name allow allowfullscreen width height loading referrerpolicy sandbox srcdoc',
  canvas: 'width height',
  td: 'colspan rowspan headers scope',
  th: 'colspan rowspan headers scope abbr',
  col: 'span',
  colgroup: 'span',
  ol: 'start reversed type',
  li: 'value',
  blockquote: 'cite',
  q: 'cite',
  time: 'datetime',
  details: 'open',
  dialog: 'open',
  progress: 'value max',
  meter: 'value min max low high optimum',
  output: 'for form name',
  object: 'data type width height name',
  embed: 'src type width height',
  map: 'name',
  area: 'href alt coords shape target rel download',
  del: 'cite datetime',
  ins: 'cite datetime',
  data: 'value',
  svg: '',
}
const SVG_ATTRS = new Set(
  'viewbox d fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit stroke-opacity fill-opacity fill-rule clip-rule clip-path cx cy r rx ry x y x1 x2 y1 y2 width height points transform xmlns opacity offset stop-color stop-opacity gradientunits gradienttransform preserveaspectratio id role focusable xlink:href href mask filter fx fy dx dy font-size font-family font-weight text-anchor dominant-baseline letter-spacing version overflow vector-effect'.split(
    ' ',
  ),
)

/** the attribute names React's types accept on this element, lower-cased; null when anything may pass (a custom element) */
function acceptsAttr(el: Element, lower: string): boolean {
  if (lower.startsWith('data-') || lower.startsWith('aria-') || lower === 'class' || lower === 'style') return true
  if (el.namespaceURI === 'http://www.w3.org/2000/svg')
    return SVG_ATTRS.has(lower.toLowerCase()) || SVG_ATTRS.has(lower)
  if (el.tagName.includes('-')) return true
  return (
    GLOBAL_ATTRS.has(lower) ||
    (Object.hasOwn(TAG_ATTRS, el.tagName) ? (TAG_ATTRS[el.tagName] ?? '') : '').split(' ').includes(lower)
  )
}

export interface Spread {
  /** `"size": expr` entries for the spread object */
  entries: string[]
  /** JSX attribute names the converter would also write, to drop */
  drop: Record<string, null>
}

/** The element's static attributes that React's types would reject, as spread entries (dropped from the default rendering). */
export function staticSpread(fc: FileCtx, el: Element): Spread {
  const spread: Spread = { entries: [], drop: {} }
  for (const attr of el.attrs) {
    const lower = attr.name.toLowerCase()
    if (
      lower.startsWith('data-doop-') ||
      /^on/.test(lower) ||
      lower === 'srcdoc' ||
      lower === 'class' ||
      lower === 'style'
    )
      continue
    if (
      [
        'key',
        'ref',
        'children',
        'dangerouslysetinnerhtml',
        'suppresshydrationwarning',
        'suppresscontenteditablewarning',
      ].includes(lower)
    )
      continue
    if (acceptsAttr(el, lower)) continue
    if (!/^[a-z][a-z0-9_-]*$/i.test(attr.name)) continue
    if (
      /^(href|src|action|formaction|poster|data|cite|background|ping|xlink:href)$/.test(lower) &&
      isUnsafeUrl(attr.value)
    )
      continue
    const name = ATTR_RENAMES.get(lower) ?? attr.name
    const value = /^(href|src|poster)$/.test(lower) ? fc.session.urls.url(attr.value) : attr.value
    spread.entries.push(`${jsString(name)}: ${jsString(value)}`)
    spread.drop[name] = null
  }
  return spread
}

/** Puts a spread right after the opening tag name of a rendered element. */
export function withSpread(rendered: string, entries: readonly string[]): string {
  if (!entries.length) return rendered
  return rendered.replace(/^<[^\s/>]+/, (tag) => `${tag} {...{ ${entries.join(', ')} }}`)
}

/** whether a bound attribute must go through the spread for this element */
export const needsSpread = (el: Element, target: string): boolean => !acceptsAttr(el, target.toLowerCase())

/** a JSX child written as an expression: `{x}` becomes `x`, an element stays */
export const exprOf = (rendered: string): string =>
  rendered.startsWith('{') && rendered.endsWith('}') ? rendered.slice(1, -1) : rendered

export function wrapCondition(rendered: string, expr: string): string {
  if (expr === 'true') return rendered
  if (expr === 'false') return ''
  return `{${expr} && (\n${indentText(exprOf(rendered))}\n)}`
}

const ATTR_RENAMES = new Map([
  ['class', 'className'],
  ['for', 'htmlFor'],
  ['tabindex', 'tabIndex'],
  ['readonly', 'readOnly'],
  ['maxlength', 'maxLength'],
  ['minlength', 'minLength'],
  ['colspan', 'colSpan'],
  ['rowspan', 'rowSpan'],
  ['autocomplete', 'autoComplete'],
  ['autofocus', 'autoFocus'],
  ['crossorigin', 'crossOrigin'],
  ['srcset', 'srcSet'],
  ['datetime', 'dateTime'],
  ['enctype', 'encType'],
  ['novalidate', 'noValidate'],
  ['playsinline', 'playsInline'],
  ['spellcheck', 'spellCheck'],
  ['contenteditable', 'contentEditable'],
  ['allowfullscreen', 'allowFullScreen'],
  ['formaction', 'formAction'],
  ['inputmode', 'inputMode'],
  ['accesskey', 'accessKey'],
  ['hreflang', 'hrefLang'],
])

/** HTML's boolean attributes: bound to a boolean prop they are present or absent. */
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

const camelStyle = (name: string): string | null => {
  if (name.startsWith('--')) return /^--[A-Za-z0-9_-]+$/.test(name) ? jsString(name) : null
  if (!/^-?[a-z][a-z0-9-]*$/.test(name)) return null
  const camel = (text: string) => text.replace(/-([a-z0-9])/g, (_all, char: string) => char.toUpperCase())
  if (name.startsWith('-ms-')) return camel(`ms-${name.slice(4)}`)
  const base = camel(name.startsWith('-') ? name.slice(1) : name)
  return name.startsWith('-') ? `${base.charAt(0).toUpperCase()}${base.slice(1)}` : base
}

/** `prop` as the JSX attribute expression for an attribute binding, falling back to the template's own literal when the prop has no default. */
function attrValueExpr(entry: PropPlan, literal: string | undefined, boolAttr: boolean): string | null {
  const { ts, kind } = entry
  if (kind.k === 'node') return null
  if (kind.k === 'boolean') {
    if (boolAttr) return literal !== undefined && !entry.hasDefault ? `${ts} ?? true` : ts
    return entry.hasDefault
      ? `String(${ts})`
      : `${ts} === undefined ? ${literal === undefined ? 'undefined' : jsString(literal)} : String(${ts})`
  }
  if (kind.k === 'number') {
    if (entry.hasDefault) return `String(${ts})`
    return `${ts} === undefined ? ${literal === undefined ? 'undefined' : jsString(literal)} : String(${ts})`
  }
  return literal !== undefined && !entry.hasDefault ? `${ts} ?? ${jsString(literal)}` : ts
}

export interface BoundElement {
  attrs: Record<string, string | null>
  /** `"name": expr` entries for attributes the element's type does not accept */
  spread: string[]
  /** set when the element's text is bound: the marker that stands in the converted text, and the JSX it becomes */
  text?: { marker: string; jsx: string }
}

/** Resolve an element's `data-doop-prop` bindings against its component into JSX attribute overrides. Mutates the element's children when the text is bound. */
export function bindElement(
  fc: FileCtx,
  plan: ComponentPlan,
  el: Element,
  markerBase: string,
  reportPath: string,
): BoundElement {
  const result: BoundElement = { attrs: {}, spread: [] }
  const raw = attrOf(el, BIND_ATTR)
  if (raw === undefined) return result
  const bindings: Binding[] = parseBindings(raw, el.tagName)
  const styleEntries: { key: string; expr: string; name: string }[] = []
  let counter = 0
  for (const { target, prop } of bindings) {
    const entry = plan.propByName.get(prop)
    if (!entry) continue
    if (target === null) {
      if (entry.kind.k === 'node') continue
      const marker = `${markerBase}${counter++}`
      el.childNodes = textChildren(el, marker)
      const jsx = entry.kind.k === 'boolean' ? `{String(${entry.ts})}` : `{${entry.ts}}`
      result.text = { marker, jsx }
      continue
    }
    if (target.startsWith('style.') || target.startsWith('--')) {
      const name = target.startsWith('--') ? target : target.slice(6)
      const key = camelStyle(name)
      if (key === null || !/^[A-Za-z0-9_-]+$/.test(name.replace(/^--/, ''))) {
        fc.note('style', `binding to style ${jsString(name)} dropped: not a style property name`)
        continue
      }
      const literal = parseStyle(attrOf(el, 'style')).get(name)
      const expr = attrValueExpr(entry, literal, false)
      if (expr) styleEntries.push({ key, expr, name })
      continue
    }
    if (!/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?$/.test(target) || target === 'style' || /^on/.test(target)) {
      fc.note(
        'dropped-attribute',
        `binding to ${jsString(target)} dropped: not an attribute name that can be written as JSX ${reportPath}`,
      )
      continue
    }
    const isForm =
      (el.tagName === 'input' || el.tagName === 'textarea' || el.tagName === 'select') &&
      el.namespaceURI === 'http://www.w3.org/1999/xhtml'
    const name =
      isForm && target === 'value'
        ? 'defaultValue'
        : isForm && target === 'checked'
          ? 'defaultChecked'
          : (ATTR_RENAMES.get(target) ?? target)
    const boolAttr = BOOLEAN_ATTRS.has(target) && entry.kind.k === 'boolean'
    const literal = attrOf(el, target)
    const expr = attrValueExpr(entry, boolAttr ? (literal === undefined ? undefined : '') : literal, boolAttr)
    if (!expr) continue
    if (needsSpread(el, target)) {
      result.spread.push(`${jsString(name)}: ${expr}`)
      result.attrs[name] = null
      continue
    }
    result.attrs[name] = `{${expr}}`
  }
  if (styleEntries.length) {
    const rest = parseStyle(attrOf(el, 'style'))
    for (const { name } of styleEntries) rest.delete(name)
    const issues: ExportIssue[] = []
    const staticStyle = rest.size ? styleToJsx(serializeStyle(rest), issues, fc.session.urls.url) : null
    fc.issues.push(...issues)
    const dynamic = styleEntries.map(({ key, expr }) => `${key}: ${expr}`).join(', ')
    fc.usesCssProps = true
    result.attrs.style = `{${staticStyle ? `${staticStyle.slice(1, -3)}, ${dynamic} }` : `{ ${dynamic} }`} as CSSProperties}`
  }
  return result
}

/** The element's children with its own text replaced by `marker`, as the engine's text binding does (other element children stay). */
function textChildren(el: Element, marker: string): Tree.ChildNode[] {
  const node = { nodeName: '#text', value: marker, parentNode: el } as Tree.TextNode
  if (!el.childNodes.some(isElement)) return [node]
  const hasText = (child: Tree.ChildNode) => child.nodeName === '#text' && (child as Tree.TextNode).value.trim() !== ''
  const at = el.childNodes.findIndex(hasText)
  const kept: Tree.ChildNode[] = []
  el.childNodes.forEach((child, index) => {
    if (index === at) kept.push(node)
    else if (!hasText(child)) kept.push(child)
  })
  if (at === -1) kept.push(node)
  return kept
}

/** A marker no text of the template contains: the same template always gets the same one. */
export function markerFor(source: string): string {
  let marker = 'DOOPBIND'
  while (source.includes(marker)) marker += 'X'
  return marker
}

/* ------------------------------------------------------------------ */
/* A component's own file                                              */
/* ------------------------------------------------------------------ */

export interface ComponentFiles {
  tsx: string
  css: string
  fc: FileCtx
}

const isCustomTag = (el: Element): boolean =>
  el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
  el.tagName.includes('-') &&
  el.tagName !== USE_TAG &&
  /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(el.tagName)

/** The default expression a destructured prop gets, or undefined. */
function defaultExpr(fc: FileCtx, plan: ComponentPlan, entry: PropPlan): string | undefined {
  const { prop, kind } = entry
  if (prop.type === 'instance') {
    const def = prop.default ? fc.session.find(prop.default) : undefined
    if (!def) return undefined
    if (fc.session.reaches(def, plan.def.id)) {
      fc.session.dropDefault(plan.def.id, prop.name)
      fc.note(
        'dropped-attribute',
        `default of ${jsString(prop.name)} dropped: it would render ${jsString(def.name)}, which renders this component again`,
      )
      return undefined
    }
    return renderUseCall(fc, { plan: fc.session.plan(def), values: new Map(), slots: new Map() })
  }
  if (kind.k !== 'string') return declaredDefault(prop, kind)
  const raw = prop.default ?? entry.derived
  if (raw === undefined) return undefined
  if (!fc.session.isUrlProp(plan, prop.name)) return jsString(raw)
  if (isUnsafeUrl(raw)) {
    fc.note('unsafe-url', `default of ${jsString(prop.name)} dropped: it is a URL that would run code`)
    return undefined
  }
  return jsString(fc.session.urls.url(raw))
}

export function emitComponent(session: ExportSession, plan: ComponentPlan): ComponentFiles {
  const def = plan.def
  const file = plan.file ?? `src/components/${plan.name}.tsx`
  const fc = new FileCtx(session, file)
  const root = parseTemplateRoot(def.template)
  fc.issues.push(...plan.mappingIssues, ...plan.cssIssues)
  for (const tag of def.head) {
    const link = parseFragment(tag).childNodes.find(isElement)
    if (link?.tagName === 'style') {
      if (attrOf(link, 'data-doop-tokens') === undefined && attrOf(link, 'data-doop-fonts') === undefined)
        fc.note('dropped-element', 'a <style> in the component head was ignored: its rules are not in the export')
      continue
    }
    if (!link || link.tagName !== 'link') continue
    const fonts = googleFontsUrl(attrOf(link, 'href') ?? '')
    if (fonts) {
      session.fontLinks.add(fonts)
      fc.usesFonts = true
    } else
      fc.note(
        'dropped-element',
        "a stylesheet link in the component head was dropped: add it to the app's HTML yourself",
      )
  }
  const named = hostedFontUrl(componentDocument(def.template, def.rawCss))
  if (named) {
    session.fontLinks.add(named)
    fc.usesFonts = true
  }
  let body = 'null'
  const marker = markerFor(def.template)
  if (root) {
    const options = componentOptions(fc, plan, root, marker)
    const result = nodeToJsx(root, options)
    fc.issues.push(...result.issues)
    body = result.jsx
  } else {
    fc.note('dropped-element', 'the component has no markup, so it renders nothing')
  }

  const params: string[] = []
  const members: string[] = []
  for (const entry of plan.props) {
    const expr = defaultExpr(fc, plan, entry)
    if (entry.kind.k === 'node') fc.usesNode = true
    members.push(`  ${entry.ts}?: ${tsType(entry.kind)}`)
    params.push(expr === undefined ? entry.ts : `${entry.ts} = ${expr}`)
  }
  for (const slot of plan.slots) {
    fc.usesNode = true
    members.push(`  ${slot.ts}?: ReactNode`)
    params.push(slot.ts)
  }

  const lines: string[] = importLines(fc, plan, 'component')
  lines.push('')
  lines.push(`export interface ${plan.propsName} {`)
  lines.push(...members)
  lines.push('}')
  lines.push('')
  const signature = params.length ? `{ ${params.join(', ')} }: ${plan.propsName}` : `_props: ${plan.propsName}`
  lines.push(`export function ${plan.name}(${signature}) {`)
  lines.push(body === 'null' ? '  return null' : `  return (\n${indentText(body, '    ')}\n  )`)
  lines.push('}')
  const css = componentCss(plan)
  return { tsx: `${lines.join('\n')}\n`, css, fc }
}

/** The component's `.module.css`, empty when it has no styles (then no file is written and nothing imports it). */
export function componentCss(plan: ComponentPlan): string {
  return [plan.split.moduleCss, plan.split.globalCss].filter(Boolean).join('\n')
}

/** The import block of a generated file, sorted so two runs agree. `from` says where the file lives. */
export function importLines(fc: FileCtx, self: ComponentPlan | null, from: 'component' | 'page'): string[] {
  const lines: string[] = []
  if (fc.usesFonts) lines.push("import '../fonts.css'")
  const reactTypes = [fc.usesCssProps ? 'CSSProperties' : '', fc.usesNode ? 'ReactNode' : ''].filter(Boolean)
  if (reactTypes.length) lines.push(`import type { ${reactTypes.join(', ')} } from 'react'`)
  const rel = from === 'component' ? '.' : '../components'
  const sheets = [...fc.styleUses].sort((a, b) => (a.name < b.name ? -1 : 1))
  const styled = (plan: ComponentPlan) => Boolean(plan.split.moduleCss || plan.split.globalCss)
  if (self && styled(self) && fc.styleUses.has(self)) lines.push(`import styles from './${self.name}.module.css'`)
  else if (self && styled(self)) lines.push(`import './${self.name}.module.css'`)
  for (const plan of sheets)
    if (plan !== self && styled(plan)) lines.push(`import ${plan.stylesIdent} from '${rel}/${plan.name}.module.css'`)
  if (fc.usesCx) lines.push(`import { cx } from '../cx'`)
  const generated = [...fc.generated].filter((plan) => plan !== self).sort((a, b) => (a.name < b.name ? -1 : 1))
  if (from === 'component') {
    for (const plan of generated) lines.push(`import { ${plan.name} } from './${plan.name}'`)
  } else if (generated.length) {
    lines.push(`import { ${generated.map((plan) => plan.name).join(', ')} } from '../components'`)
  }
  const packages = new Map<string, { named: string[]; defaults: string[] }>()
  for (const ref of fc.refs.values()) {
    const group = packages.get(ref.importFrom) ?? { named: [], defaults: [] }
    group.named.push(ref.local === ref.exportName ? ref.local : `${ref.exportName} as ${ref.local}`)
    packages.set(ref.importFrom, group)
  }
  for (const plan of fc.mapped) {
    const mapped = plan.mapped
    if (!mapped) continue
    const group = packages.get(mapped.importFrom) ?? { named: [], defaults: [] }
    if (mapped.defaultExport) group.defaults.push(plan.name)
    else group.named.push(plan.name === mapped.exportName ? plan.name : `${mapped.exportName} as ${plan.name}`)
    packages.set(mapped.importFrom, group)
  }
  for (const [pkg, group] of [...packages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const name of group.defaults.sort()) lines.push(`import ${name} from ${jsString(pkg)}`)
    if (group.named.length) lines.push(`import { ${group.named.sort().join(', ')} } from ${jsString(pkg)}`)
  }
  return lines
}

/** The htmlToJsx hooks for a component's template: bindings, conditions, slots, nested uses and the root's variant attributes. */
function componentOptions(fc: FileCtx, plan: ComponentPlan, root: Element, marker: string): HtmlToJsxOptions {
  const own = (classes: string[]) => fc.className(plan, classes, true, false)
  const options: HtmlToJsxOptions = {
    rewriteUrl: fc.session.urls.url,
    className: (classes) => own(classes),
    visit: (el, ctx) => {
      if (isCustomTag(el)) fc.session.customElements.add(el.tagName)
      if (el.tagName === USE_TAG) return visitUse(fc, plan, el, ctx, options)
      const isRoot = el === root
      const condRaw = isRoot ? undefined : attrOf(el, IF_ATTR)
      const slotName = attrOf(el, SLOT_ATTR)
      const special = isRoot || attrOf(el, BIND_ATTR) !== undefined || slotName !== undefined
      const styled = customPropertyStyle(fc, el)
      const loose = staticSpread(fc, el)
      const plain = !special && !loose.entries.length
      const guards = attrGuards(plan, el)
      if (plain && condRaw === undefined && !styled && !guards) return undefined
      let rendered = plain
        ? ctx.element(styled, undefined, guards)
        : renderCustomized(fc, plan, el, ctx, options, isRoot, slotName, marker, guards)
      const condition = condRaw === undefined ? undefined : parseCondition(condRaw)
      if (condition) rendered = wrapCondition(rendered, condExpr(plan, condition))
      return rendered
    },
  }
  return options
}

function renderCustomized(
  fc: FileCtx,
  plan: ComponentPlan,
  el: Element,
  ctx: JsxContext,
  options: HtmlToJsxOptions,
  isRoot: boolean,
  slotName: string | undefined,
  marker: string,
  guards: AttrGuards | undefined,
): string {
  const bound: BoundElement =
    slotName === undefined
      ? bindElement(fc, plan, el, marker, '')
      : { attrs: {} as Record<string, string | null>, spread: [] }
  const loose = staticSpread(fc, el)
  const attrs = { ...customPropertyStyle(fc, el), ...loose.drop, ...bound.attrs }
  if (isRoot) {
    for (const entry of plan.props) {
      const reflects = entry.prop.type === 'enum' || (entry.prop.type === 'boolean' && entry.prop.reflect === true)
      if (!reflects) continue
      attrs[`data-${entry.prop.name}`] =
        entry.kind.k === 'boolean'
          ? entry.hasDefault
            ? `{String(${entry.ts})}`
            : `{${entry.ts} === undefined ? undefined : String(${entry.ts})}`
          : `{${entry.ts}}`
    }
    const classes = (attrOf(el, 'class') ?? '').split(/[ \t\n\f\r]+/).filter(Boolean)
    const className = fc.className(plan, classes, true, true)
    if (className !== '{""}') attrs.className = className
  }
  let children: string | undefined
  if (slotName !== undefined) {
    const slot = plan.slotByName.get(slotName)
    if (slot) {
      fc.usesNode = true
      const fragment = { nodeName: '#document-fragment', childNodes: el.childNodes } as unknown as Tree.DocumentFragment
      const inner = nodeToJsx(fragment, options)
      ctx.issues.push(...inner.issues)
      children = inner.jsx === 'null' ? `{${slot.ts}}` : `{${slot.ts} ?? (\n${indentText(inner.jsx)}\n)}`
    }
  }
  const boundKeys = new Set(bound.spread.map((entry) => entry.slice(0, entry.indexOf(':'))))
  const spreadEntries = [
    ...loose.entries.filter((entry) => !boundKeys.has(entry.slice(0, entry.indexOf(':')))),
    ...bound.spread,
  ].flatMap((entry) => guardSpreadEntry(entry, guards))
  let rendered = withSpread(ctx.element(attrs, children, guards), spreadEntries)
  if (bound.text) rendered = rendered.replace(`{${jsString(bound.text.marker)}}`, bound.text.jsx)
  return rendered
}

/** A nested `<doop-use>` of a template as the component it renders: forwarded props passed through, literal attributes as props, slots as props. */
function visitUse(fc: FileCtx, plan: ComponentPlan, use: Element, ctx: JsxContext, options: HtmlToJsxOptions): string {
  const ref = attrOf(use, 'component') ?? ''
  const condRaw = attrOf(use, IF_ATTR)
  const condition = condRaw === undefined ? undefined : parseCondition(condRaw)
  const nestedDef = fc.session.find(ref)
  if (!nestedDef) {
    ctx.issues.push({ kind: 'dropped-element', detail: '<doop-use> dropped: its component is not in the export' })
    return ''
  }
  if (nestedDef.id === plan.def.id) {
    ctx.issues.push({ kind: 'dropped-element', detail: '<doop-use> dropped: a component cannot render itself' })
    return ''
  }
  if (fc.session.reaches(nestedDef, plan.def.id)) {
    fc.session.dropUse(plan.def.id, nestedDef.id)
    ctx.issues.push({
      kind: 'dropped-element',
      detail: `<doop-use> of ${jsString(nestedDef.name)} dropped: it renders this component back, so the two would never stop`,
    })
    return ''
  }
  const target = fc.session.plan(nestedDef)
  const engine = fc.session.engine()
  const state: InstanceState = stateFromUseAttrs(use, nestedDef, engine, true)
  for (const issue of engine.issues) ctx.issues.push({ kind: 'dropped-attribute', detail: issue.message })
  const values = new Map<string, CallValue>()
  for (const [name, raw] of Object.entries(state.overrides.props ?? {})) {
    const value = literalValue(fc, target, name, raw)
    if (value) values.set(name, value)
  }
  let componentProp: PropPlan | undefined
  const rawBind = attrOf(use, BIND_ATTR)
  for (const { target: inner, prop: outerName } of rawBind === undefined ? [] : parseBindings(rawBind, USE_TAG)) {
    const outer = plan.propByName.get(outerName)
    if (!outer || inner === null) continue
    if (inner === 'component') {
      if (outer.kind.k === 'node') componentProp = outer
      continue
    }
    const innerEntry = target.propByName.get(inner)
    if (!innerEntry) {
      ctx.issues.push({
        kind: 'dropped-attribute',
        detail: `forwarding to ${jsString(inner)} dropped: the component has no such prop`,
      })
      continue
    }
    const converted = convertExpr(outer.ts, outer.kind, innerEntry.kind, outer.hasDefault)
    if (converted === null) {
      ctx.issues.push({
        kind: 'dropped-attribute',
        detail: `forwarding ${jsString(outerName)} to ${jsString(inner)} dropped: the types do not meet`,
      })
      continue
    }
    const literal = values.get(inner)
    const grouped = /^[\w$.]+$/.test(converted) ? converted : `(${converted})`
    values.set(inner, { expr: literal && !outer.hasDefault ? `${grouped} ?? ${literal.expr}` : converted })
  }
  const slots = new Map<string, string>()
  const reasons = deepReasons(state.overrides)
  for (const [key, part] of Object.entries(state.overrides.parts ?? {})) {
    if (part.slot === undefined) continue
    const name = slotNameOf(target, key)
    if (name === undefined || !target.slotByName.has(name)) continue
    const inner = htmlToJsx(part.slot, options)
    ctx.issues.push(...inner.issues)
    slots.set(name, inner.jsx === 'null' ? '<></>' : inner.jsx)
  }
  if (reasons.length) {
    ctx.issues.push({
      kind: 'dropped-attribute',
      detail: `part overrides on the nested ${jsString(target.name)} could not be carried into the component and were dropped (${reasons.join('; ')})`,
    })
  }
  let element = renderUseCall(fc, { plan: target, values, slots })
  if (componentProp) {
    fc.usesNode = true
    element = `{${componentProp.ts} ?? ${element}}`
  }
  return condition ? wrapCondition(element, condExpr(plan, condition)) : element
}
