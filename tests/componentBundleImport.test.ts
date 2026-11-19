import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  saveToken: () => {},
  deleteComponent: () => {},
}))

import * as actions from '../server/actions.ts'
import { executableParts } from './executableParts.ts'
import { prepareComponent } from '../server/bundleVariants.ts'
import { sanitizeMarkup, sanitizeStylesheet } from '../server/bundleSanitize.ts'
import { ComponentError, createComponentFromHtml, findComponent, updateComponent } from '../server/componentActions.ts'
import {
  guessTokenType,
  IMPORT_PAGE,
  importComponentBundle,
  type ImportResult,
} from '../server/componentBundleImport.ts'
import { blankComponent } from '../server/components.ts'
import * as propagation from '../server/propagation.ts'
import { store } from '../server/store.ts'
import { runOperation } from '../server/workBudget.ts'
import { activeComponents, MAX_COMPONENTS, unsafeUrl } from '../shared/components.ts'
import { cleanLabel, qualifierOf } from '../server/componentBundleImport.ts'
import { primerCapturedButton } from './primerButtonBundle.ts'

const OWNER = 'owner-1'
const actor = actions.resolveActor({ name: 'Importer', kind: 'agent', userId: OWNER })

let canvasId: string

beforeEach(() => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  canvasId = store.createCanvas('Import', OWNER).id
})

const run = (bundle: unknown, dryRun = false): ImportResult =>
  runOperation('test-import', canvasId, () => importComponentBundle({ canvasId, actor }, bundle, { dryRun }))

const CARD_HTML = '<div class="card"><h2 data-doop-prop="title">Title</h2></div>'
const CARD_CSS = '.card { padding: 16px; background: #fff } .card h2 { margin: 0 }'

function cardBundle(over: { css?: string; html?: string } = {}) {
  return {
    version: 1,
    source: { kind: 'agent', name: 'Acme UI' },
    package: '@acme/ui',
    components: [
      {
        name: 'Card',
        description: 'A surface',
        html: over.html ?? CARD_HTML,
        css: over.css ?? CARD_CSS,
        props: [
          { name: 'tone', type: 'enum', options: ['plain', 'raised'] },
          { name: 'badge', type: 'boolean', default: 'false' },
        ],
        variants: {
          tone: { raised: { css: '.card { box-shadow: 0 2px 8px rgba(0,0,0,.2) }' } },
          badge: {
            true: {
              html: '<div class="card"><h2 data-doop-prop="title">Title</h2><span class="badge">New</span></div>',
            },
          },
        },
        code: { exportName: 'Card' },
      },
    ],
  }
}

