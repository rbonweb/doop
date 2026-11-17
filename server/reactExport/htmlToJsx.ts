import { html as htmlNs, parseFragment, type DefaultTreeAdapterTypes as Tree, type Token } from 'parse5'
import { parseStyle } from '../../shared/components.ts'
import { isUnsafeUrl, jsString, type ExportIssue } from './issues.ts'

export { isUnsafeUrl, jsString } from './issues.ts'

type Element = Tree.Element
type ChildNode = Tree.ChildNode
type ParentNode = Tree.ParentNode

export interface JsxContext {
  /** issues found so far; a visitor may push its own */
  issues: ExportIssue[]
  /** true inside <svg> (attribute names use the SVG table) */
  inSvg: boolean
  /** the default rendering of this element's children (JSX children text, already escaped) */
  children(): string
  /** the default rendering of the element itself; `attrs` replaces or adds JSX attributes (name -> full JSX attribute value text, e.g. '{label}' or '{"x"}'), `null` drops one */
  element(attrs?: Record<string, string | null>, children?: string): string
}

export interface HtmlToJsxOptions {
  /** called for every element before the default; return a JSX string to replace the whole element (an element, a fragment, or `{expression}`), or undefined for the default. It sees the original attributes, data-doop-* included. */
  visit?: (el: Element, ctx: JsxContext) => string | undefined
  /** turns an element's class list into the JSX value of className; default: a string literal */
  className?: (classes: string[], el: Element) => string
  /** called for every kept URL value (href, src, each srcset entry, poster, xlink:href, action, formaction, a `url()` in a style attribute) after the safety check, with the attribute name; the result is checked again, dropped with an issue if unsafe, and emitted through jsString */
  rewriteUrl?: (url: string, attr: string, el: Element) => string
  /** indent unit, default two spaces; output is readable but need not be Prettier-exact */
  indent?: string
}

export interface JsxResult {
  jsx: string
  issues: ExportIssue[]
}

/** `{"…"}`: the only form text children are emitted in */
export function jsxText(value: string): string {
  return `{${jsString(value)}}`
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** elements dropped with their subtree, other than `script` which has its own issue kind */
const DROPPED_ELEMENTS = new Set([
  'style',
  'base',
  'meta',
  'link',
  'object',
  'embed',
  'noscript',
  'template',
  'doop-use',
])

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'optgroup',
  'option',
  'p',
  'pre',
  'section',
  'select',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

/** parents whose children are never text in React (whitespace there only triggers nesting warnings) */
const NO_TEXT_PARENTS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'select',
  'optgroup',
  'datalist',
])
const SVG_TEXT_PARENTS = new Set(['text', 'tspan', 'textPath', 'title', 'desc', 'style', 'a'])
const PRESERVE_WHITESPACE = new Set(['pre', 'textarea', 'code'])

