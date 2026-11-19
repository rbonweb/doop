import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent, contextFor } from '../server/components.ts'
import { compactDocument } from '../server/componentEngine.ts'
import { extractComponentCss, scopeSelector, withVarFallbacks } from '../server/componentCss.ts'
import {
  FRAME_EXCLUSION,
  SCOPE_MARK,
  isolateFrameStyles,
  isolateStyleText,
  restoreFrameStyles,
  restoreStyleText,
  withSubjectSuffix,
} from '../server/frameIsolation.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

function mainIn(html: string, marker = 'data-main'): Tree.Element {
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.attrs.some((attr) => attr.name === marker)) return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no main')
}

describe('frame rules and component-owned elements (A)', () => {
  it('adds a zero-specificity exclusion to every rule subject, at any depth, and nothing else', () => {
    const css = `/* reset */\nh2 { margin: 40px }\n.card .title, .x > a:hover { color: red }\n@media (min-width: 600px) { p::before { content: "{" } }\n@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } }\n@font-face { font-family: F; src: url(a.woff) }\nhtml.dark body { color: #fff }\n`
    const out = isolateStyleText(css)
    expect(out).toContain(`h2${FRAME_EXCLUSION} { margin: 40px }`)
    expect(out).toContain(`.card .title${FRAME_EXCLUSION}, .x > a:hover${FRAME_EXCLUSION} { color: red }`)
    expect(out).toContain(`p${FRAME_EXCLUSION}::before { content: "{" }`)
    expect(out).toContain('@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } }')
    expect(out).toContain('@font-face { font-family: F; src: url(a.woff) }')
    expect(out).toContain('/* reset */')
    /* a rule about the document itself is left alone, its descendants are not */
    expect(out).toContain('html.dark body { color: #fff }')
  })

  it('is idempotent and restores the author text byte for byte', () => {
    const css = `h2 { margin: 40px }\n.a:not(.b)::after, *, [x="a,b"] i { color: red }\n@media print { .c { top: 0 } }`
    const once = isolateStyleText(css)
    expect(isolateStyleText(once)).toBe(once)
    expect(restoreStyleText(once)).toBe(css)
    expect(withSubjectSuffix('a', 'X')).toBe('aX')
    expect(withSubjectSuffix(':root', 'X')).toBe(':root')
  })

  it('only touches a frame holding an instance of an isolating component', () => {
    const plain = doc('<h2>x</h2>', 'h2{margin:40px}')
    expect(isolateFrameStyles(plain)).toBe(plain)
    const legacy = `<!doctype html><html><head><style>h2{margin:40px}</style><style data-doop-component-css="abc">\n:where([data-doop-instance="abc"]) h2 {margin:0}\n</style></head><body></body></html>`
    expect(isolateFrameStyles(legacy)).toBe(legacy)
    const next = legacy.replace('\n:where', `\n${SCOPE_MARK}\n:where`)
    const isolated = isolateFrameStyles(next)
    expect(isolated).toContain(`h2${FRAME_EXCLUSION}{margin:40px}`)
    /* the component's own block is never rewritten */
    expect(isolated).toContain(':where([data-doop-instance="abc"]) h2 {margin:0}')
    expect(restoreFrameStyles(isolated)).toBe(next)
  })
})

