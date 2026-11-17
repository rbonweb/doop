/**
 * Components: one design used in many places. A component's main is an ordinary
 * element in a frame, marked `data-doop-component`. An instance is that markup
 * written out in full in the frame that uses it, marked `data-doop-instance`, so
 * everything that reads frame HTML (the iframe, exports, screenshots, comments,
 * the Layers panel) needs no idea components exist. Agents read and write the
 * short form, `<doop-use component="Button" label="Buy"></doop-use>`.
 * Spec: .context/specs/components.md.
 */

export const COMPONENT_ATTR = 'data-doop-component'
export const INSTANCE_ATTR = 'data-doop-instance'
export const REV_ATTR = 'data-doop-rev'
export const PROPS_ATTR = 'data-doop-props'
export const OVERRIDES_ATTR = 'data-doop-overrides'
/** A template element's stable key: what an override is pinned to. */
export const PART_ATTR = 'data-doop-part'
export const SLOT_ATTR = 'data-doop-slot'
export const SLOT_SUGGEST_ATTR = 'data-doop-slot-suggest'
/** `label` binds the text; `href:link,--accent:accent,style.color:ink` bind attributes and styles. */
export const BIND_ATTR = 'data-doop-prop'
/** `showIcon`, `!showIcon`, `tone=ghost` or `tone!=ghost`: the element exists only when this holds. */
export const IF_ATTR = 'data-doop-if'
/** The component's scoped CSS in the head of a frame that uses it. */
export const CSS_ATTR = 'data-doop-component-css'
/** A stylesheet link or framework script a component brought into a frame's head: never the frame's own. */
export const HEAD_ATTR = 'data-doop-component-head'
/** The stylesheet update_component writes in the frame holding the main. */
export const SOURCE_CSS_ATTR = 'data-doop-component-source'
export const USE_TAG = 'doop-use'
/** A detached instance's root: `<component id>.<rev>`, what its own frozen stylesheet is scoped to. */
export const DETACHED_ATTR = 'data-doop-detached-from'
/** That stylesheet, in the head of the frame holding the detached element. Nothing regenerates it. */
export const DETACHED_CSS_ATTR = 'data-doop-detached-css'

export const MAX_COMPONENTS = 500
export const MAX_COMPONENT_HISTORY = 20
export const MAX_COMPONENT_NAME = 80
export const MAX_COMPONENT_DESCRIPTION = 1000
/** templates inside templates: a component inside itself is refused, and so is a chain this long */
export const MAX_NESTING_DEPTH = 8
/** instances inside instances however they got there, slot content included: the render stops here */
export const MAX_INSTANCE_DEPTH = 32

export const PROP_TYPES = ['text', 'image', 'link', 'enum', 'boolean', 'number', 'color', 'instance'] as const
export type ComponentPropType = (typeof PROP_TYPES)[number]

export interface ComponentProp {
  /** lowercase, since it doubles as an HTML attribute on `<doop-use>` */
  name: string
  type: ComponentPropType
  /** enum, boolean, number, color and instance: what conditions see when an instance gives no value.
   *  Text-like defaults are the template's own content */
  default?: string
  /** enum only */
  options?: string[]
  /** number only: the smallest and largest value, and the step values sit on, counted from `min` (else 0) */
  min?: number
  max?: number
  step?: number
  /** instance only: the component names or ids that may be picked; empty or absent accepts any */
  accepts?: string[]
  /** boolean only: puts `data-<name>="true"|"false"` on the instance root, as an enum does, for CSS to key on */
  reflect?: boolean
  description?: string
}

export interface ComponentSlot {
  name: string
  /** component names or ids a person or agent should reach for; guidance, not a limit */
  suggested: string[]
}

/** Where this component lives in code: the handoff for an agent turning a design into a repo's own components. */
export interface ComponentCode {
  /** source file or package, `src/components/ui/button.tsx` or `@acme/ui` */
  path?: string
  /** export name, `Button` */
  name?: string
  /** free-form usage or a prop mapping */
  snippet?: string
}

