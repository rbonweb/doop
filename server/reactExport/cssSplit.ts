import { isUnsafeUrl, jsString, type ExportIssue } from './issues.ts'

/** What the React export makes of one component's CSS: a CSS Modules sheet, a global sheet, and what was dropped. */
export interface CssModuleSplit {
  /** the stylesheet for `<Name>.module.css`: rules that name at least one class, kept as written (CSS Modules scopes the classes), plus classless rules prefixed with `.${rootClass}` (descendant, or compound when the selector starts with an attribute selector or a pseudo) */
  moduleCss: string
  /** every class the module defines, in first-seen order (what `styles['x']` may look up); the root class is listed once a classless rule was prefixed with it */
  classes: string[]
  /** what cannot be module-scoped: `:root`/`html`/`body` rules (custom properties), `@font-face`, `@property`, `@counter-style`, `@page`; the export puts it in a global sheet */
  globalCss: string
  issues: ExportIssue[]
}

interface Item {
  prelude: string
  /** the text between the braces, or null for a statement ended by `;` */
  body: string | null
}

interface Blocks {
  module: string[]
  global: string[]
}

interface Context {
  issues: ExportIssue[]
  classes: Set<string>
  rootClass: string
  rewriteUrl?: (url: string) => string
}

const GROUPING_AT_RULES = new Set(['media', 'container', 'supports', 'layer', 'starting-style'])
const GLOBAL_AT_RULES = new Set(['font-face', 'property', 'counter-style', 'page'])
const DROPPED_STATEMENTS = new Set(['import', 'charset', 'namespace'])
const GLOBAL_START = /^(?::root|html|body)(?![\w-])/i
const IDENT = /(?:[\w-]|[\u0080-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))+/y
const PROPERTY_NAME = /^(?:--[^\s:;{}()"'\\]+|-?[A-Za-z_][\w-]*)$/
/** `composes` makes CSS Modules load the named file at build time, so a collaborator could point it anywhere. */
const BLOCKED_PROPERTIES = new Set(['behavior', '-moz-binding', 'composes', 'compose-with'])
const LAYER_ORDER = /^@layer\s+[\w.-]+(?:\s*,\s*[\w.-]+)*\s*$/
const KEYFRAMES_NAME = /^@(?:-[a-z]+-)?keyframes\s+[\w-]+$/i
const KEYFRAME_SELECTOR = /^(?:from|to|\d*\.?\d+%)(?:\s*,\s*(?:from|to|\d*\.?\d+%))*$/i
const SCOPE_ESCAPE = /:(?:global|local)(?![\w-])/i

/** Splits one component's stylesheet (a definition's unscoped `rawCss`) into a CSS Modules sheet and a global sheet. `rewriteUrl` is called with every `url()` and image-function address that passed the safety check (decoded, quotes removed); its answer is checked again and written back as a quoted string. Nothing unsafe survives: `@import`, `@charset`, `expression()`, `behavior`, `-moz-binding` and any `url()` that runs code are dropped and reported. */
export function splitComponentCss(
  css: string,
  options: { rootClass?: string; rewriteUrl?: (url: string) => string } = {},
): CssModuleSplit {
  const context: Context = {
    issues: [],
    classes: new Set(),
    rootClass: options.rootClass ?? 'root',
    rewriteUrl: options.rewriteUrl,
  }
  const blocks = processItems(parseItems(stripComments(css)), context)
  return {
    moduleCss: join(blocks.module),
    classes: [...context.classes],
    globalCss: join(blocks.global),
    issues: context.issues,
  }
}

/** The JSX className value for a class list: known module classes as `styles["x"]`, unknown ones as string literals; one class gives `{styles["a"]}`, several give `{cx(styles["a"], "b")}`. */
export function moduleClassName(
  classes: string[],
  moduleClasses: ReadonlySet<string>,
  names: { styles?: string; cx?: string } = {},
): string {
  const styles = names.styles ?? 'styles'
  const cx = names.cx ?? 'cx'
  const parts = [...new Set(classes)].map((name) =>
    moduleClasses.has(name) ? `${styles}[${jsString(name)}]` : jsString(name),
  )
  if (parts.length === 0) return `{""}`
  if (parts.length === 1) return `{${parts[0]}}`
  return `{${cx}(${parts.join(', ')})}`
}

function join(blocks: string[]): string {
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n')
}

/* ---------- reading ---------- */

/** Reads a string token the way CSS does: it ends at its closing quote, or, unclosed, at the first newline or the end of the text. */
function readString(text: string, start: number): { end: number; closed: boolean } {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') i += 2
    else if (char === quote) return { end: i + 1, closed: true }
    else if (char === '\n') return { end: i, closed: false }
    else i++
  }
  return { end: text.length, closed: false }
}

function stringEnd(text: string, start: number): number {
  return readString(text, start).end
}

const IDENT_CHAR = /[\w\u0080-\uffff-]/
const HEX = /[0-9a-fA-F]/
const WHITESPACE = /[ \t\n\r\f]/

interface UrlToken {
  /** the index just past the closing `)` */
  end: number
  /** the decoded address, or null for a bad-url token */
  arg: string | null
}

/** A `url(` token with an unquoted argument that starts at `i`, read the way CSS Syntax does, so that this reader and a browser agree on where it ends: the argument may not hold a quote, `(`, inner whitespace, a non-printable or a backslash-newline, and a bad one runs on to the first `)`. Null when no unquoted `url(` starts here; `url("…")` is an ordinary function whose argument is a string. */
function urlTokenAt(text: string, i: number): UrlToken | null {
  const first = text[i]
  if (first !== 'u' && first !== 'U' && first !== '\\') return null
  const before = text[i - 1]
  if (before !== undefined && IDENT_CHAR.test(before)) return null
  IDENT.lastIndex = i
  const ident = IDENT.exec(text)?.[0]
  if (!ident || text[i + ident.length] !== '(' || decodeCssEscapes(ident).toLowerCase() !== 'url') return null
  let j = i + ident.length + 1
  while (j < text.length && WHITESPACE.test(text[j]!)) j++
  if (text[j] === '"' || text[j] === "'") return null
  const start = j
  let contentEnd = -1
  let bad = false
  while (j < text.length) {
    const char = text[j]!
    const code = char.charCodeAt(0)
    if (char === ')') {
      return { end: j + 1, arg: bad ? null : decodeCssEscapes(text.slice(start, contentEnd === -1 ? j : contentEnd)) }
    }
    if (WHITESPACE.test(char)) {
      if (contentEnd === -1) contentEnd = j
      while (j < text.length && WHITESPACE.test(text[j]!)) j++
      if (text[j] !== ')') bad = true
      continue
    }
    if (char === '\\') {
      const next = text[j + 1]
      if (next === undefined || next === '\n' || next === '\r' || next === '\f') bad = true
      j++
      if (next !== undefined && HEX.test(next)) {
        let digits = 0
        while (digits < 6 && j < text.length && HEX.test(text[j]!)) {
          j++
          digits++
        }
        if (j < text.length && WHITESPACE.test(text[j]!)) j++
      } else j++
      continue
    }
    if (
      char === '"' ||
      char === "'" ||
      char === '(' ||
      code <= 8 ||
      code === 0x0b ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      bad = true
    }
    if (contentEnd !== -1) bad = true
    j++
  }
  return { end: text.length, arg: null }
}

function stripComments(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const char = css[i]!
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      out += ' '
    } else if (char === '"' || char === "'") {
      const end = stringEnd(css, i)
      out += css.slice(i, end)
      i = end
    } else if (urlTokenAt(css, i)) {
      const end = urlTokenAt(css, i)!.end
      out += css.slice(i, end)
      i = end
    } else if (char === '\\') {
      out += css.slice(i, i + 2)
      i += 2
    } else {
      out += char
      i++
    }
  }
  return out
}

