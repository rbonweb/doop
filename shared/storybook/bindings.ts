import type { ArgProp } from './argTypes.ts'
import type { CapturedStory } from './capture.ts'

/** Pure: no node or server imports, since the CLI bundles it. Finds which attribute of which element tracks a story arg, by comparing the default render with a render of each value, so a prop can be bound to the element that really changes (`data-doop-prop="data-variant:variant"`) rather than to the story's wrapper. The library's own CSS then does the styling. */

/** Attributes whose mere presence means true; a prop that adds or removes one is a boolean on it. */
const PRESENCE = new Set([
  'disabled',
  'checked',
  'hidden',
  'readonly',
  'required',
  'selected',
  'open',
  'multiple',
  'autofocus',
  'inert',
])

/** Whether a prop may follow this attribute: a plain lowercase name, and none the capture never reads. One definition serves both sides: the server calls it on what a page answered, and `CAPTURE_PRELUDE` installs its source in the isolated world, where the capture calls it as it reads attributes, so the two cannot drift. It must stay self-contained (no outer names), since only its source travels. Attributes no prop may follow style or address the element, run script, or carry a URL. */
export function isFollowableAttribute(name: string): boolean {
  const denied = ['class', 'style', 'id', 'href', 'src', 'action', 'formaction', 'poster', 'data', 'srcset']
  return (
    name.length <= 100 &&
    /^[a-z][a-z0-9-]*$/.test(name) &&
    !denied.includes(name) &&
    !name.startsWith('on') &&
    !name.startsWith('data-doop-')
  )
}

/** At most this many elements follow one prop. */
const MAX_BOUND_ELEMENTS = 3

export interface VariantShot {
  prop: string
  value: string
  shot: CapturedStory
}

function changes(
  base: Record<string, string>,
  shot: Record<string, string>,
  name: string,
  prop: ArgProp,
  value: string,
): boolean {
  const before = base[name]
  const after = shot[name]
  if (after !== undefined && after === value && before !== after) {
    /* an enum or boolean whose default is known must start from it */
    return prop.default === undefined || before === prop.default || before === undefined
  }
  if (prop.type === 'boolean' && PRESENCE.has(name)) {
    if (value === 'true' && after !== undefined && before === undefined) return true
    if (value === 'false' && after === undefined && before !== undefined) return true
  }
  return false
}

/**
 * For each prop, the elements and attributes that follow every value of it: element index (root 0) to bindings `attr:prop`.
 * An attribute counts only when, for each value rendered, it holds that value in that render and held something else in the default render. A prop none tracks gets nothing, and is left to a CSS diff.
 */
export function findBindings(
  base: CapturedStory,
  shots: VariantShot[],
  props: ArgProp[],
): { bindings: Map<number, string[]>; bound: Set<string> } {
  const bindings = new Map<number, string[]>()
  const bound = new Set<string>()
  if (!base.attrs) return { bindings, bound }
  for (const prop of props) {
    if (prop.type !== 'enum' && prop.type !== 'boolean') continue
    const mine = shots.filter(
      (entry) => entry.prop === prop.name && entry.shot.attrs && entry.shot.shape === base.shape,
    )
    if (!mine.length) continue
    let candidates: Set<string> | undefined
    for (const { value, shot } of mine) {
      const found = new Set<string>()
      base.attrs.forEach((before, index) => {
        const after = shot.attrs?.[index]
        if (!after) return
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (isFollowableAttribute(name) && changes(before, after, name, prop, value))
            found.add(`${index}\u0000${name}`)
        }
      })
      candidates = candidates ? new Set([...candidates].filter((key) => found.has(key))) : found
      if (!candidates.size) break
    }
    if (!candidates?.size) continue
    const all = [...candidates].map((key) => {
      const [index = '0', name = ''] = key.split('\u0000')
      return { index: Number(index), name }
    })
    /* an attribute named like the prop (`data-variant` for variant) is the one that means it */
    const named = all.filter((candidate) => candidate.name.replace(/^data-/, '') === prop.name)
    const chosen = (named.length ? named : all).sort((a, b) => a.index - b.index).slice(0, MAX_BOUND_ELEMENTS)
    for (const { index, name } of chosen) {
      const list = bindings.get(index) ?? []
      list.push(`${name}:${prop.name}`)
      bindings.set(index, list)
    }
    bound.add(prop.name)
  }
  return { bindings, bound }
}

/** The base's bindings placed on a variant render's own elements, by element path: an element is the same one when its path is, and only a path that is unique in the render counts. A variant whose markup differs (an icon added to the button) then still carries the bindings, so the importer branches only what really differs. */
export function mapBindings(
  base: CapturedStory,
  shot: CapturedStory,
  bindings: Map<number, string[]>,
): Map<number, string[]> {
  const mapped = new Map<number, string[]>()
  for (const [index, list] of bindings) {
    const path = base.paths[index]
    if (path === undefined) continue
    const hits = shot.paths.flatMap((candidate, at) => (candidate === path ? [at] : []))
    const only = hits[0]
    if (hits.length === 1 && only !== undefined) mapped.set(only, list)
  }
  return mapped
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The html with each element's marker taken off, and `data-doop-prop` set to its own text bindings and the found ones. */
export function bindHtml(html: string, marker: string | undefined, bindings: Map<number, string[]>): string {
  if (!marker) return html
  const found = new RegExp(` ${escapeRegExp(marker)}="(\\d{1,6})"(?: data-doop-prop="([^"]*)")?`, 'g')
  return html.replace(found, (_all, index: string, own: string | undefined) => {
    const parts = [...(own ? [own] : []), ...(bindings.get(Number(index)) ?? [])]
    return parts.length ? ` data-doop-prop="${parts.join(',')}"` : ''
  })
}