const TAG_NAME = /^[a-z][a-zA-Z0-9]*(-[a-z0-9]+)*$/
const JSX_ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_-]*(:[A-Za-z_][A-Za-z0-9_-]*)?$/
const ATTR_NAME = /^[a-z_][a-z0-9_-]*$/i
const PLAIN_ATTR_VALUE = /^[A-Za-z0-9 _\-.,:;/#%()+=?!@]*$/
const REACT_RESERVED = new Set([
  'key',
  'ref',
  'children',
  'dangerouslysetinnerhtml',
  'suppresshydrationwarning',
  'suppresscontenteditablewarning',
  '__proto__',
])
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'data',
  'cite',
  'background',
  'manifest',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'codebase',
  'profile',
  'icon',
])
/** elements that load a document: every data: URL is a script risk there, not only the non-image ones */
const EMBEDDING_ELEMENTS = new Set(['iframe', 'frame', 'embed', 'object'])
const isDataUrl = (value: string): boolean =>
  Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
    .toLowerCase()
    .startsWith('data:')
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset'])
/** HTML attributes whose React name is not the lowercase one (`class` and `for` are handled apart) */
const HTML_ATTR_NAMES = new Map<string, string>(
  [
    'acceptCharset',
    'accessKey',
    'allowFullScreen',
    'allowTransparency',
    'autoCapitalize',
    'autoComplete',
    'autoCorrect',
    'autoFocus',
    'autoPlay',
    'autoSave',
    'cellPadding',
    'cellSpacing',
    'charSet',
    'classID',
    'colSpan',
    'contentEditable',
    'contextMenu',
    'controlsList',
    'crossOrigin',
    'dateTime',
    'disablePictureInPicture',
    'disableRemotePlayback',
    'encType',
    'enterKeyHint',
    'fetchPriority',
    'formAction',
    'formEncType',
    'formMethod',
    'formNoValidate',
    'formTarget',
    'frameBorder',
    'hrefLang',
    'imageSizes',
    'imageSrcSet',
    'inputMode',
    'itemID',
    'itemProp',
    'itemRef',
    'itemScope',
    'itemType',
    'keyType',
    'marginHeight',
    'marginWidth',
    'maxLength',
    'mediaGroup',
    'minLength',
    'noModule',
    'noValidate',
    'playsInline',
    'radioGroup',
    'readOnly',
    'referrerPolicy',
    'rowSpan',
    'spellCheck',
    'srcLang',
    'srcSet',
    'tabIndex',
    'useMap',
  ].map((name) => [name.toLowerCase(), name] as const),
)
HTML_ATTR_NAMES.set('accept-charset', 'acceptCharset')
HTML_ATTR_NAMES.set('http-equiv', 'httpEquiv')
/** namespaced attributes React spells in camelCase */
const NAMESPACED_ATTR_NAMES = new Map<string, string>([
  ['xlink:actuate', 'xlinkActuate'],
  ['xlink:arcrole', 'xlinkArcrole'],
  ['xlink:href', 'xlinkHref'],
  ['xlink:role', 'xlinkRole'],
  ['xlink:show', 'xlinkShow'],
  ['xlink:title', 'xlinkTitle'],
  ['xlink:type', 'xlinkType'],
  ['xml:base', 'xmlBase'],
  ['xml:lang', 'xmlLang'],
  ['xml:space', 'xmlSpace'],
  ['xmlns:xlink', 'xmlnsXlink'],
])
/** boolean attributes React knows, by lowercase HTML name; bare when the value is empty or the name itself */
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
  'disablepictureinpicture',
  'disableremoteplayback',
  'formnovalidate',
  'hidden',
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
  'scoped',
  'seamless',
  'selected',
])
const VALUE_ELEMENTS = new Set(['input', 'select', 'textarea'])
const ANIMATION_VALUE_ATTRS = new Set(['from', 'to', 'by', 'values'])
const BLOCKED_STYLE_PROPERTIES = new Set(['behavior', '-moz-binding'])

const issue = (issues: ExportIssue[], kind: ExportIssue['kind'], detail: string, path: string) => {
  issues.push({ kind, detail, path })
}

/** a value quoted for a report line: JSON-escaped and cut short */
const quoted = (value: string): string => {
  const text = JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

const fullAttrName = (attr: Token.Attribute): string => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name)

const isElement = (node: Tree.Node): node is Element => 'tagName' in node
const isText = (node: Tree.Node): node is Tree.TextNode => node.nodeName === '#text'
const isSvg = (el: Element): boolean => el.namespaceURI === htmlNs.NS.SVG
const isHtmlTag = (el: Element, ...names: string[]): boolean =>
  el.namespaceURI === htmlNs.NS.HTML && names.includes(el.tagName)
const isBlockElement = (node: ChildNode | undefined): boolean =>
  !!node && isElement(node) && node.namespaceURI === htmlNs.NS.HTML && BLOCK_ELEMENTS.has(node.tagName)

/** a JSX attribute value for a string: the plain `"v"` form when nothing in it needs escaping, else `{"v"}` */
function attrValue(value: string): string {
  return PLAIN_ATTR_VALUE.test(value) ? `"${value}"` : `{${jsString(value)}}`
}

// ---------------------------------------------------------------- style

/** the text of a CSS value with escapes resolved, comments removed and whitespace compacted, for the safety checks only */
function cssNormalize(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_all, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
    })
    .replace(/\\(.)/gs, '$1')
}