/** The index of the `}` that closes a block whose body starts at `from`, or the end of the text. */
function blockEnd(text: string, from: number): number {
  let depth = 1
  let paren = 0
  let i = from
  while (i < text.length) {
    const char = text[i]!
    if (char === '"' || char === "'") {
      i = stringEnd(text, i)
      continue
    }
    const url = urlTokenAt(text, i)
    if (url) {
      i = url.end
      continue
    }
    if (char === '\\') i += 2
    else {
      if (char === '(') paren++
      else if (char === ')') paren = Math.max(0, paren - 1)
      else if (paren === 0 && char === '{') depth++
      else if (paren === 0 && char === '}' && --depth === 0) return i
      i++
    }
  }
  return text.length
}

/** Cuts a comment-free stylesheet or block body into its statements (`a: b;`, `@import x;`) and blocks (`sel { … }`). */
function parseItems(text: string): Item[] {
  const items: Item[] = []
  let start = 0
  let paren = 0
  let i = 0
  const statement = (end: number) => {
    const prelude = text.slice(start, end).trim()
    if (prelude) items.push({ prelude, body: null })
  }
  while (i < text.length) {
    const char = text[i]!
    if (char === '"' || char === "'") {
      i = stringEnd(text, i)
      continue
    }
    const url = urlTokenAt(text, i)
    if (url) {
      i = url.end
      continue
    }
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '(') paren++
    else if (char === ')') paren = Math.max(0, paren - 1)
    else if (paren === 0 && char === ';') {
      statement(i)
      start = i + 1
    } else if (paren === 0 && char === '{') {
      const end = blockEnd(text, i + 1)
      items.push({ prelude: text.slice(start, i).trim(), body: text.slice(i + 1, end) })
      i = end + 1
      start = i
      continue
    } else if (paren === 0 && char === '}') start = i + 1
    i++
  }
  statement(text.length)
  return items
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = stringEnd(text, i) - 1
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