describe('importing a component bundle', () => {
  it('imports a Card with css and html variants, a text binding and a code mapping', () => {
    const result = run(cardBundle())
    expect(result.created).toHaveLength(1)
    expect(result.skipped).toEqual([])
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(def.code).toMatchObject({ importFrom: '@acme/ui', exportName: 'Card', origin: { kind: 'agent' } })
    expect(def.props.find((prop) => prop.name === 'tone')).toMatchObject({ type: 'enum', default: 'plain' })
    expect(def.props.find((prop) => prop.name === 'badge')).toMatchObject({ type: 'boolean' })
    expect(def.props.some((prop) => prop.name === 'title')).toBe(true)
    expect(def.rawCss).toContain('.card[data-tone="raised"]')
    expect(def.template).toContain('data-doop-if="badge"')
    const page = store.getCanvas(canvasId)!.pages?.find((entry) => entry.name === IMPORT_PAGE)
    expect(page?.id).toBe(result.pageId)
    expect(store.getFrame(def.mainFrameId!)?.pageId).toBe(page?.id)
    expect(actions.getActivity(canvasId)[0]?.message).toBe('imported 1 component from Acme UI')
  })

  it('re-importing updates the same component in place, keeps history and an instance follows', async () => {
    const first = run(cardBundle())
    const id = first.created[0]!.id
    const screen = actions.createFrame(
      canvasId,
      {
        name: 'Screen',
        html: `<!doctype html><html><head></head><body><doop-use component="Card" title="Hi"></doop-use></body></html>`,
      },
      actor,
    )!
    await propagation.whenIdle()
    expect(store.getFrame(screen.id)!.html).toContain(`data-doop-instance="${id}"`)

    const second = run(cardBundle({ css: '.card { padding: 40px; background: #fff } .card h2 { margin: 0 }' }))
    await propagation.whenIdle()
    expect(second.created).toEqual([])
    expect(second.updated.map((entry) => entry.id)).toEqual([id])
    const def = findComponent(canvasId, id)!
    expect(def.rev).toBeGreaterThan(1)
    expect(def.history.length).toBeGreaterThan(0)
    expect(def.rawCss).toContain('padding: 40px')
    expect(activeComponents(store.getComponents(canvasId))).toHaveLength(1)
    expect(store.getFrame(screen.id)!.html).toContain('padding: 40px')
  })

  it('reports an identical re-import as unchanged and writes nothing', () => {
    const id = run(cardBundle()).created[0]!.id
    const rev = findComponent(canvasId, id)!.rev
    const again = run(cardBundle())
    expect(again.unchanged).toEqual([{ name: 'Card', id }])
    expect(again.updated).toEqual([])
    expect(findComponent(canvasId, id)!.rev).toBe(rev)
  })

  it('matches by name and origin kind when there is no export name', () => {
    const bundle = {
      version: 1,
      source: { kind: 'agent' },
      components: [{ name: 'Pill', html: '<span class="pill">x</span>' }],
    }
    const id = run(bundle).created[0]!.id
    const next = {
      ...bundle,
      components: [{ name: 'Pill', html: '<span class="pill">x</span>', css: '.pill{color:red}' }],
    }
    expect(run(next).updated.map((entry) => entry.id)).toEqual([id])
  })

  it('a dry run answers like a real run and writes nothing', () => {
    run(cardBundle())
    const bundle = cardBundle({ css: '.card { padding: 99px }' })
    bundle.components.push({ name: 'Chip', html: '<span class="chip">c</span>' } as never)
    const before = { defs: store.getComponents(canvasId).length, frames: store.getCanvas(canvasId)!.frames.length }
    const result = run({ ...bundle, css: ':root { --ink: #111 }' }, true)
    expect(result.updated.map((entry) => entry.name)).toEqual(['Card'])
    expect(result.created).toEqual([{ name: 'Chip', id: '' }])
    expect(result.tokens.created).toEqual(['--ink'])
    expect({ defs: store.getComponents(canvasId).length, frames: store.getCanvas(canvasId)!.frames.length }).toEqual(
      before,
    )
    expect(store.getTokens(canvasId)).toEqual([])
    expect(findComponent(canvasId, 'Card')!.rawCss).not.toContain('99px')
  })

  it('refuses a bundle that cannot fit, naming the numbers, and writes nothing', () => {
    runOperation('fill', canvasId, () => {
      for (let n = 0; n < MAX_COMPONENTS - 1; n++)
        store.saveComponent(canvasId, blankComponent({ name: `C${n}`, props: [], by: 'x' }))
    })
    const bundle = {
      version: 1,
      source: { kind: 'agent' },
      components: [
        { name: 'A1', html: '<i>a</i>' },
        { name: 'A2', html: '<i>b</i>' },
      ],
    }
    expect(() => run(bundle)).toThrow(/at most 500 components and has 499.*add 2.*501/)
    expect(findComponent(canvasId, 'A1')).toBeUndefined()
  })

  it('refuses a malformed bundle by path', () => {
    expect(() => run({ version: 1, source: { kind: 'agent' }, components: [] })).toThrow(ComponentError)
    expect(() => run({ version: 1, source: { kind: 'agent' }, components: [] })).toThrow(/components/)
  })

  describe('a name another component holds', () => {
    const manual = (name: string) =>
      run({
        version: 1,
        source: { kind: 'agent' },
        components: [{ name, html: '<b>m</b>', code: { origin: { kind: 'manual' } } }],
      })
    const primer = (extra: Record<string, unknown> = {}, name = 'Tag') => ({
      version: 1,
      source: { kind: 'storybook' },
      package: '@primer/react',
      components: [{ name, html: '<i class="tag">t</i>', code: { exportName: 'Tag' }, ...extra }],
    })

    it('is imported under "Name (Package)", keeping the real export, with a renamed issue', () => {
      const own = manual('Tag').created[0]!
      const result = run(primer())
      expect(result.skipped).toEqual([])
      expect(result.created.map((entry) => entry.name)).toEqual(['Tag (Primer)'])
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          component: 'Tag',
          code: 'renamed',
          detail: { from: 'Tag', to: 'Tag (Primer)' },
          message: expect.stringContaining('“Tag (Primer)”'),
        }),
      )
      const def = findComponent(canvasId, result.created[0]!.id)!
      expect(def.code).toMatchObject({ importFrom: '@primer/react', exportName: 'Tag' })
      expect(store.getFrame(def.mainFrameId!)!.name).toBe('Tag (Primer)')
      expect(findComponent(canvasId, own.id)!.name).toBe('Tag')
    })

    it('goes on to " 2", " 3" when the qualified name is taken too', () => {
      manual('Tag')
      manual('Tag (Primer)')
      const second = run(primer())
      expect(second.created.map((entry) => entry.name)).toEqual(['Tag (Primer) 2'])
      expect(second.issues.find((issue) => issue.code === 'renamed')?.detail).toEqual({
        from: 'Tag',
        to: 'Tag (Primer) 2',
      })
      manual('Tag (Primer) 3')
      expect(run(primer()).unchanged.map((entry) => entry.name)).toEqual(['Tag (Primer) 2'])
    })

    it('a second import updates the renamed component in place, with or without an export name', () => {
      manual('Tag')
      const id = run(primer()).created[0]!.id
      const again = run(primer())
      expect(again.created).toEqual([])
      expect(again.unchanged).toEqual([{ name: 'Tag (Primer)', id }])
      /* no export name: matched by the qualified name and the kind of import */
      const bare = (css: string) => ({
        version: 1,
        source: { kind: 'storybook' },
        package: '@primer/react',
        components: [{ name: 'Bare', html: '<i class="bare">t</i>', css }],
      })
      manual('Bare')
      const first = run(bare('.bare{color:red}')).created[0]!
      expect(first.name).toBe('Bare (Primer)')
      expect(run(bare('.bare{color:blue}')).updated.map((entry) => entry.id)).toEqual([first.id])
    })

    it('a clash with the same package and export still updates in place under its own name', () => {
      const id = run(primer()).created[0]!.id
      const again = run(primer({ css: '.tag{color:red}' }))
      expect(again.updated).toEqual([{ name: 'Tag', id }])
      expect(again.issues.some((issue) => issue.code === 'renamed')).toBe(false)
    })

    it('a dry run reports the planned name and writes nothing', () => {
      manual('Tag')
      const before = store.getComponents(canvasId).length
      const dry = run(primer(), true)
      expect(dry.created).toEqual([{ name: 'Tag (Primer)', id: '' }])
      expect(dry.issues.map((issue) => issue.code)).toContain('renamed')
      expect(dry.issues.find((issue) => issue.code === 'renamed')?.detail).toEqual({ from: 'Tag', to: 'Tag (Primer)' })
      expect(store.getComponents(canvasId)).toHaveLength(before)
    })

    it('keeps the name within the limit', () => {
      const long = 'N'.repeat(80)
      manual(long)
      const created = run(primer({}, long)).created[0]!
      expect(created.name.length).toBeLessThanOrEqual(80)
      expect(created.name.endsWith(' (Primer)')).toBe(true)
    })

    it('takes the qualifier from the package, else the source name, else "Imported"', () => {
      const q = (bundle: Record<string, unknown>) => qualifierOf(bundle as never)
      expect(q({ package: '@primer/react', source: { kind: 'cli' } })).toBe('Primer')
      expect(q({ package: 'acme-ui', source: { kind: 'cli' } })).toBe('Acme-ui')
      expect(q({ package: 'acme-ui/button', source: { kind: 'cli' } })).toBe('Acme-ui')
      expect(q({ source: { kind: 'cli', name: 'my lib <b>' } })).toBe('My lib b')
      expect(q({ source: { kind: 'cli' } })).toBe('Imported')
    })
  })

  it('makes tokens only of the :root variables a captured component reaches, through var() chains', () => {
    const result = run({
      version: 1,
      source: { kind: 'storybook', url: 'https://sb.example/' },
      css: ':root { --fg: var(--ink); --ink: #111; --bg: #fff; --unused: 1px; --also-unused: var(--unused); --page: #eee } body { background: var(--page) }',
      components: [
        { name: 'Chip', html: '<p class="chip">c</p>', css: '.chip { color: var(--fg) }' },
        {
          name: 'Tag',
          html: '<p class="tag" style="background: var(--bg)">t</p>',
          props: [{ name: 'tone', type: 'enum', options: ['light', 'dark'] }],
          variants: { tone: { dark: { css: '.tag { border-color: var(--ink) }' } } },
        },
      ],
    })
    expect(result.tokens.created.sort()).toEqual(['--bg', '--fg', '--ink', '--page'])
  })

  it('reads a 15,000-variable var() chain without overflowing the stack', () => {
    const count = 15_000
    const root = Array.from({ length: count }, (_, n) => `--v${n}:var(--v${n + 1});`).join('')
    const result = run({
      version: 1,
      source: { kind: 'storybook', url: 'https://sb.example/' },
      css: `:root { ${root} --v${count}: #111 }`,
      components: [{ name: 'Chip', html: '<p class="chip">c</p>', css: '.chip { color: var(--v0) }' }],
    })
    /* every link of the chain was reached: made a token, or skipped for having no type of its own */
    expect(result.tokens.created.length + result.tokens.skipped.length).toBe(count + 1)
  })

  it('drops the code mapping of props the component does not have, keeps the rest, and still imports it', () => {
    /* what a real Storybook sends: every control is mapped, but only the ones something follows are props here */
    const mapped = [
      'show-dividers',
      'class-name',
      'auto-size',
      'visually-hidden',
      'hide-remove-button',
      'max-width',
      'label-wrap',
    ]
    const result = run({
      version: 1,
      source: { kind: 'storybook', url: 'https://sb.example/' },
      components: [
        {
          name: 'Button',
          html: '<button class="btn">Go</button>',
          props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
          code: {
            exportName: 'Button',
            props: {
              tone: { name: 'kind' },
              ...Object.fromEntries(
                mapped.map((name) => [name, { name: name.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase()) }]),
              ),
            },
          },
        },
      ],
    })
    expect(result.created.map((entry) => entry.name)).toEqual(['Button'])
    expect(result.skipped).toEqual([])
    const issue = result.issues.find((entry) => entry.code === 'code_mapping_dropped')
    expect(issue?.component).toBe('Button')
    for (const name of mapped) expect(issue?.message).toContain(name)
    const def = activeComponents(store.getComponents(canvasId))[0]!
    expect(def.template).toContain('Go')
    expect(def.code?.exportName).toBe('Button')
    /* the one text is the label, so a captured component's export gets it as its children */
    expect(def.code?.props).toEqual({ tone: { name: 'kind' }, label: { name: 'children' } })
  })

  it('names no prop after a class of a captured component, and keeps doing so for an agent bundle', () => {
    const html = '<span class="prc-Label-pTQ3x">Label</span>'
    const names = (kind: 'storybook' | 'agent') => {
      const out = run({ version: 1, source: { kind }, components: [{ name: `Label ${kind}`, html }] })
      expect(out.created).toHaveLength(1)
      return activeComponents(store.getComponents(canvasId))
        .find((def) => def.name === `Label ${kind}`)!
        .props.map((prop) => prop.name)
    }
    const captured = names('storybook')
    expect(captured).toEqual(['label'])
    expect(captured.join()).not.toContain('prc')
    expect(names('agent').join()).toContain('prc')
  })

  it('makes tokens only of the :root variables a captured component reaches, through var() chains', () => {
    const result = run({
      version: 1,
      source: { kind: 'storybook', url: 'https://sb.example/' },
      css: ':root { --fg: var(--ink); --ink: #111; --bg: #fff; --unused: 1px; --also-unused: var(--unused); --page: #eee } body { background: var(--page) }',
      components: [
        { name: 'Chip', html: '<p class="chip">c</p>', css: '.chip { color: var(--fg) }' },
        {
          name: 'Tag',
          html: '<p class="tag" style="background: var(--bg)">t</p>',
          props: [{ name: 'tone', type: 'enum', options: ['light', 'dark'] }],
          variants: { tone: { dark: { css: '.tag { border-color: var(--ink) }' } } },
        },
      ],
    })
    expect(result.tokens.created.sort()).toEqual(['--bg', '--fg', '--ink', '--page'])
  })

  it('reads a 15,000-variable var() chain without overflowing the stack', () => {
    const count = 15_000
    const root = Array.from({ length: count }, (_, n) => `--v${n}:var(--v${n + 1});`).join('')
    const result = run({
      version: 1,
      source: { kind: 'storybook', url: 'https://sb.example/' },
      css: `:root { ${root} --v${count}: #111 }`,
      components: [{ name: 'Chip', html: '<p class="chip">c</p>', css: '.chip { color: var(--v0) }' }],
    })
    /* every link of the chain was reached: made a token, or skipped for having no type of its own */
    expect(result.tokens.created.length + result.tokens.skipped.length).toBe(count + 1)
  })

  it('makes tokens from :root variables and the tokens list, leaving existing ones alone', () => {
    runOperation('seed', canvasId, () =>
      actions.createTokens(canvasId, [{ name: '--brand', type: 'color', value: '#000' }], actor),
    )
    const result = run({
      version: 1,
      source: { kind: 'agent' },
      css: ':root { --brand: #0177d3; --radius-md: 8px; --gap: 12px; --shadow: 0 1px 2px #0003 } .x { color: red }',
      tokens: [
        { name: '--font-body', value: '"Inter", sans-serif' },
        { name: '--bg', value: 'url(javascript:alert(1))' },
      ],
      components: [{ name: 'X', html: '<p class="x">x</p>' }],
    })
    expect(result.tokens.skipped).toContain('--brand')
    expect(result.tokens.skipped).toContain('--shadow')
    expect(result.tokens.created.sort()).toEqual(['--font-body', '--gap', '--radius-md'])
    expect(store.getTokens(canvasId).find((token) => token.name === '--brand')?.value).toBe('#000')
    expect(store.getTokens(canvasId).find((token) => token.name === '--radius-md')?.type).toBe('radius')
    expect(result.issues.some((issue) => issue.code === 'unsafe_token')).toBe(true)
  })

  it('stores nothing hostile from a bundle', () => {
    const result = run({
      version: 1,
      source: { kind: 'agent' },
      components: [
        {
          name: 'Evil',
          html: '<div onclick="x()"><script>alert(1)</script><a href="javascript:alert(1)">go</a><img src="data:image/png;base64,AAAA"><iframe srcdoc="<b>"></iframe></div>',
          css: '@import url(https://evil.test/x.css); .a { background: url(javascript:alert(1)) }',
        },
      ],
    })
    const def = findComponent(canvasId, result.created[0]!.id)!
    const frame = store.getFrame(def.mainFrameId!)!.html
    for (const text of [def.template, def.rawCss, def.css, frame])
      expect(text).not.toMatch(/<script|onclick|javascript:|srcdoc|<iframe|@import|base64/i)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['dropped_element', 'unsafe_url', 'inline_data']),
    )
  })
})

