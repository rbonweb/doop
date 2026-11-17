import { describe, it, expect } from 'vitest'
import {
  BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_COMPONENTS,
  MAX_BUNDLE_CSS_BYTES,
  MAX_BUNDLE_HTML_BYTES,
  MAX_INLINE_BUNDLE_BYTES,
  MAX_VARIANT_AXES,
  MAX_VARIANT_VALUES,
  componentBundleSchema,
  unsafePropValue,
} from '../shared/componentBundle.ts'

/**
 * The untrusted wire shape every importer validates: versions and sources, the
 * size and count caps, variant refinements against props, and hostile keys.
 */

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BUNDLE_VERSION,
    source: { kind: 'cli' },
    components: [{ name: 'Card', html: '<div></div>' }],
    ...overrides,
  }
}

function cardWith(variants: Record<string, unknown>, props: unknown[]): Record<string, unknown> {
  return bundle({ components: [{ name: 'Card', html: '<div></div>', props, variants }] })
}

function issueText(result: ReturnType<typeof componentBundleSchema.safeParse>): string {
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join(' ')
}

describe('componentBundleSchema', () => {
  it('parses a minimal bundle', () => {
    const result = componentBundleSchema.safeParse({
      version: 1,
      source: { kind: 'cli' },
      components: [{ name: 'Card', html: '<div></div>' }],
    })
    expect(issueText(result)).toBe('')
    expect(result.success).toBe(true)
  })

  it('parses a full bundle with props, variants, code and tokens', () => {
    const result = componentBundleSchema.safeParse(
      bundle({
        components: [
          {
            name: 'Card',
            html: '<div class="card"></div>',
            css: '.card{display:block}',
            props: [
              { name: 'tone', type: 'enum', options: ['plain', 'raised'] },
              { name: 'badge', type: 'boolean' },
            ],
            variants: {
              tone: { raised: { css: '.card{x:y}' } },
              badge: { true: { html: '<div></div>' } },
            },
            code: { importFrom: '@acme/ui', exportName: 'Card' },
          },
        ],
        tokens: [{ name: '--brand', value: '#0177d3', type: 'color' }],
      }),
    )
    expect(issueText(result)).toBe('')
    expect(result.success).toBe(true)
  })

  it('strips extra top level keys instead of keeping them', () => {
    const result = componentBundleSchema.safeParse(bundle({ evil: 'payload' }))
    expect(result.success).toBe(true)
    expect(result.success && Object.prototype.hasOwnProperty.call(result.data, 'evil')).toBe(false)
  })
})

describe('componentBundleSchema rejections', () => {
  const rejected: [string, Record<string, unknown>][] = [
    ['version 2', bundle({ version: 2 })],
    ['source kind figma', bundle({ source: { kind: 'figma' } })],
    ['empty components', bundle({ components: [] })],
    [
      `${MAX_BUNDLE_COMPONENTS + 1} components`,
      bundle({
        components: Array.from({ length: MAX_BUNDLE_COMPONENTS + 1 }, (_, index) => ({
          name: `Card${index}`,
          html: '<div></div>',
        })),
      }),
    ],
    [
      'duplicate names differing only in case and space',
      bundle({
        components: [
          { name: 'Card', html: '<div></div>' },
          { name: ' card', html: '<div></div>' },
        ],
      }),
    ],
    ['token name without --', bundle({ tokens: [{ name: 'brand', value: '#0177d3' }] })],
    ['token name with a space', bundle({ tokens: [{ name: '--a b', value: '#0177d3' }] })],
    ['html over the cap', bundle({ components: [{ name: 'Card', html: 'x'.repeat(MAX_BUNDLE_HTML_BYTES + 1) }] })],
    [
      'css over the cap',
      bundle({
        components: [{ name: 'Card', html: '<div></div>', css: 'x'.repeat(MAX_BUNDLE_CSS_BYTES + 1) }],
      }),
    ],
    ['name longer than 80 chars', bundle({ components: [{ name: 'x'.repeat(81), html: '<div></div>' }] })],
    ['empty name', bundle({ components: [{ name: '', html: '<div></div>' }] })],
    ['source url that is not a url', bundle({ source: { kind: 'cli', url: 'not a url' } })],
  ]

  it.each(rejected)('rejects %s', (_label, value) => {
    const result = componentBundleSchema.safeParse(value)
    expect(result.success).toBe(false)
  })
})

