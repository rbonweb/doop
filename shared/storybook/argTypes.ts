import type { ComponentProp } from '../components.ts'
import type { StorybookIssue } from './index.ts'

/** Pure: no node or server imports, since the CLI bundles it. Storybook's `argTypes` and `initialArgs`, as JSON read out of a running Storybook, become Doop props. Everything arrives from a page we do not control, so a field is read only when it has the right shape, nothing is ever assigned by a key the page chose, and what does not fit is dropped with its reason. */

export const MAX_ARG_TYPES = 200
export const MAX_PROPS = 40
export const MAX_OPTIONS = 20
const MAX_OPTION = 100
const MAX_STRING = 200
const MAX_DESCRIPTION = 300
const MAX_PROP_NAME = 40

export type ArgValue = string | number | boolean

/** A Doop prop and the Storybook arg it was read from. */
export interface ArgProp extends ComponentProp {
  /** the arg's own name, which the story URL and the export's prop use */
  arg: string
  /** the story's initial value, when it is a plain string, number or boolean */
  initial?: ArgValue
}

export interface ReadArgTypes {
  props: ArgProp[]
  issues: StorybookIssue[]
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** names a `<doop-use>` or an element already gives meaning to */
const RESERVED_NAMES = new Set(['id', 'class', 'style', 'component', 'slot', 'is', 'key', 'ref', 'children'])
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/
/** an option lands in an attribute value and a CSS selector: printable, no markup, quotes or backslashes */
const SAFE_OPTION = /^[^\p{Cc}<>"'`\\]+$/u
const COLOR = /^[#A-Za-z0-9(),.%\s/-]{1,100}$/

type Dict = Record<string, unknown>

function ownRecord(value: unknown): Dict | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Dict
}

function own(record: Dict, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** `showIcon` -> `show-icon`, `Tone_2` -> `tone-2`: lowercase, attribute-safe, starting with a letter. */
export function propName(arg: string): string | undefined {
  const kebab = arg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROP_NAME)
    .replace(/-+$/, '')
  return /^[a-z]/.test(kebab) ? kebab : undefined
}

function plainText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw
    .replace(/<[^>]*>?/g, ' ')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, max) : undefined
}

function primitive(value: unknown): ArgValue | undefined {
  if (typeof value === 'string') return value.length <= MAX_STRING ? value : undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  return undefined
}

/** Option values of a select or radio: an array of strings and numbers, or an object whose keys are the labels. */
function readOptions(raw: unknown): { options: string[]; dropped: number } {
  const candidates: unknown[] = Array.isArray(raw)
    ? raw.slice(0, MAX_OPTIONS * 4)
    : ownRecord(raw)
      ? Object.keys(raw as Dict).slice(0, MAX_OPTIONS * 4)
      : []
  const options: string[] = []
  let dropped = 0
  for (const candidate of candidates) {
    const value = typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : candidate
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_OPTION ||
      !SAFE_OPTION.test(value) ||
      /^\s*(?:function\b|\(.*\)\s*=>|class\b)/.test(value) ||
      UNSAFE_KEYS.has(value) ||
      options.includes(value)
    ) {
      dropped++
      continue
    }
    if (options.length < MAX_OPTIONS) options.push(value)
    else dropped++
  }
  return { options, dropped }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

type Kind = 'enum' | 'boolean' | 'number' | 'color' | 'text'

/** The control Storybook shows decides the prop; with none, the argType's own `type` does. */
function kindOf(argType: Dict): { kind?: Kind; reason?: string } {
  const control = own(argType, 'control')
  if (control === false) return { reason: 'its control is turned off' }
  const controlType =
    typeof control === 'string' ? control : ownRecord(control) ? own(control as Dict, 'type') : undefined
  if (typeof controlType === 'string') {
    switch (controlType) {
      case 'select':
      case 'radio':
      case 'inline-radio':
      case 'check':
      case 'inline-check':
      case 'multi-select':
        return { kind: 'enum' }
      case 'boolean':
        return { kind: 'boolean' }
      case 'number':
      case 'range':
        return { kind: 'number' }
      case 'color':
        return { kind: 'color' }
      case 'text':
        return { kind: 'text' }
      default:
        return { reason: `the "${controlType.slice(0, 30)}" control has no prop type` }
    }
  }
  const type = ownRecord(own(argType, 'type'))
  const typeName = type ? own(type, 'name') : undefined
  if (typeName === 'boolean') return { kind: 'boolean' }
  if (typeName === 'number') return { kind: 'number' }
  if (typeName === 'string') return { kind: 'text' }
  if (typeName === 'enum') return { kind: 'enum' }
  return { reason: 'it has no control and no simple type' }
}