describe('a CLI bundle imported twice', () => {
  const cli = () => ({
    version: 1,
    source: { kind: 'cli', name: 'storybook-static' },
    package: '@acme/ui',
    css: ':root { --brand: #0a5; --shadow: 0 1px 2px #0003 } * { box-sizing: border-box } body { margin: 0 }',
    components: [
      {
        name: 'Button',
        html: '<button class="btn">Go</button>',
        css: '.btn { padding: 1px; color: var(--brand) }',
        props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
        variants: { tone: { b: { css: '.btn { color: red }' } } },
        code: {
          exportName: 'Button',
          origin: { kind: 'cli', storyId: 'button--default', url: 'http://localhost:6006/' },
        },
      },
      { name: 'Badge', html: '<span class="badge"><b>New</b></span>', css: '.badge { color: var(--brand) }' },
    ],
  })

  it('reports every component unchanged, with no revision and no write', () => {
    const first = run(cli())
    expect(first.created).toHaveLength(2)
    const before = first.created.map(({ id }) => {
      const def = findComponent(canvasId, id)!
      return { id, rev: def.rev, updatedAt: def.updatedAt, frameAt: store.getFrame(def.mainFrameId!)!.updatedAt }
    })
    const lines = actions.getActivity(canvasId).length
    const again = run(cli())
    expect(again.created).toEqual([])
    expect(again.updated).toEqual([])
    expect(again.unchanged.map((entry) => entry.name).sort()).toEqual(['Badge', 'Button'])
    for (const entry of before) {
      const def = findComponent(canvasId, entry.id)!
      expect({ rev: def.rev, updatedAt: def.updatedAt, frameAt: store.getFrame(def.mainFrameId!)!.updatedAt }).toEqual({
        rev: entry.rev,
        updatedAt: entry.updatedAt,
        frameAt: entry.frameAt,
      })
      expect(def.history).toEqual([])
    }
    expect(actions.getActivity(canvasId).length).toBe(lines)
    expect(run(cli(), true).unchanged).toHaveLength(2)
  })

  it('leaves out of each component the :root variables that are tokens, and keeps the rest of the shared css', () => {
    const result = run(cli())
    expect(store.getTokens(canvasId).map((token) => token.name)).toContain('--brand')
    for (const { id } of result.created) {
      const css = findComponent(canvasId, id)!.rawCss
      expect(css).not.toMatch(/--brand\s*:/)
      expect(css).toContain('box-sizing: border-box')
    }
  })

  it('drops a :root rule left empty', () => {
    const result = run({
      version: 1,
      source: { kind: 'cli' },
      css: ':root { --brand: #0a5 } .card { margin: 0 }',
      components: [{ name: 'Card', html: '<div class="card">c</div>' }],
    })
    const css = findComponent(canvasId, result.created[0]!.id)!.rawCss
    expect(css).not.toContain(':root')
    expect(css).toContain('margin: 0')
  })
})

