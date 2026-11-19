import type { ArgProp } from './argTypes.ts'
import type { CapturedStory } from './capture.ts'
import { splitRules } from './cssGuard.ts'

/** Pure: no node or server imports, since the CLI bundles it. What the markup of a captured story says about how its component is meant to be used, beyond the props a Storybook lists: the parts a compound component is made of become slots (or, when a part holds one plain text, a text prop named for it), and a prop is bound to the native attribute its value shows up in (`placeholder`, `alt`, `src`, a checkbox's `checked`). Everything is read from the capture's attributes, own text and shape, never from names of components. */

/** The attributes a library uses to say which part of a component an element is. */
const IDENTITY_ATTRS = ['data-slot', 'data-part']
const IDENTITY = /^[a-z][a-z0-9_-]{0,39}$/
const SAFE_NAME = /^[a-z][a-z0-9-]{0,39}$/
/** names a `<doop-use>` or an element already gives meaning to */
const RESERVED = new Set(['id', 'class', 'style', 'component', 'slot', 'is', 'key', 'ref', 'children', 'overrides'])
/** a slot's default content is shown as it is: these hold no words or controls a person would replace */
const DECORATIVE = new Set(['svg', 'img', 'hr', 'canvas', 'video', 'audio', 'picture'])
const CONTROLS = new Set(['input', 'textarea', 'select', 'button', 'a'])
/** at most this many parts become slots */
const MAX_SLOTS = 8

/** Attributes whose value is what a person types into a field or reads in it, so an arg that equals one is that attribute. */
const CONTENT_ATTRS = new Set([
  'placeholder',
  'value',
  'alt',
  'title',
  'aria-label',
  'label',
  'min',
  'max',
  'step',
  'maxlength',
  'minlength',
  'pattern',
])
/** The attributes whose mere presence is true, and the elements that can carry each (`root` means the component's own root). */
const PRESENCE: Record<string, string[]> = {
  checked: ['input'],
  disabled: ['button', 'input', 'select', 'textarea', 'fieldset'],
  required: ['input', 'select', 'textarea'],
  readonly: ['input', 'textarea'],
  multiple: ['input', 'select'],
  autofocus: ['input', 'button', 'select', 'textarea'],
  selected: ['option'],
  open: ['details', 'dialog'],
  hidden: ['root'],
  inert: ['root'],
}
/** The attributes a prop is made for when the markup has them and no arg says so: what is typed into a field and what is said of an image. */
const NATIVE_CONTENT = ['placeholder', 'alt']

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A name that reads as an event handler (`on-click`, `onclick`, `on_change`) is not a slot or a prop: it would be mistaken for one by a framework or a person. */
function isHandlerName(name: string): boolean {
  return /^on[-_]?[a-z]/i.test(name)
}

interface TreeNode {
  tag: string
  depth: number
  parent: number
  kids: number[]
}

/** The tree `shape` writes (depth and tag of every element, in order), or undefined when it does not line up with the capture. */
function readTree(shape: string, count: number): TreeNode[] | undefined {
  const pieces = shape.split(',')
  if (pieces.length !== count) return undefined
  const nodes: TreeNode[] = []
  const lineage: number[] = []
  for (const [index, piece] of pieces.entries()) {
    const match = /^(\d{1,4})(.+)$/.exec(piece)
    if (!match) return undefined
    const depth = Number(match[1])
    if (index === 0 ? depth !== 0 : depth < 1 || depth > lineage.length) return undefined
    lineage.length = depth
    const parent = depth === 0 ? -1 : (lineage[depth - 1] ?? -1)
    lineage[depth] = index
    nodes.push({ tag: (match[2] ?? '').toLowerCase(), depth, parent, kids: [] })
    if (parent >= 0) nodes[parent]?.kids.push(index)
  }
  return nodes
}

/** What an element says it is (`data-slot` or `data-part`), as a lowercase name. */
export function identityOf(attrs: Record<string, string> | undefined): string | undefined {
  for (const name of IDENTITY_ATTRS) {
    const value = (attrs?.[name] ?? '').trim().toLowerCase()
    if (IDENTITY.test(value)) return value.replace(/_/g, '-')
  }
  return undefined
}

/** The identities of the elements below a story's root, normalized as component names are, for finding the other components a render shows. */
export function innerIdentities(capture: CapturedStory): Set<string> {
  const found = new Set<string>()
  capture.attrs?.forEach((attrs, index) => {
    const identity = index > 0 ? identityOf(attrs) : undefined
    if (identity) found.add(normal(identity))
  })
  return found
}

export interface CompoundInput {
  capture: CapturedStory
  /** the Storybook's own props, with their arg and initial value */
  props: ArgProp[]
  /** props something in the markup already follows (a text arg, a found attribute) */
  bound: ReadonlySet<string>
  /** elements that already carry a binding of any kind, by index */
  occupied: ReadonlySet<number>
  /** attributes already bound, as `index\0name` */
  boundAttrs: ReadonlySet<string>
  /** every name taken by a prop of the component */
  taken: ReadonlySet<string>
  /** the other components of the bundle, as `normal` names: a part holding one is a region someone fills */
  bundleNames: ReadonlySet<string>
}