describe('component rules (B and C)', () => {
  const html = `<html><head></head><body><div data-main class="plan"><h3 class="t" style="color: var(--ink)">T</h3><button class="btn" data-doop-instance="other" data-doop-rev="1">Go</button></div></body></html>`
  const sheet = `:root { --ink: #123; --gap: 4px; --deep: var(--gap) } .plan { gap: var(--deep) } .t { margin: 0 } .plan .btn { color: red } .btn { color: blue } .plan + .plan { margin-top: 8px }`

  it('keeps component rules out of nested instances, except the documented `.plan .btn`', () => {
    const { css } = extractComponentCss(sheet, mainIn(html), 'cid')
    expect(css.startsWith(SCOPE_MARK)).toBe(true)
    const excl = ':not(:where([data-doop-instance="cid"] [data-doop-instance]:not([data-doop-instance="cid"]) *))'
    expect(css).toContain(`.t${excl}`)
    /* the nested component's own element reached from this one's: no exclusion */
    expect(css).toContain(
      ':where([data-doop-instance="cid"]) .plan .btn, .plan:where([data-doop-instance="cid"]) .btn { color: red }',
    )
    expect(css).not.toContain(`.btn${excl}`)
    /* a bare `.btn` stays the nested component's business */
    expect(css).not.toContain('color: blue')
  })

  it('never lets a sibling combinator from the root reach outside the instance', () => {
    const scoped = scopeSelector('.plan + .plan', '[data-doop-instance="cid"]', '', true)
    expect(scoped).not.toContain('.plan:where')
    expect(scopeSelector('.plan + .plan', '[data-doop-instance="cid"]')).toContain('.plan:where')
  })

  it('does not freeze custom properties on the instance root; the main values are var() fallbacks', () => {
    const { css, rawCss, customProps } = extractComponentCss(sheet, mainIn(html), 'cid')
    expect(css).not.toMatch(/--ink\s*:/)
    expect(css).toContain('var(--deep, var(--gap, 4px))')
    expect(customProps.get('--ink')).toBe('#123')
    expect(withVarFallbacks('color: var(--ink)', customProps)).toBe('color: var(--ink, #123)')
    expect(withVarFallbacks('color: var(--ink, red)', customProps)).toBe('color: var(--ink, red)')
    expect(withVarFallbacks('color: var(--token)', customProps)).toBe('color: var(--token)')
    /* the main's own stylesheet still declares them */
    expect(rawCss).toContain(':root {')
    expect(rawCss).toContain('--ink: #123')
  })

  it('keeps the old form reachable for stored definitions', () => {
    const { css } = extractComponentCss(sheet, mainIn(html), 'cid', [], { legacy: true })
    expect(css).not.toContain(SCOPE_MARK)
    expect(css).toMatch(/:where\(\[data-doop-instance="cid"\]\) \{--ink: #123/)
    expect(css).toContain('.plan:where([data-doop-instance="cid"]) + .plan')
  })
})

describe('through the write pipeline', () => {
  const MAIN_CSS = `:root { --accent: #0a7 }\n.card { color: var(--accent); padding: 8px }\n.card h2 { margin: 0 }`
  let canvasId = ''
  let defId = ''
  let mainFrameId = ''

  beforeEach(() => {
    const canvas = store.createCanvas('scoping')
    canvasId = canvas.id
    const def = blankComponent({ name: 'Card', by: 'Tester' })
    defId = def.id
    store.saveComponent(canvas.id, def)
    const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    mainFrameId = mainFrame.id
    actions.updateFrame(
      mainFrame.id,
      {
        html: doc(
          `<section class="card" ${COMPONENT_ATTR}="${def.id}" style="border-color: var(--accent)"><h2 data-doop-prop="title">T</h2><div data-doop-slot="a"></div></section>`,
          MAIN_CSS,
        ),
      },
      actor,
    )
  })

  const current = () => store.getComponents(canvasId).find((d) => d.id === defId)!

  it('a new definition is isolating: marked, with fallbacks in its template', () => {
    const def = current()
    expect(def.css.startsWith(SCOPE_MARK)).toBe(true)
    expect(def.css).not.toMatch(/--accent\s*:/)
    expect(def.template).toContain('var(--accent, #0a7)')
  })

  it('isolates a frame placing an instance and reads back the author text', () => {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    const written = doc(
      `<doop-use component="Card" title="Hi"><p class="mine">slot</p></doop-use>`,
      'h2 { margin: 40px }\n.mine { color: red }',
    )
    actions.updateFrame(page.id, { html: written }, actor)
    const stored = store.getFrame(page.id)!.html
    expect(stored).toContain(`h2${FRAME_EXCLUSION} { margin: 40px }`)
    expect(stored).toContain(`.mine${FRAME_EXCLUSION} { color: red }`)
    const compact = compactDocument(stored, contextFor(canvasId))
    expect(compact).toContain('h2 { margin: 40px }')
    expect(compact).not.toContain(FRAME_EXCLUSION)
    /* saving the stored form again changes nothing */
    actions.updateFrame(page.id, { html: stored }, actor)
    expect(store.getFrame(page.id)!.html).toBe(stored)
    /* so does saving what an agent read */
    actions.updateFrame(page.id, { html: compact }, actor)
    expect(store.getFrame(page.id)!.html).toBe(stored)
  })

  it('a stored definition and its frames re-save byte-identical until the main changes', () => {
    const def = current()
    /* turn it back into what an older server stored */
    const legacy = extractComponentCss(
      `${MAIN_CSS}`,
      mainIn(store.getFrame(mainFrameId)!.html, COMPONENT_ATTR),
      defId,
      [],
      { legacy: true },
    )
    const template = def.template.replaceAll('var(--accent, #0a7)', 'var(--accent)')
    store.saveComponent(canvasId, { ...def, css: legacy.css, rawCss: legacy.rawCss, template })
    const page = actions.createFrame(canvasId, { name: 'Old', html: '' }, actor)!
    const html = store.getFrame(mainFrameId)!.html
    expect(html).not.toContain(SCOPE_MARK)
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="Card" title="Hi"></doop-use>`, 'h2 { margin: 40px }') },
      actor,
    )
    const stored = store.getFrame(page.id)!.html
    expect(stored).not.toContain(FRAME_EXCLUSION)
    expect(stored).not.toContain(SCOPE_MARK)
    actions.updateFrame(page.id, { html: stored }, actor)
    expect(store.getFrame(page.id)!.html).toBe(stored)
    /* the main, saved again unchanged, opens no revision and keeps its css */
    const rev = current().rev
    actions.updateFrame(mainFrameId, { html }, actor)
    expect(current().rev).toBe(rev)
    expect(current().css).toBe(legacy.css)
    expect(store.getFrame(mainFrameId)!.html).toBe(html)
  })
})