describe('the one text of a captured component', () => {
  const bundleOf = (kind: 'storybook' | 'cli' | 'agent', component: object) => ({
    version: 1,
    source: { kind, name: 'Primer' },
    package: '@primer/react',
    components: [component],
  })
  const created = (result: ImportResult) => findComponent(canvasId, result.created[0]!.id)!

  it.each(['storybook', 'cli'] as const)(
    'binds it as label and maps it to children on a %s bundle whose markup already holds bindings',
    (kind) => {
      const def = created(run(bundleOf(kind, primerCapturedButton())))
      expect(def.template).toMatch(/<span data-component="text" data-doop-prop="label"[^>]*>Button<\/span>/)
      expect(def.template).toContain('data-doop-prop="data-variant:variant"')
      expect(def.props.find((prop) => prop.name === 'label')).toMatchObject({ type: 'text' })
      expect(def.code?.props?.label).toEqual({ name: 'children' })
    },
  )

  it('leaves an agent bundle alone: no label binding and no children mapping', () => {
    const def = created(run(bundleOf('agent', primerCapturedButton())))
    expect(def.template).not.toContain('data-doop-prop="label"')
    expect(def.props.some((prop) => prop.name === 'label')).toBe(false)
    expect(def.code?.props?.label).toBeUndefined()
  })

  it('leaves a prop the Storybook named, and the mapping it made, as they were', () => {
    const named = {
      ...primerCapturedButton(
        '<button class="btn" data-variant="default" data-doop-prop="data-variant:variant"><span data-doop-prop="label">Button</span></button>',
      ),
      props: [
        { name: 'variant', type: 'enum' as const, options: ['default', 'primary'], default: 'default' },
        { name: 'label', type: 'text' as const },
      ],
      code: { exportName: 'Button', props: { label: { name: 'caption' } } },
    }
    const def = created(run(bundleOf('storybook', named)))
    expect(def.code?.props?.label).toEqual({ name: 'caption' })
    expect(def.props.filter((prop) => prop.name === 'label')).toHaveLength(1)
  })

  it('infers no second label when the Storybook named one that the markup does not bind', () => {
    const unbound = {
      ...primerCapturedButton(),
      props: [
        { name: 'variant', type: 'enum' as const, options: ['default', 'primary'], default: 'default' },
        { name: 'label', type: 'text' as const },
      ],
    }
    const def = created(run(bundleOf('storybook', unbound)))
    expect(def.template).toContain('Button</span>')
    expect(def.template).not.toMatch(/<span[^>]*data-doop-prop="label"/)
    expect(def.code?.props?.label).toBeUndefined()
  })

  it('infers nothing when the markup shows two texts', () => {
    const two = primerCapturedButton(
      '<button class="btn" data-variant="default" data-doop-prop="data-variant:variant"><span>One</span><span>Two</span></button>',
    )
    const def = created(run(bundleOf('storybook', two)))
    expect(def.template).not.toContain('data-doop-prop="label"')
    expect(def.code?.props?.label).toBeUndefined()
  })

  it('does not pass a rule it would clash with: a children slot or a prop already sent to children', () => {
    const slotted = {
      ...primerCapturedButton(),
      code: { exportName: 'Button', props: { variant: { name: 'children' } } },
    }
    const def = created(run(bundleOf('storybook', slotted)))
    expect(def.props.find((prop) => prop.name === 'label')).toBeDefined()
    expect(def.code?.props?.label).toBeUndefined()
  })

  it('reports a second import of the same bundle as unchanged', () => {
    run(bundleOf('storybook', primerCapturedButton()))
    const again = run(bundleOf('storybook', primerCapturedButton()))
    expect(again.created).toEqual([])
    expect(again.updated).toEqual([])
    expect(again.unchanged.map((entry) => entry.name)).toEqual(['Button'])
    expect(run(bundleOf('storybook', primerCapturedButton()), true).unchanged).toHaveLength(1)
  })
})

describe('a component-valued enum in a bundle code mapping', () => {
  const icons = (code: object, props?: object[]) => ({
    version: 1,
    source: { kind: 'storybook', name: 'Primer' },
    package: '@primer/react',
    components: [
      {
        name: 'IconButton',
        html: '<button class="b" data-icon="HeartIcon" data-doop-prop="data-icon:icon">x</button>',
        props: props ?? [{ name: 'icon', type: 'enum', options: ['HeartIcon', 'StarIcon'] }],
        code: { exportName: 'IconButton', ...code },
      },
    ],
  })

  it('keeps component, importFrom and the renamed values on the stored mapping', () => {
    const mapping = {
      icon: { component: { importFrom: '@primer/octicons-react' }, values: { StarIcon: 'StarFillIcon' } },
    }
    const result = run(icons({ props: mapping }))
    expect(result.created).toHaveLength(1)
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(def.code?.props?.icon).toEqual(mapping.icon)
    expect(run(icons({ props: mapping })).unchanged).toHaveLength(1)
  })

  it('refuses a component mapping on a prop that is not an enum, naming it, and writes no mapping', () => {
    const result = run(icons({ props: { icon: { component: {} } } }, [{ name: 'icon', type: 'text' }]))
    expect(result.created).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toMatch(/code\.props\.icon\.component belongs to an enum prop/)
    expect(activeComponents(store.getComponents(canvasId))).toEqual([])
  })
})

