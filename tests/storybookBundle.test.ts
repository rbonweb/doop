import { describe, expect, it } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import { buildComponentBundle, diffStyles, type StoryPage } from '../shared/storybook/bundle.ts'
import {
  captureStory,
  readStoryMeta,
  settleStory,
  STYLE_PROPERTIES,
  type CapturedStory,
} from '../shared/storybook/capture.ts'
import type { StoryEntry } from '../shared/storybook/index.ts'
import { STORYBOOK_LIMITS } from '../shared/storybook/plan.ts'

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
    goto: async (next) => {
      url = next
      log.push(next)
    },
    waitForState: async () => (options.fail?.(url) ? 'error' : 'ready'),
    evaluateSource: async () => undefined,
    evaluate: (async (fn: unknown) => {
      if (fn === settleStory) return undefined
      if (fn === readStoryMeta) {
        return {
          argTypes: {
            tone: { control: 'select', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
            on: { control: 'boolean' },
          },
          initialArgs: { tone: 'a' },
          displayName: 'MyButton',
        }
      }
      if (fn === captureStory) {
        const given = new URL(url).searchParams.get('args') ?? ''
        const tone = given.match(/tone:(\w)/)?.[1] ?? 'a'
        const on = given.includes('on:!true')
        const styles = [
          STYLE_PROPERTIES.map((property) =>
            property === 'color' ? `tone-${tone}` : property === 'opacity' && on ? '0.5' : '',
          ),
        ]
        return shot({ styles })
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
