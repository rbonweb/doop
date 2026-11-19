import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { extractComponentCss, frameStylesheets, frameSheets, sheetFor } from '../server/componentCss.ts'
import { SCOPE_MARK } from '../server/frameIsolation.ts'
import { COMPONENT_ATTR, SOURCE_CSS_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

function mainOf(html: string, id: string): Tree.Element {
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.attrs.some((attr) => attr.name === COMPONENT_ATTR && attr.value === id)) return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no main')
}

/* Two mains in one frame, each with a source block of its own, as a server before source-block isolation read them:
   each definition was extracted from a sheet that held the other's source rules too. */
describe('a frame with two mains and their source blocks, stored by the code before isolation of source blocks', () => {
  let canvasId = ''
  let frameId = ''
  let ids: [string, string] = ['', '']

  beforeEach(() => {
    const canvas = store.createCanvas('legacy-sources')
    canvasId = canvas.id
    const a = blankComponent({ name: 'Alpha', by: 'Tester' })
    const b = blankComponent({ name: 'Beta', by: 'Tester' })
    ids = [a.id, b.id]
    store.saveComponent(canvasId, a)
    store.saveComponent(canvasId, b)
    const frame = actions.createFrame(canvasId, { name: 'Both', html: '' }, actor)!
    frameId = frame.id
    const html = `<!doctype html><html><head>
<style>.card { color: #111 }</style>
<style ${SOURCE_CSS_ATTR}="${a.id}">.card { padding: 1px }</style>
<style ${SOURCE_CSS_ATTR}="${b.id}">.card { margin: 2px }</style>
</head><body>
<div class="card" ${COMPONENT_ATTR}="${a.id}"><span data-doop-prop="t">A</span></div>
<div class="card" ${COMPONENT_ATTR}="${b.id}"><span data-doop-prop="t">B</span></div>
</body></html>`
    actions.updateFrame(frameId, { html }, actor)
  })

  const def = (id: string) => store.getComponents(canvasId).find((candidate) => candidate.id === id)!

  it('the isolating form keeps one main out of the other', () => {
    expect(def(ids[0]).css).toContain('padding: 1px')
    expect(def(ids[0]).css).not.toContain('margin: 2px')
    expect(def(ids[1]).css).toContain('margin: 2px')
    expect(def(ids[1]).css).not.toContain('padding: 1px')
    const sheets = frameSheets(store.getFrame(frameId)!.html)
    expect(sheetFor(sheets, ids[0])).not.toContain('margin: 2px')
    expect(frameStylesheets(store.getFrame(frameId)!.html)).toContain('margin: 2px')
  })

  it('re-saves byte-identical, with no new revision and no propagation, until a main changes', () => {
    const html = store.getFrame(frameId)!.html
    const everything = frameStylesheets(html)
    /* what the base code stored: each extraction read the whole frame's sheet */
    for (const id of ids) {
      const stored = def(id)
      const legacy = extractComponentCss(everything, mainOf(html, id), id, [], { legacy: true })
      expect(legacy.css).not.toContain(SCOPE_MARK)
      store.saveComponent(canvasId, { ...stored, rev: 1, css: legacy.css, rawCss: legacy.rawCss })
    }
    expect(def(ids[0]).css).toContain('margin: 2px')
    const before = ids.map((id) => ({ rev: def(id).rev, css: def(id).css, rawCss: def(id).rawCss }))
    actions.updateFrame(frameId, { html }, actor)
    expect(store.getFrame(frameId)!.html).toBe(html)
    ids.forEach((id, at) => {
      expect({ rev: def(id).rev, css: def(id).css, rawCss: def(id).rawCss }).toEqual(before[at])
      expect(actions.propagationPending(canvasId, id)).toBe(false)
    })
  })
})