/** why a declaration value cannot be carried over, or null */
function unsafeStyleValue(value: string): string | null {
  const normal = cssNormalize(value)
  const compact = normal.replace(/\s+/g, '').toLowerCase()
  if (compact.includes('expression(')) return 'expression()'
  if (compact.includes('javascript:') || compact.includes('vbscript:')) return 'script URL'
  const urls = [...normal.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)]
  for (const match of urls) if (isUnsafeUrl(match[1] ?? match[2] ?? match[3] ?? '')) return 'unsafe url()'
  if (/image-set\(|\bsrc\(|\bimage\(/i.test(normal)) {
    for (const match of normal.matchAll(/"([^"]*)"|'([^']*)'/g))
      if (isUnsafeUrl(match[1] ?? match[2] ?? '')) return 'unsafe URL'
  }
  return null
}

function styleKey(name: string): string | null {
  if (name.startsWith('--')) return jsString(name)
  if (!/^-?[a-z][a-z0-9-]*$/.test(name)) return null
  if (name.startsWith('-ms-')) return camel(`ms-${name.slice(4)}`)
  const camelled = camel(name.startsWith('-') ? name.slice(1) : name)
  return name.startsWith('-') ? `${camelled.charAt(0).toUpperCase()}${camelled.slice(1)}` : camelled
}

function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_all, char: string) => char.toUpperCase())
}

/** a style attribute string to a JSX style object expression, `{{ color: "red", "--x": "1" }}`; unsafe declarations reported */
export function styleToJsx(style: string, issues: ExportIssue[], rewriteUrl?: (url: string) => string): string | null {
  return styleToJsxAt(style, issues, '', rewriteUrl)
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi

/** `url()` values passed through `rewrite`; null when a rewritten URL is unsafe */
function rewriteStyleUrls(value: string, rewrite: (url: string) => string): string | null {
  let unsafe = false
  const out = value.replace(CSS_URL, (whole, double?: string, single?: string, bare?: string) => {
    const url = cssNormalize(double ?? single ?? bare ?? '').trim()
    const next = rewrite(url)
    if (next === url) return whole
    if (isUnsafeUrl(next)) unsafe = true
    const escaped = next.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ')
    return `url("${escaped}")`
  })
  return unsafe ? null : out
}

function styleToJsxAt(
  style: string,
  issues: ExportIssue[],
  path: string,
  rewriteUrl?: (url: string) => string,
): string | null {
  const entries: string[] = []
  for (const [name, raw] of parseStyle(style)) {
    let value = raw
    if (/!\s*important\s*$/i.test(value)) {
      value = value.replace(/\s*!\s*important\s*$/i, '')
      issue(issues, 'style', `!important removed from ${quoted(name)}`, path)
    }
    const key = styleKey(name)
    if (key === null || BLOCKED_STYLE_PROPERTIES.has(name)) {
      issue(issues, 'style', `declaration ${quoted(name)} dropped`, path)
      continue
    }
    const unsafe = unsafeStyleValue(value)
    if (unsafe) {
      issue(issues, 'style', `declaration ${quoted(name)} dropped: ${unsafe}`, path)
      continue
    }
    if (rewriteUrl && value) {
      const rewritten = rewriteStyleUrls(value, rewriteUrl)
      if (rewritten === null || unsafeStyleValue(rewritten)) {
        issue(issues, 'style', `declaration ${quoted(name)} dropped: unsafe url() after rewrite`, path)
        continue
      }
      value = rewritten
    }
    if (!value) continue
    entries.push(`${key}: ${jsString(value)}`)
  }
  return entries.length ? `{{ ${entries.join(', ')} }}` : null
}

// ---------------------------------------------------------------- attributes

/** the entries of a srcset, minus the unsafe ones; null when nothing was dropped (keep the value as written) */
function filterSrcset(
  value: string,
  rewrite?: (url: string) => string | null,
): { kept: string; dropped: number; total: number } {
  const entries: { url: string; descriptor: string }[] = []
  let i = 0
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i] ?? '')) i++
    if (i >= value.length) break
    let url = ''
    while (i < value.length && !/\s/.test(value[i] ?? '')) url += value[i++]
    let descriptor = ''
    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      let depth = 0
      while (i < value.length) {
        const char = value[i] ?? ''
        if (char === '(') depth++
        else if (char === ')') depth--
        else if (char === ',' && depth <= 0) break
        descriptor += char
        i++
      }
    }
    entries.push({ url, descriptor: descriptor.trim() })
  }
  const safe: typeof entries = []
  for (const entry of entries) {
    if (isUnsafeUrl(entry.url)) continue
    const url = rewrite ? rewrite(entry.url) : entry.url
    if (url !== null) safe.push({ url, descriptor: entry.descriptor })
  }
  return {
    kept: safe.map((entry) => (entry.descriptor ? `${entry.url} ${entry.descriptor}` : entry.url)).join(', '),
    dropped: entries.length - safe.length,
    total: entries.length,
  }
}