export interface ComponentSnapshot {
  rev: number
  template: string
  rawCss: string
  head: string[]
  props: ComponentProp[]
  savedAt: number
  savedBy: string
}

export interface ComponentDef {
  id: string
  name: string
  description: string
  /** compact main markup: the root and every element keyed, nested instances as `<doop-use>` */
  template: string
  /** scoped to the instance root; goes in the head of every frame using this */
  css: string
  /** the same rules unscoped: what a regenerated main's own stylesheet holds */
  rawCss: string
  /** stylesheet and font tags the design relies on */
  head: string[]
  props: ComponentProp[]
  slots: ComponentSlot[]
  rev: number
  /** the frame whose element is the main; null once that element is gone */
  mainFrameId: string | null
  code?: ComponentCode
  /** imported from a library canvas: pulled on request, never pushed. `library`
   *  marks a link to a workspace library's published snapshot: such a component
   *  has no main here, and is changed on its library canvas. */
  source?: { canvasId: string; componentId: string; rev: number; library?: true }
  /** recent earlier states, newest last: rollback and three-way merge of stale saves */
  history: ComponentSnapshot[]
  /** `deleted` is a soft delete: the definition is kept and frozen, its instances keep
   *  their markup and stop following it, new uses are refused, and it can be restored.
   *  Absent means active. */
  status?: 'active' | 'deleted'
  deletedAt?: number
  deletedBy?: string
  createdAt: number
  updatedAt: number
  updatedBy: string
}

export function isDeleted(def: Pick<ComponentDef, 'status'> | undefined): boolean {
  return def?.status === 'deleted'
}

/** A definition with no markup: a row that lost its content (an older write landing last,
 *  2026-11-11). Nothing can be rendered from it, so its instances are left exactly as they
 *  are, stylesheet included, until its main is written again and gives it back its markup. */
export function isHollow(def: Pick<ComponentDef, 'template'> | undefined): boolean {
  return def !== undefined && !def.template.trim()
}

/** The components of a canvas that are in use: everything but the soft-deleted. */
export function activeComponents<T extends Pick<ComponentDef, 'status'>>(defs: readonly T[] | undefined): T[] {
  return (defs ?? []).filter((def) => !isDeleted(def))
}

/** A component as its workspace library last published it. Canvases in the
 *  workspace use this snapshot, never the library canvas's live definition, so
 *  work in progress there reaches nobody until it is published. */
export interface LibraryComponent {
  /** the library canvas */
  canvasId: string
  id: string
  name: string
  description: string
  template: string
  css: string
  rawCss: string
  head: string[]
  props: ComponentProp[]
  slots: ComponentSlot[]
  code?: ComponentCode
  /** nested components this one is built from that come from ANOTHER library,
   *  by component id → that library's canvas: recorded at publish time, so a
   *  canvas taking this up follows the same library the publisher did. Ones
   *  from this same library are not listed. */
  nested?: Record<string, string>
  /** this publication's version: the library canvas's revision when taken, raised
   *  past the last publication's when a change left that revision alone */
  rev: number
  publishedAt: number
  publishedBy: string
}

/** What publishing would do to one component of a library canvas. */
export type LibraryChange = 'new' | 'changed' | 'unchanged' | 'removed'

/** One template element's overrides on one instance. A value of null removes what the template set. */
export interface PartOverride {
  attrs?: Record<string, string | null>
  style?: Record<string, string | null>
  /** the element rendered as another tag: a `<button>` turned into an `<a>` */
  tag?: string
  text?: string
  /** children replaced wholesale: an edit no finer override can hold */
  html?: string
  hidden?: boolean
  /** a slot's content, compact */
  slot?: string
  /** a nested instance's own state */
  use?: InstanceOverrides
}

export interface InstanceOverrides {
  props?: Record<string, string>
  parts?: Record<string, PartOverride>
}

export type ComponentIssueCode =
  | 'unknown_component'
  | 'deleted_component'
  | 'unknown_prop'
  | 'invalid_prop_value'
  | 'nesting_cycle'
  | 'unknown_main'
  | 'instance_removed'
  | 'too_deep'
  | 'library_ambiguous'
  | 'ignored_attribute'
  | 'css_not_kept'
  | 'empty_template'
  | 'unclosed_use'

