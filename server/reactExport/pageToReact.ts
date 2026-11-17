import { parse, parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { INSTANCE_ATTR, PART_ATTR, REV_ATTR, USE_TAG } from '../../shared/components.ts'
import {
  attrOf,
  isElement,
  readInstance,
  renderInstanceHtml,
  stateFromUseAttrs,
  type InstanceState,
} from '../componentEngine.ts'
import {
  FileCtx,
  customPropertyStyle,
  staticSpread,
  withSpread,
  deepReasons,
  importLines,
  literalValue,
  renderUseCall,
  slotNameOf,
  type CallValue,
  type ComponentPlan,
  type ExportSession,
} from './componentToReact.ts'
import { parseItems, safeClass, safeClassCss, splitComponentCss, splitTopLevel, type Item } from './cssSplit.ts'
import { cssToTailwind, type TailwindSplit } from './tailwind.ts'
import { htmlToJsx, nodeToJsx, styleToJsx, type HtmlToJsxOptions, type JsxContext } from './htmlToJsx.ts'
import { googleFontsUrl } from './fonts.ts'
import { jsString, type ExportIssue } from './issues.ts'

type Element = Tree.Element

export interface PageInput {
  id: string
  name: string
  html: string
}

export interface PageFiles {
  tsx: string
  css: string
  fc: FileCtx
}

/** Stylesheets and links Doop writes into a frame's head itself: the export carries components as modules and tokens as tokens.css. */
const MANAGED_ATTRS = [
  'data-doop-component-css',
  'data-doop-tokens',
  'data-doop-component-source',
  'data-doop-detached-css',
  'data-doop-component-head',
]

const isCustomTag = (el: Element): boolean =>
  el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
  el.tagName.includes('-') &&
  el.tagName !== USE_TAG &&
  /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(el.tagName)

const textOf = (el: Element): string =>
  el.childNodes.map((child) => (child.nodeName === '#text' ? (child as Tree.TextNode).value : '')).join('')

/** A frame becomes a page component: its body as JSX under a root class, its own stylesheets as a global `.css` scoped by that class. */
export function emitPage(session: ExportSession, frame: PageInput, base: string, fn: string): PageFiles {
  const file = `src/pages/${base}.tsx`
  const fc = new FileCtx(session, file)
  const doc = parse(frame.html)
  const rootClass = `page-${base}`

  const styles: string[] = []
  const walk = (parent: Tree.ParentNode): void => {
    const kept: Tree.ChildNode[] = []
    for (const child of parent.childNodes) {
      if (isElement(child)) {
        const managed = MANAGED_ATTRS.some((name) => attrOf(child, name) !== undefined)
        if (child.tagName === 'style' && child.namespaceURI === 'http://www.w3.org/1999/xhtml') {
          if (!managed) styles.push(textOf(child))
          continue
        }
        if (child.tagName === 'link' && attrOf(child, 'rel')?.toLowerCase().split(/\s+/).includes('stylesheet')) {
          const href = attrOf(child, 'href') ?? ''
          const fonts = googleFontsUrl(href)
          if (fonts) {
            session.fontLinks.add(fonts)
            fc.usesFonts = true
          } else if (!managed) {
            fc.note(
              'dropped-element',
              `stylesheet link in <head> dropped: add ${jsString(href).slice(0, 120)} to the app's HTML yourself`,
            )
          }
          continue
        }
        walk(child)
      }
      kept.push(child)
    }
    parent.childNodes = kept
  }
  walk(doc)

  const body = findBody(doc)
  const scoped = themeOnHtml(safeClassCss(styles.join('\n')))
  const rewriteUrl = session.urls.url
  const tw = session.styling === 'tailwind' ? cssToTailwind(scoped, { rootClass, rewriteUrl }) : undefined
  const split = tw ? tw.leftover : splitComponentCss(scoped, { rootClass, rewriteUrl })
  fc.issues.push(...(tw ? [...tw.issues, ...tw.leftover.issues] : split.issues))
  fc.pageTw = tw
  const joined = scopePageCss([split.globalCss, split.moduleCss].filter(Boolean).join('\n'), rootClass)
  const css = joined || (tw ? '' : '/* no styles */\n')

  const options = pageOptions(fc, session)
  const fragment = { nodeName: '#document-fragment', childNodes: body.childNodes } as unknown as Tree.DocumentFragment
  const result = nodeToJsx(fragment, options)
  fc.issues.push(...result.issues)

  const bodyClasses = (attrOf(body, 'class') ?? '').split(/[ \t\n\f\r]+/).filter(Boolean)
  const wrapperAttrs = [`className=${globalClassName(fc.pageTw, bodyClasses, rootClass)}`]
  const bodyStyle = attrOf(body, 'style')
  if (bodyStyle) {
    const issues: ExportIssue[] = []
    const style = styleToJsx(bodyStyle, issues)
    fc.issues.push(...issues)
    if (style) wrapperAttrs.push(`style=${style}`)
  }
  const inner = result.jsx === 'null' ? '' : result.jsx
  const open = `<div ${wrapperAttrs.join(' ')}`
  const jsx = inner ? `${open}>\n${inner.replace(/^(?=.)/gm, '  ')}\n</div>` : `${open} />`

  const lines = css ? [`import './${base}.css'`] : []
  lines.push(...importLines(fc, null, 'page'))
  lines.push('')
  lines.push(`export function ${fn}() {`)
  lines.push(`  return (\n${jsx.replace(/^(?=.)/gm, '    ')}\n  )`)
  lines.push('}')
  return { tsx: `${lines.join('\n')}\n`, css, fc }
}

function findBody(doc: Tree.Document): Element {
  const stack: Tree.ParentNode[] = [doc]
  for (let next = stack.pop(); next; next = stack.pop()) {
    for (const child of next.childNodes) {
      if (!isElement(child)) continue
      if (child.tagName === 'body') return child
      stack.push(child)
    }
  }
  return { nodeName: 'body', tagName: 'body', attrs: [], childNodes: [] } as unknown as Element
}

/** The component whose module styles an element: the nearest instance above it for a template element (one that carries a part key); slot content a frame wrote belongs to the page. */
function ownerOf(session: ExportSession, el: Element, slotOwner: ComponentPlan | undefined): ComponentPlan | undefined {
  if (attrOf(el, PART_ATTR) === undefined && attrOf(el, INSTANCE_ATTR) === undefined) return undefined
  for (let node: Tree.ParentNode | null = el; node && isElement(node); node = node.parentNode) {
    const id = attrOf(node, INSTANCE_ATTR)
    if (id === undefined) continue
    const def = session.find(id)
    if (!def) return undefined
    const plan = session.plan(def)
    return plan.mapped ? undefined : plan
  }
  return slotOwner && !slotOwner.mapped ? slotOwner : undefined
}

function visitInstance(fc: FileCtx, session: ExportSession, el: Element, ctx: JsxContext): string | undefined {
  const id = attrOf(el, INSTANCE_ATTR) ?? ''
  const def = session.find(id)
  if (!def) {
    fc.inlined.push({
      component: id,
      reason: 'its component is not part of the export, so the markup is kept without its stylesheet',
    })
    return undefined
  }
  const plan = session.plan(def)
  const engine = session.engine()
  const revision = engine.atRev(def.id, Number(attrOf(el, REV_ATTR)) || 0) ?? def
  const state = readInstance(el, revision, engine)
  if (!state) return undefined
  return instanceJsx(fc, session, plan, state, ctx, () => {
    const classes = (attrOf(el, 'class') ?? '').split(/[ \t\n\f\r]+/).filter(Boolean)
    const className = fc.className(plan, classes, false, true)
    return ctx.element(className === '{""}' ? undefined : { className })
  })
}

function visitUse(fc: FileCtx, session: ExportSession, use: Element, ctx: JsxContext): string {
  const ref = attrOf(use, 'component') ?? ''
  const def = session.find(ref)
  if (!def) {
    ctx.issues.push({ kind: 'dropped-element', detail: '<doop-use> dropped: its component is not in the export' })
    return ''
  }
  const plan = session.plan(def)
  const engine = session.engine()
  const state = stateFromUseAttrs(use, def, engine)
  for (const issue of engine.issues) ctx.issues.push({ kind: 'dropped-attribute', detail: issue.message })
  return (
    instanceJsx(fc, session, plan, state, ctx, () => {
      const markup = renderInstanceHtml(def, { instanceId: '', overrides: state.overrides }, session.engine())
      const fragment = parseFragment(markup)
      const root = fragment.childNodes.find(isElement)
      if (!root) return ''
      const inner = nodeToJsx(root, pageOptions(fc, session))
      ctx.issues.push(...inner.issues)
      return inner.jsx === 'null' ? '' : inner.jsx
    }) ?? ''
  )
}

/** An instance as `<Comp …/>` when it has props and slots only, else its own markup inlined with a report line. */
function instanceJsx(
  fc: FileCtx,
  session: ExportSession,
  plan: ComponentPlan,
  state: InstanceState,
  ctx: JsxContext,
  inline: () => string,
): string | undefined {
  const reasons = deepReasons(state.overrides)
  if (reasons.length) {
    if (!plan.mapped) {
      fc.inlined.push({ component: plan.def.name, reason: `part overrides (${reasons.join('; ')})` })
      fc.styleUses.add(plan)
      return inline()
    }
    ctx.issues.push({
      kind: 'dropped-attribute',
      detail: `part overrides on ${jsString(plan.name)} cannot be passed to a package component and were dropped (${reasons.join('; ')})`,
    })
  }
  const values = new Map<string, CallValue>()
  for (const [name, raw] of Object.entries(state.overrides.props ?? {})) {
    const value = literalValue(fc, plan, name, raw)
    if (value) values.set(name, value)
  }
  const slots = new Map<string, string>()
  for (const [key, part] of Object.entries(state.overrides.parts ?? {})) {
    if (part.slot === undefined) continue
    const name = slotNameOf(plan, key)
    if (name === undefined || !plan.slotByName.has(name)) continue
    if (isDefaultContent(plan, key, part.slot)) continue
    const inner = htmlToJsx(part.slot, pageOptions(fc, session, plan))
    ctx.issues.push(...inner.issues)
    slots.set(name, inner.jsx === 'null' ? '<></>' : inner.jsx)
  }
  return renderUseCall(fc, { plan, values, slots })
}

/** The htmlToJsx hooks for page markup. `slotOwner` is the component whose slot a fragment fills: template-made elements in it still take that component's classes. */
function pageOptions(fc: FileCtx, session: ExportSession, slotOwner?: ComponentPlan): HtmlToJsxOptions {
  const options: HtmlToJsxOptions = {
    rewriteUrl: session.urls.url,
    className: (classes, el) => {
      const owner = ownerOf(session, el, slotOwner)
      if (owner) return fc.className(owner, classes, false, attrOf(el, INSTANCE_ATTR) !== undefined)
      return globalClassName(fc.pageTw, classes)
    },
    visit: (el, ctx) => {
      if (isCustomTag(el)) session.customElements.add(el.tagName)
      if (el.tagName === USE_TAG) return visitUse(fc, session, el, ctx)
      if (attrOf(el, INSTANCE_ATTR) !== undefined) return visitInstance(fc, session, el, ctx)
      const styled = customPropertyStyle(fc, el)
      const loose = staticSpread(fc, el)
      if (!styled && !loose.entries.length) return undefined
      return withSpread(ctx.element({ ...styled, ...loose.drop }), loose.entries)
    },
  }
  return options
}

/** Is this slot content just what the template already holds there? Then the instance passes nothing and the component's own default shows. */
function isDefaultContent(plan: ComponentPlan, key: string, html: string): boolean {
  const el = slotElement(plan, key)
  if (!el) return false
  const defaults = signature(el.childNodes)
  return defaults === signature(parseFragment(html).childNodes)
}

function slotElement(plan: ComponentPlan, key: string): Element | undefined {
  const root = findByPart(parseFragment(plan.def.template).childNodes, key)
  return root
}

function findByPart(nodes: Tree.ChildNode[], key: string): Element | undefined {
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (attrOf(node, PART_ATTR) === key) return node
    const inner = findByPart(node.childNodes, key)
    if (inner) return inner
  }
  return undefined
}

