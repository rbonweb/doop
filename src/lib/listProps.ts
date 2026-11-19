import {
  BIND_ATTR,
  EACH_ATTR,
  IF_ATTR,
  MAX_LIST_ITEMS,
  listJson,
  parseBindings,
  parseCondition,
  readList,
  unsafeUrl,
  type ComponentDef,
  type ComponentProp,
  type ListItem,
} from '../../shared/components'

/**
 * The editor's side of a list prop: its value is a JSON array of items, one value per declared field. The server owns what
 * is stored and rendered (`readList`, `listJson`); this reads a value into rows, builds the next value from an edit, and
 * works out the one item a main's own content stands for, which a fresh instance shows until it is given items.
 */

/** The fields of a list prop in the order they were declared. */
export function listFieldNames(prop: Pick<ComponentProp, 'fields'>): string[] {
  return Object.keys(prop.fields ?? {})
}

/** The items a stored value holds; a value that is not a valid list reads as no items rather than as an error. */
export function listItemsOf(prop: ComponentProp, value: string): ListItem[] {
  if (value.trim() === '') return []
  return readList(prop, value).items ?? []
}

/** The next value for a list: the one stored form the server writes, so an unchanged list is an unchanged marker. */
export function listValue(items: readonly ListItem[]): string {
  return listJson(items)
}

/** A new item: every boolean off, every other field left out until it is filled in. */
export function newListItem(prop: Pick<ComponentProp, 'fields'>): ListItem {
  const item: ListItem = {}
  for (const [name, field] of Object.entries(prop.fields ?? {})) if (field.type === 'boolean') item[name] = false
  return item
}

/** One field of one item set, a cleared text-like field left out of the item (the server reads a missing field as empty). */
export function setListField(
  items: readonly ListItem[],
  at: number,
  field: string,
  value: string | boolean,
): ListItem[] {
  return items.map((item, index) => {
    if (index !== at) return item
    const next: ListItem = { ...item }
    if (value === '') delete next[field]
    else next[field] = value
    return next
  })
}

export function addListItem<T>(items: readonly T[], item: T, after = items.length - 1): T[] {
  if (items.length >= MAX_LIST_ITEMS) return [...items]
  const next = [...items]
  next.splice(after + 1, 0, item)
  return next
}

export function removeListItem<T>(items: readonly T[], at: number): T[] {
  return items.filter((_item, index) => index !== at)
}

/** An item moved to a new place (`to` is where it ends up); a move off either end, or onto itself, changes nothing. */
export function moveListItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved) next.splice(to, 0, moved)
  return next
}

/** What an item is called in the list: its first filled-in text, else "Item 3". */
export function listItemTitle(prop: Pick<ComponentProp, 'fields'>, item: ListItem): string | undefined {
  for (const [name, field] of Object.entries(prop.fields ?? {})) {
    const value = item[name]
    if (field.type === 'text' && typeof value === 'string' && value.trim()) return value.trim().slice(0, 40)
  }
  return undefined
}

/**
 * The one item a main's content stands for (what its bound elements hold inside the repeated element): what an instance
 * with no items of its own shows. The server computes the same (`sampleItem`), so the editor's rows match the canvas.
 */
export function listSample(def: Pick<ComponentDef, 'template'>, prop: ComponentProp): ListItem[] {
  const holder = new DOMParser()
    .parseFromString(`<template>${def.template}</template>`, 'text/html')
    .querySelector('template')
  let each: Element | undefined
  for (const el of holder?.content.querySelectorAll(`[${EACH_ATTR}]`) ?? []) {
    if (el.getAttribute(EACH_ATTR)?.trim() === prop.name) {
      each = el
      break
    }
  }
  if (!each) return []
  const fields = prop.fields ?? {}
  const item: ListItem = {}
  for (const node of [each, ...each.querySelectorAll('*')]) {
    for (const { target, prop: name } of parseBindings(node.getAttribute(BIND_ATTR) ?? '', node.tagName)) {
      const field = Object.hasOwn(fields, name) ? fields[name] : undefined
      if (!field || field.type === 'boolean' || Object.hasOwn(item, name)) continue
      if (target !== null && (target.startsWith('style.') || target.startsWith('--'))) continue
      const value = target === null ? ownText(node) : node.getAttribute(target)
      if (!value || (field.type !== 'text' && unsafeUrl(value))) continue
      item[name] = value
    }
    const condition = node === each ? undefined : parseCondition(node.getAttribute(IF_ATTR) ?? '')
    if (condition?.equals === undefined && condition && fields[condition.prop]?.type === 'boolean')
      if (!Object.hasOwn(item, condition.prop)) item[condition.prop] = !condition.negate
  }
  return [item]
}

/** The text an element holds directly, whitespace collapsed (as the server reads it): nested elements' text is theirs. */
function ownText(el: Element): string {
  let text = ''
  for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim()
}