describe('the sanitizer', () => {
  const clean = (html: string) => sanitizeMarkup(html).html

  it('drops elements that run code or load another document', () => {
    for (const tag of ['script', 'noscript', 'iframe', 'object', 'applet', 'portal', 'fencedframe'])
      expect(clean(`<div><${tag}>x</${tag}><p>keep</p></div>`)).toBe('<div><p>keep</p></div>')
    expect(clean('<div><embed src="x"><p>keep</p></div>')).toBe('<div><p>keep</p></div>')
    expect(
      clean('<div><meta http-equiv="refresh" content="0"><base href="//x"><link rel="stylesheet" href="//x">k</div>'),
    ).toBe('<div>k</div>')
  })

  it('drops every on* attribute and srcdoc, ping and formaction', () => {
    expect(clean('<a onclick="x" ONMOUSEOVER="y" ping="//p" href="#a" onfocusin=1>a</a>')).toBe('<a href="#a">a</a>')
    expect(clean('<form formaction="x"><button formaction="javascript:x()">b</button></form>')).not.toContain(
      'formaction',
    )
  })

  it('drops javascript:, vbscript: and data:text/html URLs however they are spelled', () => {
    for (const url of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'vbscript:x',
      'data:text/html,<b>',
      '&#106;avascript:x',
    ])
      expect(clean(`<a href="${url}">a</a>`)).toBe('<a>a</a>')
    for (const attr of ['src', 'action', 'poster', 'xlink:href'])
      expect(clean(`<div ${attr}="javascript:x"></div>`)).toBe('<div></div>')
    expect(clean('<img srcset="a.png 1x, javascript:x 2x">')).toBe('<img>')
    expect(clean('<a href="https://example.test/a">a</a>')).toContain('https://example.test/a')
    expect(clean('<a href="/relative">a</a>')).toContain('/relative')
  })

  it('removes a link-setting animation inside an svg', () => {
    expect(clean('<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>')).not.toContain(
      'javascript',
    )
  })

  it('empties a base64 image and says so', () => {
    const result = sanitizeMarkup('<img alt="x" src="data:image/png;base64,iVBORw0KGgo=">')
    expect(result.html).toContain('src=""')
    expect(result.issues.map((issue) => issue.code)).toContain('inline_data')
  })

  it('keeps template attributes and drops the editor bookkeeping ones', () => {
    const html = clean(
      '<div data-doop-id="abc" data-doop-component="c1" data-doop-instance="i" data-doop-prop="a" data-doop-slot="s" data-doop-slot-suggest="Button" data-doop-if="x" data-doop-part="p">x</div>',
    )
    expect(html).toBe(
      '<div data-doop-prop="a" data-doop-slot="s" data-doop-slot-suggest="Button" data-doop-if="x">x</div>',
    )
  })

  it('keeps <doop-use> and takes a <style> element out as css', () => {
    const result = sanitizeMarkup(
      '<div><doop-use component="Icon"></doop-use><style>.a{color:red}@import "x.css";</style></div>',
    )
    expect(result.html).toBe('<div><doop-use component="Icon"></doop-use></div>')
    expect(result.css).toContain('.a')
    expect(result.css).not.toContain('@import')
  })

  it('cleans css: @import, expression(), behavior:, javascript: and relative urls', () => {
    const css = sanitizeStylesheet(`
      @import url("https://x.test/a.css");
      @charset "utf-8";
      .a { width: expression(alert(1)); color: red; behavior: url(x.htc); -moz-binding: url(x) }
      .b { background: url( "javascript:alert(1)" ) }
      .c { background: url(/img/a.png), url(https://cdn.test/a.png), url(#grad) }
      .d { background: url(data:image/png;base64,AAAA) }
      .e { color:\\65 xpression(1) }
      @media (min-width: 600px) { .f { color: blue; background: url(vbscript:x) } }
      @font-face { font-family: X; src: url(../fonts/x.woff2) }
    `)
    expect(css.value).not.toMatch(
      /@import|expression|behavior|javascript|vbscript|-moz-binding|base64|\/img\/a\.png|\.\.\/fonts/i,
    )
    expect(css.value).toContain('color: red')
    expect(css.value).toContain('https://cdn.test/a.png')
    expect(css.value).toContain('url(#grad)')
    expect(css.value).toContain('color: blue')
    expect(css.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['css_import_dropped', 'unsafe_css', 'css_url_dropped', 'inline_data']),
    )
  })

  it('survives deep and large hostile markup', () => {
    const deep = '<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000)
    expect(() => sanitizeMarkup(deep)).not.toThrow()
    expect(sanitizeStylesheet('{'.repeat(10_000)).value).toBeDefined()
  })
})

