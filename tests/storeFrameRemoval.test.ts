import { beforeEach, expect, it } from 'vitest'
import type { Canvas, ElementComment } from '../shared/types'
import { useStore } from '../src/lib/store'

const comment = (id: string, frameId?: string): ElementComment => ({
  id,
  canvasId: 'c',
  frameId,
  from: 'Ada',
  text: id,
  at: 1,
  selector: frameId ? 'p' : '',
  snippet: '',
})

beforeEach(() => {
  useStore.setState({
    canvas: { id: 'c', frames: [{ id: 'a' }, { id: 'b' }], notes: [] } as unknown as Canvas,
    comments: [comment('on-a', 'a'), comment('on-a-reply', 'a'), comment('on-b', 'b'), comment('free')],
  })
})

it('drops the comment threads of a frame that is removed, and keeps everyone else', () => {
  useStore.getState().removeFrame('a')
  expect(useStore.getState().comments.map((c) => c.id)).toEqual(['on-b', 'free'])
})

it('leaves the comment list untouched when the removed frame had none', () => {
  const before = useStore.getState().comments
  useStore.getState().removeFrame('nope')
  expect(useStore.getState().comments).toBe(before)
})
