import { afterEach, describe, expect, it } from 'vitest'
import type { Canvas } from '../shared/types'
import { canCommentNow, canEditNow } from '../src/lib/role'
import { canCommentOpenCanvas, canEditOpenCanvas, roleOf, useStore } from '../src/lib/store'

/* One rule decides what the UI offers: `roleOf` in the store. `useCanEdit` / `useCanComment`, `canEditNow` and
   `canEditOpenCanvas` all read it, so a panel on one helper never disagrees with a panel on the other. */
const canvas = (role?: Canvas['role']): Canvas => ({
  id: 'c1',
  name: 'Canvas',
  frames: [],
  createdAt: 0,
  updatedAt: 0,
  role,
})

afterEach(() => useStore.getState().setCanvas(null))

describe('the one role rule', () => {
  it.each([
    ['view', false, false],
    ['comment', false, true],
    ['edit', true, true],
    ['owner', true, true],
  ] as const)('%s: edit %s, comment %s, on every helper', (role, edit, comment) => {
    useStore.getState().setCanvas(canvas())
    useStore.getState().setRole(role)
    const s = useStore.getState()
    expect([canEditOpenCanvas(s), canEditNow()]).toEqual([edit, edit])
    expect([canCommentOpenCanvas(s), canCommentNow()]).toEqual([comment, comment])
  })

  it('reads the role the room put on the canvas copy before the store role is set', () => {
    useStore.getState().setCanvas(canvas('view'))
    expect(useStore.getState().role).toBeNull()
    expect(roleOf(useStore.getState())).toBe('view')
    expect(canEditNow()).toBe(false)
    expect(canCommentNow()).toBe(false)
  })

  it('a role that was handed over wins and follows later changes', () => {
    useStore.getState().setCanvas(canvas('edit'))
    useStore.getState().setRole('view')
    expect(canEditNow()).toBe(false)
    expect(useStore.getState().canvas?.role).toBe('view')
    useStore.getState().setRole('owner')
    expect(canEditNow()).toBe(true)
  })

  it('leaving a canvas clears the role, so the next one never starts on the last one', () => {
    useStore.getState().setCanvas(canvas())
    useStore.getState().setRole('view')
    useStore.getState().setCanvas(null)
    expect(useStore.getState().role).toBeNull()
    useStore.getState().setCanvas(canvas('view'))
    expect(canEditNow()).toBe(false)
  })

  it('a server that sends no role at all leaves the open canvas editable (the server still refuses writes)', () => {
    useStore.getState().setCanvas(canvas())
    expect(canEditNow()).toBe(true)
  })
})
