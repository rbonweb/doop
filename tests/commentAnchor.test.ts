// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'
import { buildAnchor, matchesAnchor, resolveAnchor, sanitizeAnchor } from '../shared/commentAnchor'
import type { CommentAnchor } from '../shared/types'

/* The anchor logic is one pure module; the frame runtime embeds the same source. The first half exercises it directly on a happy-dom document, the last test runs it through the real bootstrap the way FrameView drives it. */

function mount(body: string) {
  document.body.innerHTML = body
}

const PAGE = `
  <main>
    <section><h2>Pricing</h2><button class="cta">Start free trial</button></section>
    <footer><a href="/terms">Terms of service</a></footer>
  </main>`

/** the anchor and CSS path the runtime would have stored for the element */
function capture(selector: string, fx = 0.5, fy = 0.5) {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`no element for ${selector}`)
  const path = (node: Element): string => {
    const parts: string[] = []
    for (let n: Element | null = node; n && n !== document.documentElement; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${n.id}`)
        break
      }
      let nth = 1
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) nth++
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${nth})`)
    }
    return parts.join(' > ')
  }
  return { el, selector: path(el), anchor: buildAnchor(el, fx, fy) }
}

describe('resolveAnchor', () => {
  beforeEach(() => mount(PAGE))

  it('hits the stored path when the DOM is unchanged', () => {
    const { el, selector, anchor } = capture('button')
    const hit = resolveAnchor(document, selector, anchor)
    expect(hit?.how).toBe('path')
    expect(hit?.el).toBe(el)
  })

  it('rejects the element at the path when its text is different, and finds the right one by scan', () => {
    const { selector, anchor } = capture('button')
    /* a new section pushes a different button onto the old path */
    mount(`<main><section><h2>New</h2><button>Contact sales team today</button></section>${PAGE}</main>`)
    const atPath = document.querySelector(selector)
    expect(atPath?.textContent).toBe('Contact sales team today')
    expect(matchesAnchor(atPath as Element, anchor)).toBe(false)
    const hit = resolveAnchor(document, selector, anchor)
    expect(hit?.how).toBe('scan')
    expect(hit?.el.textContent).toBe('Start free trial')
  })

  it('recovers by data-testid after a sibling is inserted before the target', () => {
    mount('<main><div><span data-testid="buy">Buy now</span></div></main>')
    const { selector, anchor } = capture('[data-testid="buy"]')
    mount('<main><p>Banner</p><div><span>Banner copy</span><span data-testid="buy">Buy now</span></div></main>')
    const hit = resolveAnchor(document, selector, anchor)
    expect(hit?.how).toBe('testid')
    expect(hit?.el.getAttribute('data-testid')).toBe('buy')
  })

  it('recovers by id when the path is gone', () => {
    mount('<main><div><span id="total">Total: $40</span></div></main>')
    const { anchor } = capture('#total')
    /* a stale selector from before the id existed in this spot */
    mount('<main><header>New</header><section><div><span id="total">Total: $40</span></div></section></main>')
    const hit = resolveAnchor(document, 'main > div:nth-of-type(1) > span:nth-of-type(1)', anchor)
    expect(hit?.how).toBe('id')
    expect(hit?.el.id).toBe('total')
  })

  it('recovers by a same-tag scan after a sibling is inserted before the target', () => {
    const { selector, anchor } = capture('footer a')
    mount(`<main><aside><a href="/new">What is new</a></aside>${PAGE}</main>`)
    /* the old path now lands on the wrong link */
    expect(document.querySelector(selector)?.textContent).not.toBe('Terms of service')
    const hit = resolveAnchor(document, selector, anchor)
    expect(hit?.how).toBe('scan')
    expect(hit?.el.textContent).toBe('Terms of service')
  })

  it('finds the innermost element holding a quote-only anchor', () => {
    mount(`<main><section><div><p>Intro <b>Get started in minutes</b> today</p></div></section></main>`)
    const anchor: CommentAnchor = { v: 1, tag: '', quote: 'Get started in minutes', fx: 0.5, fy: 0.5 }
    const hit = resolveAnchor(document, '', anchor)
    expect(hit?.how).toBe('text')
    expect(hit?.el.tagName).toBe('B')
  })

  it('returns null when nothing matches', () => {
    const { selector, anchor } = capture('button')
    mount('<main><p>Completely different page</p></main>')
    expect(resolveAnchor(document, selector, anchor)).toBeNull()
  })

  it('does not scan on a bare tag, which would pin the comment to the first such element', () => {
    mount('<main><img id="a"><img id="b"></main>')
    const anchor: CommentAnchor = { v: 1, tag: 'img', fx: 0.5, fy: 0.5 }
    expect(resolveAnchor(document, 'main > div > img', anchor)).toBeNull()
  })

  it('uses only the path for a legacy comment without an anchor', () => {
    const hit = resolveAnchor(document, 'footer a', undefined)
    expect(hit?.how).toBe('path')
    expect(resolveAnchor(document, 'footer button', undefined)).toBeNull()
    expect(resolveAnchor(document, '>>not a selector<<', undefined)).toBeNull()
  })
})