describe('variants', () => {
  const base = (css: string, prop: object, variants: object) =>
    prepareComponent({
      name: 'Btn',
      html: '<button class="btn"><i class="icon"></i>Go</button>',
      css: '.btn { color: red; }',
      props: [prop],
      variants: { [(prop as { name: string }).name]: { [Object.keys(variants)[0]!]: { css } } },
    } as never)

  it('scopes rules under the root attribute', () => {
    const out = base(
      '.btn { color: blue } .btn:hover { color: navy } .btn .icon { width: 8px } .icon { height: 8px } .other { x: y } .btn, .x { z: w } @media (min-width: 1px) { .btn { q: r } }',
      { name: 'tone', type: 'enum', options: ['solid', 'ghost'] },
      { ghost: {} },
    ).css
    expect(out).toContain('.btn { color: red; }')
    expect(out).toContain('.btn[data-tone="ghost"] { color: blue; }')
    expect(out).toContain('.btn[data-tone="ghost"]:hover')
    expect(out).toContain('.btn[data-tone="ghost"] .icon')
    expect(out).toContain('[data-tone="ghost"] .icon { height: 8px; }')
    expect(out).toContain('[data-tone="ghost"] .other')
    expect(out).toContain('.btn[data-tone="ghost"], [data-tone="ghost"] .x')
    expect(out).toMatch(/@media \(min-width: 1px\) \{\s*\.btn\[data-tone="ghost"\] \{ q: r; \}/)
  })

  it('gives a boolean with css variants reflect and writes "true"/"false"', () => {
    const out = base('.btn { opacity: .5 }', { name: 'disabled', type: 'boolean' }, { true: {} })
    expect(out.css).toContain('.btn[data-disabled="true"]')
    expect(out.props?.[0]?.reflect).toBe(true)
  })

  it('branches only the child that differs, and keeps the default binding on an element a variant renders unbound', () => {
    const props = [
      { name: 'variant', type: 'enum', options: ['default', 'primary'] },
      { name: 'icon', type: 'enum', options: ['none', 'eye'] },
    ]
    const bound =
      '<button class="b" data-variant="default" data-doop-prop="data-variant:variant"><span>Go</span></button>'
    const unbound = '<button class="b" data-variant="default"><svg></svg><span>Go</span></button>'
    const out = prepareComponent({
      name: 'Button',
      html: `<div class="w">${bound}</div>`,
      props,
      variants: { icon: { eye: { html: `<div class="w">${unbound}</div>` } } },
    } as never)
    expect(out.html).toBe(
      '<div class="w"><button class="b" data-variant="default" data-doop-prop="data-variant:variant"><svg data-doop-if="icon=eye"></svg><span>Go</span></button></div>',
    )
    expect(out.html.match(/<button/g)).toHaveLength(1)
  })

  it('expresses an alternative render with data-doop-if and keeps the default when it cannot', () => {
    const props = [{ name: 'size', type: 'enum', options: ['sm', 'lg'] }]
    const out = prepareComponent({
      name: 'Row',
      html: '<div class="row"><span class="a">A</span><span class="b">B</span></div>',
      props,
      variants: {
        size: {
          lg: {
            html: '<div class="row"><span class="a">A</span><span class="c">C</span><span class="b">B</span></div>',
          },
        },
      },
    } as never)
    expect(out.html).toBe(
      '<div class="row"><span class="a">A</span><span class="c" data-doop-if="size=lg">C</span><span class="b">B</span></div>',
    )
    const replaced = prepareComponent({
      name: 'Row',
      html: '<div class="row"><span class="a">A</span></div>',
      props,
      variants: { size: { lg: { html: '<div class="row"><b class="z">Z</b></div>' } } },
    } as never)
    expect(replaced.html).toContain('<span class="a" data-doop-if="size!=lg">A</span>')
    expect(replaced.html).toContain('<b class="z" data-doop-if="size=lg">Z</b>')
    const other = prepareComponent({
      name: 'Row',
      html: '<div class="row">A</div>',
      props,
      variants: { size: { lg: { html: '<section>Z</section>' } } },
    } as never)
    expect(other.html).toBe('<div class="row">A</div>')
    expect(other.issues.map((issue) => issue.code)).toContain('variant_html_unsupported')
  })
})

describe('token types', () => {
  it('guesses from the value and the name', () => {
    expect(guessTokenType('--brand', '#0177d3')).toBe('color')
    expect(guessTokenType('--radius-lg', '12px')).toBe('radius')
    expect(guessTokenType('--space-3', '12px')).toBe('spacing')
    expect(guessTokenType('--font-weight-bold', '700')).toBe('fontWeight')
    expect(guessTokenType('--font-body', '"Inter", sans-serif')).toBe('fontFamily')
    expect(guessTokenType('--shadow', '0 1px 2px #0003')).toBeUndefined()
  })
})

/* Every route untrusted text takes into a stored frame, proved by parsing what was stored (tests/executableParts.ts). */
describe('nothing a bundle says can run in the frame it makes', () => {
  /** Import the bundle, put an instance of its first component on a frame, and return what both frames hold. */
  async function stored(bundle: unknown) {
    const result = run(bundle)
    const created = result.created[0]
    expect(created).toBeDefined()
    const def = findComponent(canvasId, created!.id)!
    const screen = actions.createFrame(
      canvasId,
      {
        name: 'Screen',
        html: `<!doctype html><html><head></head><body><doop-use component="${def.name}"></doop-use></body></html>`,
      },
      actor,
    )!
    await propagation.whenIdle()
    return { result, main: store.getFrame(def.mainFrameId!)!.html, instance: store.getFrame(screen.id)!.html }
  }
  const one = (component: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    version: 1,
    source: { kind: 'agent' },
    components: [{ name: 'Probe', html: '<div class="probe">x</div>', ...component }],
    ...extra,
  })
  const BREAKOUT = 'a{x:y}</style><script>alert(1)</script><style>b{color:red}'

  it('finds what it should (the helper itself)', () => {
    expect(
      executableParts(
        '<style>a{}</style><script>1</script><a onclick=x href="  JaVa\tScript:1">a</a><svg><set attributeName="onmouseover"/><animate attributeName="href"/></svg>',
      ).length,
    ).toBe(5)
    expect(
      executableParts('<style>a{}</style><p class="x">hi</p><svg><animate attributeName="opacity"/></svg>'),
    ).toEqual([])
  })

  it('css that closes the style element, in component css', async () => {
    const { main, instance } = await stored(one({ css: BREAKOUT }))
    expect(executableParts(main)).toEqual([])
    expect(executableParts(instance)).toEqual([])
  })

  it('css that closes the style element, in the bundle css, a variant and a <style> in the markup', async () => {
    const props = [{ name: 'tone', type: 'enum', options: ['a', 'b'] }]
    const { main, instance } = await stored(
      one(
        {
          html: `<div class="probe">x<style>${BREAKOUT}</style></div>`,
          props,
          variants: { tone: { b: { css: BREAKOUT, html: `<div class="probe">y<style>${BREAKOUT}</style></div>` } } },
        },
        { css: BREAKOUT },
      ),
    )
    expect(executableParts(main)).toEqual([])
    expect(executableParts(instance)).toEqual([])
    expect(main).not.toContain('</style><script')
  })

  it('css in a style attribute and in a selector', async () => {
    const { main, instance } = await stored(
      one({
        html: '<div class="probe" style="background:url(javascript:alert(1));color:red</style><script>alert(2)</script>">x</div>',
        css: '</style><script>alert(3)</script>{color:red} .probe</style><script>alert(4)</script>{color:blue}',
      }),
    )
    expect(executableParts(main)).toEqual([])
    expect(executableParts(instance)).toEqual([])
  })

  it('a later update that sends css with a closing style tag, past the importer', async () => {
    const { result } = await stored(one({}))
    runOperation('update', canvasId, () => updateComponent(canvasId, result.created[0]!.id, { css: BREAKOUT }, actor))
    await propagation.whenIdle()
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(executableParts(store.getFrame(def.mainFrameId!)!.html)).toEqual([])
  })

  it('a component with an enum option that could end an attribute or a selector is skipped, naming it, and the rest import', () => {
    const bad = (name: string, options: string[], extra: Record<string, unknown> = {}) => ({
      name,
      html: '<div class="probe">x</div>',
      props: [{ name: 'tone', type: 'enum', options, ...extra }],
      variants: { tone: { [options[1]!]: { css: '.probe { color: red }' } } },
    })
    const result = run({
      version: 1,
      source: { kind: 'agent' },
      components: [
        bad('Bad1', ['ok', 'a</style><script>alert(8)</script>']),
        bad('Bad2', ['ok', 'x"y']),
        bad('Bad3', ['ok', 'fine'], { default: 'a{b}' }),
        { name: 'Good', html: '<i class="good">g</i>' },
      ],
    })
    expect(result.created.map((entry) => entry.name)).toEqual(['Good'])
    expect(result.skipped.map((entry) => entry.name).sort()).toEqual(['Bad1', 'Bad2', 'Bad3'])
    expect(result.skipped.find((entry) => entry.name === 'Bad1')!.reason).toMatch(
      /option “a<\/style><script>alert\(8\)<\/script>”/,
    )
    expect(result.issues.filter((issue) => issue.code === 'unsafe_prop_value')).toHaveLength(3)
    expect(activeComponents(store.getComponents(canvasId)).map((def) => def.name)).toEqual(['Good'])
    const dry = run({ version: 1, source: { kind: 'agent' }, components: [bad('Bad4', ['ok', 'a;b'])] }, true)
    expect(dry.skipped).toHaveLength(1)
  })

  it('range media and container queries survive, byte for byte, through the sanitizer and the import', async () => {
    const css =
      '@media (width < 600px) { .probe { color: blue; } }\n@container (width<400px) { .probe { color: green; } }'
    const clean = sanitizeStylesheet(css).value
    expect(clean).toContain('@media (width < 600px)')
    expect(clean).toContain('@container (width<400px)')
    expect(clean).not.toContain('\\3c')
    const props = [{ name: 'tone', type: 'enum', options: ['a', 'b'] }]
    const { main, instance } = await stored(
      one({ css: '.probe { color: red }', props, variants: { tone: { b: { css } } } }, { css }),
    )
    const def = findComponent(canvasId, 'Probe')!
    expect(def.rawCss).toContain('@media (width < 600px)')
    expect(def.rawCss).toContain('@container (width<400px)')
    expect(def.rawCss).toContain('@media (width < 600px) {\n.probe[data-tone="b"] { color: blue; }')
    expect(main).toContain('(width < 600px)')
    expect(executableParts(main)).toEqual([])
    expect(executableParts(instance)).toEqual([])
  })

  it('an enum option that is awkward but safe is scoped as an escaped attribute value', async () => {
    const { main } = await stored(
      one({
        css: '.probe { color: red }',
        props: [{ name: 'tone', type: 'enum', options: ['plain', 'a b-c.d'] }],
        variants: { tone: { 'a b-c.d': { css: '.probe { color: blue }' } } },
      }),
    )
    expect(main).toContain('[data-tone="a b-c.d"]')
    expect(executableParts(main)).toEqual([])
  })

  it('svg animations aimed at event handlers or links, and strings in attributes', async () => {
    const { main, instance } = await stored(
      one({
        html: [
          '<div class="probe"><svg viewBox="0 0 1 1">',
          '<a href="https://x.test"><set attributeName="href" to="javascript:alert(1)"/></a>',
          '<set attributeName="onmouseover" to="alert(2)"/>',
          '<animate attributeName="xlink:href" values="javascript:alert(3)"/>',
          '<animateMotion attributeName="onclick" path="M0,0"/>',
          '<animateTransform attributeName="onload" type="rotate"/>',
          '<animate attributeName="opacity" from="0" to="1"/>',
          '</svg><img src="x" onerror="alert(4)" alt="&quot;><script>alert(5)</script>"></div>',
        ].join(''),
      }),
    )
    expect(executableParts(main)).toEqual([])
    expect(executableParts(instance)).toEqual([])
    expect(main).toContain('attributeName="opacity"')
  })

  it('names and the source label that reach frame names and the activity line carry no markup', () => {
    const result = run({
      version: 1,
      source: { kind: 'agent', name: '<img src=x onerror=alert(1)>Acme "UI"\u0007' },
      components: [{ name: 'Bad<script>\u0000"Name', html: '<i>x</i>' }],
    })
    const line = actions.getActivity(canvasId)[0]!.message
    expect(hasMarkupOrControl(line)).toBe(false)
    expect(executableParts(`<p>${line}</p>`)).toEqual([])
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(hasMarkupOrControl(def.name)).toBe(false)
    expect(store.getFrame(def.mainFrameId!)!.name).toBe(def.name)
    expect(cleanLabel('  a\n\tb <c> "d"  ')).toBe('a b c d')
  })

  it('base64 data in css outside url() is removed everywhere css can sit', async () => {
    const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    const { result, main, instance } = await stored(
      one(
        {
          html: `<div class="probe" style="background:image-set('${b64}' 1x)">x</div>`,
          css: `.probe { background: -webkit-image-set("${b64}" 1x); content: "${b64}" }`,
          props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
          variants: { tone: { b: { css: `.probe { background: image-set("${b64}" 1x) }` } } },
        },
        { css: `.probe { border-image: image-set("${b64}" 1x) }` },
      ),
    )
    expect(main).not.toMatch(/base64/i)
    expect(instance).not.toMatch(/base64/i)
    expect(result.issues.filter((issue) => issue.code === 'inline_data').length).toBeGreaterThan(0)
  })

  it('variant css keeps only scoped rules and media-like blocks, and says what it dropped', () => {
    const out = prepareComponent({
      name: 'Btn',
      html: '<button class="btn">x</button>',
      props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
      variants: {
        tone: {
          b: {
            css: '@scope (html) { * { background: red } } @starting-style { body { color: red } } @keyframes k { from { x: y } } @font-face { font-family: F } @layer l { .btn { color: blue } } .btn { color: green }',
          },
        },
      },
    } as never)
    expect(out.css).not.toMatch(/@scope|@starting-style|@keyframes|@font-face/)
    expect(out.css).toContain('.btn[data-tone="b"] { color: blue; }')
    expect(out.css).toContain('.btn[data-tone="b"] { color: green; }')
    expect(out.issues.filter((issue) => issue.code === 'variant_css_at_rule')).toHaveLength(4)
  })

  it('the bundle css is sanitized like a component css and leads each stylesheet', async () => {
    const { result, main } = await stored(
      one(
        { html: '<div class="probe card">x</div>', css: '.probe { color: red }' },
        {
          css: '@import url(https://evil.test/x.css); .card { margin: 0 } .z { background: url(javascript:alert(1)) } :root { --ink: #111 }',
        },
      ),
    )
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(def.rawCss).toContain('margin: 0')
    expect(main).not.toMatch(/@import|javascript:/i)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['css_import_dropped', 'unsafe_css']),
    )
    expect(store.getTokens(canvasId).some((token) => token.name === '--ink')).toBe(true)
  })

  it('a failure after earlier batches committed answers with the partial result, not an error', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const components = Array.from({ length: 8 }, (_, n) => ({ name: `P${n}`, html: `<i class="p${n}">x</i>` }))
    let calls = 0
    /* calls: page and tokens, layout, first batch of six, second batch: this one fails */
    const result = importComponentBundle(
      {
        canvasId,
        actor,
        batch: (work) => {
          if (++calls === 4) throw new Error('boom')
          return runOperation('batch', canvasId, work)
        },
      },
      { version: 1, source: { kind: 'agent' }, components },
    )
    quiet.mockRestore()
    expect(result.created).toHaveLength(6)
    expect(result.skipped.map((entry) => entry.name)).toEqual(['P6', 'P7'])
    expect(result.issues.map((issue) => issue.code)).toContain('import_failed')
    expect(activeComponents(store.getComponents(canvasId))).toHaveLength(6)
  })
})

