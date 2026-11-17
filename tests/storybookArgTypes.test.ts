import { describe, expect, it } from 'vitest'
import { MAX_OPTIONS, MAX_PROPS, propName, readArgTypes } from '../shared/storybook/argTypes.ts'

const read = (argTypes: unknown, initialArgs: unknown = {}) => readArgTypes(argTypes, initialArgs)

describe('propName', () => {
  it.each([
    ['showIcon', 'show-icon'],
    ['Tone_2', 'tone-2'],
    ['HTMLContent', 'html-content'],
    ['label', 'label'],
    ['  weird  name!! ', 'weird-name'],
    ['9lives', undefined],
    ['___', undefined],
    ['', undefined],
  ])('%s -> %s', (arg, expected) => {
    expect(propName(arg)).toBe(expected)
  })

  it('caps the length', () => {
    expect(propName('a'.repeat(200))?.length).toBeLessThanOrEqual(40)
  })
})

describe('readArgTypes mapping', () => {
  it('maps select, radio, inline-radio and check with options to an enum', () => {
    for (const type of ['select', 'radio', 'inline-radio', 'check']) {
      const { props } = read({ tone: { control: { type }, options: ['primary', 'secondary'] } }, { tone: 'secondary' })
      expect(props).toEqual([
        {
          name: 'tone',
          type: 'enum',
          arg: 'tone',
          options: ['primary', 'secondary'],
          default: 'secondary',
          initial: 'secondary',
        },
      ])
    }
  })

  it('reads options from the control, from an object and from type.value', () => {
    expect(read({ a: { control: { type: 'select', options: ['x', 'y'] } } }).props[0]?.options).toEqual(['x', 'y'])
    expect(read({ a: { control: 'select', options: { Small: 1, Large: 2 } } }).props[0]?.options).toEqual([
      'Small',
      'Large',
    ])
    expect(read({ a: { type: { name: 'enum', value: ['p', 'q'] } } }).props[0]?.options).toEqual(['p', 'q'])
  })

  it('maps boolean, number, range, color and text', () => {
    const { props, issues } = read(
      {
        disabled: { control: { type: 'boolean' } },
        size: { control: { type: 'range', min: 1, max: 10, step: 0.5 } },
        count: { control: 'number' },
        fill: { control: { type: 'color' } },
        label: { control: { type: 'text' } },
      },
      { disabled: true, size: 4, fill: '#ff0000', label: 'Hi', count: 'x' },
    )
    expect(issues).toEqual([])
    expect(props.map((prop) => [prop.name, prop.type, prop.default])).toEqual([
      ['disabled', 'boolean', 'true'],
      ['size', 'number', '4'],
      ['count', 'number', undefined],
      ['fill', 'color', '#ff0000'],
      ['label', 'text', undefined],
    ])
    expect(props[1]).toMatchObject({ min: 1, max: 10, step: 0.5 })
    expect(props[4]?.initial).toBe('Hi')
  })

  it('falls back to the argType type when there is no control', () => {
    const { props } = read({
      a: { type: { name: 'boolean' } },
      b: { type: { name: 'string' } },
      c: { type: { name: 'number' } },
    })
    expect(props.map((prop) => prop.type)).toEqual(['boolean', 'text', 'number'])
  })

  it('drops what does not fit, with the reason', () => {
    const { props, issues } = read({
      onClick: { action: 'clicked' },
      handler: { control: false },
      data: { control: { type: 'object' } },
      when: { control: 'date' },
      lonely: { control: 'select', options: ['only'] },
      untyped: {},
      notObject: 'string',
    })
    expect(props).toEqual([])
    expect(issues).toHaveLength(1)
    const message = issues[0]!.message
    for (const word of ['onClick', 'handler', 'data', 'when', 'lonely', 'untyped', 'notObject'])
      expect(message).toContain(word)
  })

  it('returns nothing for a non-object', () => {
    for (const input of [null, undefined, 3, 'x', [], true]) expect(read(input)).toEqual({ props: [], issues: [] })
  })

  it('ignores a default outside the options and a reversed range', () => {
    const { props } = read(
      {
        tone: { control: 'select', options: ['a', 'b'] },
        n: { control: { type: 'range', min: 10, max: 2, step: -1 } },
      },
      { tone: 'zzz' },
    )
    expect(props[0]?.default).toBeUndefined()
    expect(props[1]).toEqual({ name: 'n', type: 'number', arg: 'n', min: 10 })
  })
})