export interface CompoundPlan {
  /** element index -> bindings (`attr:prop`, or the bare prop name for the element's text) to add */
  bindings: Map<number, string[]>
  /** element index -> slot name */
  slots: Map<number, string>
  /** props the markup now follows that the Storybook did not list */
  added: ArgProp[]
  /** props whose type the binding settled (a text arg that fills an image's `src` is an image) */
  retyped: Map<string, ArgProp['type']>
  /** names of added props that have no counterpart in the React component, so the export leaves them out */
  omit: Set<string>
  /** states the markup says twice (`aria-checked` and the `data-state` a library styles by): the prop, and the `data-state` value of each side, so the library's rules for the on state can be applied by the prop */
  states: { prop: string; on: string; off: string }[]
}

/** The ARIA states that a library mirrors into `data-state`, with the value of each side. */
const STATE_PAIRS: Record<string, { prop: string; on: string; off: string }> = {
  'aria-checked': { prop: 'checked', on: 'checked', off: 'unchecked' },
  'aria-pressed': { prop: 'pressed', on: 'on', off: 'off' },
  'aria-expanded': { prop: 'expanded', on: 'open', off: 'closed' },
}

function unique(base: string, taken: Set<string>): string {
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  taken.add(name)
  return name
}

/** What the markup says about its parts and its props. Nothing here changes the capture. */
export function planCompound(input: CompoundInput): CompoundPlan {
  const { capture } = input
  const plan: CompoundPlan = {
    bindings: new Map(),
    slots: new Map(),
    added: [],
    retyped: new Map(),
    omit: new Set(),
    states: [],
  }
  const attrs = capture.attrs
  const texts = capture.texts
  if (!attrs || !texts || attrs.length !== capture.paths.length || texts.length !== attrs.length) return plan
  const tree = readTree(capture.shape, attrs.length)
  if (!tree) return plan
  const taken = new Set(input.taken)
  const bind = (index: number, binding: string) => {
    plan.bindings.set(index, [...(plan.bindings.get(index) ?? []), binding])
  }
  const subtree = (index: number): number[] => {
    const out: number[] = []
    const depth = tree[index]?.depth ?? 0
    for (let at = index + 1; at < tree.length && (tree[at]?.depth ?? 0) > depth; at++) out.push(at)
    return out
  }
  const rootIdentity = identityOf(attrs[0])
  const slotOf = (index: number): number | undefined => {
    for (let at = index; at >= 0; at = tree[at]?.parent ?? -1) if (plan.slots.has(at)) return at
    return undefined
  }

  /* parts: the outermost identified elements below the root */
  const parts: number[] = []
  for (let index = 1; index < tree.length; index++) {
    if (!identityOf(attrs[index])) continue
    let nested = false
    for (let at = tree[index]?.parent ?? -1; at > 0; at = tree[at]?.parent ?? -1) {
      if (identityOf(attrs[at])) {
        nested = true
        break
      }
    }
    if (!nested) parts.push(index)
  }
  const slotNames = new Set<string>()
  for (const index of parts) {
    const identity = identityOf(attrs[index])
    if (!identity || input.occupied.has(index)) continue
    const stripped =
      rootIdentity && identity.startsWith(`${rootIdentity}-`) ? identity.slice(rootIdentity.length + 1) : identity
    const stem = stripped.replace(/_/g, '-')
    if (isHandlerName(stem)) continue
    if (!SAFE_NAME.test(stem)) continue
    const node = tree[index]!
    const below = subtree(index)
    if (below.some((at) => input.occupied.has(at))) continue
    const text = texts[index] ?? ''
    if (!node.kids.length) {
      /* one plain text: a text prop named for the part */
      if (!text || DECORATIVE.has(node.tag)) continue
      const name = unique(RESERVED.has(stem) ? `${stem}-text` : stem, taken)
      bind(index, name)
      plan.added.push({ name, type: 'text', arg: name })
      plan.omit.add(name)
      continue
    }
    if (DECORATIVE.has(node.tag) || plan.slots.size >= MAX_SLOTS) continue
    const worthy = below.some(
      (at) =>
        Boolean(texts[at]) ||
        CONTROLS.has(tree[at]?.tag ?? '') ||
        input.bundleNames.has(normal(identityOf(attrs[at]) ?? '')),
    )
    if (!worthy && !text) continue
    plan.slots.set(index, unique(RESERVED.has(stem) ? `${stem}-content` : stem, slotNames))
  }

  const bindAttribute = (index: number, attribute: string, prop: string) => {
    bind(index, `${attribute}:${prop}`)
  }
  const free = (index: number, attribute: string) =>
    slotOf(index) === undefined && !input.boundAttrs.has(`${index}\u0000${attribute}`)

  /* a prop the Storybook listed, whose value is on an element: bound to that attribute */
  for (const prop of input.props) {
    if (input.bound.has(prop.name) || prop.initial === undefined) continue
    const value = String(prop.initial)
    const arg = normal(prop.arg)
    if (prop.type === 'boolean') {
      let target: { index: number; attribute: string } | undefined
      for (const [index, own] of attrs.entries()) {
        for (const [attribute, held] of Object.entries(own)) {
          const named = normal(attribute.replace(/^(?:aria|data)-/, '')) === arg
          if (named && free(index, attribute) && (held === value || (held === '' && value === 'true'))) {
            target ??= { index, attribute }
          }
        }
      }
      const allowed = PRESENCE[arg]
      if (!target && allowed) {
        const hosts = tree.flatMap((node, index) =>
          (allowed.includes('root') ? index === 0 : allowed.includes(node.tag)) && free(index, arg) ? [index] : [],
        )
        const [only] = hosts
        if (hosts.length === 1 && only !== undefined) target = { index: only, attribute: arg }
      }
      if (target) bindAttribute(target.index, target.attribute, prop.name)
      continue
    }
    if (prop.type !== 'text' && prop.type !== 'number' && prop.type !== 'color') continue
    if (!value.trim()) continue
    let target: { index: number; attribute: string; image?: boolean } | undefined
    for (const [index, own] of attrs.entries()) {
      for (const [attribute, held] of Object.entries(own)) {
        const named = normal(attribute.replace(/^(?:aria|data)-/, '')) === arg
        if (held === value && (CONTENT_ATTRS.has(attribute) || named) && free(index, attribute)) {
          target ??= { index, attribute }
        }
      }
    }
    if (!target && prop.type === 'text' && (value.startsWith('/') || /^https?:\/\//.test(value))) {
      const index = capture.srcs?.findIndex((src) => src && (src === value || src.endsWith(value))) ?? -1
      if (index >= 0 && free(index, 'src')) target = { index, attribute: 'src', image: true }
    }
    if (!target) continue
    bindAttribute(target.index, target.attribute, prop.name)
    if (target.image) plan.retyped.set(prop.name, 'image')
  }

  /* an attribute that holds something to type or say, with no prop for it: its own prop, named like the attribute */
  for (const attribute of NATIVE_CONTENT) {
    for (const [index, own] of attrs.entries()) {
      const held = own[attribute]
      if (!held?.trim() || !free(index, attribute)) continue
      if ([...(plan.bindings.get(index) ?? [])].some((binding) => binding.startsWith(`${attribute}:`))) continue
      const name = unique(attribute, taken)
      bindAttribute(index, attribute, name)
      plan.added.push({ name, type: 'text', arg: name })
    }
  }
  /* an image the library names as a part of the component (`data-slot`), with no prop for its source: the source is its prop, named as the attribute is so it passes through to the element */
  for (const [index, node] of tree.entries()) {
    if (node.tag !== 'img' || !identityOf(attrs[index]) || !capture.srcs?.[index] || !free(index, 'src')) continue
    if ([...(plan.bindings.get(index) ?? [])].some((binding) => binding.startsWith('src:'))) continue
    const name = unique('src', taken)
    bindAttribute(index, 'src', name)
    plan.added.push({ name, type: 'image', arg: name })
  }

  /* a state the markup says in ARIA and again in `data-state` (a switch, a checkbox, a toggle): a boolean prop that follows the ARIA attribute; the library's rules are keyed to `data-state`, so the caller applies them for the on state */
  for (const [index, own] of attrs.entries()) {
    for (const [attribute, pair] of Object.entries(STATE_PAIRS)) {
      const held = own[attribute]
      const state = own['data-state']
      if ((held !== 'true' && held !== 'false') || state !== (held === 'true' ? pair.on : pair.off)) continue
      if (taken.has(pair.prop) || plan.states.length || !free(index, attribute) || slotOf(index) !== undefined) continue
      taken.add(pair.prop)
      bindAttribute(index, attribute, pair.prop)
      plan.added.push({ name: pair.prop, type: 'boolean', arg: pair.prop, default: held })
      plan.states.push(pair)
    }
  }
  return plan
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The rules of `css` that apply while a state is on, written without the `data-state` they are keyed to (the prop turns the look on, and the compound onto the root does the rest): a rule whose selector names the on value, in a group too (`@layer`, `@media`), and not the off value. */
export function onStateRules(css: string, state: { on: string; off: string }, depth = 0): string {
  const on = new RegExp(`\\[data-state=(?:"${escapeRegExp(state.on)}"|${escapeRegExp(state.on)})\\]`, 'g')
  const off = new RegExp(`\\[data-state=(?:"${escapeRegExp(state.off)}"|${escapeRegExp(state.off)})\\]`)
  const kept: string[] = []
  for (const rule of splitRules(css).rules) {
    const open = rule.indexOf('{')
    const close = rule.lastIndexOf('}')
    if (open < 0 || close < open) continue
    const head = rule.slice(0, open)
    if (head.trimStart().startsWith('@')) {
      if (depth >= 3) continue
      const inner = onStateRules(rule.slice(open + 1, close), state, depth + 1)
      if (inner) kept.push(`${head.trim()} {\n${inner}\n}`)
    } else if (on.test(head) && !off.test(head)) {
      kept.push(`${head.replace(on, '').trim()} ${rule.slice(open)}`)
    }
    on.lastIndex = 0
  }
  return kept.join('\n')
}
