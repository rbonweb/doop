import { isFollowableAttribute } from './bindings.ts'
import type { StorybookIssue } from './index.ts'

/** Pure: no node or server imports, since the CLI bundles it. The functions below run INSIDE a Storybook story page, in an ISOLATED world (`frame.isolatedRealm()`): they see the page's DOM and CSSOM but none of its JavaScript, so page script cannot replace `JSON.stringify`, a DOM getter or `getComputedStyle` under them. Each is self-contained: it may use only what the page has and its own arguments, and helpers live inside it. The result is serialized there and measured there, so the server never receives more than the cap, and it validates what arrives again. The caller runs `CAPTURE_PRELUDE` in that world first, since tsx annotates nested functions with `__name`. Storybook's preview object lives in the page's own world and is read by probe.ts instead. */

export const FOLLOWABLE_GLOBAL = '__doopFollowableAttribute'

export const CAPTURE_PRELUDE = `globalThis.__name = (target) => target\nglobalThis.${FOLLOWABLE_GLOBAL} = ${isFollowableAttribute.toString()}`

/** The computed properties a variant is diffed on, in the order `styles` lists them. */
export const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration-line',
  'text-align',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'display',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'cursor',
  'pointer-events',
  'visibility',
  'transform',
  'filter',
  'outline-style',
  'outline-color',
] as const

export interface CaptureOptions {
  /** text args whose value is the rendered text of one element; that element gets `data-doop-prop` */
  textArgs: { prop: string; value: string }[]
  /** the sanitized html may not be longer than this (UTF-16 units, as a cheap bound on bytes) */
  maxBytes: number
  /** the computed properties to read; pass `STYLE_PROPERTIES`, since a function sent to the page cannot see this module */
  styleProperties: readonly string[]
  /** over this many elements no computed styles are read, so a variant cannot be diffed */
  maxElements: number
  /** a throwaway attribute name Doop chose for this render: when set, every element of `html` carries it with its index (root 0), so a binding found later can be written onto the right element */
  marker?: string
  /** the name of the component this story is for: when the story renders it inside something else (a label next to its input, a card around a form), the element that names itself this (`data-slot` or `data-part`) is the root instead, so the component is its own part and not the whole story */
  focus?: string
}

export interface CapturedStory {
  ok: true
  /** the first element of `#storybook-root`, passive: no scripts, handlers or executable URLs */
  html: string
  /** the rules that apply to that tree, from the CSSOM (adopted sheets included) */
  css: string
  /** rules that style the document rather than the tree (resets, `:root` variables, font faces), one entry per rule */
  sharedRules: string[]
  /** the story page's own font: the computed `font-family` of its body (at most 500 characters; absent when empty or longer), for a bundle whose shared rules set none */
  rootFont?: string
  /** the tree's shape (depth and tag of every element, in order), equal when two renders can be diffed */
  shape: string
  /** one selector for each element in `html`, root first: the root's tag and classes, then each descendant's path of `tag:nth-child(n)` from the root's children down, so scoped under the root they match the same element */
  paths: string[]
  /** computed `STYLE_PROPERTIES` for each element in `html`; null above `maxElements` */
  styles: string[][] | null
  /** the attributes of each element in `html` that a prop might track (data-*, aria-*, role, disabled and the like; never class, style, id or a URL), by name; null above `maxElements` */
  attrs?: Record<string, string>[] | null
  /** the text each element of `html` holds directly, whitespace collapsed and cut at 200 characters (empty when none); null above `maxElements` */
  texts?: string[] | null
  /** the `src` of each element of `html` (an http(s) address, or empty), for a prop that fills an image; null above `maxElements` */
  srcs?: string[] | null
  /** the marker attribute the html was written with (set by the importer, not the page) */
  marker?: string
  issues: StorybookIssue[]
}

export type StoryCapture = CapturedStory | { ok: false; reason: string; code?: string }

/** What `captureStory` answers: the capture as one JSON string of at most `maxBytes` characters, or a small refusal. */
export type CaptureResult = string | { ok: false; reason: string; bytes?: number }

/** Elements in the story's tree over which it is not captured. */
export const MAX_CAPTURE_ELEMENTS = 20_000

