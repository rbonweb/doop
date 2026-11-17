import type { StorybookIssue } from './index.ts'

/** Pure: no node or server imports, since the CLI bundles it. The functions below run INSIDE a Storybook story page (`page.evaluate` / `page.waitForFunction`), so each is self-contained: it may use only what the page has and its own arguments, and helpers live inside it. They are written for a page that may be hostile: they read, never run, what it holds, and what they return is plain data that the caller validates again. The caller sets `globalThis.__name = (t) => t` first (`CAPTURE_PRELUDE`), since tsx annotates nested functions with it. */

export const CAPTURE_PRELUDE = 'globalThis.__name = (target) => target'

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
  /** over this many elements no computed styles are read, so a variant cannot be diffed */
  maxElements: number
}

export interface CapturedStory {
  ok: true
  /** the first element of `#storybook-root`, passive: no scripts, handlers or executable URLs */
  html: string
  /** the rules that apply to that tree, from the CSSOM (adopted sheets included) */
  css: string
  /** rules that style the document rather than the tree (resets, `:root` variables, font faces), one entry per rule */
  sharedRules: string[]
  /** the tree's shape (depth and tag of every element, in order), equal when two renders can be diffed */
  shape: string
  /** one selector for each element in `html`, root first: the root's tag and classes, then each descendant's path of `tag:nth-child(n)` from the root's children down, so scoped under the root they match the same element */
  paths: string[]
  /** computed `STYLE_PROPERTIES` for each element in `html`; null above `maxElements` */
  styles: string[][] | null
  issues: StorybookIssue[]
}

export type StoryCapture = CapturedStory | { ok: false; reason: string }

export interface StoryMeta {
  argTypes: unknown
  initialArgs: unknown
  /** the component's display name, when Storybook knows it */
  displayName?: string
}

/** Where a story is: 'ready' once it has rendered, 'error' when Storybook shows its error screen, else 'pending'. */
export function storyState(): 'ready' | 'error' | 'pending' {
  const body = document.body
  if (!body) return 'pending'
  if (body.classList.contains('sb-show-errordisplay')) return 'error'
  const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: unknown } } })
    .__STORYBOOK_PREVIEW__
  const phase = preview?.currentRender?.phase
  if (phase === 'errored') return 'error'
  const root = document.querySelector('#storybook-root') ?? document.querySelector('#root')
  const hasContent = !!root?.firstElementChild
  if (typeof phase === 'string')
    return (phase === 'completed' || phase === 'played') && hasContent ? 'ready' : 'pending'
  return body.classList.contains('sb-show-main') && hasContent ? 'ready' : 'pending'
}

/** argTypes, initialArgs and the display name of a story, read from the preview and flattened to plain JSON (functions, symbols and cycles dropped, depth and size bounded). */
export async function readStoryMeta(storyId: string): Promise<StoryMeta | null> {
  const win = window as unknown as Record<string, unknown>
  const preview = win.__STORYBOOK_PREVIEW__ as
    | {
        currentRender?: { story?: unknown }
        storyStoreValue?: { loadStory?: (id: { storyId: string }) => Promise<unknown> }
        storyStore?: { loadStory?: (id: { storyId: string }) => Promise<unknown> }
      }
    | undefined
  let story: unknown = preview?.currentRender?.story
  if (!story || (story as { id?: unknown }).id !== storyId) {
    story = undefined
    const store = preview?.storyStoreValue ?? preview?.storyStore
    try {
      if (store?.loadStory) story = await store.loadStory({ storyId })
    } catch {
      /* try the older store */
    }
  }
  if (!story) {
    const legacy = win.__STORYBOOK_STORY_STORE__ as { fromId?: (id: string) => unknown } | undefined
    try {
      story = legacy?.fromId?.(storyId)
    } catch {
      /* no store */
    }
  }
  if (!story || typeof story !== 'object') return null

  let budget = 20000
  const plain = (value: unknown, depth: number): unknown => {
    if (value === null) return null
    const kind = typeof value
    if (kind === 'string') return (value as string).slice(0, 400)
    if (kind === 'number') return Number.isFinite(value as number) ? value : undefined
    if (kind === 'boolean') return value
    if (kind !== 'object' || depth > 4 || budget-- <= 0) return undefined
    if (Array.isArray(value)) return value.slice(0, 60).map((item) => plain(item, depth + 1))
    const out: Record<string, unknown> = Object.create(null)
    let keys = 0
    for (const key of Object.keys(value as object)) {
      if (keys++ >= 300) break
      let member: unknown
      try {
        member = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const flat = plain(member, depth + 1)
      if (flat !== undefined) out[key] = flat
    }
    return out
  }
  const record = story as Record<string, unknown>
  const component = record.component as { displayName?: unknown; name?: unknown } | undefined
  const nameOf = (value: unknown) => (typeof value === 'string' && value.length < 100 ? value : undefined)
  return {
    argTypes: plain(record.argTypes, 0),
    initialArgs: plain(record.initialArgs, 0),
    displayName: nameOf(component?.displayName) ?? nameOf(component?.name),
  }
}

/** Lets a story come to rest before it is captured: fonts, images and two frames, no longer than `maxMs`. */
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
}

