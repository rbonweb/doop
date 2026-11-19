import { BIND_ATTR, parseBindings } from '../../shared/components'

/**
 * The editor's side of a rich-text prop: the small inline subset the server keeps (text, b, i, br, a with an absolute
 * http(s) address; server/richText.ts decides what is stored). The field's contenteditable is turned into that subset
 * here before it is sent, so what is shown after the save is what was typed, and nothing but the subset is ever put back
 * into the field.
 */

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char)

/** An absolute http or https address with a host and no spaces or quote characters: the only link a value holds. */
export function webAddress(value: string): string | null {
  const text = value.trim()
  if (!/^https?:\/\/[^/?#]/i.test(text) || /[\s"'<>`\\]/.test(text)) return null
  try {
    const url = new URL(text)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? text : null
  } catch {
    return null
  }
}

const BLOCKS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE'])

function bold(el: Element): boolean {
  if (el.tagName === 'B' || el.tagName === 'STRONG') return true
  const weight = (el as HTMLElement).style?.fontWeight ?? ''
  return weight === 'bold' || Number(weight) >= 600
}

function italic(el: Element): boolean {
  return el.tagName === 'I' || el.tagName === 'EM' || (el as HTMLElement).style?.fontStyle === 'italic'
}

function walk(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml((node.textContent ?? '').replace(/\u00a0/g, ' '))
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  if (el.tagName === 'BR') return '<br>'
  if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return ''
  let inner = ''
  for (const child of el.childNodes) inner += walk(child)
  if (el.tagName === 'A') {
    const href = webAddress(el.getAttribute('href') ?? '')
    inner = href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner
  }
  if (bold(el) && inner) inner = `<b>${inner}</b>`
  if (italic(el) && inner) inner = `<i>${inner}</i>`
  /* a block the browser made for a line (a div after Enter, a pasted paragraph) becomes a line break before it */
  return BLOCKS.has(el.tagName) && inner ? `<br>${inner}` : inner
}

/** The subset markup a field's content stands for. Leading and doubled breaks the blocks left are trimmed. */
export function richTextSubset(root: Node): string {
  let html = ''
  for (const child of root.childNodes) html += walk(child)
  return html.replace(/^(?:<br>)+/, '').replace(/(<br>){3,}/g, '<br><br>')
}

/** A stored value as the field shows it: parsed inertly and rebuilt through the same walk, never put in as it came. */
export function richTextForField(value: string): string {
  const holder = new DOMParser().parseFromString(`<template>${value}</template>`, 'text/html').querySelector('template')
  return holder ? richTextSubset(holder.content) : ''
}

/** The content a main gives a rich-text prop when an instance gives none: the bound element's inline markup, in the subset. */
export function richTextTemplateValue(template: string, prop: string): string {
  const holder = new DOMParser()
    .parseFromString(`<template>${template}</template>`, 'text/html')
    .querySelector('template')
  for (const el of holder?.content.querySelectorAll(`[${BIND_ATTR}]`) ?? []) {
    for (const binding of parseBindings(el.getAttribute(BIND_ATTR) ?? '', el.tagName)) {
      if (binding.prop === prop && binding.target === null) return richTextSubset(el)
    }
  }
  return ''
}

/** Whether two values hold the same content, ignoring how the browser happened to write it. */
export function sameRichText(a: string, b: string): boolean {
  return richTextForField(a) === richTextForField(b)
}
