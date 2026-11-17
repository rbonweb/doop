import { parseCss, type CssNode } from '../server/componentCss.ts'
import { describe, expect, it } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import {
  buildComponentBundle,
  diffStyles,
  isEmittedPath,
  renderStory,
  safeDeclarationValue,
  type StoryPage,
} from '../shared/storybook/bundle.ts'
import { captureStory, settleStory, STYLE_PROPERTIES, type CapturedStory } from '../shared/storybook/capture.ts'
import type { StoryEntry } from '../shared/storybook/index.ts'
import { STORYBOOK_LIMITS } from '../shared/storybook/plan.ts'
import { guardCss, splitRules } from '../shared/storybook/cssGuard.ts'
import { probeAttribute, probeInstallSource, probeName } from '../shared/storybook/probe.ts'
import { isBoundedJson } from '../shared/storybook/schemas.ts'

const entry = (title: string, name = 'Default'): StoryEntry => ({
  id: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--${name.toLowerCase()}`,
  title,
  name,
  type: 'story',
  tags: [],
})

const column = (property: string) => STYLE_PROPERTIES.indexOf(property as (typeof STYLE_PROPERTIES)[number])

function shot(overrides: Partial<CapturedStory> = {}): CapturedStory {
  const base = STYLE_PROPERTIES.map(() => '')
  return {
    ok: true,
    html: '<button>x</button>',
    css: '',
    sharedRules: [],
    shape: '0button',
    paths: ['button.btn'],
    styles: [base],
    issues: [],
    ...overrides,
  }
}

/** A page that renders every story as one button with a tone enum, and counts renders. */
function fakePage(log: string[], options: { fail?: (url: string) => boolean } = {}): StoryPage {
  let url = ''
  return {
    installProbe: async () => {},
    goto: async (next) => {
      url = next
      log.push(next)
    },
    waitForState: async () => (options.fail?.(url) ? 'error' : 'ready'),
    readMeta: async () =>
      JSON.stringify({
        argTypes: {
          tone: { control: 'select', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
          on: { control: 'boolean' },
        },
        initialArgs: { tone: 'a' },
        displayName: 'MyButton',
      }),
    evaluateSource: async () => undefined,
    evaluate: (async (fn: unknown) => {
      if (fn === settleStory) return undefined
      if (fn === captureStory) {
        const given = new URL(url).searchParams.get('args') ?? ''
        const tone = given.match(/tone:(\w)/)?.[1] ?? 'a'
        const on = given.includes('on:!true')
        const styles = [
          STYLE_PROPERTIES.map((property) =>
            property === 'color' ? `tone-${tone}` : property === 'opacity' && on ? '0.5' : '',
          ),
        ]
        return JSON.stringify(shot({ styles }))
      }
      throw new Error('unexpected evaluate')
    }) as StoryPage['evaluate'],
  }
}

const withPage =
  (log: string[], options?: Parameters<typeof fakePage>[1]) =>
  async <T>(use: (page: StoryPage) => Promise<T>) =>
    use(fakePage(log, options))

describe('diffStyles', () => {
  it('writes one rule per element whose computed look differs, and nothing for the rest', () => {
    const base = shot({
      shape: '0a,1b',
      paths: ['a.root', 'b:nth-child(1)'],
      styles: [STYLE_PROPERTIES.map(() => ''), STYLE_PROPERTIES.map(() => '')],
    })
    const variant = shot({
      shape: '0a,1b',
      paths: base.paths,
      styles: [STYLE_PROPERTIES.map((p) => (p === 'color' ? 'red' : '')), STYLE_PROPERTIES.map(() => '')],
    })
    expect(diffStyles(base, variant)).toBe('a.root {\n  color: red;\n}')
    expect(diffStyles(base, base)).toBe('')
  })

  it('is undefined when the trees differ in shape or styles are missing', () => {
    expect(diffStyles(shot(), shot({ shape: '0button,1span' }))).toBeUndefined()
    expect(diffStyles(shot(), shot({ styles: null }))).toBeUndefined()
    expect(diffStyles(shot({ styles: null }), shot())).toBeUndefined()
  })

  it('skips values that could close a rule or open markup', () => {
    const variant = shot({
      styles: [STYLE_PROPERTIES.map((p) => (p === 'color' ? 'red;}body{x:y' : p === 'cursor' ? 'pointer' : ''))],
    })
    expect(diffStyles(shot(), variant)).toBe('button.btn {\n  cursor: pointer;\n}')
    expect(column('color')).toBeGreaterThan(-1)
  })
})

describe('buildComponentBundle', () => {
  const source = { kind: 'storybook' as const, url: 'https://sb.test/' }

  it('builds a valid bundle, naming the export after the display name', async () => {
    const log: string[] = []
    const { bundle, renders } = await buildComponentBundle({
      entries: [entry('A/Button')],
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log),
    })
    expect(componentBundleSchema.safeParse(bundle).success).toBe(true)
    expect(bundle.components[0]?.code?.exportName).toBe('MyButton')
    expect(renders).toBe(log.length)
  })

  it('renders each component once and its variants inside the 8 values and 4 axes limits', async () => {
    const log: string[] = []
    const { bundle } = await buildComponentBundle({
      entries: [entry('A/Button')],
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log),
    })
    const component = bundle.components[0]!
    expect(Object.keys(component.variants ?? {}).sort()).toEqual(['on', 'tone'])
    expect(Object.keys(component.variants?.tone ?? {})).toHaveLength(STORYBOOK_LIMITS.values)
    expect(log).toHaveLength(1 + 8 + 1)
  })

  it('never passes 400 renders, and says so', async () => {
    const log: string[] = []
    const entries = Array.from({ length: 60 }, (_, i) => entry(`G/C${i}`))
    const { bundle, issues } = await buildComponentBundle({
      entries,
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log),
    })
    expect(bundle.components).toHaveLength(60)
    expect(log.length).toBeLessThanOrEqual(STORYBOOK_LIMITS.renders)
    expect(issues.some((issue) => issue.code === 'variants_skipped')).toBe(true)
  })

  it('stops at the 10 minute limit with what it has, and says so', async () => {
    let clock = 0
    const entries = [entry('A/One'), entry('A/Two'), entry('A/Three')]
    const log: string[] = []
    const result = await buildComponentBundle({
      entries,
      source,
      baseUrl: 'https://sb.test/',
      now: () => clock,
      withPage: async (use) => {
        clock += STORYBOOK_LIMITS.importMs / 2 + 1
        return use(fakePage(log))
      },
    })
    expect(result.bundle.components.length).toBeGreaterThan(0)
    expect(result.bundle.components.length).toBeLessThan(3)
    expect(result.issues.map((issue) => issue.code)).toContain('import_timeout')
  })

  it('leaves a failing story out and throws when nothing imports', async () => {
    const log: string[] = []
    const some = await buildComponentBundle({
      entries: [entry('A/Good'), entry('A/Bad')],
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log, { fail: (url) => url.includes('a-bad') }),
    })
    expect(some.bundle.components.map((component) => component.name)).toEqual(['Good'])
    expect(some.issues).toContainEqual(expect.objectContaining({ component: 'Bad', code: 'story_failed' }))
    await expect(
      buildComponentBundle({
        entries: [entry('A/Bad')],
        source,
        baseUrl: 'https://sb.test/',
        withPage: withPage([], { fail: () => true }),
      }),
    ).rejects.toThrow('could not be captured')
  })

  it('aborts on the signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      buildComponentBundle({
        entries: [entry('A/One')],
        source,
        baseUrl: 'https://sb.test/',
        withPage: withPage([]),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled')
  })
})

describe('diffStyles against a page that writes its own paths and values', () => {
  const variantWith = (property: string, value: string, paths = ['button.btn']) =>
    shot({ paths, styles: [STYLE_PROPERTIES.map((p) => (p === property ? value : ''))] })

  it.each([
    'b{}@import url(//evil)',
    'button.btn{}x',
    'button.btn, a',
    'button > a',
    'button.btn[data-x]',
    'button.btn:hover',
    '',
    'button.' + 'a'.repeat(5) + '.b.c.d.e.f.g.h',
  ])('refuses the root path %j', (path) => {
    expect(diffStyles(shot({ paths: [path] }), variantWith('color', 'red', [path]))).toBeUndefined()
  })

  it('refuses a descendant path that is not tag:nth-child steps', () => {
    const base = (paths: string[]) =>
      shot({ shape: '0a,1b', paths, styles: [STYLE_PROPERTIES.map(() => ''), STYLE_PROPERTIES.map(() => '')] })
    const next = (paths: string[]) =>
      shot({
        shape: '0a,1b',
        paths,
        styles: [STYLE_PROPERTIES.map(() => ''), STYLE_PROPERTIES.map((p) => (p === 'color' ? 'red' : ''))],
      })
    for (const bad of ['b', 'b:nth-child(1) {} @import x', 'b:nth-child(1), i', 'b:nth-child(x)']) {
      expect(diffStyles(base(['a.root', bad]), next(['a.root', bad])), bad).toBeUndefined()
    }
    const good = ['a.root', 'b:nth-child(1) > i:nth-child(12)']
    expect(diffStyles(base(good), next(good))).toBe('b:nth-child(1) > i:nth-child(12) {\n  color: red;\n}')
  })

  it('accepts the escaped classes capture writes', () => {
    const path = String.raw`button.md\:flex.w-1\/2.\31 23`
    expect(diffStyles(shot({ paths: [path] }), variantWith('color', 'red', [path]))).toContain('color: red;')
  })

  it.each([
    'red; background:url(javascript:x)',
    'red}body{x:y',
    'a/*b',
    'url(javascript:alert(1))',
    'url("data:image/svg+xml;base64,AAAA")',
    'url(https://x.test/a.png)',
    'x\\9',
    '@import "x"',
    'expression(alert(1))',
    '"unbalanced',
    'red !important',
    '<b>',
    '',
    'x'.repeat(501),
  ])('drops the declaration value %j', (value) => {
    expect(safeDeclarationValue(value)).toBe(false)
    expect(diffStyles(shot(), variantWith('color', value))).toBe('')
  })

  it.each([
    'rgb(0, 128, 85)',
    'rgb(0 0 0 / 50%)',
    '"Helvetica Neue", Arial, sans-serif',
    '0px 1px 2px rgba(0, 0, 0, 0.2)',
    'matrix(1, 0, 0, 1, 0, 0)',
    'url("https://cdn.test/a.png")',
    'linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))',
    '微软雅黑',
  ])('keeps the declaration value %j', (value) => {
    expect(safeDeclarationValue(value)).toBe(true)
  })
})

describe('renderStory against a page that lies', () => {
  const pageReturning = (capture: unknown, meta: unknown = { argTypes: {}, initialArgs: {} }): StoryPage => ({
    installProbe: async () => {},
    goto: async () => {},
    waitForState: async () => 'ready',
    readMeta: async () => (typeof meta === 'string' ? meta : JSON.stringify(meta)),
    evaluateSource: async () => undefined,
    evaluate: (async (fn: unknown) => (fn === captureStory ? capture : undefined)) as StoryPage['evaluate'],
  })
  /* what the isolated-world capture sends: one JSON string */
  const sent = (value: unknown) => JSON.stringify(value)
  const request = { baseUrl: 'https://sb.test/', storyId: 'a--b', args: {}, readMeta: true }

  it.each([
    ['styles that are not an array', { ...shot(), styles: {} }],
    ['styles that do not line up with paths', { ...shot(), paths: ['a', 'b'] }],
    ['a style row of the wrong length', { ...shot(), styles: [['x']] }],
    ['an html that is not a string', { ...shot(), html: 5 }],
    ['a huge shape', { ...shot(), shape: 'x'.repeat(20_001) }],
    ['too many shared rules', { ...shot(), sharedRules: Array.from({ length: 501 }, () => 'a{}') }],
    ['a null result', null],
    ['a string that is not JSON', 'ok'],
  ])('turns %s into a failed capture, never a throw', async (_name, result) => {
    const rendered = await renderStory(pageReturning(typeof result === 'string' ? result : sent(result)), request)
    expect(rendered.capture).toEqual({ ok: false, reason: 'The page returned a capture Doop could not read' })
  })

  it('refuses a capture that is not a string within the cap, without parsing it', async () => {
    const raw = await renderStory(pageReturning({ ...shot() }), request)
    expect(raw.capture).toEqual({ ok: false, reason: 'The page returned a capture Doop could not read' })
    const long = await renderStory(pageReturning('{"x":"' + 'x'.repeat(2_000_000) + '"}'), request)
    expect(long.capture).toMatchObject({ ok: false, reason: expect.stringContaining('too large') })
  })

  it('reports the capture function’s own refusals', async () => {
    const big = await renderStory(pageReturning({ ok: false, reason: 'too_large', bytes: 50_000_000 }), request)
    expect(big.capture).toEqual({
      ok: false,
      reason: 'The rendered story is too large to import (50000000 bytes; the limit is 2000000)',
    })
    const many = await renderStory(pageReturning({ ok: false, reason: 'too_many_elements', bytes: 30_000 }), request)
    expect(many.capture).toMatchObject({ ok: false, reason: expect.stringContaining('too many elements') })
    const nothing = await renderStory(pageReturning({ ok: false, reason: 'The story rendered nothing' }), request)
    expect(nothing.capture).toEqual({ ok: false, reason: 'The story rendered nothing' })
  })

  it('ignores a meta that is not what it should be, and says so', async () => {
    for (const meta of [
      { argTypes: {}, initialArgs: {}, displayName: 5 },
      'x',
      { argTypes: { a: 'y'.repeat(401) }, initialArgs: {} },
      '{"argTypes":"' + 'y'.repeat(300_000) + '"}',
    ]) {
      const rendered = await renderStory(pageReturning(sent(shot()), meta), request)
      expect(rendered.capture.ok).toBe(true)
      expect(rendered.props).toEqual([])
      expect(rendered.displayName).toBeUndefined()
      expect(rendered.issues.map((issue) => issue.code)).toContain('argtypes_unavailable')
    }
  })

  it('keeps unknown keys out of what it returns', async () => {
    const rendered = await renderStory(pageReturning({ ...shot(), extra: 'x' }), request)
    expect(rendered.capture).not.toHaveProperty('extra')
  })
})

describe('isBoundedJson', () => {
  it('limits nodes, depth and strings, and refuses functions and non-finite numbers', () => {
    expect(isBoundedJson({ a: [1, 'x', null, true, { b: 2 }] })).toBe(true)
    expect(isBoundedJson('x'.repeat(401))).toBe(false)
    expect(isBoundedJson(Array.from({ length: 20_001 }, () => 1))).toBe(false)
    let deep: unknown = 1
    for (let i = 0; i < 10; i++) deep = { deep }
    expect(isBoundedJson(deep)).toBe(false)
    expect(isBoundedJson({ f: () => 1 })).toBe(false)
    expect(isBoundedJson(Infinity)).toBe(false)
    expect(isBoundedJson(undefined)).toBe(false)
  })
})

describe('a renderer that cannot open pages', () => {
  it('returns what it has with a renderer_unavailable issue after three failures in a row', async () => {
    let opened = 0
    const result = await buildComponentBundle({
      entries: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((name) => entry(`A/${name}`)),
      source: { kind: 'storybook' },
      baseUrl: 'https://sb.test/',
      withPage: async (use) => {
        if (++opened > 1 + 8 + 1) throw new Error('The renderer is busy, try again in a moment')
        return use(fakePage([]))
      },
    })
    expect(result.bundle.components.map((component) => component.name)).toEqual(['One'])
    expect(result.issues.map((issue) => issue.code)).toContain('renderer_unavailable')
  })

  it('throws the renderer error when nothing could be imported', async () => {
    await expect(
      buildComponentBundle({
        entries: [entry('A/One'), entry('A/Two'), entry('A/Three'), entry('A/Four')],
        source: { kind: 'storybook' },
        baseUrl: 'https://sb.test/',
        withPage: async () => {
          throw new Error('The renderer is busy, try again in a moment')
        },
      }),
    ).rejects.toThrow("Doop's renderer could not open pages")
  })
})

/** The CSS of a bundle, parsed with the importer's own parser: what the importer will read, not what the string looks like. */
function assertOnlySafeCss(css: string | undefined, selectors: 'emitted' | 'any'): void {
  if (!css) return
  const allowed = ['font-face', 'keyframes']
  const check = (nodes: CssNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'atomic') {
        expect(allowed, `@${node.name}`).toContain(node.name)
        continue
      }
      if (node.kind === 'group') {
        expect(node.prelude).toMatch(/^@(?:media|supports|container|layer)\b/)
        check(node.nodes)
        continue
      }
      if (selectors === 'emitted') {
        for (const selector of node.selector.split(',').map((part) => part.trim())) {
          expect(
            isEmittedPath(selector, selector.includes(' > ') || selector.includes(':nth-child') ? 1 : 0),
            selector,
          ).toBe(true)
        }
      }
      for (const declaration of node.body.split(';').filter((part) => part.trim())) {
        const value = declaration.slice(declaration.indexOf(':') + 1)
        for (const match of value.matchAll(/url\(\s*["']?([^"')]*)/gi))
          expect(match[1], value).toMatch(/^https?:\/\/|^data:image\//i)
        expect(value).not.toMatch(/javascript|expression|<|@import/i)
      }
    }
  }
  check(parseCss(css))
  expect(css).not.toMatch(/<\/style|@import|<script|\/\*/i)
}

describe('a page that hands back hostile CSS', () => {
  const HOSTILE_VALUE =
    'red; background:url(javascript:alert(1)); } @import url(//evil.test/x.css); </style><script>alert(1)</script>'
  const OK_RULES = '.a { color: red; }\n@media (min-width: 10px) { .a { color: blue; } }'

  function hostilePage(): StoryPage {
    let url = ''
    return {
      installProbe: async () => {},
      goto: async (next) => {
        url = next
      },
      waitForState: async () => 'ready',
      readMeta: async () =>
        JSON.stringify({ argTypes: { tone: { control: 'select', options: ['a', 'b'] } }, initialArgs: { tone: 'a' } }),
      evaluateSource: async () => undefined,
      evaluate: (async (fn: unknown) => {
        if (fn === settleStory) return undefined
        if (fn !== captureStory) throw new Error('unexpected evaluate')
        const variant = url.includes('args=')
        const badPaths = url.includes('hostile-paths')
        return JSON.stringify(
          shot({
            css: [
              OK_RULES,
              '.x { background: url(javascript:alert(1)); }',
              '.y { background: url("https://cdn.test/ok.png"); }',
              '@import url(//evil.test/x.css);',
              '.z { color: red; } </style><script>alert(1)</script>',
            ].join('\n'),
            sharedRules: [
              '@import url(//evil.test/y.css);',
              'body { margin: 0; }',
              'a{}b{',
              ':root { --x: 1 } @charset "x"; ',
            ],
            paths: badPaths ? ['b{}@import url(//evil.test)'] : ['button.btn'],
            styles: [
              STYLE_PROPERTIES.map((property) =>
                variant && property === 'color' ? HOSTILE_VALUE : variant && property === 'cursor' ? 'pointer' : '',
              ),
            ],
          }),
        )
      }) as StoryPage['evaluate'],
    }
  }

  async function bundleOf(title: string) {
    return buildComponentBundle({
      entries: [entry(title)],
      source: { kind: 'storybook' },
      baseUrl: 'https://sb.test/',
      withPage: async (use) => use(hostilePage()),
    })
  }

  it('leaves only whole, safe rules in the component, shared and variant CSS, as a parser sees them', async () => {
    for (const title of ['A/Clean', 'A/Hostile paths']) {
      const { bundle, issues } = await bundleOf(title)
      const component = bundle.components[0]!
      assertOnlySafeCss(bundle.css, 'any')
      assertOnlySafeCss(component.css, 'any')
      expect(component.css).toContain('.a { color: red; }')
      expect(component.css).toContain('.y { background: url("https://cdn.test/ok.png"); }')
      expect(component.css).not.toContain('javascript')
      expect(bundle.css).toContain('body { margin: 0; }')
      expect(bundle.css).not.toContain('@')
      expect(issues.map((issue) => issue.code)).toContain('css_rules_dropped')
      const variants = Object.values(component.variants ?? {}).flatMap((values) => Object.values(values))
      expect(variants.length).toBeGreaterThan(0)
      for (const variant of variants) assertOnlySafeCss(variant.css, title === 'A/Clean' ? 'emitted' : 'any')
    }
  })

  it('writes the variant rule with the safe declarations only, on the emitted path', async () => {
    const { bundle } = await bundleOf('A/Clean')
    expect(bundle.components[0]?.variants?.tone?.b?.css).toBe('button.btn {\n  cursor: pointer;\n}')
  })

  it('falls back to the variant render, not to the hostile path, when the paths are not ones the capture writes', async () => {
    const { bundle } = await bundleOf('A/Hostile paths')
    const variant = bundle.components[0]?.variants?.tone?.b
    expect(variant?.html).toBeDefined()
    expect(variant?.css).not.toContain('@import')
    expect(variant?.css).not.toContain('b{}')
  })
})

describe('guardCss', () => {
  it.each([
    ['@import url(//evil.test/x.css);', ''],
    ['a{} }', 'a{}'],
    ['a{', ''],
    ['a { content: "unterminated }', ''],
    ['a{}b', 'a{}'],
    ['@namespace x url(y);', ''],
    ['@page { margin: 0 }', ''],
    ['@font-face { src: url(javascript:alert(1)) }', ''],
    ['a { background: url(data:text/html,<script>) }', ''],
    ['a { background: url(java\\73 cript:x) }', ''],
    ['a { background: image-set("x.png" 1x) }', ''],
    ['a { width: expression(alert(1)) }', ''],
    ['a { -moz-binding: url("https://x.test/#y") }', ''],
    ['a { color: red } </style><script>x</script>', 'a { color: red }'],
    ['a { content: "</style>" }', ''],
    ['@media screen { @import url(x); }', ''],
    ['a { background: url(https://a.example/x/*) } b { color: red }', ''],
    ['.ok { color: red }\n/* c */ .b { color: blue }', '.ok { color: red }'],
    ['a { content: "/*" }', ''],
  ])('%j keeps %j', (css, kept) => {
    expect(guardCss(css).css).toBe(kept)
  })

  it('keeps well-formed rules of the kinds the capture writes', () => {
    const css =
      '.a:hover > b { color: red }\n@media (min-width: 1px) { .a { margin: 0 } }\n@font-face { font-family: X; src: url("https://f.test/x.woff2") }\n@keyframes k { to { opacity: 0 } }\n.m { background: url("data:image/svg+xml;utf8,<svg/>") }'
    const { css: kept, dropped } = guardCss(css)
    expect(dropped).toBe(0)
    expect(splitRules(kept).rules).toHaveLength(5)
  })

  it('does not let a /* inside an unquoted url() hide an @import from the parser', async () => {
    const hostile =
      'a{background:url(https://a.example/x/*)} @import "//evil.example/e.css"; c{background:url(https://b.example/*/)}'
    const { css } = guardCss(hostile)
    expect(parseCss(css).filter((node) => node.kind === 'atomic')).toEqual([])
    expect(css).not.toContain('@import')
    expect(css).not.toContain('evil.example')
  })

  it('keeps the good rules around a bad one', () => {
    const { css, dropped } = guardCss('.a{color:red}\n.b{background:url(javascript:x)}\n.c{color:blue}')
    expect(dropped).toBe(1)
    expect(css).toBe('.a{color:red}\n.c{color:blue}')
  })
})

describe('the probe', () => {
  it('has a different random name each time, and an attribute a DOM can carry', () => {
    const names = new Set(Array.from({ length: 20 }, () => probeName()))
    expect(names.size).toBe(20)
    for (const name of names) {
      expect(name).toMatch(/^__doop_probe_[0-9a-f]{24}$/)
      expect(probeAttribute(name)).toMatch(/^data-doop-probe-[0-9a-f]{24}$/)
    }
  })

  it('installs as one self-contained expression that needs no helper from this module', () => {
    const source = probeInstallSource('__doop_probe_abc')
    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('"__doop_probe_abc"')
    expect(source).toContain('const __name')
  })
})
