import { CSS_ATTR, DETACHED_CSS_ATTR } from '../shared/components.ts'
import { TOKEN_BLOCK_ATTR } from '../shared/designTokens.ts'
import { FONT_BLOCK_ATTR } from '../shared/fonts.ts'

/**
 * CSS isolation between a frame and the component instances placed in it.
 *
 * A frame's own rules (`h2 { margin: 40px }`, `.card .title { color: red }`) used to match elements
 * inside an instance, so an instance no longer looked like its main. The fix keeps the author's rules
 * as written and adds one zero-specificity exclusion to each rule's subject: the element is not a
 * component-owned element inside an instance. Component-owned elements wear `data-doop-part`; slot
 * content is the frame's own and does not, so a frame rule keeps styling what a person put in a slot,
 * and the instance root, which a frame lays out (margin, grid placement, width), is never excluded.
 * `:where()` inside `:not()` adds no specificity and works in every browser, with no `@scope`.
 *
 * The exclusion is stored in the frame's own `<style>` text (one point every renderer passes through:
 * the canvas, the server renderer, PDF, `/i/`, exports) and is taken off again wherever the text is
 * read back for people or agents (`restoreFrameStyles`). It applies only to a frame that holds an
 * instance of a component extracted in the current form (`SCOPE_MARK`), so every frame stored before
 * it keeps its bytes and its pixels until its main changes.
 */

/** First line of a component stylesheet extracted in the isolating form. */
export const SCOPE_MARK = '/* doop-scope:2 */'
/** What a frame rule's subject must not be: an element a component owns, inside an instance. */
export const FRAME_EXCLUSION = ':not(:where([data-doop-instance] [data-doop-part]))'

/* a stylesheet inside a main or an instance (`data-doop-part`) is the component's markup, not the frame's */
const MANAGED_STYLE_ATTRS = [CSS_ATTR, DETACHED_CSS_ATTR, TOKEN_BLOCK_ATTR, FONT_BLOCK_ATTR, 'data-doop-part']
const STYLE_BLOCK = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi
const GROUPS = new Set(['media', 'supports', 'container', 'layer'])
const PSEUDO_ELEMENT = /::|:(?:before|after|first-line|first-letter)(?![\w-])/i
const DOCUMENT_SUBJECT = /^(?:html|body|:root)(?![\w-])/i

/** Past a quoted string starting at `at`. */
function pastString(text: string, at: number): number {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return i + 1
  }
  return text.length
}

/** The `}` closing the block whose `{` sits at `open`, skipping strings and comments. */
function blockClose(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const char = css[i]
    if (char === '"' || char === "'") i = pastString(css, i) - 1
    else if (char === '/' && css[i + 1] === '*') i = (css.indexOf('*/', i + 2) + 1 || css.length) - 1
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return css.length
}

/** Does a declaration block hold a block of its own (nested rules), outside strings and comments? */
function hasNestedBlock(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '"' || char === "'") i = pastString(body, i) - 1
    else if (char === '/' && body[i + 1] === '*') i = (body.indexOf('*/', i + 2) + 1 || body.length) - 1
    else if (char === '{') return true
  }
  return false
}

/** A selector list cut at its top-level commas, whitespace and all, so it can be put back as it was. */
function splitRaw(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const char = list[i]
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = pastString(list, i) - 1
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }
  parts.push(list.slice(start))
  return parts
}

/** Where the last compound of a selector starts. */
function lastCompoundStart(selector: string): number {
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = pastString(selector, i) - 1
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && (/\s/.test(char) || char === '>' || char === '+' || char === '~')) start = i + 1
  }
  return start
}

/** Index of the first top-level pseudo-element in a compound, or its length. */
function pseudoElementAt(compound: string): number {
  let depth = 0
  for (let i = 0; i < compound.length; i++) {
    const char = compound[i]!
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = pastString(compound, i) - 1
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && char === ':' && PSEUDO_ELEMENT.test(compound.slice(i))) {
      if (compound.slice(i).search(PSEUDO_ELEMENT) === 0) return i
    }
  }
  return compound.length
}

/** `selector` with `suffix` on its subject (the last compound, before any pseudo-element). A selector
 *  already carrying it, nesting (`&`) and one whose subject is the document are left alone. */