/** the React name for an attribute, or null when it cannot be emitted */
function reactAttrName(name: string, inSvg: boolean, custom = false): string | null {
  if (name === 'class') return 'className'
  if (name === 'for') return custom ? 'for' : 'htmlFor'
  const namespaced = NAMESPACED_ATTR_NAMES.get(name)
  if (namespaced) return namespaced
  if (name.startsWith('data-') || name.startsWith('aria-')) return ATTR_NAME.test(name) ? name : null
  const mapped = HTML_ATTR_NAMES.get(name)
  if (mapped) return mapped
  if (inSvg && /^[a-z]+(-[a-z]+)+$/.test(name)) return camel(name)
  return ATTR_NAME.test(name) ? name : null
}

interface JsxAttr {
  name: string
  /** the text after the `=`, or null for a bare boolean attribute */
  value: string | null
}

// ---------------------------------------------------------------- conversion

/** why an element is never emitted, whoever asks: script, style, anything outside the allowed tag names and the SMIL elements that could set an event handler or a link */
function blockedElement(el: Element): { kind: ExportIssue['kind']; detail: string } | null {
  const tag = el.tagName
  if (tag === 'script') return { kind: 'script', detail: '<script> dropped' }
  if (!TAG_NAME.test(tag) || tag === 'this') {
    return { kind: 'dropped-element', detail: `<${quoted(tag)}> dropped with its contents` }
  }
  if (tag === 'style' || (DROPPED_ELEMENTS.has(tag) && !isSvg(el))) {
    return { kind: 'dropped-element', detail: `<${tag}> dropped` }
  }
  if (isSvg(el) && (tag === 'animate' || tag === 'set')) {
    const target = el.attrs.find((attr) => attr.name === 'attributeName')?.value.trim() ?? ''
    if (/^on/i.test(target) || /^(xlink:)?href$/i.test(target)) {
      return { kind: 'dropped-element', detail: `<${tag}> dropped: it targets ${quoted(target)}` }
    }
  }
  return null
}

class Converter {
  readonly issues: ExportIssue[] = []
  private readonly indent: string

  constructor(private readonly options: HtmlToJsxOptions) {
    this.indent = options.indent ?? '  '
  }

  /** the rendered pieces of a node list, in order, with whitespace rules applied */
  renderChildren(parent: ParentNode, nodes: ChildNode[], preserve: boolean, parentPath: string): string[] {
    const out: string[] = []
    const parentEl = isElement(parent as Tree.Node) ? (parent as Element) : null
    const parentBlockish = !parentEl || isBlockElement(parentEl)
    const noText =
      !!parentEl &&
      (isHtmlTag(parentEl, ...NO_TEXT_PARENTS) || (isSvg(parentEl) && !SVG_TEXT_PARENTS.has(parentEl.tagName)))
    const tagCounts = new Map<string, number>()
    for (const node of nodes) if (isElement(node)) tagCounts.set(node.tagName, (tagCounts.get(node.tagName) ?? 0) + 1)
    const seen = new Map<string, number>()
    nodes.forEach((node, index) => {
      if (isText(node)) {
        const piece = this.renderText(node.value, nodes, index, preserve, parentBlockish, noText)
        if (piece !== null) out.push(piece)
      } else if (isElement(node)) {
        const nth = (seen.get(node.tagName) ?? 0) + 1
        seen.set(node.tagName, nth)
        const label = (tagCounts.get(node.tagName) ?? 0) > 1 ? `${node.tagName}[${nth}]` : node.tagName
        out.push(this.renderElement(node, preserve, parentPath ? `${parentPath} > ${label}` : label))
      } else if (node.nodeName === '#comment') {
        issue(this.issues, 'comment', 'HTML comment dropped', parentPath)
      }
    })
    return out.filter((piece) => piece !== '')
  }

