import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import * as actions from '../server/actions.ts'
import { changeInstances } from '../server/componentActions.ts'
import { blankComponent } from '../server/components.ts'
import { store } from '../server/store.ts'
import {
  ATTR_IF_ATTR,
  COMPONENT_ATTR,
  INSTANCE_ATTR,
  OVERRIDES_ATTR,
  attrsToRemove,
  formatAttrConditions,
  parseAttrConditions,
} from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

describe('data-doop-attr-if grammar', () => {
  it('reads entries with AND conditions, a namespaced attribute and escaped separators', () => {
    const entries = parseAttrConditions(
      String.raw`data-no-visuals: tone!=a & tone!=b; xlink:href: !off; title: label=a\;b\&c`,
    )
    expect(entries).toEqual([
      {
        attr: 'data-no-visuals',
        conditions: [
          { prop: 'tone', equals: 'a', negate: true },
          { prop: 'tone', equals: 'b', negate: true },
        ],
      },
      { attr: 'xlink:href', conditions: [{ prop: 'off', negate: true }] },
      { attr: 'title', conditions: [{ prop: 'label', equals: 'a;b&c', negate: false }] },
    ])
    expect(parseAttrConditions(formatAttrConditions(entries))).toEqual(entries)
  })

  it('leaves out an entry with no condition or a condition that does not parse', () => {
    expect(parseAttrConditions('a; b: ; c: !!x; d: ok & Not Valid; e: fine')).toEqual([
      { attr: 'e', conditions: [{ prop: 'fine', negate: false }] },
    ])
  })

  it('removes an attribute unless every condition of its entry holds', () => {
    const value = 'a: tone=x & !off; b: tone!=x'
    const at = (props: Record<string, string>) => attrsToRemove(value, (prop) => props[prop])
    expect(at({ tone: 'x' })).toEqual(['b'])
    expect(at({ tone: 'x', off: 'true' })).toEqual(['a', 'b'])
    expect(at({ tone: 'y' })).toEqual(['a'])
  })
})

const TEMPLATE = (id: string) =>
  `<button class="btn" ${COMPONENT_ATTR}="${id}" data-state="on" data-doop-attr-if="data-state: !quiet"><span class="ic" data-kind="x" data-doop-attr-if="data-kind: tone=primary &amp; !quiet">i</span><span class="lbl" title="t" data-bad="b" data-doop-attr-if="title: tone!=ghost; data-bad: nonsense!!">l</span></button>`

const PROPS = [
  { name: 'tone', type: 'enum' as const, options: ['primary', 'ghost'], default: 'primary' },
  { name: 'quiet', type: 'boolean' as const, default: 'false' },
]