function decodeCssEscapes(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([^]))/g,
    (_match, hex: string | undefined, newline: string | undefined, other: string | undefined) => {
      if (hex !== undefined) {
        const code = parseInt(hex, 16)
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(code)
      }
      return newline !== undefined ? '' : (other ?? '')
    },
  )
}

function atName(prelude: string): string {
  return (/^@(?:-[a-z]+-)?([a-z-]+)/i.exec(prelude)?.[1] ?? '').toLowerCase()
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string): string {
  const flat = tidy(text)
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat
}

/** True when every quote is closed and every `(` and `[` is matched in order, so a selector or at-rule prelude can be written into a stylesheet without swallowing what follows. A `{`, `}` or `;` is refused. */
function balanced(text: string): boolean {
  const stack: string[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') {
      if (i + 1 >= text.length) return false
      i++
    } else if (char === '"' || char === "'") {
      const string = readString(text, i)
      if (!string.closed) return false
      i = string.end - 1
    } else if (char === '(' || char === '[') stack.push(char === '(' ? ')' : ']')
    else if (char === ')' || char === ']') {
      if (stack.pop() !== char) return false
    } else if (char === '{' || char === '}' || char === ';') return false
  }
  return stack.length === 0
}

function hasUrlFunction(text: string): boolean {
  return /url\s*\(/i.test(decodeCssEscapes(text))
}

/* ---------- declarations ---------- */

/** Functions whose string arguments are addresses, like `url()`'s. */
const IMAGE_FUNCTIONS = ['image', 'image-set', 'cross-fade', 'element', 'src']

interface ValueTokens {
  /** false when the value could be read differently by a browser, a bundler or a CSS parser: an unclosed quote or bracket, a bad-url, or a `{`, `}`, `;` or `@` outside a string or url token */
  ok: boolean
  /** the decoded address of every `url()` */
  urls: string[]
  /** the decoded content of every string */
  strings: string[]
  /** the lower-case names of the functions called, vendor prefix removed */
  functions: Set<string>
  /** a `:` outside every bracket, string and url: no standard property value has one, and a CSS parser reads it as the start of the next declaration */
  colon: boolean
  /** where each url token and string sits in the value, for rewriting */
  refs: ValueRef[]
}

interface ValueRef {
  start: number
  end: number
  /** the decoded address or string content */
  url: string
  /** a whole unquoted `url(…)` token, rewritten as `url("…")`, or a string, rewritten as a string */
  token: boolean
  /** the string is the argument of `url(`, so it is an address whatever else the value holds */
  urlArgument: boolean
}

/** Reads a declaration value as CSS tokens: strings, unquoted `url()` tokens, identifiers and functions, and brackets. */
function tokenizeValue(value: string): ValueTokens {
  const result: ValueTokens = { ok: true, urls: [], strings: [], functions: new Set(), colon: false, refs: [] }
  const stack: string[] = []
  let urlString = false
  let i = 0
  while (i < value.length) {
    const char = value[i]!
    const url = urlTokenAt(value, i)
    if (url) {
      if (url.arg === null) result.ok = false
      else {
        result.urls.push(url.arg)
        result.refs.push({ start: i, end: url.end, url: url.arg, token: true, urlArgument: true })
      }
      urlString = false
      i = url.end
      continue
    }
    if (char === '"' || char === "'") {
      const string = readString(value, i)
      if (!string.closed) result.ok = false
      const content = decodeCssEscapes(value.slice(i + 1, string.closed ? string.end - 1 : string.end))
      result.strings.push(content)
      result.refs.push({ start: i, end: string.end, url: content, token: false, urlArgument: urlString })
      if (urlString) result.urls.push(content)
      urlString = false
      i = string.end
      continue
    }
    if (WHITESPACE.test(char)) {
      i++
      continue
    }
    urlString = false
    if (IDENT_CHAR.test(char) || (char === '\\' && value[i + 1] !== undefined && value[i + 1] !== '\n')) {
      if (value[i - 1] !== undefined && IDENT_CHAR.test(value[i - 1]!)) {
        i++
        continue
      }
      IDENT.lastIndex = i
      const ident = IDENT.exec(value)?.[0] ?? char
      i += ident.length
      if (value[i] === '(') {
        const name = decodeCssEscapes(ident)
          .toLowerCase()
          .replace(/^-[a-z]+-/, '')
        result.functions.add(name)
        if (name === 'url') {
          stack.push(')')
          i++
          urlString = true
        }
      }
      continue
    }
    if (char === '\\') result.ok = false
    else if (char === '(' || char === '[') stack.push(char === '(' ? ')' : ']')
    else if (char === ')' || char === ']') {
      if (stack.pop() !== char) result.ok = false
    } else if (char === '{' || char === '}' || char === ';' || char === '@') result.ok = false
    else if (char === ':' && stack.length === 0) result.colon = true
    i++
  }
  if (stack.length > 0) result.ok = false
  return result
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}

/** Without the control characters and spaces a URL parser trims from both ends. */
function trimControls(text: string): string {
  const chars = Array.from(text)
  let start = 0
  let end = chars.length
  while (start < end && chars[start]!.charCodeAt(0) <= 0x20) start++
  while (end > start && chars[end - 1]!.charCodeAt(0) <= 0x20) end--
  return chars.slice(start, end).join('')
}

/** True for a CSS URL that is safe to leave in an exported stylesheet: absolute `http(s)`, protocol-relative, root-relative without a `..` segment, a fragment, or a raster or SVG data image. Anything else (a relative path, `~pkg`, `file:`) is something a bundler would resolve to a file on the exporter's machine, so it is refused. */
function isKeptUrl(raw: string): boolean {
  /* A URL parser trims the ends and deletes tab and newlines inside, so a URL with a control character inside is read differently from how it is written: refuse it rather than guess. */
  const value = trimControls(raw)
  if (!value || Array.from(value).some(isControl) || isUnsafeUrl(value)) return false
  if (/^https?:\/\/(?!\/)/i.test(value) || /^\/\/(?!\/)/.test(value) || value.startsWith('#')) return true
  if (/^data:image\//i.test(value)) return true
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  let path = value
  try {
    path = decodeURIComponent(value)
  } catch {
    return false
  }
  return !path.split(/[/\\]/).some((segment) => segment === '..' || segment.startsWith('..?'))
}

/** Why a declaration cannot be kept, or null when it is safe. */
function declarationProblem(name: string, value: string): string | null {
  if (BLOCKED_PROPERTIES.has(decodeCssEscapes(name).trim().toLowerCase())) return `${name.trim()} is not allowed`
  const tokens = tokenizeValue(value)
  if (!tokens.ok) return 'unbalanced brackets or quotes, a bad url() or a stray { } ; @'
  if (tokens.colon && !name.trim().startsWith('--')) return 'a stray colon in the value'
  if (tokens.functions.has('expression') || /expression\s*\(/i.test(decodeCssEscapes(value))) {
    return 'expression() is not allowed'
  }
  if (!tokens.urls.every(isKeptUrl)) return 'url() points at code or at a local file'
  if (IMAGE_FUNCTIONS.some((fn) => tokens.functions.has(fn)) && !tokens.strings.every(isKeptUrl)) {
    return 'image URL points at code or at a local file'
  }
  return null
}

/** Removes backslash-newline, which a string reads as a line continuation and nothing else reads as an escape, so the text that is checked is the text that is written. An escaped backslash before a newline is kept. */
function stripContinuations(text: string): string {
  return text.replace(/\\(?:(\r\n|[\n\r\f])|[^])/g, (match, newline: string | undefined) =>
    newline === undefined ? match : '',
  )
}

/** A CSS string literal holding `value`. */
function cssString(value: string): string {
  const escaped = Array.from(value)
    .map((char) => {
      if (char === '\\' || char === '"') return `\\${char}`
      return isControl(char) ? `\\${char.charCodeAt(0).toString(16)} ` : char
    })
    .join('')
  return `"${escaped}"`
}

/** The value with every address handed to `rewriteUrl` and written back as a quoted string, or the reason the rewritten address cannot be kept. The result is read again and must pass the same checks. */
function rewriteUrls(name: string, value: string, rewriteUrl: (url: string) => string): string | { problem: string } {
  const tokens = tokenizeValue(value)
  const imageValue = IMAGE_FUNCTIONS.some((fn) => tokens.functions.has(fn))
  let out = ''
  let at = 0
  for (const ref of tokens.refs) {
    if (!ref.urlArgument && !imageValue) continue
    const next = rewriteUrl(ref.url)
    if (!isKeptUrl(next)) return { problem: 'the rewritten url is not allowed' }
    out += value.slice(at, ref.start) + (ref.token ? `url(${cssString(next)})` : cssString(next))
    at = ref.end
  }
  out += value.slice(at)
  return declarationProblem(name, out) ? { problem: 'the rewritten value is not allowed' } : out
}

/** The declarations and nested blocks of a rule body, each as one block of text. */
function emitBody(body: string, context: Context, owner: string): string[] {
  const lines: string[] = []
  for (const item of parseItems(body)) {
    if (item.body === null) {
      const colon = item.prelude.indexOf(':')
      const name = colon === -1 ? '' : item.prelude.slice(0, colon).trim()
      const value = tidy(stripContinuations(item.prelude.slice(colon + 1)))
      if (!PROPERTY_NAME.test(name) || !value) {
        context.issues.push({
          kind: 'css',
          detail: `dropped malformed declaration "${clip(item.prelude)}"`,
          path: owner,
        })
        continue
      }
      const problem = declarationProblem(name, value)
      if (problem) {
        context.issues.push({
          kind: 'css',
          detail: `dropped declaration "${clip(item.prelude)}": ${problem}`,
          path: owner,
        })
        continue
      }
      let kept = value
      if (context.rewriteUrl) {
        const rewritten = rewriteUrls(name, value, context.rewriteUrl)
        if (typeof rewritten !== 'string') {
          context.issues.push({
            kind: 'css',
            detail: `dropped declaration "${clip(item.prelude)}": ${rewritten.problem}`,
            path: owner,
          })
          continue
        }
        kept = rewritten
      }
      lines.push(`${name}: ${kept};`)
      continue
    }
    const prelude = tidy(item.prelude)
    const problem = nestedPreludeProblem(prelude)
    if (problem) {
      context.issues.push({ kind: 'css', detail: `dropped nested block "${clip(prelude)}": ${problem}`, path: owner })
      continue
    }
    const inner = emitBody(item.body, context, owner)
    if (inner.length === 0) continue
    if (!prelude.startsWith('@')) for (const name of analyzeSelector(prelude).all) context.classes.add(name)
    lines.push(`${prelude} {\n${indent(inner.join('\n'))}\n}`)
  }
  return lines
}

/* ---------- selectors ---------- */

interface SelectorInfo {
  /** classes outside any functional pseudo-class and attribute selector */
  top: string[]
  /** every class, including the ones inside `:not()` and `:is()` */
  all: string[]
}

function analyzeSelector(selector: string): SelectorInfo {
  const top: string[] = []
  const all: string[] = []
  let depth = 0
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = stringEnd(selector, i) - 1
    else if (char === '[') {
      for (i++; i < selector.length && selector[i] !== ']'; i++) {
        if (selector[i] === '\\') i++
        else if (selector[i] === '"' || selector[i] === "'") i = stringEnd(selector, i) - 1
      }
    } else if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === '.') {
      IDENT.lastIndex = i + 1
      const match = IDENT.exec(selector)
      if (match && !/^\d/.test(match[0])) {
        const name = decodeCssEscapes(match[0])
        all.push(name)
        if (depth === 0) top.push(name)
        i += match[0].length
      }
    }
  }
  return { top, all }
}

/** Why a selector cannot be written into a module: it escapes the module's scope, is not well formed, or has unbalanced brackets or quotes. Null when it is fine. */
function selectorProblem(selector: string): string | null {
  if (!selector) return 'empty selector'
  if (!balanced(selector)) return 'unbalanced brackets or quotes'
  if (hasUrlFunction(selector)) return 'url() in a selector'
  if (SCOPE_ESCAPE.test(decodeCssEscapes(selector))) return ':global and :local escape module scoping'
  let depth = 0
  let combinator = false
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') {
      i++
      combinator = false
    } else if (char === '"' || char === "'") {
      i = stringEnd(selector, i) - 1
      combinator = false
    } else if (char === '[') {
      for (i++; i < selector.length && selector[i] !== ']'; i++) {
        if (selector[i] === '\\') i++
        else if (selector[i] === '"' || selector[i] === "'") i = stringEnd(selector, i) - 1
      }
      combinator = false
    } else if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === '.' || char === '#') {
      IDENT.lastIndex = i + 1
      const name = IDENT.exec(selector)?.[0]
      if (!name || /^-?\d/.test(name) || name === '-') return `"${char}" is not followed by a valid name`
      i += name.length
      combinator = false
    } else if (char === ':') {
      const start = selector[i + 1] === ':' ? i + 2 : i + 1
      IDENT.lastIndex = start
      const name = IDENT.exec(selector)?.[0]
      if (!name) return 'a pseudo-class or pseudo-element has no name'
      i = start + name.length - 1
      combinator = false
    } else if (depth === 0 && (char === '>' || char === '+' || char === '~')) {
      if (combinator) return 'two combinators in a row'
      combinator = true
    } else if (!/\s/.test(char)) combinator = false
  }
  return combinator ? 'trailing combinator' : null
}