  private renderText(
    value: string,
    siblings: ChildNode[],
    index: number,
    preserve: boolean,
    parentBlockish: boolean,
    noText: boolean,
  ): string | null {
    if (value === '') return null
    if (preserve) return jsxText(value)
    const whitespaceOnly = /^[ \t\n\f\r]*$/.test(value)
    const prev = siblings[index - 1]
    const next = siblings[index + 1]
    if (whitespaceOnly) {
      if (noText) return null
      const edge = index === 0 || index === siblings.length - 1
      if (edge) return null
      if (value.includes('\n') && (isBlockElement(prev) || isBlockElement(next))) return null
      return jsxText(' ')
    }
    let text = value.replace(/[ \t\n\f\r]+/g, ' ')
    if ((index === 0 && parentBlockish) || isBlockElement(prev)) text = text.replace(/^ /, '')
    if ((index === siblings.length - 1 && parentBlockish) || isBlockElement(next)) text = text.replace(/ $/, '')
    return jsxText(text)
  }

  renderElement(el: Element, preserveInherited: boolean, path: string): string {
    const preserve = preserveInherited || isHtmlTag(el, ...PRESERVE_WHITESPACE)
    let childrenMemo: string | undefined
    let attrsMemo: JsxAttr[] | undefined
    const children = (): string => {
      childrenMemo ??= this.renderChildren(el, el.childNodes, preserve, path).join('\n')
      return childrenMemo
    }
    const attrs = (): JsxAttr[] => {
      attrsMemo ??= this.attributes(el, path)
      return attrsMemo
    }
    const blocked = blockedElement(el)
    let reported = false
    const element = (overrides?: Record<string, string | null>, childrenText?: string): string => {
      if (blocked) {
        if (!reported) issue(this.issues, blocked.kind, blocked.detail, path)
        reported = true
        return ''
      }
      return this.defaultElement(el, attrs(), overrides, childrenText, children, path)
    }

    const ctx: JsxContext = { issues: this.issues, inSvg: isSvg(el), children, element }
    const visited = this.options.visit?.(el, ctx)
    if (visited !== undefined) return visited
    return element()
  }

  private defaultElement(
    el: Element,
    attrs: JsxAttr[],
    overrides: Record<string, string | null> | undefined,
    childrenOverride: string | undefined,
    children: () => string,
    path: string,
  ): string {
    let list = attrs
    const extra: JsxAttr[] = []
    if (overrides) {
      const merged = new Map<string, JsxAttr | null>(list.map((attr) => [attr.name, attr]))
      for (const [name, value] of Object.entries(overrides)) {
        if (!JSX_ATTR_NAME.test(name) || /^on/i.test(name) || REACT_RESERVED.has(name.toLowerCase())) {
          issue(this.issues, 'dropped-attribute', `override ${quoted(name)} refused`, path)
          continue
        }
        if (value === null) merged.delete(name)
        else if (merged.has(name)) merged.set(name, { name, value })
        else extra.push({ name, value })
      }
      list = [...merged.values()].filter((attr): attr is JsxAttr => attr !== null)
    }
    const all = [...list, ...extra]
    const tag = el.tagName
    let body: string
    if (childrenOverride !== undefined) body = childrenOverride
    else if (isHtmlTag(el, 'textarea')) body = ''
    else if (VOID_ELEMENTS.has(tag) && el.namespaceURI === htmlNs.NS.HTML) body = ''
    else body = children()

    const words = all.map((attr) => (attr.value === null ? attr.name : `${attr.name}=${attr.value}`))
    const open = [tag, ...words].join(' ')
    const opening =
      open.length > 100 && words.length > 1 ? `${tag}\n${this.indent}${words.join(`\n${this.indent}`)}\n` : open
    if (body === '') return `<${opening}${opening.endsWith('\n') ? '' : ' '}/>`
    const inner = `${this.indent}${body.replace(/\n/g, `\n${this.indent}`)}`
    return `<${opening}>\n${inner}\n</${tag}>`
  }

