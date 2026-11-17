import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { compactDocument, expandUses } from '../server/componentEngine.ts'
import { changeInstances, createComponentFromHtml, updateComponent } from '../server/componentActions.ts'
import { COMPONENT_ATTR, isColorValue, type ComponentProp } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

describe('prop forwarding', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('forwarding').id
  })

  function makeComponent(name: string, markup: (id: string) => string, props: ComponentProp[] = []) {
    const def = blankComponent({ name, by: 'Tester', props })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return { id: def.id, frame, def: () => store.getComponents(canvasId).find((candidate) => candidate.id === def.id)! }
  }

  const button = () =>
    makeComponent(
      'Button',
      (id) =>
        `<button ${COMPONENT_ATTR}="${id}" class="btn" data-doop-prop="--size:size"><span class="label" data-doop-prop="label">Click</span></button>`,
      [
        { name: 'variant', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
        { name: 'size', type: 'number', min: 1, max: 5, step: 1 },
      ],
    )

  const card = (use: string) =>
    makeComponent('Card', (id) => `<article ${COMPONENT_ATTR}="${id}"><h3>Card</h3>${use}</article>`)

  const write = (body: string) => {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(body) }, actor)
    return page.id
  }
  const html = (frameId: string) => store.getFrame(frameId)!.html
  const bodyOf = (frameId: string) => /<body>([\s\S]*)<\/body>/.exec(html(frameId))![1]!
  const issuesOf = (markup: string) => {
    const ctx = contextFor(canvasId)
    expandUses(markup, ctx, [], 0, { final: true })
    return ctx.issues.map((issue) => `${issue.code}: ${issue.message}`)
  }
  const labelOf = (frameId: string) => /class="label"[^>]*>([^<]*)</.exec(html(frameId))?.[1]

  function forwardingCard() {
    const b = button()
    const c = card(`<doop-use component="${b.id}" label="Go" data-doop-prop="label:cta"></doop-use>`)
    return { b, c }
  }

  describe('a text prop', () => {
    it('derives the outer prop from the nested one and keeps the binding in the main and the template', () => {
      const { c } = forwardingCard()
      expect(c.def().props.find((prop) => prop.name === 'cta')).toEqual({ name: 'cta', type: 'text' })
      expect(c.def().template).toContain('data-doop-prop="label:cta"')
      expect(html(c.frame.id)).toContain('data-doop-prop="label:cta"')
    })

    it('renders the literal with no value, the forwarded value with one, and an own nested override over it', () => {
      const { c } = forwardingCard()
      const plain = write(`<doop-use component="${c.id}"></doop-use>`)
      expect(labelOf(plain)).toBe('Go')
      const bought = write(`<doop-use component="${c.id}" cta="Buy"></doop-use>`)
      expect(labelOf(bought)).toBe('Buy')
      const own = write(`<doop-use component="${c.id}" cta="Buy" overrides='{}'></doop-use>`)
      expect(labelOf(own)).toBe('Buy')
    })

    it('uses the declared default of the outer prop as the forwarded value', () => {
      const b = button()
      const c = makeComponent(
        'Card',
        (id) =>
          `<article ${COMPONENT_ATTR}="${id}"><doop-use component="${b.id}" label="Go" data-doop-prop="label:cta"></doop-use></article>`,
        [{ name: 'cta', type: 'text', default: 'Sign up' }],
      )
      expect(c.def().props.find((prop) => prop.name === 'cta')?.default).toBeUndefined()
      const page = write(`<doop-use component="${c.id}"></doop-use>`)
      expect(labelOf(page)).toBe('Go')
    })

    it('sets the outer prop when the nested label is edited, and records no nested override', () => {
      const { c } = forwardingCard()
      const page = write(`<doop-use component="${c.id}" cta="Buy"></doop-use>`)
      actions.updateFrame(page, { html: html(page).replace('>Buy<', '>Hello<') }, actor)
      expect(labelOf(page)).toBe('Hello')
      const compact = compactDocument(html(page), contextFor(canvasId))
      expect(compact).toContain('cta="Hello"')
      expect(compact).not.toContain('overrides=')
    })

    it('an edit with no outer value yet sets it, and typing the literal back removes it', () => {
      const { c } = forwardingCard()
      const page = write(`<doop-use component="${c.id}"></doop-use>`)
      actions.updateFrame(page, { html: html(page).replace('>Go<', '>Hi<') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('cta="Hi"')
      actions.updateFrame(page, { html: html(page).replace('>Hi<', '>Go<') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).not.toContain('cta=')
    })

    it('follows the outer prop when update_instances changes it', () => {
      const { c } = forwardingCard()
      const page = write(`<doop-use component="${c.id}" cta="Buy"></doop-use>`)
      const instanceId = /<article[^>]*data-doop-id="([^"]+)"/.exec(html(page))![1]!
      changeInstances(canvasId, page, [{ instanceId, props: { cta: 'Subscribe' } }], actor)
      expect(labelOf(page)).toBe('Subscribe')
      changeInstances(canvasId, page, [{ instanceId, props: { cta: '' } }], actor)
      expect(labelOf(page)).toBe('Go')
    })

    it('keeps an own nested override over the forwarded value, and an edit of it stays nested', () => {
      const { c } = forwardingCard()
      const page = write(`<doop-use component="${c.id}" cta="Buy"></doop-use>`)
      const instanceId = /<article[^>]*data-doop-id="([^"]+)"/.exec(html(page))![1]!
      const key =
        /data-doop-part="([a-z]+)"[^>]*data-doop-instance|data-doop-instance[^>]*data-doop-part="([a-z]+)"/.exec(
          html(page),
        )!
      const part = key[1] ?? key[2]!
      changeInstances(
        canvasId,
        page,
        [{ instanceId, overrides: { [part]: { use: { props: { label: 'Own' } } } } }],
        actor,
      )
      expect(labelOf(page)).toBe('Own')
      /* a later change of the outer prop does not reach it */
      changeInstances(canvasId, page, [{ instanceId, props: { cta: 'Later' } }], actor)
      expect(labelOf(page)).toBe('Own')
      actions.updateFrame(page, { html: html(page).replace('>Own<', '>Edited<') }, actor)
      expect(labelOf(page)).toBe('Edited')
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('cta="Later"')
    })

    it('round-trips the short form: expand, compact, expand', () => {
      const { c } = forwardingCard()
      const short = `<doop-use component="${c.id}" cta="Buy"></doop-use>`
      const page = write(short)
      const compact = compactDocument(html(page), contextFor(canvasId))
      expect(compact).toContain(`cta="Buy"`)
      const again = write(/<body>([\s\S]*)<\/body>/.exec(compact)![1]!)
      expect(bodyOf(again).replace(/data-doop-id="[^"]*"/g, '')).toBe(bodyOf(page).replace(/data-doop-id="[^"]*"/g, ''))
    })

    it('keeps the binding when the main is saved again, and reads it back in the short form of the main', () => {
      const { c } = forwardingCard()
      actions.updateFrame(c.frame.id, { html: html(c.frame.id) }, actor)
      expect(c.def().template).toContain('data-doop-prop="label:cta"')
      expect(compactDocument(html(c.frame.id), contextFor(canvasId))).toContain('data-doop-prop="label:cta"')
    })
  })

  describe('an enum and a number', () => {
    it('derives the outer enum with the nested options, and forwards it', () => {
      const b = button()
      const c = card(`<doop-use component="${b.id}" data-doop-prop="variant:tone,size:scale"></doop-use>`)
      expect(c.def().props.find((prop) => prop.name === 'tone')).toEqual({
        name: 'tone',
        type: 'enum',
        options: ['primary', 'ghost'],
      })
      expect(c.def().props.find((prop) => prop.name === 'scale')).toEqual({
        name: 'scale',
        type: 'number',
        min: 1,
        max: 5,
        step: 1,
      })
      const page = write(`<doop-use component="${c.id}" tone="ghost" scale="3"></doop-use>`)
      expect(html(page)).toContain('data-variant="ghost"')
      expect(issuesOf(`<doop-use component="${c.id}" tone="loud"></doop-use>`)[0]).toContain('use primary | ghost')
    })
  })

  describe('component:icon', () => {
    const icons = () => {
      const star = makeComponent('Star', (id) => `<i ${COMPONENT_ATTR}="${id}">star</i>`)
      const heart = makeComponent('Heart', (id) => `<i ${COMPONENT_ATTR}="${id}">heart</i>`)
      const moon = makeComponent('Moon', (id) => `<i ${COMPONENT_ATTR}="${id}">moon</i>`)
      return { star, heart, moon }
    }

    it('lets an instance prop pick the nested component, accepting the literal by default', () => {
      const { star, heart } = icons()
      const c = card(`<doop-use component="${star.id}" data-doop-prop="component:icon"></doop-use>`)
      expect(c.def().props.find((prop) => prop.name === 'icon')).toEqual({
        name: 'icon',
        type: 'instance',
        accepts: [star.id],
      })
      expect(bodyOf(write(`<doop-use component="${c.id}"></doop-use>`))).toContain('star')
      /* the literal is the only one accepted until accepts lists more */
      expect(issuesOf(`<doop-use component="${c.id}" icon="Heart"></doop-use>`)[0]).toContain('invalid_prop_value')
      updateComponent(
        canvasId,
        c.id,
        { props: [{ name: 'icon', type: 'instance', accepts: ['Star', 'Heart'] }] },
        actor,
      )
      const page = write(`<doop-use component="${c.id}" icon="Heart"></doop-use>`)
      expect(bodyOf(page)).toContain('heart')
      expect(bodyOf(page)).not.toContain('star')
      /* a value outside accepts is refused and the literal renders */
      const refused = issuesOf(`<doop-use component="${c.id}" icon="Moon"></doop-use>`)
      expect(refused[0]).toContain('use Star | Heart')
      expect(bodyOf(write(`<doop-use component="${c.id}" icon="Moon"></doop-use>`))).toContain('star')
      expect(heart.id).toBeTruthy()
    })
  })

  describe('data-doop-if on a nested use', () => {
    it('hides and shows it, and raises no issue', () => {
      const b = button()
      const c = makeComponent(
        'Card',
        (id) =>
          `<article ${COMPONENT_ATTR}="${id}"><h3>Card</h3><doop-use component="${b.id}" data-doop-if="show"></doop-use></article>`,
        [{ name: 'show', type: 'boolean', default: 'true' }],
      )
      expect(c.def().template).toContain('data-doop-if="show"')
      expect(issuesOf(`<doop-use component="${c.id}"></doop-use>`)).toEqual([])
      const shown = write(`<doop-use component="${c.id}"></doop-use>`)
      expect(bodyOf(shown)).toContain('class="btn"')
      const hidden = write(`<doop-use component="${c.id}" show="false"></doop-use>`)
      expect(bodyOf(hidden)).not.toContain('class="btn"')
      expect(compactDocument(html(c.frame.id), contextFor(canvasId))).toContain('data-doop-if="show"')
    })
  })

  describe('what does not bind', () => {
    it('keeps ignored_attribute for an outer prop the component does not have', () => {
      const b = button()
      const def = {
        ...blankComponent({ name: 'Old', by: 'Tester' }),
        rev: 1,
        template: `<div data-doop-part="r"><doop-use component="${b.id}" data-doop-part="u" label="Go" data-doop-prop="label:cta"></doop-use></div>`,
      }
      store.saveComponent(canvasId, def)
      const ctx = contextFor(canvasId)
      expandUses(`<doop-use component="${def.id}"></doop-use>`, ctx, [], 0, { final: true })
      expect(ctx.issues.map((issue) => issue.code)).toEqual(['ignored_attribute'])
      expect(ctx.issues[0]!.message).toContain('has no prop “cta”')
      expect(ctx.issues[0]!.message).toContain('label:cta')
    })

    it('still drops data-doop-prop on a <doop-use> in a plain frame, and says how to write it', () => {
      const b = button()
      const issues = issuesOf(`<doop-use component="${b.id}" data-doop-prop="label:cta"></doop-use>`)
      expect(issues).toHaveLength(1)
      expect(issues[0]).toContain('ignored_attribute')
      expect(issues[0]).toContain('inner:outer')
    })
  })

  describe('stored frames', () => {
    it('re-saves byte-identical when a main has a stray data-doop-prop and no instance gives a value', () => {
      const b = button()
      const def = {
        ...blankComponent({ name: 'Old', by: 'Tester' }),
        rev: 1,
        template: `<div data-doop-part="r"><h3 data-doop-part="h">Hi</h3><doop-use component="${b.id}" data-doop-part="u" label="Go" data-doop-prop="label:cta"></doop-use></div>`,
      }
      store.saveComponent(canvasId, def)
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      const stored = html(page)
      expect(stored).toContain('Go')
      actions.updateFrame(page, { html: stored }, actor)
      expect(html(page)).toBe(stored)
    })
  })

  describe('review fixes', () => {
    it('keeps the carried attributes out of the main’s own markers, and re-saves the main byte-identical', () => {
      const b = button()
      const c = makeComponent(
        'Card',
        (id) =>
          `<article ${COMPONENT_ATTR}="${id}"><doop-use component="${b.id}" label="Go" data-doop-prop="label:cta" data-doop-if="show"></doop-use></article>`,
        [{ name: 'show', type: 'boolean', default: 'true' }],
      )
      const first = html(c.frame.id)
      expect(first).not.toContain('data-doop-overrides')
      expect(first).toContain('data-doop-prop="label:cta"')
      expect(first).toContain('data-doop-if="show"')
      expect(compactDocument(first, contextFor(canvasId))).not.toContain('overrides=')
      actions.updateFrame(c.frame.id, { html: first }, actor)
      const second = html(c.frame.id)
      expect(second).toBe(first)
      actions.updateFrame(c.frame.id, { html: second }, actor)
      expect(html(c.frame.id)).toBe(second)
    })

    it('refuses a component:icon value that would nest the outer one, and the nested element comes back', () => {
      const star = makeComponent('Star', (id) => `<i ${COMPONENT_ATTR}="${id}">star</i>`)
      const c = card(`<doop-use component="${star.id}" data-doop-prop="component:icon"></doop-use>`)
      updateComponent(canvasId, c.id, { props: [{ name: 'icon', type: 'instance' }] }, actor)
      makeComponent('Wrapper', (id) => `<div ${COMPONENT_ATTR}="${id}"><doop-use component="${c.id}"></doop-use></div>`)
      const loop = `<doop-use component="${c.id}" icon="Wrapper"></doop-use>`
      expect(issuesOf(loop).join('\n')).toContain('would put “Card” inside itself')
      const page = write(loop)
      expect(bodyOf(page)).toContain('star')
      actions.updateFrame(page, { html: html(page) }, actor)
      expect(html(page)).not.toContain('"hidden":true')
      const instanceId = /<article[^>]*data-doop-id="([^"]+)"/.exec(html(page))![1]!
      changeInstances(canvasId, page, [{ instanceId, props: { icon: 'Star' } }], actor)
      expect(bodyOf(page)).toContain('star')
    })

    it('says nothing when a swapped-in component lacks a forwarded prop', () => {
      const pill = makeComponent(
        'Pill',
        (id) => `<b ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">pill</span></b>`,
      )
      const star = makeComponent('Star', (id) => `<i ${COMPONENT_ATTR}="${id}">star</i>`)
      const c = card(`<doop-use component="${pill.id}" data-doop-prop="component:icon,label:cta"></doop-use>`)
      updateComponent(canvasId, c.id, { props: [{ name: 'icon', type: 'instance', accepts: ['Pill', 'Star'] }] }, actor)
      const swapped = issuesOf(`<doop-use component="${c.id}" icon="Star" cta="x"></doop-use>`)
      expect(swapped).toEqual([])
      expect(issuesOf(`<doop-use component="${c.id}" cta="x"></doop-use>`)).toEqual([])
      expect(star.id).toBeTruthy()
    })

    it('counts a forwarding binding on a <doop-use> as a binding, so no prop is inferred beside it', () => {
      const b = button()
      const made = createComponentFromHtml(
        canvasId,
        {
          name: 'Banner',
          html: `<div class="banner"><h3>Pro</h3><doop-use component="${b.id}" data-doop-prop="label:cta"></doop-use></div>`,
        },
        actor,
      )
      expect(made.inferred).toEqual([])
      expect(made.component.props.map((prop) => prop.name)).toEqual(['cta'])
    })
  })

  describe('colours', () => {
    it('refuses a url() anywhere in a colour, fallback included', () => {
      expect(isColorValue('var(--x, #fff)')).toBe(true)
      expect(isColorValue('var(--x, url(//host/x))')).toBe(false)
      expect(isColorValue('color-mix(in srgb, red, URL(x))')).toBe(false)
    })
  })
})