function nestedPreludeProblem(prelude: string): string | null {
  if (prelude.startsWith('@')) {
    if (hasUrlFunction(prelude)) return 'url() in an at-rule prelude'
    return balanced(prelude) ? null : 'unbalanced brackets or quotes'
  }
  if (prelude.startsWith('--')) return 'a custom property holding a block is not supported'
  return splitTopLevel(prelude, ',').map(selectorProblem).find(Boolean) ?? (prelude ? null : 'empty selector')
}

function escapeIdent(name: string): string {
  return name.replace(/[^\w-]/g, (char) => `\\${char}`)
}

/** `.root` placed on a classless selector: compound when it starts with an attribute selector or a pseudo, descendant otherwise. */
function prefixRoot(selector: string, rootClass: string): string {
  const root = `.${escapeIdent(rootClass)}`
  return selector.startsWith('[') || selector.startsWith(':') ? `${root}${selector}` : `${root} ${selector}`
}

/* ---------- rules ---------- */

function processItems(items: Item[], context: Context): Blocks {
  const blocks: Blocks = { module: [], global: [] }
  for (const item of items) {
    if (item.body === null) processStatement(item.prelude, context, blocks)
    else if (item.prelude.startsWith('@')) processAtRule(item as Item & { body: string }, context, blocks)
    else processStyleRule(item as Item & { body: string }, context, blocks)
  }
  return blocks
}

