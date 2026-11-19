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
import { prepareComponent } from '../server/bundleVariants.ts'
import { sanitizeMarkup } from '../server/bundleSanitize.ts'
import { importComponentBundle } from '../server/componentBundleImport.ts'
import { findComponent } from '../server/componentActions.ts'
import * as propagation from '../server/propagation.ts'
import { store } from '../server/store.ts'
import { runOperation } from '../server/workBudget.ts'
import { primerButton } from './primerButtonBundle.ts'

const OWNER = 'owner-1'
const actor = actions.resolveActor({ name: 'Importer', kind: 'agent', userId: OWNER })

let canvasId: string

beforeEach(() => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  canvasId = store.createCanvas('Primer', OWNER).id
})

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0

describe('a variant that differs from the default by an attribute', () => {
  it('keeps one button and conditions the attribute and the icon', () => {
    const out = prepareComponent(primerButton() as never)
    expect(out.issues.filter((issue) => issue.code === 'variant_html_unsupported')).toEqual([])
    expect(count(out.html, /<button/g)).toBe(1)
    expect(out.html).toContain(
      'data-doop-attr-if="data-no-visuals: trailing-visual!=SearchIcon &amp; trailing-visual!=EyeIcon"',
    )
    expect(count(out.html, /data-doop-if=/g)).toBe(2)
    expect(out.html).toMatch(/<span data-component="trailingVisual" data-doop-if="trailing-visual=SearchIcon">/)
    expect(out.html).toMatch(/<span data-component="trailingVisual" data-doop-if="trailing-visual=EyeIcon">/)
    expect(out.html).not.toContain('display:contents')
  })

  it('renders each option with its own icon and data-no-visuals only on the default', async () => {
    const result = runOperation('test-import', canvasId, () =>
      importComponentBundle(
        { canvasId, actor },
        {
          version: 1,
          source: { kind: 'agent', name: 'Primer' },
          package: '@primer/react',
          components: [primerButton()],
        },
        {},
      ),
    )
    const id = result.created[0]!.id
    expect(findComponent(canvasId, id)!.template).toContain('data-doop-attr-if=')
    const uses = ['none', 'SearchIcon', 'EyeIcon']
      .map((option) => `<doop-use component="Button" trailing-visual="${option}"></doop-use>`)
      .join('')
    const frame = actions.createFrame(
      canvasId,
      { name: 'Screen', html: `<!doctype html><html><head></head><body>${uses}</body></html>` },
      actor,
    )!
    await propagation.whenIdle()
    const buttons = store.getFrame(frame.id)!.html.match(/<button\b[\s\S]*?<\/button>/g) ?? []
    expect(buttons).toHaveLength(3)
    const [none, search, eye] = buttons as [string, string, string]
    expect(none).toContain('data-no-visuals="true"')
    expect(none).not.toContain('trailingVisual')
    expect(search).not.toContain('data-no-visuals')
    expect(search).toContain('M1 1h14')
    expect(search).not.toContain('M2 8h12')
    expect(eye).not.toContain('data-no-visuals')
    expect(eye).toContain('M2 8h12')
    expect(eye).not.toContain('M1 1h14')
  })

  it('still replaces an element whose attribute has a different value', () => {
    const out = prepareComponent({
      name: 'Tag',
      html: '<div class="w"><span class="a" data-kind="one">A</span></div>',
      props: [{ name: 'size', type: 'enum', options: ['sm', 'lg'] }],
      variants: { size: { lg: { html: '<div class="w"><span class="a" data-kind="two">A</span></div>' } } },
    } as never)
    expect(out.html).toContain('<span class="a" data-kind="one" data-doop-if="size!=lg">A</span>')
    expect(out.html).toContain('<span class="a" data-kind="two" data-doop-if="size=lg">A</span>')
    expect(out.html).not.toContain('data-doop-attr-if')
  })

  it('shows an attribute a variant adds only for that value, and falls back when two values add it', () => {
    const props = [{ name: 'size', type: 'enum', options: ['sm', 'md', 'lg'] }]
    const one = prepareComponent({
      name: 'Tag',
      html: '<div class="w"><span class="a">A</span></div>',
      props,
      variants: { size: { lg: { html: '<div class="w"><span class="a" title="Big">A</span></div>' } } },
    } as never)
    expect(one.html).toContain('<span class="a" title="Big" data-doop-attr-if="title: size=lg">A</span>')
    const two = prepareComponent({
      name: 'Tag',
      html: '<div class="w"><span class="a">A</span></div>',
      props,
      variants: {
        size: {
          md: { html: '<div class="w"><span class="a" title="Big">A</span></div>' },
          lg: { html: '<div class="w"><span class="a" title="Big">A</span></div>' },
        },
      },
    } as never)
    expect(count(two.html, /<span/g)).toBeGreaterThan(1)
    expect(two.html).toContain('data-doop-if="size=lg"')
  })
})

describe('data-doop-attr-if in bundle markup', () => {
  it('keeps the entries that name a harmless attribute and drops the rest', () => {
    const out = sanitizeMarkup(
      '<button data-doop-attr-if="onclick: a; title: titled; srcdoc: b; data-doop-if: c; bogus; data-x: not a condition!!">Go</button>',
    )
    expect(out.html).toContain('data-doop-attr-if="title: titled"')
    expect(out.html).not.toContain('onclick')
    expect(out.html).not.toContain('srcdoc')
    expect(out.issues.some((issue) => issue.code === 'attr_condition_dropped')).toBe(true)
  })

  it('drops the attribute when every entry goes', () => {
    const out = sanitizeMarkup('<button data-doop-attr-if="onclick: a; nonsense">Go</button>')
    expect(out.html).not.toContain('data-doop-attr-if')
  })
})