/** The first element rendered into the story root, as passive html, the CSS that applies to it and what a variant needs to be diffed against it. Never mutates the live story. */
export function captureStory(options: CaptureOptions): StoryCapture {
  const issues: StorybookIssue[] = []
  const host = document.querySelector('#storybook-root') ?? document.querySelector('#root')
  const live = host?.firstElementChild
  if (!host || !live) return { ok: false, reason: 'The story rendered nothing into #storybook-root' }
  if (host.children.length > 1) {
    issues.push({
      code: 'multiple_roots',
      message: 'The story renders several root elements; only the first was captured',
    })
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

  const html = clone.outerHTML
  if (html.length > options.maxBytes) return { ok: false, reason: 'The rendered story is too large to import' }

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
      return STYLE_PROPERTIES.map((property) => computed.getPropertyValue(property))
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
  const globalOnly = /^(?:\*|html|body|:root|html body|html > body)?$/i
  const reaches = (selector: string): boolean => {
    try {
      return live.matches(selector) || !!live.querySelector(selector)
    } catch {
      return false
    }
  }
  const unscoped = (selector: string) => selector.replace(dynamic, '').replace(/\s+/g, ' ').trim()
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
  const css: string[] = []
  const shared: string[] = []
  let crossOrigin = 0
  let scanned = 0
  const walk = (rules: CSSRuleList, base: string, depth: number): string[] => {
    const out: string[] = []
    for (const rule of Array.from(rules)) {
      if (scanned++ > 30000 || performance.now() - started > 4000) break
      if (rule.constructor.name === 'CSSImportRule') {
        const imported = (rule as CSSImportRule).styleSheet
        if (imported && depth < 6) {
          try {
            out.push(...walk(imported.cssRules, imported.href ?? base, depth + 1))
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
          if (!internal.test(style.selectorText)) shared.push(absolutize(style.cssText, base))
        } else if (!internal.test(style.selectorText) && selectors.some((s) => reaches(s) || reaches(unscoped(s)))) {
          out.push(absolutize(style.cssText, base))
        }
        continue
      }
      const type = rule.constructor.name
      if (type === 'CSSFontFaceRule') {
        const family = (rule as CSSFontFaceRule).style
          .getPropertyValue('font-family')
          .replace(/^["']|["']$/g, '')
          .toLowerCase()
        if (used.fonts.has(family)) shared.push(absolutize(rule.cssText, base))
      } else if (type === 'CSSKeyframesRule') {
        if (used.animations.has((rule as CSSKeyframesRule).name)) out.push(rule.cssText)
      } else if ('cssRules' in rule && depth < 6 && /^CSS(?:Media|Supports|Container|LayerBlock)Rule$/.test(type)) {
        const inner = walk((rule as CSSGroupingRule).cssRules, base, depth + 1)
        if (inner.length)
          out.push(`${rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()} {\n${inner.join('\n')}\n}`)
      }
    }
    return out
  }
  const sheets: CSSStyleSheet[] = [
    ...Array.from(document.styleSheets),
    ...Array.from(document.adoptedStyleSheets ?? []),
  ]
  for (const sheet of sheets) {
    if (sheet.disabled) continue
    try {
      css.push(...walk(sheet.cssRules, sheet.href ?? document.baseURI, 0))
    } catch {
      crossOrigin++
    }
  }
  if (crossOrigin) {
    issues.push({
      code: 'css_cross_origin',
      message: `${crossOrigin} stylesheets could not be read (they come from another origin); their rules are not in the import`,
    })
  }
  if (performance.now() - started > 4000 || scanned > 30000) {
    issues.push({ code: 'css_scan_capped', message: 'The page has so many CSS rules that only part of them were read' })
  }

  return {
    ok: true,
    html,
    css: css.join('\n'),
    sharedRules: Array.from(new Set(shared)),
    shape,
    paths,
    styles,
    issues,
  }
}