/** Something an agent should hear about instead of finding out from a screenshot. */
export interface ComponentIssue {
  code: ComponentIssueCode
  message: string
}

/** One instance's identity as the editor needs it, read from the frame's markup. */
export interface InstanceSummary {
  instanceId: string
  componentId: string
  rev: number
  props: Record<string, string>
  overriddenParts: string[]
}

const PROP_NAME = /^[a-z][a-z0-9-]{0,39}$/
/* a prop doubles as an attribute on `<doop-use>`, and these already mean something there */
const RESERVED_PROP_NAMES = new Set(['component', 'id', 'class', 'style', 'overrides', 'slot'])

export function isPropName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PROP_NAME.test(value) &&
    !RESERVED_PROP_NAMES.has(value) &&
    !value.startsWith('data-doop-')
  )
}

/** `Primary Button!` → `primary-button`: what a label becomes as a prop. */
export function toPropName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 40)
  return isPropName(slug) ? slug : 'value'
}

export type Condition = { prop: string; equals?: string; negate: boolean }

export function parseCondition(value: string): Condition | null {
  const text = value.trim()
  const match = /^(!?)([a-z][a-z0-9-]*)(?:(!?=)(.*))?$/.exec(text)
  if (!match) return null
  const [, bang, prop, operator, equals] = match
  if (!prop) return null
  if (operator) return { prop, equals: (equals ?? '').trim(), negate: operator === '!=' }
  return { prop, negate: bang === '!' }
}

export function conditionHolds(condition: Condition, value: string | undefined): boolean {
  const holds = condition.equals !== undefined ? value === condition.equals : value !== undefined && value !== 'false'
  return condition.negate ? !holds : holds
}

export interface Binding {
  /** the attribute, `style.<property>` or `--custom-property` a prop fills; null for the text */
  target: string | null
  prop: string
}

/** What a bare binding (`data-doop-prop="photo"`) fills on an element that holds no text:
 *  an image's source, a field's value. Elsewhere a bare binding is the text. */
