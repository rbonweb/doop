import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { blankComponent, contextFor } from '../server/components.ts'
import { compactDocument, expandUses, partsOf } from '../server/componentEngine.ts'
import { changeInstances, updateComponent } from '../server/componentActions.ts'
import { COMPONENT_ATTR, type ComponentProp } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('swapping a nested component on one instance', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('swap').id
  })

  function makeComponent(name: string, markup: (id: string) => string, props: ComponentProp[] = []) {
    const def = blankComponent({ name, by: 'Tester', props })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return { id: def.id, frame, def: () => store.getComponents(canvasId).find((candidate) => candidate.id === def.id)! }
  }

  const write = (body: string) => {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(body) }, actor)
    return page.id
  }
  const html = (frameId: string) => store.getFrame(frameId)!.html
  /* the root of a re-rendered instance keeps its template part key, which the first expansion leaves out */
  const bodyOf = (frameId: string) =>
    /<body>([\s\S]*)<\/body>/.exec(html(frameId))![1]!.replace(/ data-doop-part="[a-z]+"(?= data-doop-instance)/g, '')
  const issuesOf = (markup: string) => {
    const ctx = contextFor(canvasId)
    expandUses(markup, ctx, [], 0, { final: true })
    return ctx.issues.map((issue) => `${issue.code}: ${issue.message}`)
  }
  const instanceIdOf = (frameId: string, tag: string) =>
    new RegExp(`<${tag}[^>]*data-doop-id="([^"]+)"`).exec(html(frameId))![1]!

  const icons = () => ({
    star: makeComponent('Star', (id) => `<i ${COMPONENT_ATTR}="${id}">star</i>`),
    heart: makeComponent('Heart', (id) => `<i ${COMPONENT_ATTR}="${id}">heart</i>`),
  })
  const card = (nested: string, props: ComponentProp[] = []) =>
    makeComponent('Card', (id) => `<article ${COMPONENT_ATTR}="${id}"><h3>Card</h3>${nested}</article>`, props)
  const useKey = (template: string) => [...partsOf(template)].find(([, info]) => info.isUse)![0]

  function starCard() {
    const { star, heart } = icons()
    const c = card(`<doop-use component="${star.id}"></doop-use>`)
    const page = write(`<doop-use component="${c.id}"></doop-use>`)
    return { star, heart, c, page, part: useKey(c.def().template), instance: instanceIdOf(page, 'article') }
  }

  it('renders the other component, by name, and keeps it through a re-save', () => {
    const { c, page, part, instance } = starCard()
    const before = bodyOf(page)
    changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: 'Heart' } }], actor)
    expect(bodyOf(page)).toContain('heart')
    expect(bodyOf(page)).not.toContain('star')
    const saved = html(page)
    actions.updateFrame(page, { html: saved }, actor)
    expect(html(page)).toBe(saved)
    expect(compactDocument(html(page), contextFor(canvasId))).toMatch(/overrides="[^"]*&quot;swap&quot;/)
    /* a second instance of the same card is not swapped */
    expect(bodyOf(write(`<doop-use component="${c.id}"></doop-use>`))).toContain('star')
    expect(before).toContain('star')
  })

  it('resets with component null, and a swap back to the template component stores nothing', () => {
    const { star, page, part, instance } = starCard()
    const original = bodyOf(page)
    changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: 'Heart' } }], actor)
    changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: null } }], actor)
    expect(bodyOf(page)).toBe(original)
    changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: 'Heart' } }], actor)
    changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: star.id } }], actor)
    expect(bodyOf(page)).toBe(original)
    expect(html(page)).not.toContain('swap')
  })

  it('reads a swap back from markup an editor changed, and drops it when the markup matches again', () => {
    const { star, heart, page } = starCard()
    const edited = html(page)
      .replace(`data-doop-instance="${star.id}"`, `data-doop-instance="${heart.id}"`)
      .replace('>star<', '>heart<')
    actions.updateFrame(page, { html: edited }, actor)
    expect(html(page)).toContain(`&quot;swap&quot;:&quot;${heart.id}&quot;`)
    expect(bodyOf(page)).toContain('heart')
    const back = html(page)
      .replace(`data-doop-instance="${heart.id}"`, `data-doop-instance="${star.id}"`)
      .replace('>heart<', '>star<')
    actions.updateFrame(page, { html: back }, actor)
    expect(html(page)).not.toContain('swap')
    expect(bodyOf(page)).toContain('star')
  })

  it('carries same-named props over and drops the ones the new component lacks', () => {
    const button = makeComponent(
      'Button',
      (id) => `<button ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">Click</span></button>`,
      [{ name: 'size', type: 'number', min: 1, max: 5, step: 1 }],
    )
    const pill = makeComponent(
      'Pill',
      (id) => `<b ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">pill</span></b>`,
    )
    const c = card(`<doop-use component="${button.id}" label="Go" size="3"></doop-use>`)
    const page = write(`<doop-use component="${c.id}"></doop-use>`)
    const part = useKey(c.def().template)
    changeInstances(
      canvasId,
      page,
      [{ instanceId: instanceIdOf(page, 'article'), swap: { part, component: 'Pill' } }],
      actor,
    )
    expect(bodyOf(page)).toContain('>Go<')
    expect(bodyOf(page)).toContain('<b ')
    expect(html(page)).not.toContain('"size"')
    expect(issuesOf(`<doop-use component="${c.id}"></doop-use>`)).toEqual([])
    expect(pill.id).toBeTruthy()
  })

  it('refuses a part that is not a nested component, naming the nested ones', () => {
    const { page, part, instance } = starCard()
    expect(() =>
      changeInstances(canvasId, page, [{ instanceId: instance, swap: { part: 'nope', component: 'Heart' } }], actor),
    ).toThrow(new RegExp(`Its nested parts: ${part} \\(Star\\)`))
  })

  it('refuses a swap that would put the component inside itself, and ignores a stored one', () => {
    const { star, c, page, part, instance } = starCard()
    const wrapper = makeComponent(
      'Wrapper',
      (id) => `<div ${COMPONENT_ATTR}="${id}"><doop-use component="${c.id}"></doop-use></div>`,
    )
    expect(() =>
      changeInstances(canvasId, page, [{ instanceId: instance, swap: { part, component: 'Wrapper' } }], actor),
    ).toThrow(/nesting_cycle/)
    const stored = `<doop-use component="${c.id}" overrides='${JSON.stringify({ [part]: { swap: wrapper.id } })}'></doop-use>`
    expect(issuesOf(stored).join('\n')).toContain('nesting_cycle')
    expect(bodyOf(write(stored))).toContain('star')
    expect(star.id).toBeTruthy()
  })

  it('puts the instance swap before a forwarded component prop, and the forwarded one back when it is reset', () => {
    const { star } = icons()
    const moon = makeComponent('Moon', (id) => `<i ${COMPONENT_ATTR}="${id}">moon</i>`)
    const c = card(`<doop-use component="${star.id}" data-doop-prop="component:icon"></doop-use>`)
    updateComponent(
      canvasId,
      c.id,
      { props: [{ name: 'icon', type: 'instance', accepts: ['Star', 'Heart', 'Moon'] }] },
      actor,
    )
    const page = write(`<doop-use component="${c.id}" icon="Heart"></doop-use>`)
    expect(bodyOf(page)).toContain('heart')
    const part = useKey(c.def().template)
    const instanceId = instanceIdOf(page, 'article')
    changeInstances(canvasId, page, [{ instanceId, swap: { part, component: 'Moon' } }], actor)
    expect(bodyOf(page)).toContain('moon')
    changeInstances(canvasId, page, [{ instanceId, swap: { part, component: null } }], actor)
    expect(bodyOf(page)).toContain('heart')
    expect(moon.id).toBeTruthy()
  })

  it('leaves stored nested instances without a swap byte-identical on a re-save', () => {
    const { page } = starCard()
    const before = html(page)
    actions.updateFrame(page, { html: before }, actor)
    expect(html(page)).toBe(before)
    expect(compactDocument(before, contextFor(canvasId))).not.toContain('swap')
  })
})