function processStatement(prelude: string, context: Context, blocks: Blocks): void {
  if (!prelude.startsWith('@')) {
    context.issues.push({ kind: 'css', detail: `dropped stray declaration "${clip(prelude)}" outside a rule` })
    return
  }
  const name = atName(prelude)
  if (name === 'layer') {
    const flat = tidy(prelude)
    if (LAYER_ORDER.test(flat)) blocks.module.push(`${flat};`)
    else context.issues.push({ kind: 'css', detail: `dropped malformed @layer statement "${clip(prelude)}"` })
  } else if (DROPPED_STATEMENTS.has(name)) {
    context.issues.push({ kind: 'css', detail: `dropped @${name}: "${clip(prelude)}"` })
  } else context.issues.push({ kind: 'css', detail: `dropped unsupported at-rule "${clip(prelude)}"` })
}

function processAtRule(item: Item & { body: string }, context: Context, blocks: Blocks): void {
  const prelude = tidy(item.prelude)
  const name = atName(prelude)
  if (!balanced(prelude) || hasUrlFunction(prelude) || (name === 'keyframes' && !KEYFRAMES_NAME.test(prelude))) {
    context.issues.push({ kind: 'css', detail: `dropped at-rule with a malformed prelude "${clip(prelude)}"` })
    return
  }
  if (name === 'keyframes') {
    const frames: string[] = []
    for (const frame of parseItems(item.body)) {
      if (frame.body === null) continue
      if (!KEYFRAME_SELECTOR.test(tidy(frame.prelude))) {
        context.issues.push({ kind: 'css', detail: `dropped keyframe "${clip(frame.prelude)}"`, path: prelude })
        continue
      }
      const inner = emitBody(frame.body, context, prelude)
      if (inner.length > 0) frames.push(`${tidy(frame.prelude)} {\n${indent(inner.join('\n'))}\n}`)
    }
    if (frames.length > 0) blocks.module.push(`${prelude} {\n${indent(frames.join('\n'))}\n}`)
  } else if (GLOBAL_AT_RULES.has(name)) {
    const inner = emitBody(item.body, context, prelude)
    if (inner.length > 0) blocks.global.push(`${prelude} {\n${indent(inner.join('\n'))}\n}`)
  } else if (GROUPING_AT_RULES.has(name)) {
    const inner = processItems(parseItems(item.body), context)
    for (const target of ['module', 'global'] as const) {
      if (inner[target].length > 0) blocks[target].push(`${prelude} {\n${indent(inner[target].join('\n\n'))}\n}`)
    }
  } else context.issues.push({ kind: 'css', detail: `dropped unsupported at-rule "${clip(prelude)}"` })
}

