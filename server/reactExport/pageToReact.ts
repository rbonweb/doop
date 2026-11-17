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
import { splitComponentCss } from './cssSplit.ts'
import { cssToTailwind, type TailwindSplit } from './tailwind.ts'
import { htmlToJsx, nodeToJsx, styleToJsx, type HtmlToJsxOptions, type JsxContext } from './htmlToJsx.ts'
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
          if (
            !managed &&
            !MANAGED_ATTRS.some((name) => attrOf(child, name) !== undefined) &&
            attrOf(child, 'data-doop-webfonts') === undefined
          ) {
            fc.note(
              'dropped-element',
              `stylesheet link in <head> dropped: add ${jsString(attrOf(child, 'href') ?? '').slice(0, 120)} to the app's HTML yourself`,
            )
          } else if (attrOf(child, 'data-doop-webfonts') !== undefined) {
            fc.note(
              'dropped-element',
              `hosted font stylesheet link dropped: add ${jsString(attrOf(child, 'href') ?? '').slice(0, 160)} to the app's HTML yourself`,
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
  const scoped = scopeDocumentSelectors(styles.join('\n'), rootClass)
  const rewriteUrl = session.urls.url
  const tw = session.styling === 'tailwind' ? cssToTailwind(scoped, { rootClass, rewriteUrl }) : undefined
  const split = tw ? tw.leftover : splitComponentCss(scoped, { rootClass, rewriteUrl })
  fc.issues.push(...(tw ? [...tw.issues, ...tw.leftover.issues] : split.issues))
  fc.pageTw = tw
  const joined = [split.globalCss, split.moduleCss].filter(Boolean).join('\n')
  const css = joined || (tw ? '' : '/* no styles */\n')

  const options = pageOptions(fc, session)
  const fragment = { nodeName: '#document-fragment', childNodes: body.childNodes } as unknown as Tree.DocumentFragment
  const result = nodeToJsx(fragment, options)
  fc.issues.push(...result.issues)

  const bodyClasses = (attrOf(body, 'class') ?? '').split(/[ \t\n\f\r]+/).filter(Boolean)
  const wrapperAttrs = [`className=${globalClassName(fc.pageTw, [rootClass, ...bodyClasses])}`]
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

/** `html` and `body` rules would restyle the app the page is dropped into: they apply to the page's root element instead. */
function scopeDocumentSelectors(css: string, rootClass: string): string {
  return css.replace(/(^|[}\s,;{])(?:html|body)(?=\s*[{,])/g, (_all, lead: string) => `${lead}.${rootClass}`)
}

/** The className for a page's own (global) classes: in Tailwind mode the utilities they became, plus the class itself while rules for it remain or nothing replaced it. */
function globalClassName(tw: TailwindSplit | undefined, classes: string[]): string {
  if (!tw) return `{${jsString(classes.join(' '))}}`
  const out: string[] = []
  for (const name of new Set(classes)) {
    const utilities = tw.utilities.get(name)
    if (utilities) out.push(...utilities)
    if (!utilities || tw.leftover.classes.includes(name)) out.push(name)
  }
  return `{${jsString([...new Set(out)].join(' '))}}`
}