export function withSubjectSuffix(selector: string, suffix: string): string {
  const core = selector.trim()
  if (!core || core.includes(suffix) || core.includes('&')) return selector
  const start = lastCompoundStart(core)
  const compound = core.slice(start)
  if (!compound || DOCUMENT_SUBJECT.test(compound)) return selector
  const at = start + pseudoElementAt(compound)
  const rewritten = `${core.slice(0, at)}${suffix}${core.slice(at)}`
  const lead = selector.slice(0, selector.indexOf(core))
  return `${lead}${rewritten}${selector.slice(selector.indexOf(core) + core.length)}`
}

/** Every style rule's selector list of a stylesheet through `map`, at any depth of `@media`, `@supports`,
 *  `@container` and `@layer`; every other byte (comments, declarations, keyframes, font faces) as written. */
function mapRuleSelectors(css: string, map: (selector: string) => string): string {
  let out = ''
  let at = 0
  while (at < css.length) {
    let open = -1
    let semi = -1
    for (let i = at; i < css.length; i++) {
      const char = css[i]
      if (char === '"' || char === "'") i = pastString(css, i) - 1
      else if (char === '/' && css[i + 1] === '*') i = (css.indexOf('*/', i + 2) + 1 || css.length) - 1
      else if (char === '{') {
        open = i
        break
      } else if (char === ';') {
        semi = i
        break
      }
    }
    if (open === -1) {
      out += css.slice(at)
      break
    }
    if (semi !== -1) {
      out += css.slice(at, semi + 1)
      at = semi + 1
      continue
    }
    const close = blockClose(css, open)
    const prelude = css.slice(at, open)
    const lead = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(prelude)![0]
    const head = prelude.slice(lead.length)
    const body = css.slice(open + 1, close)
    if (head.startsWith('@')) {
      const name = /^@(?:-[a-z]+-)?([a-z-]+)/i.exec(head)?.[1]?.toLowerCase() ?? ''
      out += `${prelude}{${GROUPS.has(name) ? mapRuleSelectors(body, map) : body}`
    } else if (hasNestedBlock(body)) {
      /* nested rules read their parent: left as written */
      out += `${prelude}{${body}`
    } else {
      out += `${lead}${splitRaw(head).map(map).join(',')}{${body}`
    }
    out += close < css.length ? '}' : ''
    at = close + 1
  }
  return out
}

/** The stylesheet with every rule's subject excluded from component-owned elements. Idempotent. */
export function isolateStyleText(css: string): string {
  return mapRuleSelectors(css, (selector) => withSubjectSuffix(selector, FRAME_EXCLUSION))
}

/** The author's stylesheet as it was written. */
export function restoreStyleText(css: string): string {
  return css.includes(FRAME_EXCLUSION) ? css.replaceAll(FRAME_EXCLUSION, '') : css
}

const isManaged = (attrs: string) => MANAGED_STYLE_ATTRS.some((name) => new RegExp(`\\b${name}\\b`).test(attrs))

function mapFrameStyles(html: string, map: (css: string) => string): string {
  return html.replace(STYLE_BLOCK, (block, attrs: string, css: string) => {
    if (isManaged(attrs)) return block
    const next = map(css)
    return next === css ? block : `<style${attrs}>${next}</style>`
  })
}

/** Does this document hold a component stylesheet in the isolating form? */
export function isIsolating(html: string): boolean {
  if (!html.includes(SCOPE_MARK)) return false
  for (const match of html.matchAll(STYLE_BLOCK)) {
    if (new RegExp(`\\b${CSS_ATTR}=`).test(match[1]!) && match[2]!.includes(SCOPE_MARK)) return true
  }
  return false
}

/** A frame's own stylesheets isolated from its instances, when it has instances of an isolating
 *  component; every other frame comes back as it was, byte for byte. */
export function isolateFrameStyles(html: string): string {
  return isIsolating(html) ? mapFrameStyles(html, isolateStyleText) : html
}

/** The frame as an author reads it: the exclusion taken off the frame's own stylesheets. */
export function restoreFrameStyles(html: string): string {
  return html.includes(FRAME_EXCLUSION) ? mapFrameStyles(html, restoreStyleText) : html
}
