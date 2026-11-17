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
import { compactDocument, expandUses } from '../server/componentEngine.ts'
import { validProps } from '../server/componentActions.ts'
import {
  COMPONENT_ATTR,
  INSTANCE_ATTR,
  componentSignature,
  propValueProblem,
  type ComponentProp,
} from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

describe('component prop types', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('prop types').id
  })

  function makeComponent(name: string, markup: (id: string) => string, props: ComponentProp[] = []) {
    const def = blankComponent({ name, by: 'Tester', props })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return { def: store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!, frame }
  }

  function write(body: string) {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(body) }, actor)
    return page.id
  }

  const html = (frameId: string) => store.getFrame(frameId)!.html
  const bodyOf = (frameId: string) => /<body>([\s\S]*)<\/body>/.exec(html(frameId))![1]!
  const issuesOf = (markup: string) => {
    const ctx = contextFor(canvasId)
    expandUses(markup, ctx, [], 0, { final: true })
    return ctx.issues
  }

  describe('number, color and instance', () => {
    const quantity = (): ComponentProp[] => [
      { name: 'count', type: 'number', min: 0, max: 10, step: 2, default: '2' },
      { name: 'accent', type: 'color' },
      { name: 'icon', type: 'instance', accepts: ['Icon', 'Avatar'] },
    ]
    const make = () =>
      makeComponent(
        'Badge',
        (id) =>
          `<div ${COMPONENT_ATTR}="${id}" data-doop-prop="--accent:accent"><span data-doop-prop="count">1</span><span data-doop-prop="icon">i</span></div>`,
        quantity(),
      )

    it('keeps the typed fields on the definition and shows them in the signature', () => {
      const { def } = make()
      expect(def.props.find((prop) => prop.name === 'count')).toMatchObject({
        type: 'number',
        min: 0,
        max: 10,
        step: 2,
        default: '2',
      })
      expect(def.props.find((prop) => prop.name === 'icon')).toMatchObject({
        type: 'instance',
        accepts: ['Icon', 'Avatar'],
      })
      expect(componentSignature(def)).toBe(
        'Badge(accent: color, count: number(0..10 step 2) = 2, icon: instance(Icon|Avatar))',
      )
      expect(
        componentSignature({
          name: 'X',
          slots: [],
          props: [{ name: 'n', type: 'number', min: 0, max: 10, default: '1' }],
        }),
      ).toBe('X(n: number(0..10) = 1)')
    })

    it('accepts good values on a <doop-use>', () => {
      const { def } = make()
      const markup = `<doop-use component="${def.id}" count="4" accent="#0af" icon="avatar"></doop-use>`
      expect(issuesOf(markup)).toEqual([])
      const page = write(markup)
      expect(bodyOf(page)).toContain('--accent: #0af')
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('count="4"')
    })

    it.each([
      ['count', 'many', 'use a number from 0 to 10 in steps of 2'],
      ['count', '12', 'use a number from 0 to 10 in steps of 2'],
      ['count', '3', 'use a number from 0 to 10 in steps of 2'],
      ['count', '', 'use a number from 0 to 10 in steps of 2'],
      ['accent', 'blue', 'use a hex colour'],
      ['accent', '#12', 'use a hex colour'],
      ['accent', 'rgb(1,2,3); background: red', 'use a hex colour'],
      ['icon', 'Logo', 'use Icon | Avatar'],
    ])('drops %s="%s" with invalid_prop_value', (name, value, hint) => {
      const { def } = make()
      const issues = issuesOf(`<doop-use component="${def.id}" ${name}="${value}"></doop-use>`)
      expect(issues).toHaveLength(1)
      expect(issues[0]!.code).toBe('invalid_prop_value')
      expect(issues[0]!.message).toContain(`"${value}" is not a value of ${name} — ${hint}`)
      const page = write(`<doop-use component="${def.id}" ${name}="${value}"></doop-use>`)
      expect(html(page)).not.toContain(`"${name}":"${value}"`)
    })

    it('checks values in one place for server and client', () => {
      const count: ComponentProp = { name: 'count', type: 'number', min: -1, max: 1, step: 0.5 }
      expect(propValueProblem(count, '-0.5')).toBeUndefined()
      expect(propValueProblem(count, '0.25')).toBeDefined()
      expect(propValueProblem({ name: 'n', type: 'number' }, '1e3')).toBeUndefined()
      expect(propValueProblem({ name: 'n', type: 'number' }, 'Infinity')).toBeDefined()
      const colour: ComponentProp = { name: 'c', type: 'color' }
      for (const good of [
        '#fff',
        '#ffff',
        '#ffffff',
        '#ffffff80',
        'rgb(0 0 0 / 50%)',
        'hsla(10, 20%, 30%, .5)',
        'oklch(0.7 0.1 200)',
        'var(--brand)',
      ])
        expect(propValueProblem(colour, good), good).toBeUndefined()
      for (const bad of ['', 'red', '#ff', '#fffff', 'rgb(0,0,0', 'var(brand)', 'url(x)', 'rgb(expression(1))'])
        expect(propValueProblem(colour, bad), bad).toBeDefined()
      expect(propValueProblem({ name: 'i', type: 'instance' }, 'Anything')).toBeUndefined()
      expect(propValueProblem({ name: 'i', type: 'instance' }, '')).toBeDefined()
      expect(propValueProblem({ name: 'b', type: 'boolean' }, 'perhaps')).toBeUndefined()
    })

    it('refuses bad definitions in validProps', () => {
      expect(() => validProps([{ name: 'n', type: 'number', min: 5, max: 1 }])).toThrow(/min 5 is above max 1/)
      expect(() => validProps([{ name: 'n', type: 'number', step: 0 }])).toThrow(/step must be above 0/)
      expect(() => validProps([{ name: 'n', type: 'number', step: -2 }])).toThrow(/step must be above 0/)
      expect(() => validProps([{ name: 'n', type: 'number', min: 'a' }])).toThrow(/min must be a number/)
      expect(() => validProps([{ name: 't', type: 'text', accepts: ['Icon'] }])).toThrow(/accepts belongs to instance/)
      expect(() => validProps([{ name: 't', type: 'text', min: 1 }])).toThrow(/min belongs to number/)
      expect(() => validProps([{ name: 't', type: 'text', reflect: true }])).toThrow(/reflect belongs to boolean/)
      expect(() => validProps([{ name: 'n', type: 'number', max: 3, default: '9' }])).toThrow(
        /default “9” does not fit/,
      )
      expect(() => validProps([{ name: 'c', type: 'color', default: 'blue' }])).toThrow(/default “blue” does not fit/)
      expect(() => validProps([{ name: 'i', type: 'instance', accepts: ['Icon'], default: 'Logo' }])).toThrow(
        /does not fit/,
      )
    })

    it('normalizes the typed fields', () => {
      const [number, instance, flag] = validProps([
        { name: 'n', type: 'number', min: '1', max: 9, step: '2' },
        { name: 'i', type: 'instance', accepts: [' Icon ', 'Icon', 'Avatar', ''] },
        { name: 'f', type: 'boolean', reflect: true },
      ] as unknown as ComponentProp[])
      expect(number).toEqual({ name: 'n', type: 'number', min: 1, max: 9, step: 2 })
      expect(instance).toEqual({ name: 'i', type: 'instance', accepts: ['Icon', 'Avatar'] })
      expect(flag).toEqual({ name: 'f', type: 'boolean', reflect: true })
    })

    it('prunes a number edited back to the template value', () => {
      const { def } = make()
      const page = write(`<doop-use component="${def.id}" count="4"></doop-use>`)
      expect(html(page)).toContain('data-doop-props')
      actions.updateFrame(page, { html: html(page).replace('>4</span>', '>1</span>') }, actor)
      expect(html(page)).not.toContain('data-doop-props')
    })
  })

  describe('booleans on HTML attributes', () => {
    const make = (extra: Partial<ComponentProp> = {}) =>
      makeComponent(
        'Button',
        (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}" data-doop-prop="disabled:disabled">Go</button>`,
        [{ name: 'disabled', type: 'boolean', ...extra }],
      )

    it('writes the bare attribute when on and none when off', () => {
      const { def } = make()
      const on = write(`<doop-use component="${def.id}" disabled="true"></doop-use>`)
      expect(bodyOf(on)).toMatch(/<button[^>]* disabled=""[^>]*>/)
      const off = write(`<doop-use component="${def.id}" disabled="false"></doop-use>`)
      expect(bodyOf(off)).not.toMatch(/ disabled[=> ]/)
      expect(bodyOf(off)).toContain('data-doop-props')
    })

    it('uses the declared default, and leaves the template alone with no value at all', () => {
      const withDefault = make({ default: 'true' })
      const page = write(`<doop-use component="${withDefault.def.id}"></doop-use>`)
      expect(bodyOf(page)).toMatch(/<button[^>]* disabled=""/)
      const plain = makeComponent(
        'Plain',
        (id) => `<button ${COMPONENT_ATTR}="${id}" disabled data-doop-prop="disabled:disabled">Go</button>`,
        [{ name: 'disabled', type: 'boolean' }],
      )
      const untouched = write(`<doop-use component="${plain.def.id}"></doop-use>`)
      expect(bodyOf(untouched)).toMatch(/<button[^>]* disabled(?:="")?[ >]/)
    })

    it.each([
      ['checked', 'input'],
      ['hidden', 'div'],
      ['required', 'input'],
      ['readonly', 'input'],
      ['open', 'details'],
      ['multiple', 'select'],
      ['inert', 'div'],
      ['muted', 'video'],
    ])('treats %s as a boolean attribute', (attr, tag) => {
      const { def } = makeComponent(
        `Part-${attr}`,
        (id) => `<${tag} ${COMPONENT_ATTR}="${id}" data-doop-prop="${attr}:${attr}"></${tag}>`,
        [{ name: attr, type: 'boolean' }],
      )
      expect(bodyOf(write(`<doop-use component="${def.id}" ${attr}="true"></doop-use>`))).toMatch(
        new RegExp(` ${attr}=""`),
      )
      expect(bodyOf(write(`<doop-use component="${def.id}" ${attr}="false"></doop-use>`))).not.toMatch(
        new RegExp(` ${attr}[=> ]`),
      )
    })

    it('keeps the value string for any other attribute', () => {
      const { def } = makeComponent(
        'Toggle',
        (id) => `<button ${COMPONENT_ATTR}="${id}" data-doop-prop="aria-pressed:pressed">T</button>`,
        [{ name: 'pressed', type: 'boolean' }],
      )
      expect(bodyOf(write(`<doop-use component="${def.id}" pressed="false"></doop-use>`))).toContain(
        'aria-pressed="false"',
      )
      expect(bodyOf(write(`<doop-use component="${def.id}" pressed="true"></doop-use>`))).toContain(
        'aria-pressed="true"',
      )
    })

    it('reads an instance edit that removes the attribute as false, and adding it back as true', () => {
      const { def } = make()
      const page = write(`<doop-use component="${def.id}" disabled="true"></doop-use>`)
      actions.updateFrame(page, { html: html(page).replace(/ disabled=""/, '') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('disabled="false"')
      expect(bodyOf(page)).not.toMatch(/<button[^>]* disabled/)
      expect(bodyOf(page)).not.toContain('data-doop-overrides')
      actions.updateFrame(page, { html: html(page).replace('<button ', '<button disabled="" ') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('disabled="true"')
    })

    it('puts data-<name> on the root only for reflect, and reads it back', () => {
      const plain = make()
      expect(bodyOf(write(`<doop-use component="${plain.def.id}" disabled="true"></doop-use>`))).not.toContain(
        'data-disabled',
      )
      const reflected = makeComponent('Chip', (id) => `<span ${COMPONENT_ATTR}="${id}">x</span>`, [
        { name: 'selected', type: 'boolean', reflect: true, default: 'false' },
      ])
      expect(reflected.def.props.map((prop) => prop.name)).toEqual(['selected'])
      const page = write(`<doop-use component="${reflected.def.id}"></doop-use>`)
      expect(bodyOf(page)).toContain('data-selected="false"')
      const on = write(`<doop-use component="${reflected.def.id}" selected="true"></doop-use>`)
      expect(bodyOf(on)).toContain('data-selected="true"')
      actions.updateFrame(page, { html: html(page).replace('data-selected="false"', 'data-selected="true"') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).toContain('selected="true"')
    })
  })

  describe('a bound text keeps the other children', () => {
    const make = () =>
      makeComponent(
        'Link',
        (id) =>
          `<a class="lnk" href="#" ${COMPONENT_ATTR}="${id}" data-doop-prop="label"><svg width="8" height="8"></svg>Open</a>`,
      )

    it('replaces only the text', () => {
      const { def } = make()
      const page = write(`<doop-use component="${def.id}" label="Close"></doop-use>`)
      expect(bodyOf(page)).toMatch(/<a [^>]*><svg[^>]*><\/svg>Close<\/a>/)
    })

    it('keeps the text where it stood, between children', () => {
      const { def } = makeComponent(
        'Mid',
        (id) => `<button ${COMPONENT_ATTR}="${id}" data-doop-prop="label"><i></i>Old<b></b></button>`,
      )
      const page = write(`<doop-use component="${def.id}" label="New"></doop-use>`)
      expect(bodyOf(page)).toMatch(/<button [^>]*><i[^>]*><\/i>New<b[^>]*><\/b><\/button>/)
    })

    it('maps an instance edit of the label to the prop, not an override', () => {
      const { def } = make()
      const page = write(`<doop-use component="${def.id}" label="Close"></doop-use>`)
      actions.updateFrame(page, { html: html(page).replace('Close</a>', 'Dismiss</a>') }, actor)
      expect(compactDocument(html(page), contextFor(canvasId))).toMatch(/label="Dismiss"/)
      expect(html(page)).not.toContain('data-doop-overrides')
      expect(bodyOf(page)).toMatch(/<svg[^>]*><\/svg>Dismiss<\/a>/)
    })

    it('prunes the label when it is set back to the template text', () => {
      const { def } = make()
      const page = write(`<doop-use component="${def.id}" label="Close"></doop-use>`)
      actions.updateFrame(page, { html: html(page).replace('Close</a>', 'Open</a>') }, actor)
      expect(html(page)).not.toContain('data-doop-props')
    })

    it('still renders a leaf exactly as before', () => {
      const { def } = makeComponent(
        'Leaf',
        (id) => `<button ${COMPONENT_ATTR}="${id}" data-doop-prop="label">Buy</button>`,
      )
      expect(bodyOf(write(`<doop-use component="${def.id}" label="Sell"></doop-use>`))).toMatch(/>Sell<\/button>/)
    })
  })

  describe('stored instances from before', () => {
    it('re-saves disabled="false" without the attribute and changes nothing else', () => {
      const { def } = makeComponent(
        'Button',
        (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}" data-doop-prop="disabled:disabled">Go</button>`,
        [{ name: 'disabled', type: 'boolean' }],
      )
      const seeded = write(`<doop-use component="${def.id}" disabled="true"></doop-use>`)
      const before = html(seeded)
        .replace(/ disabled=""/, ' disabled="false"')
        .replace('&quot;disabled&quot;:&quot;true&quot;', '&quot;disabled&quot;:&quot;false&quot;')
      expect(before).toContain('disabled="false"')
      expect(before).toContain('&quot;disabled&quot;:&quot;false&quot;')
      const old = actions.createFrame(canvasId, { name: 'Old', html: '' }, actor)!
      actions.updateFrame(old.id, { html: before }, actor)
      expect(html(old.id)).toBe(before.replace(/ disabled="false"/, ''))
      /* and it is stable from then on */
      const again = html(old.id)
      actions.updateFrame(old.id, { html: again }, actor)
      expect(html(old.id)).toBe(again)
    })

    it('keeps the look of an instance whose bound text once wiped its icon', () => {
      const { def } = makeComponent(
        'Link',
        (id) => `<a href="#" ${COMPONENT_ATTR}="${id}" data-doop-prop="label"><svg width="8" height="8"></svg>Open</a>`,
      )
      const seeded = write(`<doop-use component="${def.id}" label="Close"></doop-use>`)
      /* what the old render stored: the label replaced every child, the svg included */
      const old = html(seeded).replace(/<svg[^>]*><\/svg>/, '')
      expect(old).not.toContain('<svg')
      const page = actions.createFrame(canvasId, { name: 'Old', html: '' }, actor)!
      actions.updateFrame(page.id, { html: old }, actor)
      expect(html(page.id)).not.toContain('<svg')
      expect(html(page.id)).toContain('Close')
      expect(html(page.id)).toContain('&quot;hidden&quot;:true')
    })

    it('re-saves a plain text-bound instance byte for byte', () => {
      const { def } = makeComponent(
        'Leaf',
        (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">Buy</span></button>`,
      )
      const seeded = write(`<doop-use component="${def.id}" label="Sell"></doop-use>`)
      const stored = html(seeded)
      expect(stored).toContain(INSTANCE_ATTR)
      const copy = actions.createFrame(canvasId, { name: 'Copy', html: '' }, actor)!
      actions.updateFrame(copy.id, { html: stored }, actor)
      expect(html(copy.id)).toBe(stored)
      actions.updateFrame(copy.id, { html: html(copy.id) }, actor)
      expect(html(copy.id)).toBe(stored)
    })
  })
})
