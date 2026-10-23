// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

/* The sleep half of the frame runtime, driven the way FrameView drives it: doop:sleep and doop:html messages from the parent. happy-dom has no Web Animations, so document.getAnimations is stubbed with objects shaped like the ones the browser hands out. */

function post(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}
const sleep = (on: boolean) => post({ type: 'doop:sleep', on })
const render = (html: string) => post({ type: 'doop:html', html })

const sleepStyles = () => document.head.querySelectorAll('style#doop-sleep')

interface FakeAnimation {
  playState: 'running' | 'paused' | 'finished'
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
}

function fakeAnimation(playState: FakeAnimation['playState']): FakeAnimation {
  const a: FakeAnimation = {
    playState,
    pause: vi.fn(() => {
      a.playState = 'paused'
    }),
    play: vi.fn(() => {
      a.playState = 'running'
    }),
  }
  return a
}

function fakeVideo(playing: boolean) {
  const v = document.createElement('video')
  let paused = !playing
  Object.defineProperty(v, 'paused', { get: () => paused })
  Object.defineProperty(v, 'ended', { get: () => false })
  v.pause = vi.fn(() => {
    paused = true
  })
  v.play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  })
  return v
}

let animations: FakeAnimation[] = []
const getAnimations = vi.fn(() => animations)

beforeAll(() => {
  const boot = /<script data-v-boot>([\s\S]*)<\/script>/.exec(FRAME_BOOTSTRAP)?.[1]
  if (!boot) throw new Error('bootstrap script not found')
  new Function(boot)()
  Object.defineProperty(document, 'getAnimations', { value: getAnimations, configurable: true })
})

beforeEach(() => {
  animations = []
  getAnimations.mockClear()
  document.body.innerHTML = ''
})

afterEach(() => {
  sleep(false)
})

describe('frame runtime sleep', () => {
  it('adds the sleep style on sleep and removes it on wake', () => {
    sleep(true)
    const style = document.getElementById('doop-sleep')
    expect(style?.tagName).toBe('STYLE')
    expect(style?.textContent).toContain('animation-play-state:paused!important')
    sleep(false)
    expect(document.getElementById('doop-sleep')).toBeNull()
  })

  it('is idempotent for repeated messages', () => {
    animations = [fakeAnimation('running')]
    sleep(true)
    sleep(true)
    expect(sleepStyles()).toHaveLength(1)
    expect(animations[0]?.pause).toHaveBeenCalledTimes(1)
    sleep(false)
    sleep(false)
    expect(animations[0]?.play).toHaveBeenCalledTimes(1)
    expect(sleepStyles()).toHaveLength(0)
  })

  it('resumes only the animations it paused itself', () => {
    const running = fakeAnimation('running')
    const alreadyPaused = fakeAnimation('paused')
    const finished = fakeAnimation('finished')
    animations = [running, alreadyPaused, finished]
    sleep(true)
    expect(running.pause).toHaveBeenCalled()
    expect(alreadyPaused.pause).not.toHaveBeenCalled()
    expect(finished.pause).not.toHaveBeenCalled()
    sleep(false)
    expect(running.play).toHaveBeenCalledTimes(1)
    expect(alreadyPaused.play).not.toHaveBeenCalled()
    expect(finished.play).not.toHaveBeenCalled()
  })

  it('resumes only the videos it paused itself', () => {
    const playing = fakeVideo(true)
    const stopped = fakeVideo(false)
    document.body.append(playing, stopped)
    sleep(true)
    expect(playing.pause).toHaveBeenCalledTimes(1)
    expect(stopped.pause).not.toHaveBeenCalled()
    sleep(false)
    expect(playing.play).toHaveBeenCalledTimes(1)
    expect(stopped.play).not.toHaveBeenCalled()
  })

  it('switches transitions off for the duration of the toggle and puts everything back', () => {
    const root = document.documentElement
    root.style.setProperty('transition-property', 'opacity')
    const seen: { root: string; guard: boolean }[] = []
    const record = () => {
      seen.push({
        root: root.style.getPropertyValue('transition-property'),
        guard: !!document.head.querySelector('style[data-v-still]'),
      })
      return [] as FakeAnimation[]
    }
    getAnimations.mockImplementationOnce(record)

    sleep(true)
    expect(seen).toEqual([{ root: 'none', guard: true }])
    expect(root.style.getPropertyValue('transition-property')).toBe('opacity')
    expect(document.head.querySelector('style[data-v-still]')).toBeNull()

    sleep(false)
    expect(root.style.getPropertyValue('transition-property')).toBe('opacity')
    expect(document.head.querySelector('style[data-v-still]')).toBeNull()
    root.style.removeProperty('transition-property')
  })

  it('leaves no style attribute behind on the root', () => {
    document.documentElement.removeAttribute('style')
    sleep(true)
    sleep(false)
    expect(document.documentElement.hasAttribute('style')).toBe(false)
  })

  it('keeps the sleep style through a new document morphed in while asleep', () => {
    render('<!doctype html><html><head><style>.a{color:red}</style></head><body><p>one</p></body></html>')
    sleep(true)
    render(
      '<!doctype html><html><head><style>.a{color:red}</style><style>.b{color:blue}</style></head><body><p>two</p></body></html>',
    )
    expect(document.body.textContent).toBe('two')
    expect(sleepStyles()).toHaveLength(1)
    expect(document.getElementById('doop-sleep')?.textContent).toContain('animation-play-state:paused!important')
    /* the design's own styles survive intact beside it */
    expect([...document.head.querySelectorAll('style:not(#doop-sleep)')].map((s) => s.textContent)).toEqual([
      '.a{color:red}',
      '.b{color:blue}',
    ])
    sleep(false)
    expect(sleepStyles()).toHaveLength(0)
  })

  it('does not add the sleep style on a morph while awake', () => {
    render('<!doctype html><html><head></head><body><p>awake</p></body></html>')
    expect(sleepStyles()).toHaveLength(0)
  })
})
