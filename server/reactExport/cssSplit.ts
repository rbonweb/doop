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

/** Splits one component's stylesheet (a definition's unscoped `rawCss`) into a CSS Modules sheet and a global sheet. Nothing unsafe survives: `@import`, `@charset`, `expression()`, `behavior`, `-moz-binding` and any `url()` that runs code are dropped and reported. */
export function splitComponentCss(css: string, options: { rootClass?: string } = {}): CssModuleSplit {
  const context: Context = { issues: [], classes: new Set(), rootClass: options.rootClass ?? 'root' }
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

function stringEnd(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') i += 2
    else if (char === quote) return i + 1
    else if (char === '\n') return i
    else i++
  }
  return text.length
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

/** True when every quote is closed and every `(` and `[` is matched in order, so the text can be written into a stylesheet without swallowing what follows. A `{` or `}` is refused; a `;` too unless `semicolons` allows it (a declaration value may hold one inside `url(data:…;base64,…)`). */
function balanced(text: string, semicolons: boolean): boolean {
  const stack: string[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') {
      if (i + 1 >= text.length) return false
      i++
    } else if (char === '"' || char === "'") {
      let end = i + 1
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
      if (text[end] !== char) return false
      i = end
    } else if (char === '(' || char === '[') stack.push(char === '(' ? ')' : ']')
    else if (char === ')' || char === ']') {
      if (stack.pop() !== char) return false
    } else if (char === '{' || char === '}' || (char === ';' && !semicolons)) return false
  }
  return stack.length === 0
}

/* ---------- declarations ---------- */

/** The URL inside every `url(...)` of an already decoded value. */
function urlArguments(decoded: string): string[] {
  const found: string[] = []
  const pattern = /url\s*\(/gi
  for (let match = pattern.exec(decoded); match; match = pattern.exec(decoded)) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (i < decoded.length && depth > 0) {
      const char = decoded[i]!
      if (char === '(') depth++
      else if (char === ')') depth--
      i++
    }
    found.push(decoded.slice(start, depth === 0 ? i - 1 : i).replace(/^[\s"']+/, ''))
  }
  return found
}

function quotedStrings(decoded: string): string[] {
  return [...decoded.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((match) => match[1] ?? match[2] ?? '')
}

/** Why a declaration cannot be kept, or null when it is safe. */
function declarationProblem(name: string, value: string): string | null {
  if (BLOCKED_PROPERTIES.has(decodeCssEscapes(name).trim().toLowerCase())) return `${name.trim()} is not allowed`
  const decoded = decodeCssEscapes(value)
  if (/expression\s*\(/i.test(decoded)) return 'expression() is not allowed'
  if (urlArguments(decoded).some(isUnsafeUrl)) return 'url() points at code'
  if (/image-set\s*\(|\bsrc\s*\(/i.test(decoded) && quotedStrings(decoded).some(isUnsafeUrl))
    return 'image URL points at code'
  return null
}

/** The declarations and nested blocks of a rule body, each as one block of text. */
function emitBody(body: string, context: Context, owner: string): string[] {
  const lines: string[] = []
  for (const item of parseItems(body)) {
    if (item.body === null) {
      const colon = item.prelude.indexOf(':')
      const name = colon === -1 ? '' : item.prelude.slice(0, colon).trim()
      const value = tidy(item.prelude.slice(colon + 1))
      if (!PROPERTY_NAME.test(name) || !value) {
        context.issues.push({
          kind: 'css',
          detail: `dropped malformed declaration "${clip(item.prelude)}"`,
          path: owner,
        })
        continue
      }
      const problem = balanced(value, true) ? declarationProblem(name, value) : 'unbalanced brackets or quotes'
      if (problem) {
        context.issues.push({
          kind: 'css',
          detail: `dropped declaration "${clip(item.prelude)}": ${problem}`,
          path: owner,
        })
        continue
      }
      lines.push(`${name}: ${value};`)
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
  if (!balanced(selector, false)) return 'unbalanced brackets or quotes'
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
  if (prelude.startsWith('@')) return balanced(prelude, false) ? null : 'unbalanced brackets or quotes'
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
  if (!balanced(prelude, false) || (name === 'keyframes' && !KEYFRAMES_NAME.test(prelude))) {
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
  if (!balanced(owner, false)) {
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
