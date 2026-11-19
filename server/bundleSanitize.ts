import { serialize, type DefaultTreeAdapterTypes as Tree, type Token } from 'parse5'
import {
  ATTR_IF_ATTR,
  IF_ATTR,
  SLOT_ATTR,
  BIND_ATTR,
  USE_TAG,
  URL_TARGETS,
  styleText,
  unsafeBindingTarget,
  formatAttrConditions,
  parseAttrConditions,
} from '../shared/components.ts'
import { attrOf, isElement, rootFragment } from './componentEngine.ts'
import { parseCss, serializeNodes, splitTopLevel, type CssNode } from './componentCss.ts'

/**
 * Everything in a component bundle is untrusted: a published Storybook, a CLI upload or an agent wrote it. The importer
 * (server/componentBundleImport.ts) runs every component's markup and stylesheet through here before the ordinary
 * component write path sees them, so a script, an event handler or a remote-code URL never reaches a frame.
 * Nothing here runs customer code or fetches anything; it only removes what must not be stored, and says what it removed.
 */

export interface SanitizeIssue {
  code: string
  message: string
}

export interface Sanitized {
  value: string
  issues: SanitizeIssue[]
}

/** Elements that run code, load another document or change how the frame is read: removed with their content. */
const DROPPED_TAGS = new Set([
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'fencedframe',
  'base',
  'meta',
  'link',
])

/** Attributes removed whatever they hold. */
const DROPPED_ATTRS = new Set(['srcdoc', 'ping', 'formaction'])

/** Attributes that carry a URL (or, for srcset, a list of them). */
const URL_ATTRS = URL_TARGETS

/** The `data-doop-*` attributes a template may carry; every other one is the editor's own bookkeeping. */
const KEPT_DOOP_ATTRS = new Set([BIND_ATTR, SLOT_ATTR, 'data-doop-slot-suggest', IF_ATTR, ATTR_IF_ATTR])

const MAX_DEPTH = 200
const MAX_NODES = 50_000

/** A value with control characters and whitespace removed and lower-cased, the way a browser reads a URL's scheme. */
function compact(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const skipped =
      code <= 0x20 ||
      (code >= 0x7f && code <= 0xa0) ||
      code === 0xad ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x3000 ||
      code === 0xfeff
    if (!skipped) out += char
  }
  return out.toLowerCase()
}

