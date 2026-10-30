// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetCameraActivity, setStageSize, useFrameSleep } from '../src/lib/frameSleep'
import { useStore } from '../src/lib/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const farAway = { id: 'f', x: 9000, y: 9000, width: 400, height: 300 }
const postMessage = vi.fn()
const iframeRef = { current: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement }

function Probe({ ready }: { ready: boolean }) {
  useFrameSleep(iframeRef, { frame: farAway, ready, editing: false, working: false })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  postMessage.mockClear()
  useStore.setState({ viewport: { x: 0, y: 0, zoom: 1 }, selectedIds: [], streams: {}, presenting: false })
  setStageSize(1000, 800)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetCameraActivity()
})

it('puts a sleeping frame back to sleep when its remounted document becomes ready', () => {
  act(() => root.render(createElement(Probe, { ready: true })))
  expect(postMessage).toHaveBeenCalledTimes(1)
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'doop:sleep', on: true }, '*')

  /* the iframe remounts: the old document is gone and the new one starts awake */
  act(() => root.render(createElement(Probe, { ready: false })))
  expect(postMessage).toHaveBeenCalledTimes(1)
  act(() => root.render(createElement(Probe, { ready: true })))
  expect(postMessage).toHaveBeenCalledTimes(2)
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'doop:sleep', on: true }, '*')
})
