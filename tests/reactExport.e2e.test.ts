import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
import { renderInstanceHtml } from '../server/componentEngine.ts'
import { buildReactExport, componentReactFiles, type ReactExportInput } from '../server/reactExport/index.ts'
import { COMPONENT_ATTR, activeComponents, type ComponentDef, type ComponentProp } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'
import { normalize, renderAll, typecheck, writeProject, type Project } from './reactExportHarness'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const BUTTON_CSS = `.btn { padding: 8px 12px; border: 0; background: var(--color-primary, #0a58ca); color: #fff }
.label { font-weight: 600 }`
const CARD_CSS = `.card { display: grid; gap: 8px; padding: 16px; border: 1px solid #ddd }
.card[data-tone="ghost"] { background: transparent }
.title { margin: 0; font-size: 18px }
.badge { font-size: 11px; background: url(/a/badge.png) no-repeat }
.actions { display: flex; gap: 8px }`

let canvasId: string

function makeComponent(name: string, markup: (id: string) => string, css: string, props: ComponentProp[] = []) {
  const def = blankComponent({ name, by: 'Tester', props })
  store.saveComponent(canvasId, def)
  const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
  actions.updateFrame(frame.id, { html: doc(markup(def.id), css) }, actor)
  return { id: def.id, def: () => store.getComponents(canvasId).find((candidate) => candidate.id === def.id)! }
}

/** the worked example: a Button, a Card that forwards `cta` to the Button and holds an `actions` slot, and a frame using the Card twice */
function workedExample() {
  canvasId = store.createCanvas('react export').id
  const button = makeComponent(
    'Button',
    (id) =>
      `<button ${COMPONENT_ATTR}="${id}" class="btn"><span class="label" data-doop-prop="label">Click</span></button>`,
    BUTTON_CSS,
  )
  const card = makeComponent(
    'Card',
    (id) =>
      `<article ${COMPONENT_ATTR}="${id}" class="card"><h3 class="title" data-doop-prop="title">Card</h3>` +
      `<img src="/a/cover.png" alt="cover" data-doop-prop="cover">` +
      `<span class="badge" data-doop-if="badge">New</span>` +
      `<doop-use component="${button.id}" label="Go" data-doop-prop="label:cta"></doop-use>` +
      `<div class="actions" data-doop-slot="actions"><doop-use component="${button.id}" label="More"></doop-use></div></article>`,
    CARD_CSS,
    [
      { name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
      { name: 'badge', type: 'boolean', default: 'false', reflect: true },
    ],
  )
  const page = actions.createFrame(canvasId, { name: 'Pricing', html: '' }, actor)!
  actions.updateFrame(
    page.id,
    {
      html: doc(
        `<h1 class="hero">Plans</h1>` +
          `<doop-use component="${card.id}" title="Pro" tone="ghost" badge="true" cta="Buy"></doop-use>` +
          `<doop-use component="${card.id}" title="Free" cta="Start"><template slot="actions"><doop-use component="${button.id}" label="Custom"></doop-use></template></doop-use>`,
        `.hero { font-size: 32px } body { margin: 0 }`,
      ),
    },
    actor,
  )
  return { button, card, pageId: page.id }
}

const input = (pageId: string | null, extra: Partial<ReactExportInput> = {}): ReactExportInput => ({
  canvasName: 'react export',
  components: activeComponents(store.getComponents(canvasId)),
  frames: pageId ? [{ id: pageId, name: 'Pricing', html: store.getFrame(pageId)!.html }] : [],
  tokens: [],
  themeOrder: [],
  styling: 'modules',
  assetOrigin: 'https://doop.example',
  ...extra,
})

const expected = (id: string, props: Record<string, string>) =>
  normalize(
    renderInstanceHtml(
      store.getComponents(canvasId).find((def) => def.id === id)!,
      { instanceId: 'abcdef', overrides: { props } },
      contextFor(canvasId),
    ),
  )

describe('React export end to end, CSS Modules', () => {
  let projects: Project[] = []
  afterAll(() => projects.forEach((project) => project.cleanup()))
  beforeAll(() => {
    projects = []
  })

  it('type-checks strictly, renders the same DOM as Doop and keeps nothing relative', async () => {
    const { button, card, pageId } = workedExample()
    const result = buildReactExport(input(pageId))
    expect(result.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'README.md',
        'export-report.json',
        'src/cx.ts',
        'src/css-modules.d.ts',
        'src/components/Button.tsx',
        'src/components/Button.module.css',
        'src/components/Card.tsx',
        'src/components/Card.module.css',
        'src/components/index.ts',
        'src/pages/Pricing.tsx',
        'src/pages/Pricing.css',
        'src/tokens.css',
        'src/tokens.json',
      ]),
    )
    const project = writeProject(result.files)
    projects.push(project)
    expect(typecheck(project)).toEqual([])

    const out = await renderAll(project, {
      buttonDefault: { from: './src/components/Button', name: 'Button' },
      buttonBuy: { from: './src/components/Button', name: 'Button', props: { label: 'Buy' } },
      cardDefault: { from: './src/components/Card', name: 'Card' },
      cardFull: {
        from: './src/components/Card',
        name: 'Card',
        props: { title: 'Pro', tone: 'ghost', badge: true, cta: 'Buy', cover: '/a/x.png' },
      },
      page: { from: './src/pages/Pricing', name: 'Pricing' },
    })
    expect(normalize(out.buttonDefault!)).toBe(expected(button.id, {}))
    expect(normalize(out.buttonBuy!)).toBe(expected(button.id, { label: 'Buy' }))
    expect(normalize(out.cardDefault!)).toBe(
      expected(card.id, {}).replace(/src="\/a\/cover.png"/, 'src="https://doop.example/a/cover.png"'),
    )
    expect(normalize(out.cardFull!)).toBe(
      expected(card.id, { title: 'Pro', tone: 'ghost', badge: 'true', cta: 'Buy', cover: '/a/x.png' }),
    )

    // the page is the stored frame's body, in a wrapper
    const body = /<body>([\s\S]*)<\/body>/.exec(store.getFrame(pageId)!.html)![1]!
    const wrapper = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(out.page!)![1]!
    expect(normalize(wrapper)).toBe(
      normalize(body).replace(/src="\/a\/cover.png"/g, 'src="https://doop.example/a/cover.png"'),
    )

    // no relative URL or file reference survived, and assets are absolute
    const all = result.files.map((file) => file.content).join('\n')
    expect(all).not.toContain('dangerouslySetInnerHTML')
    expect(result.files.find((f) => f.path === 'src/components/Card.module.css')!.content).toContain(
      'url("https://doop.example/a/badge.png")',
    )
  })

  it('is deterministic and gives "Copy as React" the one component', () => {
    const { card } = workedExample()
    const a = buildReactExport(input(null, { componentIds: [card.id] }))
    const b = buildReactExport(input(null, { componentIds: [card.id] }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const single = componentReactFiles({ ...input(null), componentId: card.id })
    expect(single.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['src/components/Card.tsx', 'src/components/Card.module.css']),
    )
    expect(single.files.every((file) => !file.path.includes('Button'))).toBe(true)
    expect(single.files.find((file) => file.path === 'src/components/Card.tsx')!.content).toContain("from './Button'")
  })
})