describe('data-doop-attr-if in the component engine', () => {
  let canvasId: string
  let componentId: string
  beforeEach(() => {
    canvasId = store.createCanvas('attr-if').id
    const def = blankComponent({ name: 'Button', by: 'Tester', props: PROPS })
    store.saveComponent(canvasId, def)
    componentId = def.id
    const main = actions.createFrame(canvasId, { name: 'Main', html: '' }, actor)!
    actions.updateFrame(main.id, { html: doc(TEMPLATE(def.id), '.btn { padding: 4px }') }, actor)
  })

  const pageWith = (...uses: string[]) => {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(uses.join('')) }, actor)
    return page.id
  }
  const buttons = (frameId: string) => store.getFrame(frameId)!.html.match(/<button\b[\s\S]*?<\/button>/g) ?? []

  it('keeps the template’s attribute and the marker in the stored main', () => {
    const template = store.getComponents(canvasId).find((def) => def.id === componentId)!.template
    expect(template).toContain(`${ATTR_IF_ATTR}="data-state: !quiet"`)
    expect(template).toContain('data-state="on"')
    expect(template).toContain('data-kind: tone=primary &amp; !quiet')
  })

  it('removes an attribute on the root and a nested element when its conditions fail, and never shows the marker', () => {
    const page = pageWith(
      `<doop-use component="Button"></doop-use>`,
      `<doop-use component="Button" tone="ghost"></doop-use>`,
      `<doop-use component="Button" quiet="true"></doop-use>`,
    )
    const [plain, ghost, quiet] = buttons(page) as [string, string, string]
    expect(plain).toContain('data-state="on"')
    expect(plain).toContain('data-kind="x"')
    expect(plain).toContain('title="t"')
    expect(ghost).toContain('data-state="on"')
    expect(ghost).not.toContain('data-kind')
    expect(ghost).not.toContain('title=')
    expect(quiet).not.toContain('data-state')
    expect(quiet).not.toContain('data-kind')
    expect(quiet).toContain('title="t"')
    for (const html of [plain, ghost, quiet]) expect(html).not.toContain(ATTR_IF_ATTR)
  })

  it('ignores an entry that does not parse: its attribute stays', () => {
    const page = pageWith(`<doop-use component="Button" tone="ghost"></doop-use>`)
    expect(buttons(page)[0]).toContain('data-bad="b"')
  })

  it('takes the attribute as derived from props on read-back, never as an edit', () => {
    const page = pageWith(`<doop-use component="Button" tone="ghost"></doop-use>`)
    const stored = store.getFrame(page)!.html
    /* a save of what the frame already holds changes nothing */
    actions.updateFrame(page, { html: `${stored} ` }, actor)
    expect(store.getFrame(page)!.html.trim()).toBe(stored.trim())
    /* someone puts the removed attribute back, or strips a kept one, by hand in the markup */
    const edited = stored.replace('<span class="lbl"', '<span class="lbl" title="t"').replace(' data-state="on"', '')
    actions.updateFrame(page, { html: edited }, actor)
    const after = buttons(page)[0]!
    expect(after).not.toContain(OVERRIDES_ATTR)
    expect(after).toContain('data-state="on"')
    expect(after).not.toContain('title=')
  })

  it('follows a prop change in both directions', () => {
    const page = pageWith(`<doop-use component="Button"></doop-use>`)
    const instanceId = /data-doop-id="([^"]+)"/.exec(buttons(page)[0]!)![1]!
    changeInstances(canvasId, page, [{ instanceId, props: { tone: 'ghost', quiet: 'true' } }], actor)
    expect(buttons(page)[0]).not.toMatch(/data-state|data-kind|title=/)
    changeInstances(canvasId, page, [{ instanceId, props: { tone: '', quiet: '' } }], actor)
    expect(buttons(page)[0]).toMatch(/data-state="on"[\s\S]*data-kind="x"[\s\S]*title="t"/)
    expect(buttons(page)[0]).not.toContain(OVERRIDES_ATTR)
  })

  it('keeps the attribute through a main edit that does not touch it', () => {
    const main = store.getComponents(canvasId).find((def) => def.id === componentId)!.mainFrameId!
    const html = store.getFrame(main)!.html
    actions.updateFrame(main, { html: html.replace('>l</span>', '>Label</span>') }, actor)
    const template = store.getComponents(canvasId).find((def) => def.id === componentId)!.template
    expect(template).toContain(`${ATTR_IF_ATTR}="data-state: !quiet"`)
    expect(template).toContain('>Label</span>')
  })
})

/* Stored markup from before the attribute existed (a Button with text, boolean and enum bindings, a slot, a nested <doop-use> and
   data-doop-if), captured on the commit before data-doop-attr-if: the engine must give the same bytes back. Part keys are random, so
   they are numbered in order of appearance. */
const OLD_PAGE =
  '<!doctype html><html><head><style></style><style data-doop-component-css="DEF">\n:where([data-doop-instance="DEF"]) .btn, .btn:where([data-doop-instance="DEF"]) {padding:4px}\n:where([data-doop-instance="DEF"]) .btn[data-tone="ghost"], .btn[data-tone="ghost"]:where([data-doop-instance="DEF"]) {background:none}\n</style>\n</head><body><button class="btn" disabled="" data-doop-instance="DEF" data-doop-rev="1" data-doop-id="ID" data-tone="ghost" data-doop-props="{&quot;busy&quot;:&quot;true&quot;,&quot;label&quot;:&quot;Go&quot;,&quot;tone&quot;:&quot;ghost&quot;}"><span class="spin" data-doop-part="P1">...</span><span data-doop-part="P2">Go</span><span class="tail" data-doop-part="P3" title="Go">t</span><div class="actions" data-doop-slot="actions" data-doop-part="P4"><span>x</span></div></button><button class="btn" data-doop-instance="DEF" data-doop-rev="1" data-doop-id="ID" data-tone="primary"><span data-doop-part="P2">Buy</span><div class="actions" data-doop-slot="actions" data-doop-part="P4"></div><i class="ic" data-doop-part="P5" data-doop-instance="INNER" data-doop-rev="1" data-doop-id="ID"></i></button></body></html>'