function processStyleRule(item: Item & { body: string }, context: Context, blocks: Blocks): void {
  const owner = tidy(item.prelude)
  if (!balanced(owner) || hasUrlFunction(owner)) {
    context.issues.push({ kind: 'css', detail: `dropped rule "${clip(owner)}": unbalanced brackets or quotes` })
    return
  }
  const declarations = emitBody(item.body, context, owner)
  if (declarations.length === 0) return
  const moduleSelectors: string[] = []
  const globalSelectors: string[] = []
  const classes: string[] = []
  for (const selector of splitTopLevel(owner, ',')) {
    const problem = selectorProblem(selector)
    if (problem) {
      context.issues.push({ kind: 'css', detail: `dropped selector "${clip(selector)}": ${problem}`, path: owner })
      continue
    }
    const info = analyzeSelector(selector)
    if (info.top.length > 0) {
      moduleSelectors.push(selector)
      classes.push(...info.all)
    } else if (GLOBAL_START.test(selector)) globalSelectors.push(selector)
    else {
      moduleSelectors.push(prefixRoot(selector, context.rootClass))
      classes.push(context.rootClass, ...info.all)
    }
  }
  const text = indent(declarations.join('\n'))
  if (moduleSelectors.length > 0) {
    for (const name of classes) context.classes.add(name)
    blocks.module.push(`${moduleSelectors.join(',\n')} {\n${text}\n}`)
  }
  if (globalSelectors.length > 0) blocks.global.push(`${globalSelectors.join(',\n')} {\n${text}\n}`)
}