describe('React export end to end, a component mapped to the team package', () => {
  it('imports Button from the package with label as children and emits no Button file', async () => {
    const { button, card, pageId } = workedExample()
    const def = store.getComponents(canvasId).find((candidate) => candidate.id === button.id)!
    store.saveComponent(canvasId, {
      ...def,
      code: { importFrom: '@acme/ui', exportName: 'Button', props: { label: { name: 'children' } } },
    })
    const result = buildReactExport(input(pageId))
    expect(result.files.some((file) => file.path.startsWith('src/components/Button'))).toBe(false)
    const cardTsx = result.files.find((file) => file.path === 'src/components/Card.tsx')!.content
    expect(cardTsx).toContain('import { Button } from "@acme/ui"')
    expect(cardTsx).toMatch(/<Button>\s*\{cta \?\? "Go"\}\s*<\/Button>/)
    expect(result.report.components.find((entry) => entry.id === button.id)).toMatchObject({
      importedFrom: '@acme/ui',
      exportName: 'Button',
    })

    const stub = {
      'index.js':
        'const { createElement } = require("react"); exports.Button = ({ children }) => createElement("button", { className: "acme-btn" }, children)\n',
      'index.d.ts':
        "import type { ReactNode } from 'react'\nexport declare function Button(props: { children?: ReactNode }): JSX.Element\n",
      'package.json': '{"name":"@acme/ui","main":"index.js","types":"index.d.ts"}\n',
    }
    const project = writeProject(
      result.files,
      Object.fromEntries(Object.entries(stub).map(([name, content]) => [`@acme/ui/${name}`, content])),
    )
    try {
      expect(typecheck(project)).toEqual([])
      const out = await renderAll(project, {
        card: { from: './src/components/Card', name: 'Card', props: { cta: 'Buy', title: 'T' } },
      })
      expect(out.card).toContain('<button class="acme-btn">Buy</button>')
      expect(card.id).toBeTruthy()
    } finally {
      project.cleanup()
    }
  })
})

