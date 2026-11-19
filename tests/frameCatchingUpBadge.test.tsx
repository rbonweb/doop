// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FrameCatchingUpBadge } from '../src/components/FrameCatchingUpBadge'
import { useStore } from '../src/lib/store'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  useStore.getState().setCatchingUp([])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const badge = () => container.querySelector('[data-frame-catching-up]')

it('shows on a frame the room says is catching up, and goes when it is visited', async () => {
  await act(async () => root.render(<FrameCatchingUpBadge frameId="f1" />))
  expect(badge()).toBeNull()

  await act(async () => useStore.getState().setCatchingUp(['f1', 'f2']))
  expect(badge()?.textContent).toBe('Catching up')

  await act(async () => useStore.getState().updateCatchingUp([], ['f1']))
  expect(badge()).toBeNull()
})

it('ignores frames that are not waiting, and follows added ids', async () => {
  await act(async () => root.render(<FrameCatchingUpBadge frameId="f3" />))
  await act(async () => useStore.getState().setCatchingUp(['other']))
  expect(badge()).toBeNull()
  await act(async () => useStore.getState().updateCatchingUp(['f3'], []))
  expect(badge()).not.toBeNull()
})