/* A published snapshot carries the template, so forwarding works on a canvas that only uses the component. */
describe('prop forwarding through a workspace library', () => {
  let server: Server
  let owner: Client
  let consumerId: string

  const json = async <T>(res: Response) => (await res.json()) as T

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@forwarding.test', 'Owner')
    const workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    const libraryId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'System', workspaceId })))
      .id
    consumerId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Landing', workspaceId }))).id
    const button = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Button',
      html: '<button class="btn"><span class="label" data-doop-prop="label">Start</span></button>',
    })
    expect(button.status, await button.clone().text()).toBe(200)
    const card = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Card',
      html: '<article class="card"><h3>Pro</h3><doop-use component="Button" label="Go" data-doop-prop="label:cta"></doop-use></article>',
    })
    expect(card.status, await card.clone().text()).toBe(200)
    const published = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect(published.status, await published.clone().text()).toBe(200)
  }, 60_000)

  afterAll(() => server?.stop())

  it('renders the forwarded label on a canvas that uses the published Card', async () => {
    const frame = await owner.post(`/api/canvases/${consumerId}/frames`, {
      name: 'Hero',
      html: doc('<doop-use component="Card" cta="Buy now"></doop-use><doop-use component="Card"></doop-use>'),
    })
    expect(frame.status).toBe(200)
    const canvas = await json<{
      frames: { html: string }[]
      components: { name: string; props: { name: string }[] }[]
    }>(await owner.get(`/api/canvases/${consumerId}`))
    const labels = [...canvas.frames[0]!.html.matchAll(/class="label"[^>]*>([^<]*)</g)].map((match) => match[1])
    expect(labels).toEqual(['Buy now', 'Go'])
    expect(canvas.components.find((entry) => entry.name === 'Card')?.props.map((prop) => prop.name)).toContain('cta')
  })
})