const SIGNATURE_SKIP = new Set(['id', 'data-doop-id', PART_ATTR])

/** A structural fingerprint of markup that ignores whitespace runs and the ids the engine mints. */
function signature(nodes: Tree.ChildNode[]): string {
  const out: string[] = []
  for (const node of nodes) {
    if (isElement(node)) {
      const attrs = node.attrs
        .filter((attr) => !SIGNATURE_SKIP.has(attr.name))
        .map((attr) => `${attr.name}=${attr.value}`)
        .sort()
        .join('\u0001')
      out.push(`<${node.tagName} ${attrs}>${signature(node.childNodes)}</>`)
    } else if (node.nodeName === '#text') {
      const value = (node as Tree.TextNode).value.replace(/\s+/g, ' ').trim()
      if (value) out.push(value)
    }
  }
  return out.join('\u0002')
}

/** The canvas switches theme on `<html>`: a rule that opens with the bare theme attribute (`[data-doop-theme=dark] .x`) is spelled with its `html`, so the split leaves it a global rule rather than gluing the page root class onto the attribute. */
const themeOnHtml = (css: string): string =>
  css.replace(/(^|[,{};]\s*)(\[data-doop-theme(?:[~|^$*]?=[^\]]*)?\])(?=\s)/gi, '$1html$2')