describe('componentBundleSchema variants', () => {
  const toneProp = [{ name: 'tone', type: 'enum', options: ['plain', 'raised'] }]

  it('rejects a variant key naming a prop that does not exist', () => {
    const result = componentBundleSchema.safeParse(cardWith({ missing: { plain: {} } }, toneProp))
    expect(result.success).toBe(false)
    expect(issueText(result)).toContain('enum or boolean prop')
  })

  it('rejects a variant key naming a text prop', () => {
    const result = componentBundleSchema.safeParse(cardWith({ label: { hi: {} } }, [{ name: 'label', type: 'text' }]))
    expect(result.success).toBe(false)
    expect(issueText(result)).toContain('enum or boolean prop')
  })

  it('rejects an enum variant value that is not one of the options', () => {
    const result = componentBundleSchema.safeParse(cardWith({ tone: { weird: {} } }, toneProp))
    expect(result.success).toBe(false)
    expect(issueText(result)).toContain('not an option')
  })

  it('rejects the boolean variant value yes but accepts true and false', () => {
    const badgeProp = [{ name: 'badge', type: 'boolean' }]
    const yes = componentBundleSchema.safeParse(cardWith({ badge: { yes: {} } }, badgeProp))
    expect(yes.success).toBe(false)
    expect(issueText(yes)).toContain('boolean variant value')

    const both = componentBundleSchema.safeParse(cardWith({ badge: { true: {}, false: {} } }, badgeProp))
    expect(issueText(both)).toBe('')
    expect(both.success).toBe(true)
  })

  it(`rejects more than ${MAX_VARIANT_AXES} variant props`, () => {
    const axes = Array.from({ length: MAX_VARIANT_AXES + 1 }, (_, index) => `b${index + 1}`)
    const variants = Object.fromEntries(axes.map((name) => [name, { true: {} }]))
    const props = axes.map((name) => ({ name, type: 'boolean' }))
    const result = componentBundleSchema.safeParse(cardWith(variants, props))
    expect(result.success).toBe(false)
    expect(issueText(result)).toContain(`at most ${MAX_VARIANT_AXES}`)
  })

  it(`rejects more than ${MAX_VARIANT_VALUES} values on one enum prop but accepts exactly ${MAX_VARIANT_VALUES}`, () => {
    const options = Array.from({ length: MAX_VARIANT_VALUES + 1 }, (_, index) => `o${index + 1}`)
    const nine = Object.fromEntries(options.map((option) => [option, {}]))
    const tooMany = componentBundleSchema.safeParse(cardWith({ tone: nine }, [{ name: 'tone', type: 'enum', options }]))
    expect(tooMany.success).toBe(false)
    expect(issueText(tooMany)).toContain(`at most ${MAX_VARIANT_VALUES}`)

    const eightOptions = options.slice(0, MAX_VARIANT_VALUES)
    const eight = Object.fromEntries(eightOptions.map((option) => [option, {}]))
    const justRight = componentBundleSchema.safeParse(
      cardWith({ tone: eight }, [{ name: 'tone', type: 'enum', options: eightOptions }]),
    )
    expect(issueText(justRight)).toBe('')
    expect(justRight.success).toBe(true)
  })
})

describe('componentBundleSchema hostile input', () => {
  it('does not crash on a __proto__ variants prop name', () => {
    const value = JSON.parse(
      '{"version":1,"source":{"kind":"cli"},"components":[{"name":"Card","html":"<div></div>",' +
        '"props":[{"name":"__proto__","type":"boolean"}],"variants":{"__proto__":{"true":{}}}}]}',
    )
    expect(() => componentBundleSchema.safeParse(value)).not.toThrow()
    const result = componentBundleSchema.safeParse(value)
    expect(typeof result.success).toBe('boolean')
  })

  it('does not crash on a __proto__ component prop name', () => {
    const value = JSON.parse(
      '{"version":1,"source":{"kind":"cli"},"components":[{"name":"Card","html":"<div></div>",' +
        '"props":[{"name":"__proto__","type":"boolean"}]}]}',
    )
    expect(() => componentBundleSchema.safeParse(value)).not.toThrow()
    const result = componentBundleSchema.safeParse(value)
    expect(typeof result.success).toBe('boolean')
  })
})

describe('componentBundle constants', () => {
  it('keeps the inline cap below the whole bundle cap', () => {
    expect(MAX_INLINE_BUNDLE_BYTES).toBeLessThan(MAX_BUNDLE_BYTES)
  })

  it('is version 1', () => {
    expect(BUNDLE_VERSION).toBe(1)
  })
})

describe('enum values that reach a selector or an attribute', () => {
  const withProp = (prop: Record<string, unknown>) => ({
    components: [{ name: 'Card', html: '<div></div>', props: [prop] }],
  })
  const flagged = (prop: Record<string, unknown>) => {
    const parsed = componentBundleSchema.safeParse(bundle(withProp(prop)))
    /* the schema lets the bundle through: the importer skips just that component */
    expect(parsed.success).toBe(true)
    return parsed.success ? unsafePropValue(parsed.data.components[0]!) : 'unparsed'
  }

  it('flags markup, quote, brace, semicolon, backslash and control characters in options and defaults, naming the value', () => {
    for (const bad of ['a</style>', 'x"y', 'a\\b', 'a{b', 'a}b', 'a;b', 'a\nb', 'a\u0000b', 'a<b', 'a>b'])
      expect(flagged({ name: 'tone', type: 'enum', options: ['ok', bad] })).toMatch(
        /prop “tone” has the option [\s\S]*not allowed in an enum option/,
      )
    expect(flagged({ name: 'tone', type: 'enum', options: ['ok'], default: 'a<b' })).toMatch(/has the default “a<b”/)
  })

  it('accepts ordinary options', () => {
    expect(flagged({ name: 'size', type: 'enum', options: ['sm', 'extra large', 'a-b.c_d', '16/9', 'Ünï'] })).toBeNull()
  })
})
