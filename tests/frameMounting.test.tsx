// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { framesToMount, resetFrameMounts, useFrameMounted, useFrameMountScheduler } from '../src/lib/frameMounting'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEW = { width: 1000, height: 800 }

function frame(id: string, x: number, y: number, width = 400, height = 300): Frame {
  return { id, canvasId: 'c1', name: id, x, y, width, height, html: '', createdAt: 0, updatedAt: 0, updatedBy: 'me' }
}

describe('framesToMount', () => {
  const frames = [frame('far', 9000, 9000), frame('edge', 1300, 100), frame('centre', 300, 250), frame('corner', 0, 0)]

  it('picks frames on or near the viewport, nearest the centre first', () => {
    expect(framesToMount(frames, { x: 0, y: 0, zoom: 1 }, VIEW, new Set())).toEqual(['centre', 'corner', 'edge'])
  })

  it('leaves out frames already mounted', () => {
    expect(framesToMount(frames, { x: 0, y: 0, zoom: 1 }, VIEW, new Set(['centre']))).toEqual(['corner', 'edge'])
  })

  it('follows the viewport and its zoom', () => {
    /* panned so the far frame sits in view */
    expect(framesToMount(frames, { x: -8800, y: -8800, zoom: 1 }, VIEW, new Set())).toEqual(['far'])
    /* zoomed far out, everything is near */
    expect(framesToMount(frames, { x: 0, y: 0, zoom: 0.05 }, VIEW, new Set())).toHaveLength(4)
  })
})

describe('the mount scheduler', () => {
  let container: HTMLDivElement
  let root: Root

  function Stage() {
    const ref = useRef<HTMLDivElement>(null)
    useFrameMountScheduler(ref)
    return <div ref={ref} />
  }

  function Probe({ id }: { id: string }) {
    return <span data-id={id}>{useFrameMounted(id) ? 'mounted' : 'waiting'}</span>
  }

  const state = () =>
    Object.fromEntries(Array.from(container.querySelectorAll('span'), (el) => [el.dataset.id, el.textContent]))

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    })
    resetFrameMounts()
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VIEW.width })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEW.height })
    const frames = [frame('a', 300, 250), frame('b', 0, 0), frame('far', 9000, 9000)]
    useStore.setState({
      canvas: { id: 'c1', name: 'C', frames } as unknown as Canvas,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('mounts near frames one per step, nearest first, and never the far one', async () => {
    act(() =>
      root.render(
        <>
          <Stage />
          <Probe id="a" />
          <Probe id="b" />
          <Probe id="far" />
        </>,
      ),
    )
    expect(state()).toEqual({ a: 'mounted', b: 'waiting', far: 'waiting' })
    await advance(50)
    expect(state()).toEqual({ a: 'mounted', b: 'mounted', far: 'waiting' })
    await advance(1000)
    expect(state().far).toBe('waiting')
  })

  it('mounts frames the viewport moves to, and keeps the ones it left', async () => {
    act(() =>
      root.render(
        <>
          <Stage />
          <Probe id="a" />
          <Probe id="b" />
          <Probe id="far" />
        </>,
      ),
    )
    await advance(50)
    act(() => useStore.setState({ viewport: { x: -8800, y: -8800, zoom: 1 } }))
    await advance(200)
    expect(state()).toEqual({ a: 'mounted', b: 'mounted', far: 'mounted' })
  })

  it('holds off mounting while the viewport keeps moving, then settles once it stops', async () => {
    act(() =>
      root.render(
        <>
          <Stage />
          <Probe id="a" />
          <Probe id="b" />
          <Probe id="far" />
        </>,
      ),
    )
    await advance(50)
    /* a gesture: the camera reaches the far frame but keeps moving every 100 ms */
    for (let i = 0; i < 6; i++) {
      act(() => useStore.setState({ viewport: { x: -8800 - i, y: -8800, zoom: 1 } }))
      await advance(100)
    }
    expect(state().far).toBe('waiting')
    await advance(200)
    expect(state().far).toBe('mounted')
  })
})
