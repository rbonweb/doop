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
import { COMPONENT_ATTR, activeComponents, type ComponentProp } from '../shared/components.ts'
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
      'url(https://doop.example/a/badge.png)',
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
