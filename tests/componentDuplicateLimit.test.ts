import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveToken: () => {},
  deleteToken: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { duplicateComponent } from '../server/componentActions.ts'
import { COMPONENT_ATTR, MAX_COMPONENTS } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

describe('duplicate_component at the canvas limit', () => {
  it('refuses a copy once the canvas holds MAX_COMPONENTS and changes nothing', () => {
    const canvasId = store.createCanvas('full').id
    const first = blankComponent({ name: 'C0', by: 'Tester' })
    store.saveComponent(canvasId, first)
    const frame = actions.createFrame(canvasId, { name: 'C0 main', html: '' }, actor)!
    actions.updateFrame(
      frame.id,
      { html: `<!doctype html><html><body><b ${COMPONENT_ATTR}="${first.id}">x</b></body></html>` },
      actor,
    )
    for (let i = 1; i < MAX_COMPONENTS; i++)
      store.saveComponent(canvasId, blankComponent({ name: `C${i}`, by: 'Tester' }))
    expect(store.getComponents(canvasId)).toHaveLength(MAX_COMPONENTS)
    expect(() => duplicateComponent(canvasId, first.id, actor)).toThrow(`at most ${MAX_COMPONENTS} components`)
    expect(store.getComponents(canvasId)).toHaveLength(MAX_COMPONENTS)
  })
})