const GROUPING_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'starting-style'])
const ROOT_SELECTOR = /^:root(?![\w-])/i
const BODY_COMPOUND = /^body(?![\w-])/i
const HTML_COMPOUND = /^html(?![\w-])/i
const THEME_COMPOUND = /^\[data-doop-theme(?:[~|^$*]?=[^\]]*)?\]/i

/** A selector cut into its compounds and the combinators between them (`a > b .c` is `a`, ` > `, `b`, ` `, `.c`), brackets, parentheses and strings kept whole. */
function compoundsOf(selector: string): { compounds: string[]; combinators: string[] } {
  const compounds: string[] = []
  const combinators: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector.charAt(i)
    if (quote) {
      current += char
      if (char === '\\') current += selector.charAt(++i)
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '(') depth += 1
    else if (char === ']' || char === ')') depth -= 1
    if (
      depth === 0 &&
      (char === ' ' || char === '>' || char === '+' || char === '~' || char === '\t' || char === '\n')
    ) {
      let combinator = ''
      while (i < selector.length && /[\s>+~]/.test(selector.charAt(i))) combinator += selector.charAt(i++)
      i -= 1
      if (current) {
        compounds.push(current)
        combinators.push(combinator)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) compounds.push(current)
  return { compounds, combinators: combinators.slice(0, Math.max(compounds.length - 1, 0)) }
}

/** One selector placed under the page's root class. The page's `<body>` is the root element, so the `body` compound becomes the root class and whatever sits before it (`html.dark`, `[data-doop-theme=dark]`) stays, since the theme lives on the app's `<html>`: `html.dark body .x` is `html.dark .page-x .x`, `body.dark .x` is `.page-x.dark .x`. A selector that names `html` or a theme attribute but no `body` gets the root class after it (`html[data-doop-theme=dark] .x` is `html[data-doop-theme=dark] .page-x .x`); `:root` stays; anything else becomes a descendant of the root. */
function scopeSelector(selector: string, rootClass: string): string {
  const root = `.${rootClass}`
  const sel = selector.trim()
  if (!sel || ROOT_SELECTOR.test(sel)) return sel
  if (sel.startsWith(root) && !/[\w-]/.test(sel.charAt(root.length))) return sel
  const { compounds, combinators } = compoundsOf(sel)
  const join = (from: number, to: number): string =>
    compounds
      .slice(from, to)
      .map((compound, index) => compound + (combinators[from + index] ?? ''))
      .join('')
  const bodyAt = compounds.findIndex((compound) => BODY_COMPOUND.test(compound))
  if (bodyAt >= 0) {
    const rest = (compounds[bodyAt] ?? '').slice(4)
    return `${join(0, bodyAt)}${root}${rest}${bodyAt < compounds.length - 1 ? (combinators[bodyAt] ?? ' ') : ''}${join(bodyAt + 1, compounds.length)}`
  }
  const first = compounds[0] ?? ''
  if (THEME_COMPOUND.test(first) || HTML_COMPOUND.test(first)) {
    if (compounds.length === 1) return HTML_COMPOUND.test(first) ? `${root}${first.slice(4)}` : `${first} ${root}`
    return `${first} ${root} ${join(1, compounds.length)}`
  }
  return `${root} ${sel}`
}

function scopeItems(items: Item[], rootClass: string): string[] {
  const out: string[] = []
  for (const item of items) {
    const prelude = item.prelude.trim()
    if (item.body === null) out.push(`${prelude};`)
    else if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? ''
      out.push(
        GROUPING_AT_RULES.has(name)
          ? `${prelude} {\n${scopeItems(parseItems(item.body), rootClass)
              .join('\n\n')
              .replace(/^(?=.)/gm, '  ')}\n}`
          : `${prelude} {${item.body}}`,
      )
    } else {
      const selectors = splitTopLevel(prelude, ',').map((selector) => scopeSelector(selector, rootClass))
      out.push(`${selectors.join(',\n')} {${item.body}}`)
    }
  }
  return out
}

/** A page's stylesheet with every selector under the page root class, so no page CSS is global: two pages defining `.card` differently do not collide and `body` rules never restyle the app the page sits in. At-rules that name no selectors (`@keyframes`, `@font-face`) are kept as they are. */
function scopePageCss(css: string, rootClass: string): string {
  if (!css.trim()) return ''
  const text = scopeItems(parseItems(css), rootClass).join('\n\n')
  return text ? `${text}\n` : ''
}

/** The className for a page's own (global) classes: in Tailwind mode the utilities they became, plus the class itself while rules for it remain or nothing replaced it. */
function globalClassName(tw: TailwindSplit | undefined, rawClasses: string[], always?: string): string {
  const classes = rawClasses.map(safeClass)
  if (!tw) return `{${jsString((always ? [always, ...classes] : classes).join(' '))}}`
  const out: string[] = always ? [always] : []
  for (const name of new Set(classes)) {
    const utilities = tw.utilities.get(name)
    if (utilities) out.push(...utilities)
    if (!utilities || tw.leftover.classes.includes(name)) out.push(name)
  }
  return `{${jsString([...new Set(out)].join(' '))}}`
}