describe('buildAnchor and sanitizeAnchor', () => {
  it('captures identity hints and a whitespace-normalised quote capped at 200 characters', () => {
    mount(`<div><button id="go" role="link" aria-label="Go" data-testid="go">  ${'word '.repeat(80)}\n</button></div>`)
    const anchor = buildAnchor(document.querySelector('button') as Element, 0.25, 4)
    expect(anchor).toMatchObject({
      v: 1,
      tag: 'button',
      id: 'go',
      role: 'link',
      ariaLabel: 'Go',
      testId: 'go',
      fx: 0.25,
      fy: 1,
    })
    expect(anchor.quote).toHaveLength(200)
    expect(anchor.quote?.startsWith('word word')).toBe(true)
  })

  it('drops junk and clamps fractions on the way into storage', () => {
    expect(sanitizeAnchor('nope')).toBeUndefined()
    expect(sanitizeAnchor({ tag: '' })).toBeUndefined()
    expect(sanitizeAnchor({ tag: 'BUTTON', fx: 9, fy: -3, quote: 'x'.repeat(500), extra: 1 })).toEqual({
      v: 1,
      tag: 'button',
      fx: 1,
      fy: 0,
      quote: 'x'.repeat(200),
    })
  })
})

describe('frame runtime doop:locate', () => {
  beforeAll(() => {
    const boot = /<script data-v-boot>([\s\S]*)<\/script>/.exec(FRAME_BOOTSTRAP)?.[1]
    if (!boot) throw new Error('bootstrap script not found')
    new Function(boot)()
  })

  function locate(selector: string, anchor?: CommentAnchor) {
    return new Promise<Record<string, unknown>>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        if (ev.data?.type !== 'doop:located') return
        window.removeEventListener('message', onMsg)
        resolve(ev.data)
      }
      window.addEventListener('message', onMsg)
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'doop:locate', reqId: 'c1', selector, anchor }, source: window }),
      )
    })
  }

  it('answers with how the element was found and its current path, and reports a miss as null', async () => {
    mount(PAGE)
    const { selector, anchor } = capture('button')
    expect(await locate(selector, anchor)).toMatchObject({ reqId: 'c1', how: 'path', rect: expect.any(Object) })

    mount(`<main><section><h2>Banner</h2></section>${PAGE}</main>`)
    const moved = await locate(selector, anchor)
    expect(moved.how).toBe('scan')
    expect(typeof moved.selector).toBe('string')
    expect(document.querySelector(moved.selector as string)?.textContent).toBe('Start free trial')

    mount('<main><p>Gone</p></main>')
    expect(await locate(selector, anchor)).toMatchObject({ rect: null, how: null, selector: null })
  })
})
