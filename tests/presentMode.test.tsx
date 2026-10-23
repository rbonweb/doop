// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { PresentMode } from '../src/components/PresentMode'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const downloadDeckPdf = vi.fn()
vi.mock('../src/lib/deckExport', () => ({
  downloadDeckPdf: (...args: unknown[]) => downloadDeckPdf(...args),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function frame(id: string, x: number, y: number, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c1',
    name: `Frame ${id}`,
    x,
    y,
    width: 400,
    height: 300,
    html: `<h1>${id}</h1>`,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
    ...extra,
  }
}

function canvasOf(frames: Frame[]): Canvas {
  return { id: 'c1', name: 'Flow', createdAt: 0, updatedAt: 0, frames }
}

let container: HTMLDivElement
let root: Root
let onClose: Mock<() => void>
let posted: { data: Record<string, unknown> }[]

const iframe = () => container.querySelector('iframe') as HTMLIFrameElement

/* happy-dom does not give a srcdoc iframe a window, so the iframe gets a stand-in that records what the show posts to it */
function fakeWindow() {
  const win = { postMessage: vi.fn((data: Record<string, unknown>) => posted.push({ data })) }
  Object.defineProperty(iframe(), 'contentWindow', { value: win, configurable: true })
  return win
}

async function fromFrame(win: object, data: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: win as MessageEventSource }))
  })
}

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function mount(frames: Frame[], startId: string) {
  useStore.setState({ canvas: canvasOf(frames) })
  await act(async () => {
    root.render(<PresentMode startId={startId} onClose={onClose} />)
  })
  const win = fakeWindow()
  await fromFrame(win, { type: 'doop:frame-ready' })
  return win
}

const htmlPosts = () => posted.map((p) => p.data).filter((d) => d.type === 'doop:html')
const lastHtml = () => htmlPosts().at(-1)
const modePosts = () => posted.map((p) => p.data).filter((d) => d.type === 'doop:mode')
const title = () => container.querySelector('[role="dialog"]')?.getAttribute('aria-label')

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onClose = vi.fn<() => void>()
  posted = []
  downloadDeckPdf.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  useStore.setState({ canvas: null })
})

const FLOW = () => [
  frame('a', 0, 0),
  frame('b', 500, 0, { html: '<button data-goto="c">Next</button>' }),
  frame('c', 1000, 0),
  frame('d', 0, 400),
]

