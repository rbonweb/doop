import { selectAll } from 'css-select'
import { parse } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'
import { parseCss, type CssNode } from '../server/componentCss.ts'
import { describe, expect, it } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import {
  BundleImportError,
  buildComponentBundle,
  diffStyles,
  isEmittedPath,
  KnownRenderError,
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
function fakePage(
  log: string[],
  options: { fail?: (url: string) => boolean; withoutControls?: (storyId: string) => boolean; perStory?: boolean } = {},
): StoryPage {
  let url = ''
  return {
    installProbe: async () => {},
    goto: async (next) => {
      url = next
      log.push(next)
    },
    waitForState: async () => (options.fail?.(url) ? 'error' : 'ready'),
    readMeta: async (_probe, storyId) =>
      options.withoutControls?.(String(storyId))
        ? JSON.stringify({ argTypes: {}, initialArgs: {} })
        : JSON.stringify({
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
        /* with perStory, each story is its own markup: the default a div, the Playground a button */
        const playground = options.perStory && new URL(url).searchParams.get('id')?.includes('features')
        return JSON.stringify(
          options.perStory
            ? shot({
                styles,
                html: playground ? '<button class="pg">play</button>' : '<div class="df">default</div>',
                paths: [playground ? 'button.pg' : 'div.df'],
                shape: playground ? '0button' : '0div',
              })
            : shot({ styles }),
        )
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

  it('fails with the needs_worker code when every story needs a service worker, and the component stays out of the issue text', async () => {
    const page = { ...fakePage([]), waitForState: async () => 'needs_worker' as const }
    const error = await buildComponentBundle({
      entries: [entry('Inputs/Button')],
      source,
      baseUrl: 'https://sb.test/',
      withPage: async (use) => use(page),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleImportError)
    expect((error as BundleImportError).code).toBe('needs_worker')
    expect((error as BundleImportError).message).toContain('needs a service worker')
  })

  it('does not start an issue with the component name, since the card names it', async () => {
    const { issues } = await buildComponentBundle({
      entries: [entry('A/Button'), entry('B/Broken')],
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage([], { fail: (url) => url.includes('broken') }),
    })
    const failed = issues.find((issue) => issue.code === 'story_failed')
    expect(failed?.component).toBe('Broken')
    for (const issue of issues) if (issue.component) expect(issue.message.startsWith(`${issue.component}:`)).toBe(false)
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

  it('takes the controls from a Playground when the default story has none, and varies that story', async () => {
    const log: string[] = []
    const entries = [entry('Kit/Btn', 'Default'), entry('Kit/Btn/Features', 'Playground')]
    const result = await buildComponentBundle({
      entries: entries.map((story) => ({ ...story, title: story.title.replace('/Features', '') })),
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log, { withoutControls: (id) => id === 'kit-btn--default' }),
    })
    const [component] = result.bundle.components
    expect(component?.props?.map((prop) => prop.name)).toEqual(['tone', 'on'])
    expect(Object.keys(component?.variants ?? {})).toContain('tone')
    /* the markup and the variants both come from the Playground, and the origin says so */
    expect(component?.code?.origin?.storyId).toBe(entries[1]!.id)
    const variantUrls = log.filter((url) => url.includes('args='))
    expect(variantUrls.length).toBeGreaterThan(0)
    for (const url of variantUrls) expect(url).toContain(`id=${entries[1]!.id}`)
  })

  /* Primer: the default story has no argTypes, its Playground (same title) has them all, and the Features stories sit under a sub-title */
  const primerShaped = [
    entry('Kit/Btn', 'Default'),
    entry('Kit/Btn', 'Playground'),
    entry('Kit/Btn/Features', 'Primary'),
    entry('Kit/Btn/Features', 'Danger'),
  ]

  it('finds the controls on a sibling Playground when the rest of the group sits under a sub-title', async () => {
    const log: string[] = []
    const result = await buildComponentBundle({
      entries: primerShaped,
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage(log, { withoutControls: (id) => id === 'kit-btn--default' }),
    })
    const [component] = result.bundle.components
    expect(component?.props?.map((prop) => prop.name)).toEqual(['tone', 'on'])
    expect(Object.keys(component?.variants ?? {})).toContain('tone')
    expect(component?.code?.origin?.storyId).toBe('kit-btn--playground')
    expect(log.filter((url) => url.includes('id=kit-btn-features'))).toEqual([])
  })

  it('tries a Playground that fails to render once more, so one dropped request does not lose the controls', async () => {
    let playgroundLoads = 0
    const result = await buildComponentBundle({
      entries: primerShaped,
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage([], {
        withoutControls: (id) => id === 'kit-btn--default',
        fail: (url) => url.includes('id=kit-btn--playground') && ++playgroundLoads === 1,
      }),
    })
    expect(playgroundLoads).toBeGreaterThan(1)
    expect(result.bundle.components[0]?.props?.map((prop) => prop.name)).toEqual(['tone', 'on'])
    expect(result.bundle.components[0]?.code?.origin?.storyId).toBe('kit-btn--playground')
  })

  it('says so when the stories that might hold the controls cannot be captured', async () => {
    const result = await buildComponentBundle({
      entries: primerShaped,
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage([], {
        withoutControls: (id) => id === 'kit-btn--default',
        fail: (url) => url.includes('id=kit-btn--playground'),
      }),
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'controls_probe_failed',
        component: 'Btn',
        message: expect.stringContaining('Playground'),
      }),
    )
  })

  it('ships the story that has the controls, so every variant rule matches an element of the markup', async () => {
    const entries = [
      entry('Kit/Btn', 'Default'),
      { ...entry('Kit/Btn', 'Playground'), id: 'kit-btn-features--playground' },
    ]
    const result = await buildComponentBundle({
      entries,
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage([], { withoutControls: (id) => id === 'kit-btn--default', perStory: true }),
    })
    const [component] = result.bundle.components
    expect(component?.html).toBe('<button class="pg">play</button>')
    expect(component?.code?.origin?.storyId).toBe('kit-btn-features--playground')
    expect(component?.code?.origin?.url).toContain('id=kit-btn-features--playground')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'controls_from_story', component: 'Btn' }))
    const doc = parse(component!.html, { treeAdapter: adapter })
    const selectors = Object.values(component?.variants ?? {})
      .flatMap((values) => Object.values(values))
      .flatMap((variant) => parseCss(variant.css ?? ''))
      .flatMap((node) => (node.kind === 'rule' ? [node.selector] : []))
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selectAll(selector, doc).length, selector).toBeGreaterThan(0)
  })

  it('never reports more renders done than planned, probes for controls included', async () => {
    const events: { rendered: number; total: number }[] = []
    await buildComponentBundle({
      entries: [entry('Kit/Btn', 'Default'), { ...entry('Kit/Btn', 'Playground'), id: 'kit-btn-features--playground' }],
      source,
      baseUrl: 'https://sb.test/',
      withPage: withPage([], { withoutControls: (id) => id === 'kit-btn--default' }),
      onRender: (event) => events.push(event),
    })
    expect(events.length).toBeGreaterThan(3)
    for (const event of events) expect(event.total).toBeGreaterThanOrEqual(event.rendered)
    const totals = events.map((event) => event.total)
    expect(totals).toEqual([...totals].sort((a, b) => a - b))
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
    expect(some.issues).toContainEqual(
      expect.objectContaining({
        component: 'Bad',
        code: 'story_failed',
        message: expect.stringMatching(/^The default story/),
      }),
    )
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

describe('bindings on a variant that changes the markup', () => {
  /** A button inside a wrapper, with a `variant` that sets data-variant on the button and an `icon` that adds a child to it. */
  function buttonPage(): StoryPage {
    let url = ''
    return {
      installProbe: async () => {},
      goto: async (next) => {
        url = next
      },
      waitForState: async () => 'ready',
      readMeta: async () =>
        JSON.stringify({
          argTypes: {
            variant: { control: 'select', options: ['default', 'primary'] },
            icon: { control: 'select', options: ['none', 'eye'] },
          },
          initialArgs: { variant: 'default', icon: 'none' },
          displayName: 'Button',
        }),
      evaluateSource: async () => undefined,
      evaluate: (async (fn: unknown, options: { marker?: string }) => {
        if (fn === settleStory) return undefined
        if (fn !== captureStory) throw new Error('unexpected evaluate')
        const given = new URL(url).searchParams.get('args') ?? ''
        const variant = given.includes('variant:primary') ? 'primary' : 'default'
        const eye = given.includes('icon:eye')
        const mark = (index: number) => (options.marker ? ` ${options.marker}="${index}"` : '')
        const styles = STYLE_PROPERTIES.map(() => '')
        return JSON.stringify(
          shot({
            html: `<div class="w"${mark(0)}><button data-variant="${variant}"${mark(1)}>${eye ? `<svg${mark(2)}></svg>` : ''}<span${mark(eye ? 3 : 2)}>Go</span></button></div>`,
            shape: eye ? '0div,1button,2svg,2span' : '0div,1button,2span',
            paths: eye
              ? [
                  'div.w',
                  'button:nth-child(1)',
                  'button:nth-child(1) > svg:nth-child(1)',
                  'button:nth-child(1) > span:nth-child(2)',
                ]
              : ['div.w', 'button:nth-child(1)', 'button:nth-child(1) > span:nth-child(1)'],
            styles: eye ? [styles, styles, styles, styles] : [styles, styles, styles],
            attrs: eye ? [{}, { 'data-variant': variant }, {}, {}] : [{}, { 'data-variant': variant }, {}],
          }),
        )
      }) as StoryPage['evaluate'],
    }
  }

  it('puts the default binding on the button of the variant that adds a child', async () => {
    const { bundle } = await buildComponentBundle({
      entries: [entry('A/Button')],
      source: { kind: 'storybook', url: 'https://sb.test/' },
      baseUrl: 'https://sb.test/',
      withPage: async (use) => use(buttonPage()),
    })
    const component = bundle.components[0]!
    expect(component.html).toContain('<button data-variant="default" data-doop-prop="data-variant:variant">')
    const eye = component.variants?.icon?.eye?.html ?? ''
    expect(eye).toContain('<button data-variant="default" data-doop-prop="data-variant:variant"><svg>')
    expect(eye).not.toContain('data-doop-m-')
    expect(component.html).not.toContain('data-doop-m-')
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

  it('never puts a renderer error message into an issue, only the messages Doop wrote', async () => {
    const cdp =
      'Protocol error (Page.navigate): net::ERR_CONNECTION_REFUSED at http://10.0.0.5:9222/devtools/browser/abc'
    const page = (message: Error): StoryPage => {
      const base = fakePage([])
      return {
        ...base,
        goto: async (url, timeoutMs) => {
          if (url.includes('a-bad')) throw message
          await base.goto(url, timeoutMs)
        },
      }
    }
    const run = (error: Error) =>
      buildComponentBundle({
        entries: [entry('A/Good'), entry('A/Bad')],
        source: { kind: 'storybook' },
        baseUrl: 'https://sb.test/',
        withPage: async (use) => use(page(error)),
      })
    const leaked = await run(new Error(cdp))
    expect(JSON.stringify(leaked.issues)).not.toContain('10.0.0.5')
    expect(JSON.stringify(leaked.issues)).not.toContain('Protocol error')
    expect(leaked.issues).toContainEqual(
      expect.objectContaining({
        component: 'Bad',
        code: 'story_failed',
        message: expect.stringContaining('The renderer could not open this story'),
      }),
    )
    const known = await run(new KnownRenderError('The story did not finish rendering in time'))
    expect(JSON.stringify(known.issues)).toContain('The story did not finish rendering in time')
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