describe('readArgTypes against hostile input', () => {
  it('ignores prototype keys, and builds nothing on Object.prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"control":"text"},"constructor":{"control":"text"},"prototype":{"control":"text"},"ok":{"control":"text","description":"fine"}}',
    )
    const { props } = read(hostile, JSON.parse('{"__proto__":{"polluted":true},"ok":"v"}'))
    expect(props.map((prop) => prop.name)).toEqual(['ok'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps only the first MAX_OPTIONS usable options and drops unsafe, repeated and function-like ones', () => {
    const many = Array.from({ length: 500 }, (_, i) => `v${i}`)
    const { props, issues } = read({
      big: { control: 'select', options: many },
      mixed: {
        control: 'select',
        options: [
          'ok',
          'a"b',
          "x'y",
          '<b>',
          'back\\slash',
          'function () { return 1 }',
          '(a) => a',
          'ok',
          '',
          'x'.repeat(101),
          'line\nbreak',
          5,
          null,
          {},
          'fine',
        ],
      },
    })
    expect(props[0]?.options).toHaveLength(MAX_OPTIONS)
    expect(props[1]?.options).toEqual(['ok', '5', 'fine'])
    expect(issues[0]?.message).toContain('options were unusable')
  })

  it('caps the number of props and argTypes read', () => {
    const table: Record<string, unknown> = {}
    for (let i = 0; i < 500; i++) table[`p${String.fromCharCode(97 + (i % 26))}${i}`] = { control: 'boolean' }
    const { props, issues } = read(table)
    expect(props).toHaveLength(MAX_PROPS)
    expect(issues[0]?.message).toContain('only the first 200 argTypes are read')
  })

  it('strips markup and control characters from descriptions and caps them', () => {
    const { props } = read({
      a: { control: 'text', description: '<script>alert(1)</script>Use for <b>emphasis</b>\u0000\n  now' },
      b: { control: 'text', description: 'x'.repeat(5000) },
      c: { control: 'text', description: { html: '<img onerror=x>' } },
    })
    expect(props[0]?.description).toBe('alert(1) Use for emphasis now')
    expect(props[1]?.description).toHaveLength(300)
    expect(props[2]?.description).toBeUndefined()
  })

  it('rejects names that cannot be passed in a URL or are reserved, and collisions', () => {
    const { props, issues } = read({
      'a b': { control: 'text' },
      'x.y': { control: 'text' },
      '9a': { control: 'text' },
      class: { control: 'text' },
      style: { control: 'text' },
      id: { control: 'text' },
      showIcon: { control: 'boolean' },
      show_icon: { control: 'boolean' },
      ünï: { control: 'text' },
    })
    expect(props.map((prop) => prop.name)).toEqual(['show-icon'])
    expect(issues[0]?.message).toContain('collides')
  })

  it('treats functions serialized as strings, non-string names and deep nesting as plain data', () => {
    let deep: unknown = { control: 'text' }
    for (let i = 0; i < 5000; i++) deep = { nested: deep }
    const { props } = read(
      {
        fn: { control: 'text', defaultValue: 'function () {}' },
        nested: deep,
        numberish: { control: 'select', options: [1, 2, 3, Infinity, NaN] },
        obj: { control: { type: 'text', value: { toString: 'x' } } },
      },
      { fn: { not: 'primitive' }, numberish: 2 },
    )
    expect(props.map((prop) => prop.name)).toEqual(['fn', 'numberish', 'obj'])
    expect(props[1]).toMatchObject({ options: ['1', '2', '3'], default: '2' })
  })

  it('does not read inherited properties', () => {
    const inherited = Object.create({ control: 'text' }) as Record<string, unknown>
    const table = Object.create(null) as Record<string, unknown>
    table.fromProto = inherited
    expect(read(table).props).toEqual([])
  })
})