/** Lets a story come to rest before it is captured: fonts, images, two frames, then a short quiet spell with no change to the story's DOM (a framework commits an args update a beat after the render event that announced it), no longer than `maxMs` in all. */
export async function settleStory(maxMs: number): Promise<void> {
  const end = performance.now() + maxMs
  const capped = (work: Promise<unknown>) =>
    Promise.race([work, new Promise((done) => setTimeout(done, Math.max(0, end - performance.now())))])
  const loaded = (img: HTMLImageElement) =>
    img.complete
      ? Promise.resolve()
      : new Promise((done) => {
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        })
  await capped(Promise.all([document.fonts.ready, ...Array.from(document.images, loaded)]))
  await capped(new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  const host = document.querySelector('#storybook-root') ?? document.querySelector('#root')
  if (!host) return
  /* a story that never stops changing (a timer, a spinner) is captured after the cap, as before */
  await capped(
    new Promise((done) => {
      let quiet: ReturnType<typeof setTimeout>
      const watcher = new MutationObserver(() => {
        clearTimeout(quiet)
        quiet = setTimeout(finish, 150)
      })
      const cap = setTimeout(finish, 800)
      function finish() {
        clearTimeout(quiet)
        clearTimeout(cap)
        watcher.disconnect()
        done(undefined)
      }
      watcher.observe(host, { subtree: true, childList: true, attributes: true, characterData: true })
      quiet = setTimeout(finish, 150)
    }),
  )
}

/** The first element rendered into the story root, as passive html, the CSS that applies to it and what a variant needs to be diffed against it. Never mutates the live story. */
export function captureStory(options: CaptureOptions): CaptureResult {
  const issues: StorybookIssue[] = []
  const host = document.querySelector('#storybook-root') ?? document.querySelector('#root')
  let live = host?.firstElementChild
  if (!host || !live) return { ok: false, reason: 'The story rendered nothing into #storybook-root' }
  if (host.children.length > 1) {
    issues.push({
      code: 'multiple_roots',
      message: 'The story renders several root elements; only the first was captured',
    })
  }

  if (host.getElementsByTagName('*').length > 20000) {
    return { ok: false, reason: 'too_many_elements', bytes: host.getElementsByTagName('*').length }
  }

  /* a story that shows the component beside or inside others (a label with its input) is captured from the part that names itself after the component */
  const identityOf = (el: Element) =>
    ['data-slot', 'data-part']
      .map((name) => (el.getAttribute(name) ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
  const wanted = (options.focus ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (wanted && !identityOf(live).includes(wanted)) {
    const part = Array.from(live.querySelectorAll('*')).find((el) => identityOf(el).includes(wanted))
    if (part) {
      issues.push({
        code: 'composite_story',
        message: `The story renders "${options.focus}" inside a <${live.localName}> with other content: only the "${options.focus}" part was captured`,
      })
      live = part
    }
  }

  const banned =
    'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe, base, meta, link, style, template'
  const clone = live.cloneNode(true) as Element
  const liveEls = [live, ...Array.from(live.querySelectorAll('*'))]
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))]
  const pairs = liveEls.length === cloneEls.length ? liveEls.map((el, i) => ({ live: el, clone: cloneEls[i]! })) : []
  if (!pairs.length) return { ok: false, reason: 'The story changed while it was being captured' }

  /* passive: nothing here may run again inside a frame */
  const doomed = cloneEls.filter((el) => el !== clone && el.matches(banned))
  if (clone.matches(banned)) return { ok: false, reason: 'The story root is not a visual element' }
  for (const el of doomed) el.remove()
  const urlAttributes = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href', 'data', 'srcset'])
  const unsafeUrl = /^\s*(?:javascript|vbscript):|^\s*data:\s*(?:text\/html|application\/xhtml)/i
  const kept = pairs.filter((pair) => pair.clone === clone || clone.contains(pair.clone))
  for (const { clone: el } of kept) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'ping' ||
        name.startsWith('data-doop-') ||
        (urlAttributes.has(name) && unsafeUrl.test(attr.value.replace(/[\p{Cc}\s]+/gu, '')))
      ) {
        el.removeAttribute(attr.name)
      } else if (name === 'src' || name === 'poster') {
        try {
          const url = new URL(attr.value, document.baseURI)
          if (url.protocol === 'http:' || url.protocol === 'https:') el.setAttribute(attr.name, url.href)
          else if (url.protocol === 'blob:') el.removeAttribute(attr.name)
        } catch {
          el.removeAttribute(attr.name)
        }
      }
    }
  }

  /* a text arg that is the rendered text of exactly one element binds that element */
  const ownText = (el: Element) =>
    Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim()
  for (const arg of options.textArgs) {
    if (!arg.value.trim()) continue
    const matches = kept.filter(
      ({ clone: el }) => ownText(el) === arg.value.trim() && !el.hasAttribute('data-doop-prop'),
    )
    const first = matches[0]
    if (matches.length === 1 && first) first.clone.setAttribute('data-doop-prop', arg.prop)
    else if (matches.length > 1) {
      issues.push({
        code: 'text_arg_ambiguous',
        message: `The text of "${arg.prop}" appears in ${matches.length} elements, so none was bound to it`,
      })
    }
  }

  /* what a prop can track: the plain attributes of each element, read before the markers go on */
  const followable = (globalThis as unknown as Record<string, (name: string) => boolean>)['__doopFollowableAttribute']!
  const small = kept.length <= options.maxElements
  const texts: string[] | null = small
    ? kept.map(({ clone: el }) => ownText(el).replace(/\s+/g, ' ').slice(0, 200))
    : null
  const srcs: string[] | null = small
    ? kept.map(({ clone: el }) => {
        const value = el.getAttribute('src') ?? ''
        return /^https?:\/\//.test(value) && value.length <= 500 ? value : ''
      })
    : null
  const attrs: Record<string, string>[] | null =
    kept.length <= options.maxElements
      ? kept.map(({ clone: el }) => {
          const found: Record<string, string> = {}
          let count = 0
          for (const attr of Array.from(el.attributes)) {
            const name = attr.name
            if (count >= 30) break
            if (!followable(name) || urlAttributes.has(name) || attr.value.length > 120) continue
            found[name] = attr.value
            count++
          }
          return found
        })
      : null
  if (options.marker && attrs) {
    kept.forEach(({ clone: el }, index) => {
      /* the marker goes right before the element's own binding (if any), so the two can be merged as text */
      const own = el.getAttribute('data-doop-prop')
      if (own !== null) el.removeAttribute('data-doop-prop')
      el.setAttribute(options.marker!, String(index))
      if (own !== null) el.setAttribute('data-doop-prop', own)
    })
  }

  const html = clone.outerHTML
  if (html.length > options.maxBytes) return { ok: false, reason: 'too_large', bytes: html.length }

  const classPart = Array.from(clone.classList)
    .slice(0, 6)
    .map((name) => '.' + CSS.escape(name))
    .join('')
  const paths: string[] = []
  const depthOf = new Map<Element, number>()
  const pathOf = new Map<Element, string>()
  for (const { clone: el } of kept) {
    const parent = el.parentElement
    if (el === clone || !parent) {
      pathOf.set(el, el.localName + classPart)
      depthOf.set(el, 0)
    } else {
      const index = Array.from(parent.children).indexOf(el) + 1
      pathOf.set(
        el,
        parent === clone
          ? `${el.localName}:nth-child(${index})`
          : `${pathOf.get(parent) ?? ''} > ${el.localName}:nth-child(${index})`,
      )
      depthOf.set(el, (depthOf.get(parent) ?? 0) + 1)
    }
    paths.push(pathOf.get(el) ?? el.localName)
  }
  const shape = kept.map((pair) => `${depthOf.get(pair.clone) ?? 0}${pair.clone.localName}`).join(',')

  let styles: string[][] | null = null
  if (kept.length <= options.maxElements) {
    styles = kept.map(({ live: el }) => {
      const computed = getComputedStyle(el)
      return options.styleProperties.map((property) => computed.getPropertyValue(property))
    })
  } else {
    issues.push({
      code: 'variants_not_diffable',
      message: `The story has more than ${options.maxElements} elements, so its variants are captured whole`,
    })
  }

  /* CSS from the CSSOM: only rules that reach this tree, and what the document needs around it */
  const started = performance.now()
  const dynamic =
    /::?(?:hover|focus|focus-visible|focus-within|active|visited|link|target|before|after|first-letter|first-line|placeholder|selection|marker|backdrop|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+)(?:\([^)]*\))?/gi
  const splitList = (text: string): string[] => {
    const out: string[] = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if (ch === ',' && depth === 0) {
        out.push(text.slice(start, i))
        start = i + 1
      }
    }
    out.push(text.slice(start))
    return out.map((part) => part.trim()).filter(Boolean)
  }
  const globalOnly = /^(?:\*|html|body|:root|:host|html body|html > body)?$/i
  const reaches = (selector: string): boolean => {
    try {
      return live.matches(selector) || !!live.querySelector(selector)
    } catch {
      return false
    }
  }
  const unscoped = (selector: string) => selector.replace(dynamic, '').replace(/\s+/g, ' ').trim()
  /* A data attribute with one value across the tree is a state of the component (data-variant="default"); one with several names its parts (data-component="text"). A rule for another value of a state (primary's icon colour: the variant attribute plus the icon's class) needs this render's markup (the icon) and a value this render does not have, while the render that has the value (variant=primary) has no icon, so no single render matches it and the rule would be lost. It counts as reaching when it would with the state taken away, and is kept as written, so an instance that has both still matches it. Attributes that say what an element is or wrap the component are never a state: they would let other components' rules in. */
  const identity =
    /^data-(?:doop-.*|component|testid|test-id|slot|name|id|part|key|portal-root|color-mode|color-scheme|light-theme|dark-theme|a11y-.*)$/i
  const attributeValues = new Map<string, Set<string>>()
  for (const el of liveEls) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith('data-') || identity.test(attr.name)) continue
      const values = attributeValues.get(attr.name) ?? new Set<string>()
      values.add(attr.value)
      attributeValues.set(attr.name, values)
    }
  }
  const stateNames = Array.from(attributeValues)
    .filter(([, values]) => values.size === 1)
    .map(([name]) => name.replace(/[^\w-]/g, ''))
  const stateAttribute = stateNames.length
    ? `\\[(?:${stateNames.join('|')})(?:[~|^$*]?=(?:"[^"]*"|'[^']*'|[^\\]]*))?\\]`
    : undefined
  /* the selector with its state attributes taken away: a compound made only of them becomes `*`, so `[data-x="a"] > .y` stays valid, and a selector with nothing but state in it reaches nothing (it would match every element) */
  const withoutState = (selector: string) => {
    if (!stateAttribute) return selector
    const whole = new RegExp(`(^|[\\s>+~,(])(?:${stateAttribute})+(?=[\\s>+~,)]|$)`, 'gi')
    const out = selector.replace(whole, '$1*').replace(new RegExp(stateAttribute, 'gi'), '').trim()
    return out.replace(/:(?:where|is)\(|[)\s*>+~,]/g, '') === '' ? '' : out
  }
  const internal = /(?:^|[\s.#>+~,])(?:\.sb-|#storybook-|\.docs-story|\.sb_)/
  const used = {
    fonts: new Set(
      liveEls.slice(0, 400).flatMap((el) =>
        getComputedStyle(el)
          .fontFamily.split(',')
          .map((f) =>
            f
              .trim()
              .replace(/^["']|["']$/g, '')
              .toLowerCase(),
          ),
      ),
    ),
    animations: new Set(
      liveEls.slice(0, 400).flatMap((el) =>
        getComputedStyle(el)
          .animationName.split(',')
          .map((n) => n.trim()),
      ),
    ),
  }
  const absolutize = (text: string, base: string) =>
    text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote: string, target: string) => {
      if (/^(?:data|blob|about):/i.test(target)) return whole
      try {
        return `url("${new URL(target, base).href}")`
      } catch {
        return whole
      }
    })
  /* Cascade layers are flattened here: Doop's own component CSS and a frame's CSS are unlayered, so a layered rule would lose to every one of them. Each rule keeps the layers it sat in as a sort key (the first-appearance index of each layer on its path, `Infinity` where the rule is not in a deeper layer), and the output is emitted in true cascade order with no `@layer` left. */
  interface Piece {
    text: string
    key: number[]
    shared: boolean
  }
  const layerIndex = new Map<string, number>()
  /* the layer path a name opens inside `layers` (each entry the full dotted name), registering every layer it passes in first-appearance order; an anonymous layer is its own entry */
  const enter = (layers: string[], name: string): string[] => {
    let path = layers
    for (const part of name ? name.split('.') : [`#anonymous${layerIndex.size}`]) {
      const parent = path[path.length - 1]
      const full = parent === undefined ? part : `${parent}.${part}`
      if (!layerIndex.has(full)) layerIndex.set(full, layerIndex.size)
      path = [...path, full]
    }
    return path
  }
  const keyOf = (layers: string[]) => layers.map((name) => layerIndex.get(name) ?? Infinity)
  const byCascade = (a: Piece, b: Piece) => {
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
      const left = a.key[i] ?? Infinity
      const right = b.key[i] ?? Infinity
      if (left !== right) return left < right ? -1 : 1
    }
    return 0
  }
  /* `@property` initial values, by name: a registered property has its initial value on every element, which an unregistered one (the browser here knows the registration, a frame does not carry it) lacks */
  const registered = new Map<string, string>()
  let crossOrigin = 0
  let oversize = 0
  let cssChars = 0
  /* a rule's text, unless it is huge: a page can make one rule 50 MB */
  const textOf = (rule: CSSRule): string | undefined => {
    const text = rule.cssText
    if (text.length > 200_000 || (cssChars += text.length) > 2_000_000) {
      oversize++
      return undefined
    }
    return text
  }
  let scanned = 0
  const walk = (rules: CSSRuleList, base: string, depth: number, layers: string[]): Piece[] => {
    const out: Piece[] = []
    const emit = (text: string, isShared: boolean) => out.push({ text, key: keyOf(layers), shared: isShared })
    for (const rule of Array.from(rules)) {
      if (scanned++ > 30000 || performance.now() - started > 4000) break
      if (rule.constructor.name === 'CSSImportRule') {
        const imported = rule as CSSImportRule & { layerName?: string | null }
        if (imported.styleSheet && depth < 6) {
          try {
            out.push(
              ...walk(
                imported.styleSheet.cssRules,
                imported.styleSheet.href ?? base,
                depth + 1,
                typeof imported.layerName === 'string' ? enter(layers, imported.layerName) : layers,
              ),
            )
          } catch {
            crossOrigin++
          }
        }
        continue
      }
      if ('selectorText' in rule) {
        const style = rule as CSSStyleRule
        const selectors = splitList(style.selectorText)
        if (selectors.length && selectors.every((s) => globalOnly.test(unscoped(s)))) {
          const text = internal.test(style.selectorText) ? undefined : textOf(style)
          if (text !== undefined) emit(absolutize(text, base), true)
        } else if (
          !internal.test(style.selectorText) &&
          selectors.some((s) => reaches(s) || reaches(unscoped(s)) || reaches(withoutState(unscoped(s))))
        ) {
          const text = textOf(style)
          if (text !== undefined) emit(absolutize(text, base), false)
        }
        continue
      }
      const type = rule.constructor.name
      if (type === 'CSSLayerStatementRule') {
        for (const name of (rule as unknown as { nameList?: string[] }).nameList ?? []) enter(layers, name)
      } else if (type === 'CSSLayerBlockRule') {
        if (depth < 6) {
          out.push(
            ...walk(
              (rule as CSSGroupingRule).cssRules,
              base,
              depth + 1,
              enter(layers, (rule as { name?: string }).name ?? ''),
            ),
          )
        }
      } else if (type === 'CSSPropertyRule') {
        const property = rule as unknown as { name: string; initialValue: string | null }
        const value = property.initialValue?.trim()
        if (value && value.length <= 1000 && /^--[\w-]+$/.test(property.name) && !/[{};<>\\]|\/\*|[\r\n]/.test(value)) {
          registered.set(property.name, absolutize(value, base))
        }
      } else if (type === 'CSSFontFaceRule') {
        const family = (rule as CSSFontFaceRule).style
          .getPropertyValue('font-family')
          .replace(/^["']|["']$/g, '')
          .toLowerCase()
        const text = used.fonts.has(family) ? textOf(rule) : undefined
        if (text !== undefined) emit(absolutize(text, base), true)
      } else if (type === 'CSSKeyframesRule') {
        const text = used.animations.has((rule as CSSKeyframesRule).name) ? textOf(rule) : undefined
        if (text !== undefined) emit(text, false)
      } else if ('cssRules' in rule && depth < 6 && /^CSS(?:Media|Supports|Container)Rule$/.test(type)) {
        const inner = walk((rule as CSSGroupingRule).cssRules, base, depth + 1, layers)
        if (!inner.length) continue
        const kind = type.replace(/^CSS|Rule$/g, '').toLowerCase()
        const label = [
          (rule as { containerName?: string }).containerName,
          (rule as { conditionText?: string }).conditionText,
        ]
          .filter(Boolean)
          .join(' ')
        /* a group holding rules of several layers is split, each layer's rules wrapped by the same condition, so every part sorts by its own layer */
        const groups = new Map<string, Piece[]>()
        for (const piece of inner) {
          const id = `${piece.shared ? 's' : 'c'}${piece.key.join(',')}`
          groups.set(id, [...(groups.get(id) ?? []), piece])
        }
        for (const pieces of groups.values()) {
          const first = pieces[0]!
          out.push({
            text: `@${kind} ${label} {\n${pieces.map((piece) => piece.text).join('\n')}\n}`,
            key: first.key,
            shared: first.shared,
          })
        }
      }
    }
    return out
  }
  const pieces: Piece[] = []
  const sheets: CSSStyleSheet[] = [
    ...Array.from(document.styleSheets),
    ...Array.from(document.adoptedStyleSheets ?? []),
  ]
  for (const sheet of sheets) {
    if (sheet.disabled) continue
    try {
      pieces.push(...walk(sheet.cssRules, sheet.href ?? document.baseURI, 0, []))
    } catch {
      crossOrigin++
    }
  }
  /* a registered property a kept rule reads becomes a rule that gives every element its initial value, ahead of every layer: a frame has no registration, so `var(--tw-border-style)` would otherwise be undefined */
  if (registered.size) {
    const read = new Set<string>()
    for (const piece of pieces) for (const match of piece.text.matchAll(/var\(\s*(--[^\s,)]+)/g)) read.add(match[1]!)
    const declarations = Array.from(registered).filter(([name]) => read.has(name))
    const selector = '*, ::before, ::after, ::backdrop'
    for (let from = 0; from < declarations.length;) {
      let body = ''
      while (from < declarations.length && body.length < 12_000) {
        const [name, value] = declarations[from++]!
        body += `${name}: ${value}; `
      }
      pieces.push({ text: `${selector} { ${body.trim()} }`, key: [-Infinity], shared: true })
    }
  }
  pieces.sort(byCascade)
  const css = pieces.filter((piece) => !piece.shared).map((piece) => piece.text)
  /* a rule that appears twice keeps its later place, the one that wins */
  const shared = Array.from(
    new Set(
      pieces
        .filter((piece) => piece.shared)
        .map((piece) => piece.text)
        .reverse(),
    ),
  ).reverse()
  if (crossOrigin) {
    issues.push({
      code: 'css_cross_origin',
      message: `${crossOrigin} stylesheets could not be read (they come from another origin); their rules are not in the import`,
    })
  }
  if (oversize) {
    issues.push({
      code: 'css_rules_oversize',
      message: `${oversize} CSS rules were too large to read and were left out`,
    })
  }
  if (performance.now() - started > 4000 || scanned > 30000) {
    issues.push({ code: 'css_scan_capped', message: 'The page has so many CSS rules that only part of them were read' })
  }

  const bodyFont = document.body ? getComputedStyle(document.body).fontFamily : ''
  const rootFont = bodyFont.length <= 500 ? bodyFont : ''

  /* serialized and measured here, where page script cannot reach JSON.stringify: the server never receives more than the cap */
  const text = JSON.stringify({
    ok: true,
    html,
    css: css.join('\n'),
    sharedRules: shared,
    ...(rootFont ? { rootFont } : {}),
    shape,
    paths,
    styles,
    attrs,
    texts,
    srcs,
    issues,
  })
  if (text.length > options.maxBytes) return { ok: false, reason: 'too_large', bytes: text.length }
  return text
}
