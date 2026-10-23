// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

/* The present half of the frame runtime, driven the way PresentMode and FrameView drive it: doop:mode, doop:html and doop:goto-at messages from the parent, clicks and keys inside the document. The runtime's own posts to the parent are read off window.postMessage, since happy-dom's parent is the window itself. */

function post(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}
const mode = (present: boolean, slides = false) => post({ type: 'doop:mode', present, slides })
const render = (html: string, transition = false) =>
  post({ type: 'doop:html', html, ...(transition ? { transition } : {}) })

const html = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const root = () => document.documentElement
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
const key = (k: string, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

const sent = (type: string) =>
  postMessage_.mock.calls
    .map((call) => call[0] as { type: string; [k: string]: unknown })
    .filter((d) => d.type === type)

let postMessage_: MockInstance<typeof window.postMessage>

beforeAll(() => {
  const boot = /<script data-v-boot>([\s\S]*)<\/script>/.exec(FRAME_BOOTSTRAP)?.[1]
  if (!boot) throw new Error('bootstrap script not found')
  new Function(boot)()
})

beforeEach(() => {
  document.body.innerHTML = ''
  /* the next-frame callbacks run at once, so an arrival is settled by the time a test looks */
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  postMessage_ = vi.spyOn(window, 'postMessage')
})

afterEach(() => {
  mode(false)
  vi.unstubAllGlobals()
  postMessage_.mockRestore()
  delete (document as { startViewTransition?: unknown }).startViewTransition
  delete (root() as { animate?: unknown }).animate
})

describe('prototype links', () => {
  it('posts doop:goto for a click inside a [data-goto] element while presenting', () => {
    mode(true)
    render(html('<a data-goto="screen-2"><span id="label">Next</span></a>'))
    click(document.getElementById('label')!)
    expect(sent('doop:goto')).toEqual([{ type: 'doop:goto', target: 'screen-2' }])
  })

  it('does not post it outside present mode, so a click on the canvas stays a selection', () => {
    render(html('<a data-goto="screen-2"><span id="label">Next</span></a>'))
    click(document.getElementById('label')!)
    expect(sent('doop:goto')).toEqual([])
  })

  it('stops following links once the presentation ends', () => {
    mode(true)
    mode(false)
    render(html('<button data-goto="x" id="b">Go</button>'))
    click(document.getElementById('b')!)
    expect(sent('doop:goto')).toEqual([])
  })

  it('swallows the click it follows, so a real link or button does not also act', () => {
    mode(true)
    render(html('<a data-goto="x" id="a" href="#elsewhere">Go</a>'))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.getElementById('a')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('shows a pointer over links while presenting and only then', () => {
    mode(true)
    expect(document.adoptedStyleSheets.length).toBeGreaterThan(0)
    mode(false)
    expect(
      document.adoptedStyleSheets.some((sheet) => String(sheet.cssRules?.[0]?.cssText ?? '').includes('data-goto')),
    ).toBe(false)
  })

  it('answers an ⌥-click probe with the target under the point, in or out of present mode', () => {
    render(html('<div data-goto="home"><b id="t">x</b></div><p id="plain">y</p>'))
    const original = document.elementFromPoint
    document.elementFromPoint = (x: number) => document.getElementById(x === 1 ? 't' : 'plain')
    try {
      post({ type: 'doop:goto-at', reqId: 7, x: 1, y: 1 })
      post({ type: 'doop:goto-at', reqId: 8, x: 2, y: 2 })
    } finally {
      document.elementFromPoint = original
    }
    expect(sent('doop:goto-result')).toEqual([
      { type: 'doop:goto-result', reqId: 7, target: 'home' },
      { type: 'doop:goto-result', reqId: 8, target: null },
    ])
  })
})

describe('the show keys and clicks', () => {
  it('relays the keys that run the show while presenting', () => {
    mode(true)
    key('ArrowRight')
    key('Backspace')
    key(' ')
    expect(sent('doop:key').map((m) => m.key)).toEqual(['ArrowRight', 'Backspace', ' '])
  })

  it('leaves keys typed into a field alone', () => {
    mode(true)
    render(html('<input id="name">'))
    key(' ', document.getElementById('name')!)
    expect(sent('doop:key')).toEqual([])
  })

  it('relays nothing when not presenting', () => {
    key('ArrowRight')
    expect(sent('doop:key')).toEqual([])
  })

  it('asks for the next slide on a click in a deck, but not on something that acts for itself', () => {
    mode(true, true)
    render(html('<p id="p">text</p><button id="b">Buy</button><a href="#x" id="l">link</a>'))
    click(document.getElementById('p')!)
    click(document.getElementById('b')!)
    click(document.getElementById('l')!)
    expect(sent('doop:advance')).toHaveLength(1)
  })

  it('does not advance on a click in a flow that is not a deck', () => {
    mode(true, false)
    render(html('<p id="p">text</p>'))
    click(document.getElementById('p')!)
    expect(sent('doop:advance')).toEqual([])
  })
})

describe('slides show markers', () => {
  it('sets data-sl-play for the whole show and data-sl-entered once the slide has arrived', () => {
    mode(true, true)
    render(html('<h1>One</h1>'))
    expect(root().hasAttribute('data-sl-play')).toBe(true)
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
  })

  it('leaves both off for a flow that is not a deck, and clears them when the show ends', () => {
    mode(true, false)
    render(html('<h1>One</h1>'))
    expect(root().hasAttribute('data-sl-play')).toBe(false)
    mode(true, true)
    mode(false)
    expect(root().hasAttribute('data-sl-play')).toBe(false)
    expect(root().hasAttribute('data-sl-entered')).toBe(false)
  })

  it('keeps the markers through a live edit of the slide on screen', () => {
    mode(true, true)
    render(html('<h1>One</h1>'))
    render(html('<h1>One, edited</h1>'))
    expect(document.querySelector('h1')?.textContent).toBe('One, edited')
    expect(root().hasAttribute('data-sl-play')).toBe(true)
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
  })

  it('takes data-sl-entered off inside the transition update and puts it back when the transition finishes', async () => {
    mode(true, true)
    render(html('<h1>One</h1>'))
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const seen: { before: boolean; inside: boolean; after: boolean }[] = []
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn((update: () => void) => {
      const before = root().hasAttribute('data-sl-entered')
      update()
      seen.push({ before, inside: root().hasAttribute('data-sl-entered'), after: false })
      return { finished }
    })
    render(html('<h1>Two</h1>'), true)
    expect(document.startViewTransition).toHaveBeenCalledOnce()
    expect(seen).toEqual([{ before: true, inside: false, after: false }])
    expect(document.querySelector('h1')?.textContent).toBe('Two')
    expect(root().hasAttribute('data-sl-entered')).toBe(false)
    finish()
    await finished
    await Promise.resolve()
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
    expect(root().hasAttribute('data-sl-play')).toBe(true)
  })

  it('also sets it again when the transition is skipped and its promise rejects', async () => {
    mode(true, true)
    render(html('<h1>One</h1>'))
    const finished = Promise.reject(new Error('skipped'))
    finished.catch(() => {})
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
      update()
      return { finished }
    }
    render(html('<h1>Two</h1>'), true)
    await finished.catch(() => {})
    await Promise.resolve()
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
  })

  it('does not run a transition when the frame is not being presented', () => {
    const start = vi.fn()
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = start
    render(html('<h1>Two</h1>'), true)
    expect(start).not.toHaveBeenCalled()
    expect(document.querySelector('h1')?.textContent).toBe('Two')
  })
})

describe('the swap without view transitions', () => {
  it('fades out, swaps, fades back in over 250 ms, and the slide arrives at the end', async () => {
    mode(true, true)
    render(html('<h1>One</h1>'))
    const finished = Promise.resolve()
    const animate = vi.fn(() => ({ finished, cancel: vi.fn() }))
    ;(root() as unknown as { animate: unknown }).animate = animate
    render(html('<h1>Two</h1>'), true)
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenLastCalledWith(
      [{ opacity: 1 }, { opacity: 0 }],
      expect.objectContaining({ duration: 125 }),
    )
    await finished
    await Promise.resolve()
    expect(document.querySelector('h1')?.textContent).toBe('Two')
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenLastCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: 125 }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
  })

  it('swaps at once where the document cannot animate', () => {
    Object.defineProperty(root(), 'animate', { value: undefined, configurable: true })
    mode(true, true)
    render(html('<h1>One</h1>'))
    render(html('<h1>Two</h1>'), true)
    expect(document.querySelector('h1')?.textContent).toBe('Two')
    expect(root().hasAttribute('data-sl-entered')).toBe(true)
  })
})