describe('React export end to end, a Primer-shaped Button with children and icon components', () => {
  const stubs = (withIcons: boolean): Record<string, string> => ({
    '@primer/react/package.json': '{"name":"@primer/react","main":"index.js","types":"index.d.ts"}\n',
    '@primer/react/index.d.ts': [
      "import type { ElementType, ReactNode } from 'react'",
      'export declare function Button(props: {',
      "  variant?: 'default' | 'primary' | 'danger'",
      "  size?: 'small' | 'medium' | 'large'",
      '  trailingVisual?: ElementType',
      '  leadingVisual?: ElementType',
      '  children?: ReactNode',
      '}): JSX.Element',
      '',
    ].join('\n'),
    '@primer/react/index.js': [
      'const { createElement } = require("react")',
      'exports.Button = ({ variant = "default", trailingVisual, children }) =>',
      '  createElement("button", { "data-variant": variant }, children, trailingVisual ? createElement(trailingVisual) : null)',
      '',
    ].join('\n'),
    ...(withIcons
      ? {
          '@primer/octicons-react/package.json':
            '{"name":"@primer/octicons-react","main":"index.js","types":"index.d.ts"}\n',
          '@primer/octicons-react/index.d.ts':
            'export declare const HeartIcon: () => JSX.Element\nexport declare const XIcon: () => JSX.Element\n',
          '@primer/octicons-react/index.js': [
            'const { createElement } = require("react")',
            'const icon = (name) => () => createElement("svg", { className: "octicon octicon-" + name })',
            'exports.HeartIcon = icon("heart")',
            'exports.XIcon = icon("x")',
            '',
          ].join('\n'),
        }
      : {}),
  })

  const primerButton = (importFrom: string | undefined): ComponentDef => ({
    id: 'c-button',
    name: 'Button',
    description: '',
    template:
      '<button data-doop-part="r" data-doop-prop="data-variant:variant"><span data-doop-part="l" data-doop-prop="label">Button</span></button>',
    css: '',
    rawCss: '',
    head: [],
    props: [
      { name: 'label', type: 'text' },
      { name: 'variant', type: 'enum', options: ['default', 'primary', 'danger'], default: 'default' },
      { name: 'trailing-visual', type: 'enum', options: ['HeartIcon', 'XIcon'] },
    ],
    slots: [],
    rev: 1,
    mainFrameId: null,
    history: [],
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'test',
    code: {
      importFrom: '@primer/react',
      exportName: 'Button',
      props: {
        label: { name: 'children' },
        'trailing-visual': { name: 'trailingVisual', component: importFrom ? { importFrom } : {} },
      },
    },
  })

  const exportPage = (importFrom: string | undefined) => {
    const button = primerButton(importFrom)
    const body =
      `<doop-use component="c-button" label="Buy" variant="primary" trailing-visual="HeartIcon"></doop-use>` +
      `<doop-use component="c-button" label="Close &amp; go" trailing-visual="XIcon"></doop-use>`
    return buildReactExport({
      canvasName: 'primer',
      components: [button],
      frames: [
        {
          id: 'f1',
          name: 'Home',
          html: `<!doctype html><html><head></head><body>${body}</body></html>`,
        },
      ],
      tokens: [],
      themeOrder: [],
      styling: 'modules',
      assetOrigin: 'https://doop.example',
    })
  }

  it('passes the label as children and the icons as imported components, and type-checks against the package typings', async () => {
    const result = exportPage('@primer/octicons-react')
    const home = result.files.find((file) => file.path === 'src/pages/Home.tsx')!.content
    expect(home).toContain('import { Button } from "@primer/react"')
    expect(home).toContain('import { HeartIcon, XIcon } from "@primer/octicons-react"')
    expect(home).toMatch(/<Button variant=\{"primary"\} trailingVisual=\{HeartIcon\}>\s*Buy\s*<\/Button>/)
    expect(home).toMatch(/<Button trailingVisual=\{XIcon\}>\s*\{"Close & go"\}\s*<\/Button>/)
    expect(result.report.issues).toEqual([])
    const project = writeProject(result.files, stubs(true))
    try {
      expect(typecheck(project)).toEqual([])
      const out = await renderAll(project, { home: { from: './src/pages/Home', name: 'Home' } })
      expect(out.home).toContain('<button data-variant="primary">Buy<svg class="octicon octicon-heart"></svg></button>')
      expect(out.home).toContain(
        '<button data-variant="default">Close &amp; go<svg class="octicon octicon-x"></svg></button>',
      )
    } finally {
      project.cleanup()
    }
  })

  it('still type-checks and renders when the icon package is unknown: the prop is left out and the report says so', async () => {
    const result = exportPage(undefined)
    const home = result.files.find((file) => file.path === 'src/pages/Home.tsx')!.content
    expect(home).toContain('trailingVisual={undefined /* TODO: pass HeartIcon */}')
    expect(home).not.toContain('octicons')
    expect(result.report.issues.map((issue) => issue.detail).join('\n')).toMatch(/"trailing-visual" is "HeartIcon"/)
    const project = writeProject(result.files, stubs(false))
    try {
      expect(typecheck(project)).toEqual([])
      const out = await renderAll(project, { home: { from: './src/pages/Home', name: 'Home' } })
      expect(out.home).toContain('<button data-variant="primary">Buy</button>')
    } finally {
      project.cleanup()
    }
  })
})