const BARE_TARGET = new Map([
  ['img', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
  ['iframe', 'src'],
  ['embed', 'src'],
  ['input', 'value'],
])

/** The bindings in a data-doop-prop value. Pass the element's tag so a bare name on an <img>
 *  binds its src: as text it would fill nothing, and the prop would silently do nothing. */
export function parseBindings(value: string, tagName?: string): Binding[] {
  const bare = (tagName && BARE_TARGET.get(tagName.toLowerCase())) ?? null
  const bindings: Binding[] = []
  for (const piece of value.split(',')) {
    const text = piece.trim()
    if (!text) continue
    const at = text.lastIndexOf(':')
    const prop = (at === -1 ? text : text.slice(at + 1)).trim()
    if (!isPropName(prop)) continue
    bindings.push({ target: at === -1 ? bare : text.slice(0, at).trim().toLowerCase(), prop })
  }
  return bindings
}

/** `a: b; c: url(x;y)` → an ordered map, leaving semicolons in parens and quotes alone. */
export function parseStyle(value: string | undefined): Map<string, string> {
  const styles = new Map<string, string>()
  if (!value) return styles
  let depth = 0
  let quote = ''
  let start = 0
  const add = (end: number) => {
    const piece = value.slice(start, end)
    const colon = piece.indexOf(':')
    if (colon <= 0) return
    const name = piece.slice(0, colon).trim()
    const body = piece.slice(colon + 1).trim()
    if (name && body) styles.set(name.startsWith('--') ? name : name.toLowerCase(), body)
  }
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (quote) {
      if (char === quote && value[i - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ';' && depth === 0) {
      add(i)
      start = i + 1
    }
  }
  add(value.length)
  return styles
}

export function serializeStyle(styles: Map<string, string>): string {
  return [...styles].map(([name, value]) => `${name}: ${value}`).join('; ')
}

/** Key-sorted JSON: identical state serializes identically, so an unchanged instance writes nothing. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/* a shape check, not a CSS parser: a function name and the characters a colour's arguments use */
const COLOR_FUNCTION = /^(?:rgba?|hsla?|oklch)\(\s*[0-9a-z.,%+\-/\s]*\)$/i
const TOKEN_COLOR = /^var\(\s*--[a-z0-9_-]+\s*\)$/i

export function isColorValue(value: string): boolean {
  const text = value.trim()
  return HEX_COLOR.test(text) || COLOR_FUNCTION.test(text) || TOKEN_COLOR.test(text)
}

function numberRange(prop: Pick<ComponentProp, 'min' | 'max'>): string {
  if (prop.min !== undefined && prop.max !== undefined) return `${prop.min}..${prop.max}`
  if (prop.min !== undefined) return `${prop.min}..`
  if (prop.max !== undefined) return `..${prop.max}`
  return ''
}

/** What a prop's type says about its value, shared by the server and the editor: undefined when the
 *  value is fine, else what to use instead (`use a number from 0 to 10`). Text, image, link and boolean
 *  take anything (a boolean reads "false" as off and everything else as on), so old markup round-trips. */
export function propValueProblem(prop: ComponentProp, value: string): string | undefined {
  switch (prop.type) {
    case 'enum':
      return prop.options?.length && !prop.options.includes(value) ? `use ${prop.options.join(' | ')}` : undefined
    case 'number': {
      const number = value.trim() === '' ? NaN : Number(value)
      const expected = `a number${
        prop.min !== undefined && prop.max !== undefined
          ? ` from ${prop.min} to ${prop.max}`
          : prop.min !== undefined
            ? ` of at least ${prop.min}`
            : prop.max !== undefined
              ? ` of at most ${prop.max}`
              : ''
      }${prop.step !== undefined ? ` in steps of ${prop.step}` : ''}`
      if (!Number.isFinite(number)) return `use ${expected}`
      if ((prop.min !== undefined && number < prop.min) || (prop.max !== undefined && number > prop.max))
        return `use ${expected}`
      if (prop.step !== undefined && prop.step > 0) {
        const steps = (number - (prop.min ?? 0)) / prop.step
        if (Math.abs(steps - Math.round(steps)) > 1e-9) return `use ${expected}`
      }
      return undefined
    }
    case 'color':
      return isColorValue(value)
        ? undefined
        : 'use a hex colour (#rgb, #rrggbb, #rrggbbaa), rgb(), hsl(), oklch() or var(--token)'
    case 'instance': {
      const name = value.trim().toLowerCase()
      if (!name) return prop.accepts?.length ? `use ${prop.accepts.join(' | ')}` : 'use the name or id of a component'
      return !prop.accepts?.length || prop.accepts.some((entry) => entry.trim().toLowerCase() === name)
        ? undefined
        : `use ${prop.accepts.join(' | ')}`
    }
    default:
      return undefined
  }
}

/** The one-line signature agents scan: `Button(label: text, tone: primary|ghost = primary) slots: icon`.
 *  Typed values show their limits: `count: number(0..10) = 1`, `icon: instance(Icon|Avatar)`. */
export function componentSignature(def: Pick<ComponentDef, 'name' | 'props' | 'slots'>): string {
  const props = def.props.map((prop) => {
    const type =
      prop.type === 'enum'
        ? (prop.options ?? []).join('|')
        : prop.type === 'number' && (numberRange(prop) || prop.step !== undefined)
          ? `number(${numberRange(prop)}${prop.step !== undefined ? `${numberRange(prop) ? ' ' : ''}step ${prop.step}` : ''})`
          : prop.type === 'instance' && prop.accepts?.length
            ? `instance(${prop.accepts.join('|')})`
            : prop.type
    return `${prop.name}: ${type}${prop.default !== undefined ? ` = ${prop.default}` : ''}`
  })
  const slots = def.slots.length ? ` slots: ${def.slots.map((slot) => slot.name).join(', ')}` : ''
  return `${def.name}(${props.join(', ')})${slots}`
}
