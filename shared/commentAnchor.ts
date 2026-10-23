import type { CommentAnchor } from './types.ts'

/** How a comment's element was found again: the stored CSS path still held,
 *  or one of the fallbacks recovered it after the frame's HTML changed. */
export type AnchorHow = 'path' | 'testid' | 'id' | 'scan' | 'text'

export interface AnchorResolution {
  el: Element
  how: AnchorHow
}

export interface AnchorTools {
  /** Whether `el` is still the element `anchor` was captured on. */
  matchesAnchor: (el: Element, anchor: CommentAnchor) => boolean
  /** Find the anchored element again: the stored path, then data-testid, id,
   *  a scan of same-tag elements, and finally the quote's innermost holder.
   *  Without an anchor (legacy comments) only the path is tried. */
  resolveAnchor: (doc: Document, selector: string, anchor?: CommentAnchor) => AnchorResolution | null
  /** Capture an anchor for `el`, with the pin position as a fraction of its box. */
  buildAnchor: (el: Element, fx: number, fy: number) => CommentAnchor
}

/**
 * The anchor logic, as one self-contained factory.
 *
 * The frame runtime has to run exactly this code inside the sandboxed iframe,
 * which cannot import anything, so the bootstrap embeds `createAnchorTools.toString()`.
 * Everything the tools need therefore lives inside this function, referencing
 * only DOM globals: no imports, no module-level helpers, no type-only syntax
 * that survives transpilation. Keep it that way, and ES5-friendly.
 */
export function createAnchorTools(): AnchorTools {
  const QUOTE_MAX = 200
  const START_LEN = 60
  const SLICE_LEN = 40

  function normalise(text: string | null | undefined): string {
    return (text || '').replace(/\s+/g, ' ').trim()
  }

  function matchesAnchor(el: Element, anchor: CommentAnchor): boolean {
    if (anchor.tag && el.tagName.toLowerCase() !== anchor.tag) return false
    if (anchor.role && el.getAttribute('role') !== anchor.role) return false
    if (anchor.ariaLabel && el.getAttribute('aria-label') !== anchor.ariaLabel) return false
    if (anchor.testId && el.getAttribute('data-testid') !== anchor.testId) return false
    const quote = anchor.quote
    if (quote) {
      const text = normalise(el.textContent)
      const startsLikeQuote = text.indexOf(quote.slice(0, START_LEN)) === 0
      const holdsHead = text.indexOf(quote.slice(0, SLICE_LEN)) !== -1
      const holdsTail = quote.length > SLICE_LEN && text.indexOf(quote.slice(-SLICE_LEN)) !== -1
      if (!startsLikeQuote && !holdsHead && !holdsTail) return false
    }
    return true
  }

  function isInert(el: Element): boolean {
    const tag = el.tagName.toLowerCase()
    return tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template'
  }

  /** Walk down from `root` into whichever child still holds `probe`, so the
   *  result is the innermost element whose text contains it. */
  function innermostHolding(root: Element, probe: string): Element | null {
    if (normalise(root.textContent).indexOf(probe) === -1) return null
    let node = root
    for (;;) {
      let next: Element | null = null
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        if (isInert(child)) continue
        if (normalise(child.textContent).indexOf(probe) !== -1) {
          next = child
          break
        }
      }
      if (!next) return node
      node = next
    }
  }

  function resolveAnchor(doc: Document, selector: string, anchor?: CommentAnchor): AnchorResolution | null {
    const accepts = (el: Element | null): el is Element => !!el && (!anchor || matchesAnchor(el, anchor))

    if (selector) {
      let byPath: Element | null = null
      try {
        byPath = doc.querySelector(selector)
      } catch {
        /* a selector that no longer parses just falls through to the hints */
      }
      if (accepts(byPath)) return { el: byPath, how: 'path' }
    }
    if (!anchor) return null

    if (anchor.testId) {
      const tagged = doc.querySelectorAll('[data-testid]')
      for (let i = 0; i < tagged.length; i++) {
        const el = tagged[i]
        if (el && el.getAttribute('data-testid') === anchor.testId && matchesAnchor(el, anchor)) {
          return { el, how: 'testid' }
        }
      }
    }
    if (anchor.id) {
      const byId = doc.getElementById(anchor.id)
      if (accepts(byId)) return { el: byId, how: 'id' }
    }
    /* a bare tag identifies nothing: scanning on it alone would pin the comment to the first such element */
    const hasHints = !!(anchor.id || anchor.testId || anchor.role || anchor.ariaLabel || anchor.quote)
    if (anchor.tag && hasHints) {
      const sameTag = doc.getElementsByTagName(anchor.tag)
      for (let i = 0; i < sameTag.length; i++) {
        const el = sameTag[i]
        if (el && matchesAnchor(el, anchor)) return { el, how: 'scan' }
      }
    }
    if (anchor.quote && doc.body) {
      const probe = anchor.quote.slice(0, START_LEN)
      const holder = innermostHolding(doc.body, probe)
      /* the body itself holding the quote means no element narrows it down */
      if (holder && holder !== doc.body) return { el: holder, how: 'text' }
    }
    return null
  }

  function buildAnchor(el: Element, fx: number, fy: number): CommentAnchor {
    const clamp = (n: number) => (n >= 0 && n <= 1 ? n : n > 1 ? 1 : 0)
    const anchor: CommentAnchor = { v: 1, tag: el.tagName.toLowerCase(), fx: clamp(fx), fy: clamp(fy) }
    const id = el.getAttribute('id')
    const testId = el.getAttribute('data-testid')
    const role = el.getAttribute('role')
    const ariaLabel = el.getAttribute('aria-label')
    const quote = normalise(el.textContent).slice(0, QUOTE_MAX)
    if (id) anchor.id = id
    if (testId) anchor.testId = testId
    if (role) anchor.role = role
    if (ariaLabel) anchor.ariaLabel = ariaLabel
    if (quote) anchor.quote = quote
    return anchor
  }

  return { matchesAnchor, resolveAnchor, buildAnchor }
}

const tools = createAnchorTools()
export const matchesAnchor = tools.matchesAnchor
export const resolveAnchor = tools.resolveAnchor
export const buildAnchor = tools.buildAnchor

/** JS source that evaluates to the anchor tools, for the frame runtime. */
export const ANCHOR_TOOLS_SOURCE = `(${createAnchorTools.toString()})()`

/** Keep only what an anchor is allowed to carry before it is stored: the
 *  client and agents send it as free-form JSON. Returns undefined for anything
 *  that is not a usable anchor. */
export function sanitizeAnchor(raw: unknown): CommentAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
  const frac = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)
  const tag = typeof a.tag === 'string' ? a.tag.toLowerCase().slice(0, 40) : ''
  const anchor: CommentAnchor = { v: 1, tag, fx: frac(a.fx), fy: frac(a.fy) }
  const id = text(a.id, 200)
  const testId = text(a.testId, 200)
  const role = text(a.role, 100)
  const ariaLabel = text(a.ariaLabel, 200)
  const quote = text(a.quote, 200)
  if (id) anchor.id = id
  if (testId) anchor.testId = testId
  if (role) anchor.role = role
  if (ariaLabel) anchor.ariaLabel = ariaLabel
  if (quote) anchor.quote = quote
  /* an anchor with nothing to find the element by is worse than none */
  if (!tag && !id && !testId && !quote) return undefined
  return anchor
}
