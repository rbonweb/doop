import { create } from 'zustand'
import { PART_ATTR, type ComponentProp } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from './api'
import { componentContextOf } from './components'
import type { StylePatch } from './frameBridge'
import { t } from './i18n'
import { useStore } from './store'
import type { VariantOp, VariantProp } from './variantTypes'

/**
 * Previewing a main's variants in the live document, and writing the Design panel's style edits to the previewed
 * combination instead of to the element. The preview is this browser's and never saved: the frame's runtime sets
 * the `data-<prop>` attributes on the main's root and takes them off again when the document is saved.
 */

type StyleOp = Extract<VariantOp, { op: 'set_style' }>

export interface VariantPreview {
  frameId: string
  componentId: string
  /** every variant prop's previewed value */
  values: Record<string, string>
  /** the previewed props that are not at their default: what a style edit is written under, empty for the base */
  when: Record<string, string>
}

interface PreviewState {
  preview: VariantPreview | null
  setPreview: (preview: VariantPreview | null) => void
}

export const useVariantPreview = create<PreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}))

/** The variant props of a component's props, in the shape the variants endpoint reads them. */
export function variantPropsOf(props: readonly ComponentProp[]): VariantProp[] {
  return props
    .filter((prop) => prop.type === 'enum' || (prop.type === 'boolean' && prop.reflect === true))
    .map((prop) => ({
      name: prop.name,
      type: prop.type === 'enum' ? ('enum' as const) : ('boolean' as const),
      options: prop.type === 'enum' ? [...(prop.options ?? [])] : ['true', 'false'],
      ...(prop.default !== undefined ? { default: prop.default } : {}),
    }))
}

/** The value an instance shows for this prop when it gives none. */
export function variantDefault(prop: VariantProp): string {
  if (prop.default !== undefined) return prop.default
  return prop.type === 'boolean' ? 'false' : (prop.options[0] ?? '')
}

/** A previewed combination: every prop at its pick (else its default), and which of them differ from the default. */
export function previewOf(
  frameId: string,
  componentId: string,
  props: readonly VariantProp[],
  picks: Record<string, string>,
): VariantPreview {
  const values: Record<string, string> = {}
  const when: Record<string, string> = {}
  for (const prop of props) {
    const pick = picks[prop.name]
    const value = pick !== undefined && prop.options.includes(pick) ? pick : variantDefault(prop)
    values[prop.name] = value
    if (value !== variantDefault(prop)) when[prop.name] = value
  }
  return { frameId, componentId, values, when }
}

/** "size=lg, tone=ghost": what the Design panel says it is editing. */
export function combinationLabel(when: Record<string, string>): string {
  return Object.entries(when)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')
}

/** A Design panel patch as the `set_style` op for one element under a combination: a null or empty value clears the property. */
export function variantStyleOp(when: Record<string, string>, element: string, patch: StylePatch): StyleOp {
  const declarations: Record<string, string | null> = {}
  for (const [property, value] of Object.entries(patch)) {
    declarations[property] = value === null || value.trim() === '' ? null : value
  }
  return { op: 'set_style', element, when: { ...when }, declarations }
}

export interface VariantEditTarget {
  preview: VariantPreview
  canvasId: string
  /** the element's part key in the main, `root` for the main's root; null for an element with no key */
  element: string | null
}

/** Where a style edit to this element goes: the previewed combination, when a non-default one is previewed on this
 *  frame and the element is the main or inside it. Null means an ordinary inline edit. */
export function variantEditTarget(frame: Frame, selector: string): VariantEditTarget | null {
  const { preview } = useVariantPreview.getState()
  if (!preview || preview.frameId !== frame.id || Object.keys(preview.when).length === 0) return null
  const context = componentContextOf(frame.html, selector, useStore.getState().canvas?.components ?? [])
  if (!context || context.kind !== 'main' || context.def.id !== preview.componentId) return null
  if (context.isRoot) return { preview, canvasId: frame.canvasId, element: 'root' }
  let key: string | null = null
  try {
    key =
      new DOMParser().parseFromString(frame.html, 'text/html').querySelector(selector)?.getAttribute(PART_ATTR) ?? null
  } catch {
    key = null
  }
  return { preview, canvasId: frame.canvasId, element: key }
}

/* Edits to one element arrive many times a second (a colour drag, a typed value): they merge into one write per
   quiet moment, and writes run in order so a later one never lands under an earlier one. */
const FLUSH_MS = 220
const pending = new Map<
  string,
  { canvasId: string; componentId: string; op: Extract<VariantOp, { op: 'set_style' }> }
>()
let timer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<unknown> = Promise.resolve()

async function flush(): Promise<void> {
  timer = null
  const batches = new Map<string, { canvasId: string; componentId: string; ops: VariantOp[] }>()
  for (const { canvasId, componentId, op } of pending.values()) {
    const key = `${canvasId}:${componentId}`
    const batch = batches.get(key) ?? { canvasId, componentId, ops: [] }
    batch.ops.push(op)
    batches.set(key, batch)
  }
  pending.clear()
  for (const { canvasId, componentId, ops } of batches.values()) {
    chain = chain
      .then(() => api.editComponentVariants(canvasId, componentId, { ops }))
      .then(({ component }) => {
        if (useStore.getState().canvas?.id === canvasId) useStore.getState().setComponentLocal(component.id, component)
      })
      .catch((error: unknown) =>
        useStore.getState().pushNotice(errorMessage(error, t('componentVariants.styleFailed'))),
      )
  }
  await chain
}

/** Queue a Design panel patch for the previewed combination. False when the element is not under a previewed
 *  combination (the caller writes it inline as usual). */
export function writeVariantStyle(frame: Frame, selector: string, patch: StylePatch): boolean {
  const target = variantEditTarget(frame, selector)
  if (!target) return false
  if (target.element === null) {
    useStore.getState().pushNotice(t('componentVariants.noPart'))
    return true
  }
  const op = variantStyleOp(target.preview.when, target.element, patch)
  const key = `${target.canvasId}:${target.preview.componentId}:${target.element}:${JSON.stringify(op.when)}`
  const queued = pending.get(key)
  if (queued) Object.assign(queued.op.declarations, op.declarations)
  else pending.set(key, { canvasId: target.canvasId, componentId: target.preview.componentId, op })
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), FLUSH_MS)
  return true
}

/** Write everything queued now, and wait for it. */
export function flushVariantStyles(): Promise<void> {
  if (timer) clearTimeout(timer)
  return flush()
}