function hasMarkupOrControl(text: string): boolean {
  return [...text].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f || '<>"'.includes(char))
}

/* A prop value is instance data: bound to an event handler or to an address it could become code. Parsed, not matched. */
describe('bindings never make a prop an event handler or a script address', () => {
  const frameWith = async (use: string) => {
    const frame = actions.createFrame(
      canvasId,
      { name: 'Screen', html: `<!doctype html><html><head></head><body>${use}</body></html>` },
      actor,
    )!
    await propagation.whenIdle()
    return store.getFrame(frame.id)!.html
  }

  it('the importer drops the on* and srcdoc pieces of a binding list and keeps the rest', () => {
    const result = sanitizeMarkup(
      '<a data-doop-prop="onclick:x,ONMOUSEOVER:x,href:target,label" href="#">go</a><b data-doop-prop="onfocus:y">b</b><i data-doop-prop="srcdoc:z,title:t">i</i>',
    )
    expect(result.html).toBe(
      '<a data-doop-prop="href:target,label" href="#">go</a><b>b</b><i data-doop-prop="title:t">i</i>',
    )
    expect(result.issues.filter((issue) => issue.code === 'binding_dropped')).toHaveLength(4)
  })

  it('a bundle with on* and href bindings, and an instance whose href is javascript:, stores nothing executable', async () => {
    const result = run({
      version: 1,
      source: { kind: 'agent' },
      components: [
        {
          name: 'Probe',
          html: '<a class="probe" data-doop-prop="onclick:x,ONMOUSEOVER:x,href:target,label" href="#">go</a>',
        },
      ],
    })
    const def = findComponent(canvasId, result.created[0]!.id)!
    expect(executableParts(store.getFrame(def.mainFrameId!)!.html)).toEqual([])
    expect(def.template).not.toMatch(/onclick|onmouseover/i)
    expect(result.issues.map((issue) => issue.code)).toContain('binding_dropped')
    const instance = await frameWith('<doop-use component="Probe" target="javascript:alert(1)" label="hi"></doop-use>')
    expect(executableParts(instance)).toEqual([])
    expect(instance).toContain('>hi<')
    const fine = await frameWith('<doop-use component="Probe" target="https://ok.test/a" label="ok"></doop-use>')
    expect(fine).toContain('href="https://ok.test/a"')
    expect(executableParts(fine)).toEqual([])
  })

  it('the engine refuses an on* target and a script address on every path, create_component included', async () => {
    runOperation('create', canvasId, () =>
      createComponentFromHtml(
        canvasId,
        {
          name: 'Btn',
          html: '<a class="b" data-doop-prop="onclick:x,onmouseover:x,href:target,formaction:go,src:pic,label" href="#">go</a>',
          props: [{ name: 'pic', type: 'image' }],
        },
        actor,
      ),
    )
    const def = findComponent(canvasId, 'Btn')!
    expect(def.template).toContain('onclick:x')
    for (const value of [
      'javascript:alert(1)',
      ' JaVa\tScript:alert(1)',
      'vbscript:x',
      'data:text/html,<script>alert(1)</script>',
    ])
      expect(
        executableParts(
          await frameWith(
            `<doop-use component="Btn" x="alert(2)" target="${value}" go="${value}" pic="${value}" label="l"></doop-use>`,
          ),
        ),
      ).toEqual([])
    const html = await frameWith('<doop-use component="Btn" x="alert(2)" target="/ok" label="l"></doop-use>')
    expect(executableParts(html)).toEqual([])
    expect(html).toContain('href="/ok"')
  })

  it('checks every srcset candidate, not only the first', async () => {
    expect(unsafeUrl('a.png 1x, data:text/html,<b>x</b> 2x')).toBe(true)
    expect(unsafeUrl('a.png 1x, JaVa\tScript:alert(1) 2x')).toBe(true)
    expect(unsafeUrl('a.png 1x, b.png 2x')).toBe(false)
    expect(unsafeUrl('data:image/png;base64,AAAA')).toBe(false)
    const result = run({
      version: 1,
      source: { kind: 'agent' },
      components: [{ name: 'Pic', html: '<img class="pic" data-doop-prop="srcset:s" src="/a.png" alt="">' }],
    })
    expect(result.created).toHaveLength(1)
    const html = await frameWith(
      '<doop-use component="Pic" s="a.png 1x, data:text/html,<script>alert(1)</script> 2x"></doop-use>',
    )
    expect(executableParts(html)).toEqual([])
    const fine = await frameWith('<doop-use component="Pic" s="a.png 1x, b.png 2x"></doop-use>')
    expect(fine).toContain('srcset="a.png 1x, b.png 2x"')
  })

  it('refuses a bound attributeName on an svg animation, and script values bound to its to, from and values', async () => {
    const svg = (extra: string) =>
      `<div class="anim"><svg viewBox="0 0 1 1"><a><set data-doop-prop="${extra}" to="1"/></a></svg></div>`
    /* through the importer: the attributeName piece is dropped, the others stay and are checked when set */
    const imported = run({
      version: 1,
      source: { kind: 'agent' },
      components: [{ name: 'Anim', html: svg('attributeName:an,to:tv,from:fr,values:vs') }],
    })
    expect(imported.issues.map((issue) => issue.code)).toContain('binding_dropped')
    expect(findComponent(canvasId, 'Anim')!.template).not.toMatch(/attributename:an/i)
    /* past the importer, in a template written another way */
    runOperation('create', canvasId, () =>
      createComponentFromHtml(
        canvasId,
        { name: 'Anim2', html: svg('attributeName:an,to:tv,from:fr,values:vs'), autoProps: false },
        actor,
      ),
    )
    expect(findComponent(canvasId, 'Anim2')!.template).toMatch(/attributename:an/i)
    for (const name of ['Anim', 'Anim2'])
      for (const value of ['javascript:alert(1)', 'vbscript:x'])
        expect(
          executableParts(
            await frameWith(
              `<doop-use component="${name}" an="href" tv="${value}" fr="${value}" vs="a;${value}"></doop-use>`,
            ),
          ),
        ).toEqual([])
    const html = await frameWith('<doop-use component="Anim2" an="onclick" tv="alert(1)"></doop-use>')
    expect(executableParts(html)).toEqual([])
  })
})
