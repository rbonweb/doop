import { CODE_ORIGINS, MAX_CODE_BYTES, type ComponentCode } from '../shared/componentCode.ts'
import type { ComponentDef, ComponentProp } from '../shared/components.ts'
import { ComponentError } from './componentActions.ts'

/**
 * A component's code mapping, checked against the props and slots the component really
 * has. Legacy keys (`path`, `name`, `snippet`) pass through untouched so values written
 * before the mapping existed read back exactly as they were; unknown keys are dropped.
 * Spec: .context/specs/components.md.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function fail(message: string): never {
  throw new ComponentError(message)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const list = (values: readonly string[]) => (values.length ? values.join(', ') : 'none')

/** A legacy string: kept as it is, but not longer than the field it belongs to. */
function text(value: unknown, key: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(`code.${key} must be a string`)
  if (value.length > max) fail(`code.${key} is ${value.length} characters; at most ${max}`)
  return value
}

function identifier(value: unknown, where: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    fail(`${where} “${String(value)}” is not a JavaScript identifier`)
  return value
}

/** The setup of the mapping: only the keys set, so a stored mapping reads back as written. */
function mapProps(raw: unknown, def: Pick<ComponentDef, 'name' | 'props'>): ComponentCode['props'] {
  if (raw === undefined) return undefined
  if (!isObject(raw)) fail('code.props must be an object keyed by prop name')
  const props: NonNullable<ComponentCode['props']> = {}
  for (const [key, entry] of Object.entries(raw)) {
    const prop = def.props.find((candidate) => candidate.name === key)
    if (!prop)
      fail(
        `code.props “${key}” is not a prop of “${def.name}”; its props are ${list(def.props.map((candidate) => candidate.name))}`,
      )
    if (!isObject(entry)) fail(`code.props.${key} must be an object`)
    const mapped: NonNullable<ComponentCode['props']>[string] = {}
    if (entry.name !== undefined) mapped.name = identifier(entry.name, `code.props.${key}.name`)
    if (entry.values !== undefined) mapped.values = mapValues(entry.values, prop, key)
    if (entry.omit !== undefined) {
      if (entry.omit !== true) fail(`code.props.${key}.omit must be true`)
      mapped.omit = true
    }
    props[key] = mapped
  }
  return props
}

function mapValues(raw: unknown, prop: ComponentProp, key: string): Record<string, string | number | boolean> {
  if (!isObject(raw)) fail(`code.props.${key}.values must be an object`)
  const allowed = prop.type === 'enum' ? (prop.options ?? []) : prop.type === 'boolean' ? ['true', 'false'] : undefined
  if (!allowed)
    fail(
      `code.props.${key}.values belongs to an enum or boolean prop; “${key}” is ${prop.type === 'text' ? 'a text prop' : `a ${prop.type} prop`}`,
    )
  const values: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!allowed.includes(name))
      fail(
        `code.props.${key}.values “${name}” is not one of ${list(allowed)}${prop.type === 'enum' ? ` — the ${key} options` : ''}`,
      )
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      fail(`code.props.${key}.values.${name} must be a string, number or boolean`)
    values[name] = value
  }
  return values
}

function mapSlots(raw: unknown, def: Pick<ComponentDef, 'name' | 'slots'>): ComponentCode['slots'] {
  if (raw === undefined) return undefined
  if (!isObject(raw)) fail('code.slots must be an object keyed by slot name')
  const slots: NonNullable<ComponentCode['slots']> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!def.slots.some((slot) => slot.name === key))
      fail(
        `code.slots “${key}” is not a slot of “${def.name}”; its slots are ${list(def.slots.map((slot) => slot.name))}`,
      )
    /* `children` is the export's own children; anything else names a prop, so an identifier */
    slots[key] = value === 'children' ? 'children' : identifier(value, `code.slots.${key}`)
  }
  return slots
}

function mapOrigin(raw: unknown): ComponentCode['origin'] {
  if (raw === undefined) return undefined
  if (!isObject(raw)) fail('code.origin must be an object')
  if (!CODE_ORIGINS.includes(raw.kind as (typeof CODE_ORIGINS)[number]))
    fail(`code.origin.kind “${String(raw.kind)}” must be one of ${CODE_ORIGINS.join(', ')}`)
  const origin: NonNullable<ComponentCode['origin']> = { kind: raw.kind as (typeof CODE_ORIGINS)[number] }
  const storyId = text(raw.storyId, 'origin.storyId', 200)
  if (storyId !== undefined) origin.storyId = storyId
  const url = text(raw.url, 'origin.url', 2000)
  if (url !== undefined) {
    if (!/^https?:\/\//i.test(url)) fail('code.origin.url must be an http(s) URL')
    origin.url = url
  }
  return origin
}

export function validCode(
  code: unknown,
  def: Pick<ComponentDef, 'name' | 'props' | 'slots'>,
): ComponentCode | undefined {
  if (code === undefined) return undefined
  if (!isObject(code)) fail('code must be an object')

  const clean: ComponentCode = {}
  const path = text(code.path, 'path', 500)
  if (path !== undefined) clean.path = path
  const name = text(code.name, 'name', 200)
  if (name !== undefined) clean.name = name
  const snippet = text(code.snippet, 'snippet', 4000)
  if (snippet !== undefined) clean.snippet = snippet
  const importFrom = text(code.importFrom, 'importFrom', 300)
  if (importFrom !== undefined) clean.importFrom = importFrom
  if (code.exportName !== undefined) clean.exportName = identifier(code.exportName, 'code.exportName')
  if (code.defaultExport !== undefined) {
    if (typeof code.defaultExport !== 'boolean') fail('code.defaultExport must be true or false')
    clean.defaultExport = code.defaultExport
  }
  const props = mapProps(code.props, def)
  if (props !== undefined) clean.props = props
  const slots = mapSlots(code.slots, def)
  if (slots !== undefined) clean.slots = slots
  const origin = mapOrigin(code.origin)
  if (origin !== undefined) clean.origin = origin

  const size = JSON.stringify(clean).length
  if (size > MAX_CODE_BYTES) fail(`code is ${size} characters; at most ${MAX_CODE_BYTES}`)
  return clean
}
