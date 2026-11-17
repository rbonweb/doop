import { defaultTreeAdapter, html as parse5Html, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { IF_ATTR } from '../shared/components.ts'
import type { BundleComponent } from '../shared/componentBundle.ts'
import { parseCss, serializeNodes, splitTopLevel, type CssNode } from './componentCss.ts'
import { attrOf, isElement, kidsOf, rootFragment, setAttr } from './componentEngine.ts'
import { sanitizeMarkup, sanitizeStylesheet, type SanitizeIssue } from './bundleSanitize.ts'

/**
 * A bundle component's variants, turned into what a Doop component is made of.
 * `variants[prop][value].css` is css written against the default markup: it is scoped under the attribute the engine
 * sets on the root for that prop (`[data-tone="ghost"]`; booleans with `reflect`), the way enum variants are styled
 * by hand. `variants[prop][value].html` is a whole alternative render: the parts that differ are expressed with
 * `data-doop-if` (shown for that value, or hidden for it) so one template renders every variant.
 */

export interface PreparedComponent {
  html: string
  css: string
  props: BundleComponent['props']
  issues: SanitizeIssue[]
}

const COMBINATOR = /^[\s>+~]/
const LEAD = /^(?:\*|[a-zA-Z][\w-]*)?(?:[.#](?:[\w\u0080-\uffff-]|\\.)+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)*/

interface RootInfo {
  tag: string
  id: string | undefined
  classes: Set<string>
}

const attrSelector = (prop: string, value: string) =>
  `[data-${prop}="${value.replace(/[\\"]/g, '\\$&').replace(/</g, '\\3c ')}"]`

/** The index in a compound where its pseudo-classes begin: the attribute goes before them. */
function pseudoStart(compound: string): number {
  let depth = 0
  for (let i = 0; i < compound.length; i++) {
    const char = compound[i]
    if (char === '\\') i++
    else if (char === '[' || char === '(') depth++
    else if (char === ']' || char === ')') depth--
    else if (char === ':' && depth === 0) return i
  }
  return compound.length
}

function matchesRoot(lead: string, root: RootInfo): boolean {
  if (!lead) return false
  const plain = lead.replace(/\[[^\]]*\]/g, '').replace(/:[:\w-]+(?:\([^)]*\))?/g, '')
  const tag = /^[a-zA-Z][\w-]*/.exec(plain)?.[0]?.toLowerCase()
  if (tag && tag !== root.tag) return false
  for (const [, name] of plain.matchAll(/\.((?:[\w\u0080-\uffff-]|\\.)+)/g))
    if (name && !root.classes.has(name)) return false
  for (const [, id] of plain.matchAll(/#((?:[\w\u0080-\uffff-]|\\.)+)/g)) if (id && id !== root.id) return false
  return true
}

/** One selector scoped to a variant: compounded onto the root when it starts there, else under the root's attribute. */
export function scopeVariantSelector(selector: string, attr: string, root: RootInfo): string {
  const text = selector.trim()
  const lead = LEAD.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  if (lead && (rest === '' || COMBINATOR.test(rest)) && matchesRoot(lead, root)) {
    const at = pseudoStart(lead)
    return `${lead.slice(0, at)}${attr}${lead.slice(at)}${rest}`
  }
  return `${attr} ${text}`
}

/** Rules scoped to the variant. Only @media, @supports, @layer and @container are looked into; every other at-rule
 *  (@scope, @starting-style, @keyframes, @font-face, …) is dropped, since nothing scopes it. */
function scopeNodes(nodes: CssNode[], attr: string, root: RootInfo, issues: SanitizeIssue[]): CssNode[] {
  return nodes.flatMap((node): CssNode[] => {
    if (node.kind === 'rule')
      return [
        {
          ...node,
          selector: splitTopLevel(node.selector, ',')
            .filter(Boolean)
            .map((selector) => scopeVariantSelector(selector, attr, root))
            .join(', '),
        },
      ]
    if (node.kind === 'group') return [{ ...node, nodes: scopeNodes(node.nodes, attr, root, issues) }]
    issues.push({
      code: 'variant_css_at_rule',
      message: `@${node.name} in variant css was removed: only rules and @media, @supports, @layer and @container blocks are kept, scoped to the variant`,
    })
    return []
  })
}

function rootInfo(root: Tree.Element): RootInfo {
  return {
    tag: root.tagName.toLowerCase(),
    id: attrOf(root, 'id'),
    classes: new Set((attrOf(root, 'class') ?? '').split(/\s+/).filter(Boolean)),
  }
}

/* ------------------------------------------------------------------ */
/* Alternative renders                                                 */
/* ------------------------------------------------------------------ */

type Node = Tree.ChildNode

const MAX_DIFF_CELLS = 250_000

const isText = (node: Node): node is Tree.TextNode => node.nodeName === '#text'

function meaningful(parent: Tree.ParentNode): Node[] {
  return parent.childNodes.filter((node) => isElement(node) || (isText(node) && node.value.trim() !== ''))
}

function bare(el: Tree.Element): Tree.Element {
  const clone = defaultTreeAdapter.createElement(el.tagName, el.namespaceURI, [...el.attrs])
  setAttr(clone, IF_ATTR, null)
  clone.childNodes = el.childNodes
  return clone
}

function signature(node: Node, memo: Map<Node, string>): string {
  const known = memo.get(node)
  if (known !== undefined) return known
  const value = isText(node) ? `T:${node.value.trim()}` : isElement(node) ? `E:${serializeOuter(bare(node))}` : ''
  memo.set(node, value)
  return value
}

function sameShell(a: Tree.Element, b: Tree.Element): boolean {
  if (a.tagName !== b.tagName) return false
  const shell = (el: Tree.Element) =>
    JSON.stringify(
      el.attrs
        .filter((attr) => attr.name !== IF_ATTR)
        .map((attr) => [attr.name, attr.value])
        .sort(),
    )
  return shell(a) === shell(b)
}

/** The pairs of equal children, in order (a longest common subsequence over their serialized markup). */
function commonChildren(a: Node[], b: Node[], memo: Map<Node, string>): [number, number][] | null {
  if (a.length * b.length > MAX_DIFF_CELLS) return null
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] =
        signature(a[i]!, memo) === signature(b[j]!, memo)
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (signature(a[i]!, memo) === signature(b[j]!, memo)) pairs.push([i++, j++])
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

type BundleProp = NonNullable<BundleComponent['props']>[number]

interface Condition {
  show: string
  hide: string
}

/** `show` is the condition under which a part appears for this value, `hide` the one under which the default part goes. */
function conditionFor(prop: BundleProp, value: string): Condition {
  if (prop.type === 'boolean')
    return value === 'true' ? { show: prop.name, hide: `!${prop.name}` } : { show: `!${prop.name}`, hide: prop.name }
  return { show: `${prop.name}=${value}`, hide: `${prop.name}!=${value}` }
}

function wrapper(condition: string, child: Node): Tree.Element {
  const box = defaultTreeAdapter.createElement('div', parse5Html.NS.HTML, [
    { name: 'style', value: 'display:contents' },
    { name: IF_ATTR, value: condition },
  ])
  child.parentNode = box
  box.childNodes = [child]
  return box
}

/** The node showing only under `condition`: the element itself when it carries no condition of its own, else wrapped. */
function conditional(node: Node, condition: string): Node {
  if (isText(node)) return wrapper(condition, node)
  if (!isElement(node)) return node
  if (attrOf(node, IF_ATTR) !== undefined) return wrapper(condition, node)
  setAttr(node, IF_ATTR, condition)
  return node
}

function diffChildren(
  base: Tree.ParentNode,
  alt: Tree.ParentNode,
  condition: Condition,
  memo: Map<Node, string>,
): boolean {
  const left = meaningful(base)
  const right = meaningful(alt)
  const pairs = commonChildren(left, right, memo)
  if (!pairs) return false
  const next: Node[] = []
  /* whitespace and other text between kept nodes is kept as it was: only meaningful nodes are rebuilt */
  const anchors = [...pairs, [left.length, right.length] as [number, number]]
  let li = 0
  let ri = 0
  for (const [pl, pr] of anchors) {
    const leftGap = left.slice(li, pl)
    const rightGap = right.slice(ri, pr)
    const one = leftGap[0]
    const other = rightGap[0]
    if (
      leftGap.length === 1 &&
      rightGap.length === 1 &&
      one &&
      other &&
      isElement(one) &&
      isElement(other) &&
      sameShell(one, other)
    ) {
      if (!diffChildren(one, other, condition, memo)) return false
      next.push(one)
    } else {
      for (const node of leftGap) next.push(conditional(node, condition.hide))
      for (const node of rightGap) next.push(conditional(node, condition.show))
    }
    if (pl < left.length) next.push(left[pl]!)
    li = pl + 1
    ri = pr + 1
  }
  base.childNodes = next
  for (const node of next) node.parentNode = base
  return true
}

function firstRoot(html: string): Tree.Element | undefined {
  return kidsOf(rootFragment(html.trim()))[0]
}

/** The default markup with the parts the variant changes made conditional, or null when that cannot be said. */
function withAlternative(baseHtml: string, altHtml: string, prop: BundleProp, value: string): string | null {
  const base = firstRoot(baseHtml)
  const alt = firstRoot(altHtml)
  if (!base || !alt || base.tagName !== alt.tagName) return null
  const memo = new Map<Node, string>()
  if (!diffChildren(base, alt, conditionFor(prop, value), memo)) return null
  return serializeOuter(base)
}

/* ------------------------------------------------------------------ */

/**
 * Sanitize a bundle component and fold its variants in (`sharedCss` is the bundle's own, already sanitized, and leads the stylesheet). Nothing is written: the caller creates the component from the
 * returned markup, stylesheet and props.
 */
export function prepareComponent(component: BundleComponent, sharedCss = ''): PreparedComponent {
  const issues: SanitizeIssue[] = []

  const markup = sanitizeMarkup(component.html)
  issues.push(...markup.issues)
  const sheet = sanitizeStylesheet([component.css ?? '', markup.css].filter(Boolean).join('\n'))
  issues.push(...sheet.issues)

  let html = markup.html
  const css: string[] = [sharedCss, sheet.value].filter(Boolean)
  const props = (component.props ?? []).map((prop) => ({ ...prop }))
  const root = firstRoot(html)
  const info = root ? rootInfo(root) : undefined

  for (const [propName, values] of Object.entries(component.variants ?? {})) {
    const prop = props.find((candidate) => candidate.name === propName)
    if (!prop) continue
    for (const [value, variant] of Object.entries(values)) {
      if (variant.css && info) {
        const clean = sanitizeStylesheet(variant.css)
        issues.push(...clean.issues)
        const scoped = serializeNodes(scopeNodes(parseCss(clean.value), attrSelector(propName, value), info, issues))
        if (scoped) css.push(scoped)
        if (prop.type === 'boolean') prop.reflect = true
      }
      if (variant.html) {
        const alt = sanitizeMarkup(variant.html)
        issues.push(...alt.issues)
        if (alt.css) {
          const altSheet = sanitizeStylesheet(alt.css)
          const scoped = info
            ? serializeNodes(scopeNodes(parseCss(altSheet.value), attrSelector(propName, value), info, issues))
            : ''
          if (scoped) css.push(scoped)
        }
        const merged = withAlternative(html, alt.html, prop, value)
        if (merged) {
          html = merged
        } else
          issues.push({
            code: 'variant_html_unsupported',
            message: `the “${propName}=${value}” render differs from the default in a way a condition cannot say (a different root, or too much changed): the default markup is kept`,
          })
      }
    }
  }
  return { html, css: css.join('\n'), props: props.length ? props : undefined, issues }
}