  /** the JSX attributes of an element, issues reported once */
  private attributes(el: Element, path: string): JsxAttr[] {
    const out: JsxAttr[] = []
    const inSvg = isSvg(el)
    const tag = el.tagName
    const isHtml = el.namespaceURI === htmlNs.NS.HTML
    const formValue = isHtml && VALUE_ELEMENTS.has(tag)
    const animation = inSvg && (tag === 'animate' || tag === 'set')
    const hasValueAttr = el.attrs.some((attr) => attr.name === 'value')
    const customElement = isHtml && tag.includes('-')
    const used = new Set<string>()
    const rewriteUrl = this.options.rewriteUrl
    /** a kept URL passed through the caller's rewrite and checked again; null (and an issue) when the result is unsafe */
    const rewrite = (url: string, attrName: string): string | null => {
      if (!rewriteUrl) return url
      const next = rewriteUrl(url, attrName, el)
      if (isUnsafeUrl(next) || (isHtml && EMBEDDING_ELEMENTS.has(tag) && isDataUrl(next))) {
        issue(this.issues, 'unsafe-url', `${quoted(attrName)} dropped: rewritten to an unsafe URL`, path)
        return null
      }
      return next
    }
    const add = (attr: JsxAttr, source: string) => {
      if (used.has(attr.name)) {
        issue(
          this.issues,
          'dropped-attribute',
          `attribute ${quoted(source)} dropped: ${attr.name} is already set`,
          path,
        )
        return
      }
      used.add(attr.name)
      out.push(attr)
    }

    for (const attr of el.attrs) {
      const name = fullAttrName(attr)
      const lower = name.toLowerCase()
      const value = attr.value
      let rewritten: string | null = null
      if (lower.startsWith('data-doop-')) continue
      if (/^on/i.test(name)) {
        issue(this.issues, 'event-handler', `event handler ${quoted(name)} dropped`, path)
        continue
      }
      if (lower === 'srcdoc') {
        issue(this.issues, 'dropped-attribute', 'srcdoc dropped', path)
        continue
      }
      if (REACT_RESERVED.has(lower)) {
        issue(this.issues, 'dropped-attribute', `attribute ${quoted(name)} is reserved by React`, path)
        continue
      }
      if (lower === 'style') {
        const style = styleToJsxAt(value, this.issues, path, rewriteUrl && ((url) => rewriteUrl(url, 'style', el)))
        if (style) add({ name: 'style', value: style }, name)
        continue
      }
      if (lower === 'class') {
        const classes = value.split(/[ \t\n\f\r]+/).filter(Boolean)
        if (!classes.length) continue
        add(
          {
            name: customElement ? 'class' : 'className',
            value: this.options.className?.(classes, el) ?? attrValue(classes.join(' ')),
          },
          name,
        )
        continue
      }
      if (URL_ATTRS.has(lower)) {
        if (isUnsafeUrl(value) || (isHtml && EMBEDDING_ELEMENTS.has(tag) && isDataUrl(value))) {
          issue(this.issues, 'unsafe-url', `${quoted(name)} dropped: ${quoted(value)}`, path)
          continue
        }
        rewritten = rewrite(value, lower)
        if (rewritten === null) continue
      } else if (lower === 'ping') {
        if (value.split(/\s+/).some((part) => isUnsafeUrl(part))) {
          issue(this.issues, 'unsafe-url', `${quoted(name)} dropped: ${quoted(value)}`, path)
          continue
        }
        if (rewriteUrl) {
          const parts = value
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => rewrite(part, lower))
          if (parts.includes(null)) continue
          rewritten = parts.join(' ')
        }
      } else if (SRCSET_ATTRS.has(lower)) {
        const result = filterSrcset(value, rewriteUrl && ((url) => rewrite(url, lower)))
        if (result.dropped || rewriteUrl) {
          if (result.dropped) {
            issue(this.issues, 'unsafe-url', `${result.dropped} unsafe ${quoted(name)} entries dropped`, path)
          }
          if (result.dropped === result.total || !result.kept) continue
          add({ name: reactAttrName(lower, inSvg) ?? lower, value: attrValue(result.kept) }, name)
          continue
        }
      } else if (animation && ANIMATION_VALUE_ATTRS.has(lower) && value.split(';').some((part) => isUnsafeUrl(part))) {
        issue(this.issues, 'unsafe-url', `${quoted(name)} dropped: ${quoted(value)}`, path)
        continue
      }

      if (isHtml && tag === 'option' && lower === 'selected') {
        if (selectOf(el)) continue
        issue(this.issues, 'dropped-attribute', '`selected` kept: the option is not inside a select', path)
      }
      if (formValue && lower === 'value') {
        add({ name: 'defaultValue', value: attrValue(value) }, name)
        continue
      }
      if (isHtml && tag === 'input' && lower === 'checked') {
        add({ name: 'defaultChecked', value: null }, name)
        continue
      }
      const reactName = reactAttrName(name, inSvg, customElement)
      if (reactName === null) {
        issue(this.issues, 'dropped-attribute', `attribute ${quoted(name)} cannot be written as JSX`, path)
        continue
      }
      if (BOOLEAN_ATTRS.has(lower) && (value === '' || value.toLowerCase() === lower)) {
        add({ name: reactName, value: null }, name)
        continue
      }
      add({ name: reactName, value: attrValue(rewritten ?? value) }, name)
    }