function optionSource(argType: Dict): unknown {
  const options = own(argType, 'options')
  if (options !== undefined) return options
  const control = ownRecord(own(argType, 'control'))
  const fromControl = control ? own(control, 'options') : undefined
  if (fromControl !== undefined) return fromControl
  const type = ownRecord(own(argType, 'type'))
  return type ? own(type, 'value') : undefined
}

/** How many skipped controls an issue names. */
const MAX_DROPPED_NAMES = 12

/** `argTypes` and `initialArgs` of one story to props. `argTypes` may hold anything a page put there; at most MAX_ARG_TYPES entries are looked at and MAX_PROPS kept. */
export function readArgTypes(argTypes: unknown, initialArgs: unknown): ReadArgTypes {
  const issues: StorybookIssue[] = []
  const table = ownRecord(argTypes)
  const initial = ownRecord(initialArgs) ?? {}
  if (!table) return { props: [], issues }
  const props: ArgProp[] = []
  const names = new Set<string>()
  const dropped: string[] = []
  let droppedCount = 0
  const drop = (arg: string, _reason: string) => {
    droppedCount++
    if (dropped.length < MAX_DROPPED_NAMES) dropped.push(arg.slice(0, 40))
  }
  let looked = 0
  let truncated = false
  for (const arg of Object.keys(table)) {
    if (looked++ >= MAX_ARG_TYPES) {
      truncated = true
      break
    }
    if (UNSAFE_KEYS.has(arg) || !ARG_NAME.test(arg)) {
      drop(arg, 'the name cannot be passed in a story URL')
      continue
    }
    const argType = ownRecord(own(table, arg))
    if (!argType) {
      drop(arg, 'its definition is not an object')
      continue
    }
    if (own(argType, 'action') !== undefined || /^on[A-Z]/.test(arg)) {
      drop(arg, 'it is an event handler')
      continue
    }
    const { kind, reason } = kindOf(argType)
    if (!kind) {
      drop(arg, reason ?? 'unsupported')
      continue
    }
    const name = propName(arg)
    if (!name || RESERVED_NAMES.has(name) || /^on-/.test(name)) {
      drop(arg, 'the name is not usable as an attribute')
      continue
    }
    if (names.has(name)) {
      drop(arg, `it collides with another prop named "${name}"`)
      continue
    }
    if (props.length >= MAX_PROPS) {
      drop(arg, `only ${MAX_PROPS} props are kept`)
      continue
    }
    const value = primitive(own(initial, arg) ?? own(argType, 'defaultValue'))
    const prop: ArgProp = { name, type: kind, arg }
    const description = plainText(own(argType, 'description'), MAX_DESCRIPTION)
    if (description) prop.description = description
    if (value !== undefined) prop.initial = value
    if (kind === 'enum') {
      const { options, dropped: bad } = readOptions(optionSource(argType))
      if (options.length < 2) {
        drop(arg, 'it lists fewer than two usable options')
        continue
      }
      if (bad) drop(arg, `${bad} options were unusable or over the ${MAX_OPTIONS} cap`)
      prop.options = options
      const fallback = value === undefined ? undefined : String(value)
      if (fallback !== undefined && options.includes(fallback)) prop.default = fallback
    } else if (kind === 'boolean') {
      if (typeof value === 'boolean') prop.default = String(value)
    } else if (kind === 'number') {
      const range = ownRecord(own(argType, 'control')) ?? {}
      const min = finite(own(range, 'min'))
      const max = finite(own(range, 'max'))
      const step = finite(own(range, 'step'))
      if (min !== undefined) prop.min = min
      if (max !== undefined && (min === undefined || max >= min)) prop.max = max
      if (step !== undefined && step > 0) prop.step = step
      if (typeof value === 'number') prop.default = String(value)
    } else if (kind === 'color') {
      if (typeof value === 'string' && COLOR.test(value)) prop.default = value
    }
    names.add(name)
    props.push(prop)
  }
  if (droppedCount) {
    const more = droppedCount - dropped.length
    issues.push({
      code: 'argtypes_dropped',
      message: `${droppedCount} ${droppedCount === 1 ? 'prop' : 'props'} skipped: ${dropped.join(', ')}${more > 0 ? `, and ${more} more` : ''}${truncated ? `; only the first ${MAX_ARG_TYPES} argTypes are read` : ''}`,
    })
  }
  return { props, issues }
}