const DANGEROUS_SCHEME =
  /(?:^|[,;(])(?:javascript|vbscript|livescript|mocha):|data:(?:text\/html|application\/xhtml|text\/xml)/
const BASE64_DATA = /data:[^,;]*(?:;[a-z0-9-]+=[^;,]*)*;base64,/i

/** Why a URL attribute's value cannot stay, or null when it can. */
function urlProblem(value: string): { code: string; message: string } | null {
  const text = compact(value)
  if (DANGEROUS_SCHEME.test(text) || /^(?:javascript|vbscript|livescript|mocha):/.test(text))
    return { code: 'unsafe_url', message: 'a javascript:, vbscript: or data:text/html URL was removed' }
  if (BASE64_DATA.test(text))
    return {
      code: 'inline_data',
      message: 'a base64 data: URI was removed: host the file and use its URL (Doop keeps files out of frames)',
    }
  return null
}

/** A data-doop-prop list without the pieces that would bind a prop to an event handler or srcdoc/ping; the rest stays. */
function cleanBindings(value: string, tag: string, issues: SanitizeIssue[]): string {
  const kept: string[] = []
  for (const piece of value.split(',')) {
    const at = piece.lastIndexOf(':')
    const target = at === -1 ? '' : piece.slice(0, at)
    if (target && (unsafeBindingTarget(target, tag) || DROPPED_ATTRS.has(target.trim().toLowerCase()))) {
      issues.push({
        code: 'binding_dropped',
        message: `the binding “${piece.trim().slice(0, 60)}” was removed: a prop is never bound to ${target.trim()}`,
      })
      continue
    }
    kept.push(piece)
  }
  return kept.join(',').trim()
}

/** Whether an attribute is removed from bundle markup whatever it holds. */
function refusedAttribute(name: string): boolean {
  return (
    name.startsWith('on') || DROPPED_ATTRS.has(name) || (name.startsWith('data-doop-') && !KEPT_DOOP_ATTRS.has(name))
  )
}

/** A data-doop-attr-if list without the entries that name an attribute this sanitizer refuses (or the editor's own `data-doop-*`) and those whose conditions do not parse; the rest stays. */
function cleanAttrConditions(value: string, issues: SanitizeIssue[]): string {
  const entries = parseAttrConditions(value)
  const kept = entries.filter((entry) => {
    const name = entry.attr.toLowerCase()
    if (!refusedAttribute(name) && !name.startsWith('data-doop-')) return true
    issues.push({
      code: 'attr_condition_dropped',
      message: `the condition on “${entry.attr.slice(0, 60)}” was removed: a prop never decides whether ${entry.attr.slice(0, 60)} is kept`,
    })
    return false
  })
  return formatAttrConditions(kept)
}

function cleanAttributes(el: Tree.Element, issues: SanitizeIssue[]) {
  const kept: Token.Attribute[] = []
  for (const attr of el.attrs) {
    const name = attr.name.toLowerCase()
    if (refusedAttribute(name)) continue
    if (name === ATTR_IF_ATTR) {
      const value = cleanAttrConditions(attr.value, issues)
      if (value) kept.push({ ...attr, value })
      continue
    }
    if (name === BIND_ATTR && el.tagName.toLowerCase() !== USE_TAG) {
      const value = cleanBindings(attr.value, el.tagName, issues)
      if (value) kept.push({ ...attr, value })
      continue
    }
    if (name === 'style') {
      const css = sanitizeDeclarations(attr.value, issues)
      if (css) kept.push({ ...attr, value: css })
      continue
    }
    if (URL_ATTRS.has(name)) {
      const problem = urlProblem(attr.value)
      if (problem) {
        issues.push({ code: problem.code, message: `<${el.tagName} ${name}>: ${problem.message}` })
        /* an image or link that cannot point anywhere stays as an empty one: the element is the design */
        if (problem.code === 'inline_data' && (name === 'src' || name === 'poster')) kept.push({ ...attr, value: '' })
        continue
      }
    }
    kept.push(attr)
  }
  el.attrs = kept
}

/** Whether a node is an animation that would set a link target or an event handler (`<animate attributeName="href" to="javascript:…">`). */
function animatesLink(el: Tree.Element): boolean {
  if (!['set', 'animate', 'animatemotion', 'animatetransform'].includes(el.tagName.toLowerCase())) return false
  const target = (attrOf(el, 'attributeName') ?? attrOf(el, 'attributename') ?? '').trim()
  return /^(on|(xlink:)?href$)/i.test(target)
}

export interface MarkupResult {
  /** the sanitized markup, every root element of it */
  html: string
  /** the rules found in <style> elements inside the markup, already sanitized: they belong with the component's css */
  css: string
  issues: SanitizeIssue[]
}

/**
 * parse5 over the markup, the way the component write path reads it (a table part in its table), then walk it
 * and remove what must not be stored. The tree is the only thing consulted: no regex runs over raw markup.
 */
export function sanitizeMarkup(markup: string): MarkupResult {
  const issues: SanitizeIssue[] = []
  const styles: string[] = []
  const fragment = rootFragment(markup.trim())
  let nodes = 0
  const walk = (parent: Tree.ParentNode, depth: number) => {
    if (depth > MAX_DEPTH) {
      parent.childNodes = []
      issues.push({ code: 'too_deep', message: `markup nested deeper than ${MAX_DEPTH} levels was cut off` })
      return
    }
    const kept: Tree.ChildNode[] = []
    for (const child of parent.childNodes) {
      if (++nodes > MAX_NODES) {
        issues.push({ code: 'too_large', message: `markup past ${MAX_NODES} nodes was cut off` })
        break
      }
      if (child.nodeName === '#comment') continue
      if (!isElement(child)) {
        kept.push(child)
        continue
      }
      const tag = child.tagName.toLowerCase()
      if (DROPPED_TAGS.has(tag) || animatesLink(child)) {
        issues.push({ code: 'dropped_element', message: `<${tag}> was removed` })
        continue
      }
      if (tag === 'style') {
        const text = child.childNodes.map((node) => ('value' in node ? node.value : '')).join('')
        const clean = sanitizeStylesheet(text)
        issues.push(...clean.issues)
        if (clean.value) styles.push(clean.value)
        continue
      }
      cleanAttributes(child, issues)
      walk(child, depth + 1)
      /* a <template>'s children live apart from childNodes */
      const content = (child as Tree.Template).content
      if (tag === 'template' && content) walk(content, depth + 1)
      kept.push(child)
    }
    parent.childNodes = kept
  }
  walk(fragment, 0)
  return { html: serialize(fragment).trim(), css: styles.join('\n'), issues: dedupe(issues) }
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

const CSS_THREATS = /expression\(|javascript:|vbscript:|livescript:|behavior:|-moz-binding|data:text\/html|@import/

/** CSS as a browser reads it, for checking only: comments out, escapes decoded, whitespace gone, lower-cased. */
function readAsBrowser(css: string): string {
  const decoded = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\([^\n])/gi, (_match, hex: string | undefined, char: string | undefined) => {
      if (!hex) return char ?? ''
      const point = parseInt(hex, 16)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
  return decoded.replace(/\s+/g, '').toLowerCase()
}

const hasThreat = (css: string) => CSS_THREATS.test(readAsBrowser(css))

/** Whether a design-token value is anything but a plain css value (a url, a script-bearing value, a block). */
export const unsafeCssValue = (value: string): boolean => hasThreat(value) || /url\(|[{};]/i.test(value)

/** A base64 data: URI wherever it sits in css text (image-set("data:…"), a string, a bare value). */
const BASE64_ANYWHERE = /data:[^,;"'()\s]*(?:;[a-z0-9-]+=[^;,"'()\s]*)*;base64,[a-z0-9+/=_-]*/gi

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi

/** Keep a url() that points at a public page or an in-document id; anything else becomes an empty url. */
function cleanUrls(css: string, issues: SanitizeIssue[]): string {
  return css.replace(URL_TOKEN, (token, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
    const raw = (dq ?? sq ?? bare ?? '').trim()
    const text = compact(raw)
    if (/^https?:\/\//.test(text) || text.startsWith('#') || text === '') return token
    if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,]*)*,/.test(text) && !BASE64_DATA.test(text)) return token
    const code = BASE64_DATA.test(text) ? 'inline_data' : 'css_url_dropped'
    issues.push({
      code,
      message:
        code === 'inline_data'
          ? 'a base64 data: URI in css was removed: host the file and use its URL'
          : `css url(${raw.slice(0, 80)}) was removed: only http(s) addresses and #ids are kept (a relative path cannot be resolved here)`,
    })
    return 'url("")'
  })
}

/** url() tokens cleaned, then any base64 data: URI left in the text (image-set, a string) removed. */
function cleanCssText(css: string, issues: SanitizeIssue[]): string {
  const urls = cleanUrls(css, issues)
  return urls.replace(BASE64_ANYWHERE, () => {
    issues.push({
      code: 'inline_data',
      message: 'a base64 data: URI in css was removed: host the file and use its URL',
    })
    return ''
  })
}

function sanitizeDeclarations(body: string, issues: SanitizeIssue[]): string {
  const kept: string[] = []
  for (const declaration of splitTopLevel(body, ';')) {
    if (!declaration.trim()) continue
    if (hasThreat(declaration)) {
      issues.push({ code: 'unsafe_css', message: `css declaration “${declaration.trim().slice(0, 60)}” was removed` })
      continue
    }
    kept.push(cleanCssText(declaration.trim(), issues))
  }
  return styleText(kept.join('; '))
}

const DECLARATION_AT_RULES = new Set(['font-face', 'page', 'property', 'counter-style', 'font-palette-values'])

function sanitizeNodes(nodes: CssNode[], issues: SanitizeIssue[]): CssNode[] {
  const kept: CssNode[] = []
  for (const node of nodes) {
    if (node.kind === 'rule') {
      if (hasThreat(node.selector)) {
        issues.push({ code: 'unsafe_css', message: `css rule “${node.selector.trim().slice(0, 60)}” was removed` })
        continue
      }
      const body = sanitizeDeclarations(node.body, issues)
      if (body) kept.push({ ...node, body: ` ${body}; ` })
    } else if (node.kind === 'group') {
      if (hasThreat(node.prelude)) {
        issues.push({ code: 'unsafe_css', message: `css block “${node.prelude.slice(0, 60)}” was removed` })
        continue
      }
      const inner = sanitizeNodes(node.nodes, issues)
      if (inner.length) kept.push({ ...node, nodes: inner })
    } else if (node.name === 'import') {
      issues.push({
        code: 'css_import_dropped',
        message: '@import was removed: send the imported stylesheet’s rules in the css itself',
      })
    } else if (DECLARATION_AT_RULES.has(node.name) && node.body) {
      const body = sanitizeDeclarations(node.body, issues)
      if (body) kept.push({ ...node, text: `${node.prelude}{ ${body}; }`, body })
    } else if (hasThreat(node.text)) {
      issues.push({ code: 'unsafe_css', message: `css block “${node.prelude.slice(0, 60)}” was removed` })
    } else {
      kept.push({ ...node, text: cleanCssText(node.text, issues) })
    }
  }
  return kept
}

/** A stylesheet: no @import, no script-bearing value, no url() that is not a public page. */
export function sanitizeStylesheet(css: string): Sanitized {
  const issues: SanitizeIssue[] = []
  const nodes = sanitizeNodes(parseCss(css), issues)
  return { value: styleText(serializeNodes(nodes)), issues: dedupe(issues) }
}

export { sanitizeDeclarations as sanitizeStyleAttribute }

function dedupe(issues: SanitizeIssue[]): SanitizeIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