    if (isHtml && tag === 'textarea') {
      const text = el.childNodes.map((node) => (isText(node) ? node.value : '')).join('')
      if (text && !hasValueAttr) add({ name: 'defaultValue', value: `{${jsString(text)}}` }, 'textarea text')
    }
    if (isHtml && tag === 'select' && !hasValueAttr) {
      const selected = selectedValues(el)
      if (selected.length) {
        const multiple = el.attrs.some((attr) => attr.name === 'multiple')
        if (multiple) add({ name: 'defaultValue', value: `{[${selected.map(jsString).join(', ')}]}` }, 'selected')
        else add({ name: 'defaultValue', value: attrValue(selected[selected.length - 1] ?? '') }, 'selected')
      }
    }
    return out
  }
}

/** the select an option sits in, directly or through an optgroup */
function selectOf(option: Element): Element | null {
  let parent = option.parentNode as Tree.Node | null
  if (parent && isElement(parent) && isHtmlTag(parent, 'optgroup')) parent = parent.parentNode as Tree.Node | null
  return parent && isElement(parent) && isHtmlTag(parent, 'select') ? parent : null
}

function textOf(node: Tree.Node): string {
  if (isText(node)) return node.value
  if ('childNodes' in node) return node.childNodes.map(textOf).join('')
  return ''
}

/** the values of the options marked `selected` in a select */
function selectedValues(select: Element): string[] {
  const values: string[] = []
  const visit = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (!isElement(node) || node.namespaceURI !== htmlNs.NS.HTML) continue
      if (node.tagName === 'optgroup') visit(node.childNodes)
      else if (node.tagName === 'option' && node.attrs.some((attr) => attr.name === 'selected')) {
        const explicit = node.attrs.find((attr) => attr.name === 'value')
        values.push(
          explicit
            ? explicit.value
            : textOf(node)
                .replace(/[ \t\n\f\r]+/g, ' ')
                .trim(),
        )
      }
    }
  }
  visit(select.childNodes)
  return values
}

function assemble(pieces: string[], indent: string): string {
  if (pieces.length === 0) return 'null'
  if (pieces.length === 1) {
    const only = pieces[0] ?? ''
    // a lone `{expression}` is an expression already; a bare child form is not valid on its own
    return only.startsWith('{') && only.endsWith('}') ? only.slice(1, -1) : only
  }
  return `<>\n${indent}${pieces.join('\n').replace(/\n/g, `\n${indent}`)}\n</>`
}

/** the same for an already parsed node (S7 walks the parsed template) */
export function nodeToJsx(node: ChildNode | Tree.DocumentFragment, options: HtmlToJsxOptions = {}): JsxResult {
  const converter = new Converter(options)
  const indent = options.indent ?? '  '
  const pieces =
    node.nodeName === '#document-fragment'
      ? converter.renderChildren(node as Tree.DocumentFragment, (node as Tree.DocumentFragment).childNodes, false, '')
      : converter.renderChildren(
          { childNodes: [node], nodeName: '#document-fragment' } as unknown as Tree.DocumentFragment,
          [node as ChildNode],
          false,
          '',
        )
  return { jsx: assemble(pieces, indent), issues: converter.issues }
}

/** a body fragment (the component template or a frame's <body> content) to one JSX expression; several top-level nodes become a fragment `<>…</>`; empty input gives `null` */
export function htmlToJsx(html: string, options: HtmlToJsxOptions = {}): JsxResult {
  return nodeToJsx(parseFragment(html), options)
}