const OLD_TEMPLATE =
  '<button class="btn" data-doop-prop="disabled:busy" data-doop-part="P6"><span class="spin" data-doop-if="busy" data-doop-part="P1">...</span><span data-doop-prop="label" data-doop-part="P2">Buy</span><span class="tail" data-doop-if="tone=ghost" data-doop-prop="title:label" data-doop-part="P3">t</span><div class="actions" data-doop-slot="actions" data-doop-part="P4"></div><doop-use component="INNER" data-doop-part="P5" data-doop-prop="glyph:label" data-doop-if="!busy"></doop-use></button>'

describe('stored markup without data-doop-attr-if', () => {
  it('saves, renders and re-saves byte for byte as before', () => {
    const canvas = store.createCanvas('old')
    const icon = blankComponent({ name: 'Icon', by: 'T', props: [{ name: 'glyph', type: 'text', default: '*' }] })
    store.saveComponent(canvas.id, icon)
    const iconMain = actions.createFrame(canvas.id, { name: 'IconMain', html: '' }, actor)!
    actions.updateFrame(
      iconMain.id,
      { html: doc(`<i class="ic" ${COMPONENT_ATTR}="${icon.id}" data-doop-prop="glyph"></i>`) },
      actor,
    )
    const def = blankComponent({
      name: 'Button',
      by: 'T',
      props: [
        { name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
        { name: 'busy', type: 'boolean', default: 'false' },
        { name: 'label', type: 'text', default: 'Buy' },
      ],
    })
    store.saveComponent(canvas.id, def)
    const main = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    actions.updateFrame(
      main.id,
      {
        html: doc(
          `<button class="btn" ${COMPONENT_ATTR}="${def.id}" data-doop-prop="disabled:busy"><span class="spin" data-doop-if="busy">...</span><span data-doop-prop="label">Buy</span><span class="tail" data-doop-if="tone=ghost" data-doop-prop="title:label">t</span><div class="actions" data-doop-slot="actions"></div><doop-use component="${icon.id}" data-doop-if="!busy" data-doop-prop="glyph:label"></doop-use></button>`,
          '.btn{padding:4px}.btn[data-tone="ghost"]{background:none}',
        ),
      },
      actor,
    )
    const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="${def.id}" label="Go" tone="ghost" busy="true"><span slot="actions">x</span></doop-use><doop-use component="${def.id}"></doop-use>`,
        ),
      },
      actor,
    )
    const keys = new Map<string, string>()
    const plain = (text: string) =>
      text
        .replace(/data-doop-part="([a-z]+)"/g, (_, key: string) => {
          if (!keys.has(key)) keys.set(key, String(keys.size + 1))
          return `data-doop-part="P${keys.get(key)}"`
        })
        .replaceAll(icon.id, 'INNER')
        .replaceAll(def.id, 'DEF')
        .replace(/data-doop-id="[^"]*"/g, 'data-doop-id="ID"')
    const stored = store.getFrame(page.id)!.html
    expect(plain(stored)).toBe(OLD_PAGE)
    expect(plain(store.getComponents(canvas.id).find((one) => one.id === def.id)!.template)).toBe(OLD_TEMPLATE)
    actions.updateFrame(page.id, { html: `${stored} ` }, actor)
    expect(store.getFrame(page.id)!.html.trim()).toBe(stored.trim())
    expect(stored).not.toContain(ATTR_IF_ATTR)
    expect(stored).not.toContain(OVERRIDES_ATTR)
    expect(stored).toContain(INSTANCE_ATTR)
  })
})