describe('walking a flow', () => {
  it('opens on the start frame and tells the frame it is being presented', async () => {
    await mount(FLOW(), 'b')
    expect(title()).toBe('Presenting Frame b')
    expect(modePosts()).toEqual([{ type: 'doop:mode', present: true, slides: false }])
    expect(lastHtml()).toEqual({ type: 'doop:html', html: '<button data-goto="c">Next</button>' })
    expect(container.textContent).toContain('2 / 4')
  })

  it('steps through the page in reading order, swapping the one iframe through a transition', async () => {
    await mount(FLOW(), 'a')
    await press('ArrowRight')
    expect(title()).toBe('Presenting Frame b')
    expect(lastHtml()).toMatchObject({ html: '<button data-goto="c">Next</button>', transition: true })
    await press('ArrowRight')
    await press('ArrowRight')
    expect(title()).toBe('Presenting Frame d')
    /* the end of the page: another step stays put */
    await press('ArrowRight')
    expect(title()).toBe('Presenting Frame d')
    await press('ArrowLeft')
    expect(title()).toBe('Presenting Frame c')
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('jumps on a link, keeps a history, and Backspace pops it', async () => {
    const win = await mount(FLOW(), 'b')
    await fromFrame(win, { type: 'doop:goto', target: 'c' })
    expect(title()).toBe('Presenting Frame c')
    await fromFrame(win, { type: 'doop:goto', target: 'Frame a' })
    expect(title()).toBe('Presenting Frame a')
    await press('Backspace')
    expect(title()).toBe('Presenting Frame c')
    await press('Backspace')
    expect(title()).toBe('Presenting Frame b')
    await press('Backspace')
    expect(title()).toBe('Presenting Frame b')
  })

  it('says so when a link points at nothing, and stays on the frame', async () => {
    const win = await mount(FLOW(), 'b')
    await fromFrame(win, { type: 'doop:goto', target: 'ghost' })
    expect(title()).toBe('Presenting Frame b')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('ghost')
  })

  it('takes keys the frame relays when focus is inside it', async () => {
    const win = await mount(FLOW(), 'a')
    await fromFrame(win, { type: 'doop:key', key: 'ArrowRight' })
    expect(title()).toBe('Presenting Frame b')
    await fromFrame(win, { type: 'doop:key', key: 'Backspace' })
    /* no link was followed, so there is nothing to go back to */
    expect(title()).toBe('Presenting Frame b')
  })

  it('ignores messages from anything but its own frame', async () => {
    await mount(FLOW(), 'a')
    await fromFrame({ other: true }, { type: 'doop:goto', target: 'c' })
    expect(title()).toBe('Presenting Frame a')
  })

  it('does not treat Space as a step outside a deck', async () => {
    await mount(FLOW(), 'a')
    await press(' ')
    expect(title()).toBe('Presenting Frame a')
  })

  it('closes on Esc, and from the toolbar', async () => {
    await mount(FLOW(), 'a')
    await press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => {
      ;(container.querySelector('[aria-label="Exit presentation"]') as HTMLElement).click()
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('steps back to where a link left from when the frame on screen is deleted, and ends when there is no way back', async () => {
    const win = await mount(FLOW(), 'b')
    await fromFrame(win, { type: 'doop:goto', target: 'c' })
    await act(async () => {
      useStore.setState({ canvas: canvasOf(FLOW().filter((f) => f.id !== 'c')) })
    })
    expect(title()).toBe('Presenting Frame b')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      useStore.setState({ canvas: canvasOf(FLOW().filter((f) => f.id !== 'c' && f.id !== 'b')) })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps showing a live edit of the frame on screen without a transition', async () => {
    await mount(FLOW(), 'a')
    await act(async () => {
      useStore.setState({ canvas: canvasOf(FLOW().map((f) => (f.id === 'a' ? { ...f, html: '<h1>edited</h1>' } : f))) })
    })
    expect(lastHtml()).toEqual({ type: 'doop:html', html: '<h1>edited</h1>' })
  })
})

describe('the toolbar', () => {
  it('goes away after two seconds without the pointer moving, and returns on movement', async () => {
    vi.useFakeTimers()
    await mount(FLOW(), 'a')
    const bar = () => container.querySelector('[role="toolbar"]') as HTMLElement
    expect(bar().className).toContain('opacity-100')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1900)
    })
    expect(bar().className).toContain('opacity-100')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(bar().className).toContain('opacity-0')
    await act(async () => {
      window.dispatchEvent(new Event('pointermove'))
    })
    expect(bar().className).toContain('opacity-100')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(bar().className).toContain('opacity-0')
  })

  it('treats the pointer moving inside the frame as movement', async () => {
    vi.useFakeTimers()
    const win = await mount(FLOW(), 'a')
    const bar = () => container.querySelector('[role="toolbar"]') as HTMLElement
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(bar().className).toContain('opacity-0')
    await fromFrame(win, { type: 'doop:pointer' })
    expect(bar().className).toContain('opacity-100')
  })

  it('shows the position and offers the Back button only after a link was followed', async () => {
    const win = await mount(FLOW(), 'b')
    expect(container.querySelector('[aria-label="Back to the previous screen"]')).toBeNull()
    await fromFrame(win, { type: 'doop:goto', target: 'c' })
    expect(container.querySelector('[aria-label="Position"]')?.textContent).toBe('3 / 4')
    expect(container.querySelector('[aria-label="Back to the previous screen"]')).not.toBeNull()
  })
})

describe('a deck', () => {
  const DECK = () => [
    frame('s2', 500, 0, { slide: true, speakerNotes: 'Say the second thing' }),
    frame('note', 250, 0),
    frame('s1', 0, 0, { slide: true, speakerNotes: 'Open with the story' }),
    frame('s3', 1000, 0, { slide: true }),
  ]

  it('plays only the slides, tells the frame it is a deck, and advances on Space and on a click', async () => {
    const win = await mount(DECK(), 's1')
    expect(modePosts()).toEqual([{ type: 'doop:mode', present: true, slides: true }])
    expect(container.textContent).toContain('1 / 3')
    await press(' ')
    expect(title()).toBe('Presenting Frame s2')
    await fromFrame(win, { type: 'doop:advance' })
    expect(title()).toBe('Presenting Frame s3')
    await press('ArrowRight')
    expect(title()).toBe('Presenting Frame s3')
    await press('ArrowLeft')
    await press('ArrowLeft')
    expect(title()).toBe('Presenting Frame s1')
  })

  it('opens the presenter strip with s: the notes, the next slide, the slide number', async () => {
    await mount(DECK(), 's1')
    expect(container.querySelector('[aria-label="Presenter view"][role="region"]')).toBeNull()
    await press('s')
    const strip = container.querySelector('[role="region"][aria-label="Presenter view"]')!
    expect(strip.textContent).toContain('Open with the story')
    expect(strip.textContent).toContain('Slide 1 / 3')
    expect(strip.querySelectorAll('iframe')).toHaveLength(1)
    await press(' ')
    expect(container.querySelector('[role="region"][aria-label="Presenter view"]')!.textContent).toContain(
      'Say the second thing',
    )
    await press('s')
    expect(container.querySelector('[role="region"][aria-label="Presenter view"]')).toBeNull()
  })

  it('says when a slide has no notes and when the deck ends', async () => {
    await mount(DECK(), 's3')
    await press('s')
    const strip = container.querySelector('[role="region"][aria-label="Presenter view"]')!
    expect(strip.textContent).toContain('No notes for this slide.')
    expect(strip.textContent).toContain('End of the deck')
  })

  it('keeps s for the page when the frame is not a slide', async () => {
    await mount(FLOW(), 'a')
    await press('s')
    expect(container.querySelector('[role="region"][aria-label="Presenter view"]')).toBeNull()
    expect(container.querySelector('[aria-label="Export deck as PDF"]')).toBeNull()
  })

  it('exports the deck from the toolbar', async () => {
    await mount(DECK(), 's1')
    await act(async () => {
      ;(container.querySelector('[aria-label="Export deck as PDF"]') as HTMLElement).click()
    })
    expect(downloadDeckPdf).toHaveBeenCalledWith('c1', expect.any(String), expect.any(String), 3)
  })

  it('opens the presenter window and closes the strip, saying so when the browser blocks it', async () => {
    await mount(DECK(), 's1')
    await press('s')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await act(async () => {
      ;(container.querySelector('[aria-label="Open presenter window"]') as HTMLElement).click()
    })
    expect(open).toHaveBeenCalledWith('/c/c1?presenter=1', 'doop-presenter', expect.stringContaining('popup'))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('blocked')
    open.mockReturnValue({} as Window)
    await act(async () => {
      ;(container.querySelector('[aria-label="Open presenter window"]') as HTMLElement).click()
    })
    expect(container.querySelector('[role="region"][aria-label="Presenter view"]')).toBeNull()
    open.mockRestore()
  })
})

describe('the presenter window link', () => {
  it('announces the show on the canvas channel, answers hello, and obeys steps from the other window', async () => {
    const instances: {
      name: string
      sent: unknown[]
      onmessage: ((ev: MessageEvent) => void) | null
      closed: boolean
    }[] = []
    class FakeChannel {
      name: string
      sent: unknown[] = []
      onmessage: ((ev: MessageEvent) => void) | null = null
      closed = false
      constructor(name: string) {
        this.name = name
        instances.push(this)
      }
      postMessage(data: unknown) {
        this.sent.push(data)
      }
      close() {
        this.closed = true
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    try {
      await mount(
        [
          frame('s1', 0, 0, { slide: true }),
          frame('s2', 500, 0, { slide: true }),
          frame('s3', 1000, 0, { slide: true }),
        ],
        's1',
      )
      const channel = instances[0]!
      expect(channel.name).toBe('doop-present-c1')
      expect(channel.sent.at(-1)).toMatchObject({ type: 'state', frameId: 's1', index: 1, total: 3, nextId: 's2' })

      await act(async () => channel.onmessage?.({ data: { type: 'command', command: 'next' } } as MessageEvent))
      expect(title()).toBe('Presenting Frame s2')
      expect(channel.sent.at(-1)).toMatchObject({ type: 'state', frameId: 's2', index: 2, nextId: 's3' })

      channel.sent.length = 0
      await act(async () => channel.onmessage?.({ data: { type: 'hello' } } as MessageEvent))
      expect(channel.sent).toEqual([expect.objectContaining({ type: 'state', frameId: 's2' })])

      await act(async () => channel.onmessage?.({ data: { type: 'command', command: 'bogus' } } as MessageEvent))
      expect(title()).toBe('Presenting Frame s2')

      act(() => root.unmount())
      expect(channel.sent.at(-1)).toEqual({ type: 'end' })
      expect(channel.closed).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      root = createRoot(container)
    }
  })
})

describe('every role may present', () => {
  const DECK = () => [
    frame('s1', 0, 0, { slide: true, speakerNotes: 'Open with the story' }),
    frame('s2', 500, 0, { slide: true }),
  ]

  afterEach(() => useStore.setState({ role: null, guest: false }))

  it.each([
    ['view', false],
    ['comment', false],
    ['edit', false],
    ['owner', false],
    ['comment', true],
    ['view', true],
  ] as const)('walks the deck and reads the notes, never editing them, as %s (guest: %s)', async (role, guest) => {
    useStore.setState({ role, guest })
    await mount(DECK(), 's1')
    await press('s')
    const strip = container.querySelector('[role="region"][aria-label="Presenter view"]')!
    expect(strip.textContent).toContain('Open with the story')
    expect(strip.querySelector('textarea, input, [contenteditable]')).toBeNull()
    await press(' ')
    expect(title()).toBe('Presenting Frame s2')
    expect(container.querySelector('[aria-label="Open presenter window"]')).not.toBeNull()
    /* the deck PDF is a signed-in route: a guest is not offered a button that would be turned down */
    expect(container.querySelector('[aria-label="Export deck as PDF"]') !== null).toBe(!guest)
  })
})

describe('the show stays dark in both themes', () => {
  const DECK = () => [
    frame('s1', 0, 0, { slide: true, speakerNotes: '**Open** with the story\n\n- one\n- two' }),
    frame('s2', 500, 0, { slide: true }),
  ]
  /* ink and paper swap sides in the dark theme, so none of them may colour the show's own chrome */
  const THEMED =
    /^(?:[a-z-]+:)*(?:bg|text|border|ring|divide|from|to|via|fill|stroke)-(?:ink|paper)(?:-[a-z]+)?(?:\/\d+)?$/

  afterEach(() => document.documentElement.classList.remove('dark'))

  it.each(['light', 'dark'])('has a fixed near-black ground and white chrome in the %s theme', async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    await mount(DECK(), 's1')
    await press('s')
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.classList).toContain('bg-[#0b0b0d]')
    expect(dialog.classList).toContain('show-dark')
    expect(container.querySelector('[role="region"][aria-label="Presenter view"]')!.classList).toContain('bg-[#0b0b0d]')
    expect(container.querySelector('[role="toolbar"]')!.className).toContain('text-white')
    /* the speaker notes' markdown reads the ink tokens, which .show-dark pins light; the chrome reads none */
    const outsideNotes = [dialog, ...dialog.querySelectorAll('[class]')]
      .filter((el) => !el.closest('[aria-label="Speaker notes"]'))
      .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
      .filter((token) => THEMED.test(token))
    expect(outsideNotes).toEqual([])
  })
})
