import { describe, expect, it } from 'vitest'
import type { ArgProp } from '../shared/storybook/argTypes.ts'
import { bindHtml, findBindings } from '../shared/storybook/bindings.ts'
import type { CapturedStory } from '../shared/storybook/capture.ts'

const story = (attrs: Record<string, string>[], shape = '0div,1span'): CapturedStory => ({
  ok: true,
  html: '',
  css: '',
  sharedRules: [],
  shape,
  paths: attrs.map(() => 'x'),
  styles: null,
  attrs,
  issues: [],
})

const variant: ArgProp = {
  name: 'variant',
  type: 'enum',
  arg: 'variant',
  options: ['default', 'danger', 'done'],
  default: 'default',
}
const disabled: ArgProp = { name: 'disabled', type: 'boolean', arg: 'disabled', default: 'false' }

describe('findBindings', () => {
  it('binds an enum to the element whose attribute holds each value, not the wrapper around it', () => {
    const base = story([{ 'data-color-mode': 'light' }, { 'data-variant': 'default' }])
    const shot = (value: string) => story([{ 'data-color-mode': 'light' }, { 'data-variant': value }])
    const { bindings, bound } = findBindings(
      base,
      [
        { prop: 'variant', value: 'danger', shot: shot('danger') },
        { prop: 'variant', value: 'done', shot: shot('done') },
      ],
      [variant],
    )
    expect([...bindings]).toEqual([[1, ['data-variant:variant']]])
    expect([...bound]).toEqual(['variant'])
  })

  it('needs the attribute to follow every value, and leaves a prop nothing tracks to the CSS diff', () => {
    const base = story([{}, { 'aria-label': 'a' }])
    const { bindings, bound } = findBindings(
      base,
      [
        { prop: 'variant', value: 'danger', shot: story([{}, { 'aria-label': 'danger' }]) },
        { prop: 'variant', value: 'done', shot: story([{}, { 'aria-label': 'a' }]) },
      ],
      [variant],
    )
    expect(bindings.size).toBe(0)
    expect(bound.size).toBe(0)
  })

  it('reads a boolean from an attribute that appears, and from a data attribute that flips to true', () => {
    const presence = findBindings(
      story([{}, {}]),
      [{ prop: 'disabled', value: 'true', shot: story([{}, { disabled: '' }]) }],
      [disabled],
    )
    expect([...presence.bindings]).toEqual([[1, ['disabled:disabled']]])
    const flipped = findBindings(
      story([{ 'data-loading': 'false' }, {}]),
      [{ prop: 'disabled', value: 'true', shot: story([{ 'data-loading': 'true' }, {}]) }],
      [disabled],
    )
    expect([...flipped.bindings]).toEqual([[0, ['data-loading:disabled']]])
  })

  it('refuses a comparison of trees of a different shape', () => {
    const { bound } = findBindings(
      story([{}, { 'data-variant': 'default' }]),
      [{ prop: 'variant', value: 'danger', shot: story([{}, { 'data-variant': 'danger' }], '0div,1p') }],
      [variant],
    )
    expect(bound.size).toBe(0)
  })
})

describe('bindHtml', () => {
  const marker = 'data-doop-m-ab12'
  it("takes every marker off and merges the found bindings with an element's own", () => {
    const html = `<div ${marker}="0"><span ${marker}="1" data-doop-prop="label">Label</span><i ${marker}="2"></i></div>`
    const out = bindHtml(html, marker, new Map([[1, ['data-variant:variant']]]))
    expect(out).toBe('<div><span data-doop-prop="label,data-variant:variant">Label</span><i></i></div>')
  })

  it('adds a binding to an element that had none', () => {
    const out = bindHtml(`<b ${marker}="0">x</b>`, marker, new Map([[0, ['disabled:disabled']]]))
    expect(out).toBe('<b data-doop-prop="disabled:disabled">x</b>')
  })

  it('does nothing without a marker', () => {
    expect(bindHtml('<b>x</b>', undefined, new Map([[0, ['a:b']]]))).toBe('<b>x</b>')
  })
})