describe('React export end to end, Tailwind', () => {
  const classCandidates = (files: { path: string; content: string }[]): string[] => {
    const out = new Set<string>()
    for (const file of files.filter((entry) => entry.path.endsWith('.tsx'))) {
      for (const match of file.content.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        for (const token of (match[1] ?? '').split(/\s+/)) if (token) out.add(token)
      }
    }
    return [...out]
  }

  it('type-checks strictly, renders the same DOM and compiles with Tailwind v4', async () => {
    const { button, card, pageId } = workedExample()
    const result = buildReactExport(input(pageId, { styling: 'tailwind' }))
    const paths = result.files.map((file) => file.path)
    expect(result.report.styling).toBe('tailwind')
    // only what has no utility stays in a module sheet; the page converted entirely
    expect(result.files.find((file) => file.path === 'src/components/Button.module.css')!.content).toContain(
      'var(--color-primary',
    )
    expect(paths).toContain('src/components/Card.module.css')
    const tokens = result.files.find((file) => file.path === 'src/tokens.css')!.content
    expect(tokens).toContain('@import "tailwindcss/theme.css" layer(theme);')
    expect(tokens).toContain('@import "tailwindcss/utilities.css" layer(utilities);')
    expect(tokens).not.toContain('@import "tailwindcss";')
    expect(tokens).not.toContain('preflight')
    // the page's body rule stays CSS, scoped to the page root
    expect(result.files.find((file) => file.path === 'src/pages/Pricing.css')!.content).toContain('.page-Pricing')
    expect(result.files.find((file) => file.path === 'README.md')!.content).toContain('Tailwind v4')

    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
      const out = await renderAll(project, {
        buttonBuy: { from: './src/components/Button', name: 'Button', props: { label: 'Buy' } },
        cardFull: {
          from: './src/components/Card',
          name: 'Card',
          props: { title: 'Pro', tone: 'ghost', badge: true, cta: 'Buy', cover: '/a/x.png' },
        },
        page: { from: './src/pages/Pricing', name: 'Pricing' },
      })
      expect(normalize(out.buttonBuy!)).toBe(expected(button.id, { label: 'Buy' }))
      expect(normalize(out.cardFull!)).toBe(
        expected(card.id, { title: 'Pro', tone: 'ghost', badge: 'true', cta: 'Buy', cover: '/a/x.png' }),
      )
      const body = /<body>([\s\S]*)<\/body>/.exec(store.getFrame(pageId)!.html)![1]!
      const wrapper = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(out.page!)![1]!
      expect(normalize(wrapper)).toBe(
        normalize(body).replace(/src="\/a\/cover.png"/g, 'src="https://doop.example/a/cover.png"'),
      )

      const { compile } = await import('@tailwindcss/node')
      const compiler = await compile(tokens, {
        base: resolve(import.meta.dirname, '..'),
        onDependency: () => {},
      })
      const css = compiler.build(classCandidates(result.files))
      // Card's ghost variant: `.card[data-tone="ghost"] { background: transparent }`
      expect(css).toMatch(/data-tone[^{]*ghost[^{]*\{[^}]*background-color: transparent/)
      // Button's padding and the badge's font size converted to utilities
      expect(css).toContain('padding')
      expect(css).toContain('--tw-font-weight: var(--font-weight-semibold)')
      expect(css).toContain('border-style: var(--tw-border-style)')
    } finally {
      project.cleanup()
    }
  })
})
