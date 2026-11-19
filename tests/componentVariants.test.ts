import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'
import { findComponent } from '../server/componentActions.ts'
import { checkDeclaration, variantRules } from '../server/componentVariants.ts'
import { COMPONENT_TOOL_NAMES } from '../server/componentTools.ts'
import { partsOf } from '../server/componentEngine.ts'
import { parseCss, splitTopLevel } from '../server/componentCss.ts'
import { elementIs } from '../server/parse5Select.ts'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }
const BUTTON = `<button class="btn"><span class="label">Start</span></button>`
const CSS = `.btn { padding: 8px 14px; background: #111; color: #fff }`

let client: Client

type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }

async function call(
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line typescript/no-explicit-any
): Promise<{ data: any; text: string; isError: boolean }> {
  const response = (await client.callTool({ name, arguments: { ...AGENT, ...args } })) as ToolResponse
  await propagation.whenIdle()
  const texts = response.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
  let data: unknown
  try {
    data = JSON.parse(texts[0] ?? '')
  } catch {
    data = undefined
  }
  return { data, text: texts.join('\n'), isError: !!response.isError }
}

async function setup(css = CSS) {
  const canvas = store.createCanvas('Canvas', OWNER)
  const { data } = await call('create_component', {
    canvas_id: canvas.id,
    name: 'Button',
    html: BUTTON,
    css,
    props: [{ name: 'size', type: 'enum', options: ['sm', 'md'], default: 'md' }],
  })
  return { canvas, id: data.component.id as string }
}

async function screen(canvasId: string, name: string, body: string) {
  const { data } = await call('create_frame', {
    canvas_id: canvasId,
    name,
    html: `<!doctype html><html><head></head><body>${body}</body></html>`,
  })
  return data.frame.id as string
}

const edit = (canvasId: string, component: string, ops: unknown[], extra: Record<string, unknown> = {}) =>
  call('edit_component_variants', { canvas_id: canvasId, component, ops, ...extra })

const propsOf = (canvasId: string, id: string) =>
  findComponent(canvasId, id)!.props.find((prop) => prop.name === 'size')!

function labelKey(canvasId: string, id: string): string {
  const def = findComponent(canvasId, id)!
  const key = [...partsOf(def.template).entries()].find(([, info]) => info.el.tagName === 'span')?.[0]
  return key ?? ''
}

beforeEach(async () => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'variants-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('variant values', () => {
  it('registers as a component tool, so the resident agent has it too', () => {
    expect(COMPONENT_TOOL_NAMES).toContain('edit_component_variants')
  })

  it('adds a value, makes it the default and refuses a duplicate', async () => {
    const { canvas, id } = await setup()
    const added = await edit(canvas.id, id, [{ op: 'add_value', prop: 'size', value: 'lg', make_default: true }])
    expect(added.isError).toBe(false)
    expect(propsOf(canvas.id, id)).toMatchObject({ options: ['sm', 'md', 'lg'], default: 'lg' })
    expect(added.data.props).toEqual([expect.objectContaining({ name: 'size', options: ['sm', 'md', 'lg'] })])
    const again = await edit(canvas.id, id, [{ op: 'add_value', prop: 'size', value: 'lg' }])
    expect(again.isError).toBe(true)
    expect(again.text).toContain('already has the value')
  })

  it('refuses a value with markup in it and an unknown prop, naming what is allowed', async () => {
    const { canvas, id } = await setup()
    const bad = await edit(canvas.id, id, [{ op: 'add_value', prop: 'size', value: 'x"]{}' }])
    expect(bad.text).toContain('must be a short word')
    const unknown = await edit(canvas.id, id, [{ op: 'add_value', prop: 'tone', value: 'x' }])
    expect(unknown.text).toContain('its variants are size (sm | md)')
  })

  it('refuses to remove the last value, and the default without a new one', async () => {
    const { canvas, id } = await setup()
    const noDefault = await edit(canvas.id, id, [{ op: 'remove_value', prop: 'size', value: 'md' }])
    expect(noDefault.text).toContain('pass new_default')
    const ok = await edit(canvas.id, id, [{ op: 'remove_value', prop: 'size', value: 'md', new_default: 'sm' }])
    expect(ok.isError).toBe(false)
    expect(propsOf(canvas.id, id)).toMatchObject({ options: ['sm'], default: 'sm' })
    const last = await edit(canvas.id, id, [{ op: 'remove_value', prop: 'size', value: 'sm' }])
    expect(last.text).toContain('last value')
  })

  it('sets the default and keeps stored instance values through an unrelated edit', async () => {
    const { canvas, id } = await setup()
    const frameId = await screen(
      canvas.id,
      'Screen',
      `<doop-use component="Button" size="sm"></doop-use><doop-use component="Button"></doop-use>`,
    )
    const before = store.getFrame(frameId)!.html
    expect(before).toContain('data-doop-props="{&quot;size&quot;:&quot;sm&quot;}"')
    const noop = await edit(canvas.id, id, [{ op: 'clear_style', when: { size: 'sm' } }])
    expect(noop.isError).toBe(false)
    expect(noop.data.instances_updated).toBe(0)
    expect(store.getFrame(frameId)!.html).toBe(before)
    await edit(canvas.id, id, [{ op: 'set_default', prop: 'size', value: 'sm' }])
    expect(store.getFrame(frameId)!.html).toContain('data-doop-props="{&quot;size&quot;:&quot;sm&quot;}"')
  })
})

describe('renaming and removing a value', () => {
  it('renames across instances in two frames and rewrites the variant rules', async () => {
    const { canvas, id } = await setup(
      `${CSS}\n.btn[data-size="md"] { padding: 12px }\n.btn[data-size="sm"] .label { font-size: 11px }`,
    )
    const one = await screen(canvas.id, 'One', `<doop-use component="Button" size="sm"></doop-use>`)
    const two = await screen(
      canvas.id,
      'Two',
      `<doop-use component="Button" size="sm"></doop-use><doop-use component="Button"></doop-use>`,
    )
    const rev = findComponent(canvas.id, id)!.rev
    const result = await edit(canvas.id, id, [
      { op: 'rename_value', prop: 'size', from: 'md', to: 'medium' },
      { op: 'rename_value', prop: 'size', from: 'sm', to: 'small' },
    ])
    expect(result.isError).toBe(false)
    expect(result.data.instances_updated).toBe(2)
    expect(result.data.frames_updated).toBe(2)
    const def = findComponent(canvas.id, id)!
    expect(propsOf(canvas.id, id)).toMatchObject({ options: ['small', 'medium'], default: 'medium' })
    expect(def.rawCss).toContain('[data-size="medium"]')
    expect(def.rawCss).toContain('[data-size="small"] .label')
    expect(def.rawCss).not.toContain('[data-size="md"]')
    expect(def.css).toContain('[data-size="medium"]')
    expect(store.getFrame(one)!.html).toContain('data-size="small"')
    expect(store.getFrame(two)!.html).toContain('data-size="small"')
    expect(store.getFrame(two)!.html).toContain('data-size="medium"')
    expect(store.getFrame(two)!.html).not.toContain('data-size="sm"')
    /* two renames in one call are one revision */
    expect(def.rev).toBe(rev + 1)
  })

  it('removes a value: its rules go and instances fall back to the default', async () => {
    const { canvas, id } = await setup(
      `${CSS}\n.btn[data-size="sm"] { padding: 2px }\n.btn[data-size="md"] { padding: 12px }`,
    )
    const frameId = await screen(canvas.id, 'S', `<doop-use component="Button" size="sm"></doop-use>`)
    const result = await edit(canvas.id, id, [{ op: 'remove_value', prop: 'size', value: 'sm' }])
    expect(result.isError).toBe(false)
    const def = findComponent(canvas.id, id)!
    expect(def.rawCss).not.toContain('data-size="sm"')
    expect(def.rawCss).toContain('data-size="md"')
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('data-size="md"')
    expect(html).not.toContain('data-doop-props')
  })
})

describe('boolean variants', () => {
  it('adds one, styles it, renames it and removes it', async () => {
    const { canvas, id } = await setup()
    const frameId = await screen(canvas.id, 'S', `<doop-use component="Button" quiet="true"></doop-use>`)
    expect(frameId).toBeTruthy()
    const added = await edit(canvas.id, id, [{ op: 'add_boolean', prop: 'disabled' }])
    expect(added.isError).toBe(false)
    expect(findComponent(canvas.id, id)!.props.find((prop) => prop.name === 'disabled')).toMatchObject({
      type: 'boolean',
      reflect: true,
      default: 'false',
    })
    const styled = await edit(canvas.id, id, [
      { op: 'set_style', element: 'root', when: { disabled: 'true' }, declarations: { opacity: '0.5' } },
    ])
    expect(styled.isError).toBe(false)
    const renamed = await edit(canvas.id, id, [{ op: 'rename_prop', prop: 'disabled', to: 'inactive' }])
    expect(renamed.isError).toBe(false)
    const def = findComponent(canvas.id, id)!
    expect(def.props.some((prop) => prop.name === 'inactive')).toBe(true)
    expect(def.rawCss).toContain('[data-inactive="true"]')
    expect(def.rawCss).not.toContain('data-disabled')
    const removed = await edit(canvas.id, id, [{ op: 'remove_prop', prop: 'inactive' }])
    expect(removed.isError).toBe(false)
    expect(findComponent(canvas.id, id)!.rawCss).not.toContain('data-inactive')
    expect(findComponent(canvas.id, id)!.props.some((prop) => prop.name === 'inactive')).toBe(false)
  })

  it('adds an enum prop in the same call as its first style', async () => {
    const { canvas, id } = await setup()
    const result = await edit(canvas.id, id, [
      { op: 'add_enum', prop: 'tone', options: ['solid', 'ghost'] },
      { op: 'set_style', element: 'root', when: { tone: 'ghost' }, declarations: { background: 'transparent' } },
    ])
    expect(result.isError).toBe(false)
    expect(result.data.rules).toEqual([
      expect.objectContaining({ when: { tone: 'ghost' }, element: null, declarations: { background: 'transparent' } }),
    ])
  })
})

describe('variant style', () => {
  it('writes, merges and clears a rule, kept in the scoped instance css and never inline', async () => {
    const { canvas, id } = await setup()
    const key = labelKey(canvas.id, id)
    expect(key).not.toBe('')
    await edit(canvas.id, id, [
      { op: 'set_style', element: key, when: { size: 'md' }, declarations: { 'font-size': '16px', color: 'red' } },
    ])
    let def = findComponent(canvas.id, id)!
    const rules = variantRules(def)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      when: { size: 'md' },
      element: key,
      declarations: { 'font-size': '16px', color: 'red' },
    })
    expect(def.css).toContain(`[data-doop-instance="${id}"]`)
    expect(def.css).toContain('font-size: 16px')
    const main = store.getFrame(def.mainFrameId!)!.html
    expect(main).not.toMatch(/style="[^"]*font-size/)

    await edit(canvas.id, id, [
      { op: 'set_style', element: key, when: { size: 'md' }, declarations: { 'font-size': '18px', color: null } },
    ])
    def = findComponent(canvas.id, id)!
    expect(variantRules(def)).toHaveLength(1)
    expect(variantRules(def)[0]!.declarations).toEqual({ 'font-size': '18px' })

    await edit(canvas.id, id, [{ op: 'clear_style', when: { size: 'md' }, element: key }])
    def = findComponent(canvas.id, id)!
    expect(variantRules(def)).toHaveLength(0)
    expect(def.rawCss).toContain('.btn')
  })

  it('styles a combination of two variants and the root', async () => {
    const { canvas, id } = await setup()
    await edit(canvas.id, id, [
      { op: 'add_boolean', prop: 'quiet' },
      { op: 'set_style', element: 'root', when: { size: 'sm', quiet: 'true' }, declarations: { padding: '2px 6px' } },
    ])
    const rule = variantRules(findComponent(canvas.id, id)!)[0]!
    expect(rule.when).toEqual({ quiet: 'true', size: 'sm' })
    expect(rule.element).toBeNull()
  })

  it('refuses declarations that fetch, inject or name no such property', async () => {
    const { canvas, id } = await setup()
    const style = (
      declarations: Record<string, string>,
      element = 'root',
      when: Record<string, string> = { size: 'sm' },
    ) => edit(canvas.id, id, [{ op: 'set_style', element, when, declarations }])
    expect((await style({ background: 'url(https://x.test/a.png)' })).text).toContain('url()')
    expect((await style({ color: 'red; } body { display: none' })).text).toContain('semicolons')
    expect((await style({ color: 'red } x {' })).text).toContain('braces')
    expect((await style({ 'background-image': '@import "x"' })).text).toContain('@import')
    expect((await style({ 'Color;x': 'red' })).text).toContain('not a CSS property')
    expect((await style({ color: 'red' }, 'nope')).text).toContain('no element “nope”')
    expect((await style({ color: 'red' }, 'root', { size: 'xl' })).text).toContain('not a value of size')
    expect((await style({ color: 'red' }, 'root', { label: 'x' })).text).toContain('not a variant')
    expect(variantRules(findComponent(canvas.id, id)!)).toHaveLength(0)
    expect(checkDeclaration('--gap', 'var(--space-2, 8px)')).toEqual({
      property: '--gap',
      value: 'var(--space-2, 8px)',
    })
  })

  it('plans an edit on a dry run and writes nothing', async () => {
    const { canvas, id } = await setup()
    await screen(canvas.id, 'S', `<doop-use component="Button" size="sm"></doop-use>`)
    const rev = findComponent(canvas.id, id)!.rev
    const plan = await edit(canvas.id, id, [{ op: 'rename_value', prop: 'size', from: 'sm', to: 'small' }], {
      dry_run: true,
    })
    expect(plan.data.dry_run).toBe(true)
    expect(plan.data.instances_updated).toBe(1)
    expect(plan.data.props[0].options).toEqual(['small', 'md'])
    expect(findComponent(canvas.id, id)!.rev).toBe(rev)
    expect(propsOf(canvas.id, id).options).toEqual(['sm', 'md'])
  })
})

describe('the React export reads the edited variants', () => {
  it('exports a renamed value and its rule', async () => {
    const { canvas, id } = await setup()
    await edit(canvas.id, id, [
      { op: 'rename_value', prop: 'size', from: 'sm', to: 'small' },
      { op: 'set_style', element: 'root', when: { size: 'small' }, declarations: { padding: '2px' } },
    ])
    const exported = call('export_react', { canvas_id: canvas.id, component_ids: [id] })
    const { data } = await exported
    const files = (data.files as { path: string; content: string }[])
      .map((file) => `${file.path}\n${file.content}`)
      .join('\n')
    expect(files).toContain('small')
    expect(files).not.toMatch(/['"]sm['"]/)
    expect(files).toMatch(/data-size/)
  })
})

describe('a component without a variants block', () => {
  it('re-saves byte-identical through an op that changes nothing', async () => {
    const { canvas, id } = await setup()
    const before = findComponent(canvas.id, id)!
    const mainHtml = store.getFrame(before.mainFrameId!)!.html
    const result = await edit(canvas.id, id, [{ op: 'set_default', prop: 'size', value: 'md' }])
    expect(result.isError).toBe(false)
    const after = findComponent(canvas.id, id)!
    expect(after.rawCss).toBe(before.rawCss)
    expect(after.template).toBe(before.template)
    expect(after.rev).toBe(before.rev)
    expect(store.getFrame(before.mainFrameId!)!.html).toBe(mainHtml)
  })
})

function elementsOf(html: string): Tree.Element[] {
  const out: Tree.Element[] = []
  const walk = (node: Tree.ParentNode) => {
    for (const child of node.childNodes) {
      if ('tagName' in child) {
        out.push(child)
        walk(child)
      }
    }
  }
  walk(parse(html))
  return out
}

/** How many elements of the consuming frame the rules of the component's scoped css that hold `needle` reach. */
function reach(frameHtml: string, css: string, needle: string): number {
  const els = elementsOf(frameHtml)
  let hits = 0
  for (const node of parseCss(css)) {
    if (node.kind !== 'rule' || !node.body.includes(needle)) continue
    for (const selector of splitTopLevel(node.selector, ',')) hits += els.filter((el) => elementIs(el, selector)).length
  }
  return hits
}

const scopedCss = (html: string) => html.match(/<style[^>]*data-doop-component-css[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''

describe('the scoped css reaches the placed instance', () => {
  it('styles the root and a child under an enum and a boolean variant', async () => {
    const { canvas, id } = await setup()
    const key = labelKey(canvas.id, id)
    await edit(canvas.id, id, [
      { op: 'add_boolean', prop: 'quiet' },
      { op: 'set_style', element: 'root', when: { size: 'sm' }, declarations: { 'padding-left': '1px' } },
      { op: 'set_style', element: key, when: { size: 'sm' }, declarations: { 'font-size': '9px' } },
      { op: 'set_style', element: 'root', when: { quiet: 'true' }, declarations: { 'margin-left': '2px' } },
      { op: 'set_style', element: key, when: { quiet: 'true' }, declarations: { 'letter-spacing': '3px' } },
    ])
    const frameId = await screen(canvas.id, 'Use', `<doop-use component="Button" size="sm" quiet="true"></doop-use>`)
    const html = store.getFrame(frameId)!.html
    const css = scopedCss(html)
    expect(css).toContain('padding-left')
    expect(reach(html, css, 'padding-left')).toBe(1)
    expect(reach(html, css, 'font-size: 9px')).toBe(1)
    expect(reach(html, css, 'margin-left')).toBe(1)
    expect(reach(html, css, 'letter-spacing')).toBe(1)
    /* a default instance (md, quiet off) gets none of them */
    const plain = store.getFrame(await screen(canvas.id, 'Plain', `<doop-use component="Button"></doop-use>`))!.html
    expect(reach(plain, scopedCss(plain), 'padding-left')).toBe(0)
    expect(reach(plain, scopedCss(plain), 'font-size: 9px')).toBe(0)
  })
})

describe('a main made from an element in a design frame', () => {
  async function fromElement() {
    const canvas = store.createCanvas('Design', OWNER)
    const frameId = await screen(
      canvas.id,
      'Design',
      '<span class="pill" data-doop-id="abc">x</span><p class="other">o</p>',
    )
    const frame = store.getFrame(frameId)!
    frame.html = frame.html.replace(
      '<head></head>',
      '<head><style>.pill{padding:4px} .pill[data-tone="a"]{color:red} .other{margin:1px}</style></head>',
    )
    const created = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Pill',
      frame_id: frameId,
      element: 'abc',
      props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
    })
    return { canvas, frameId, id: created.data.component.id as string }
  }

  it('renames a value in the design stylesheet in place, keeping one rule and the siblings', async () => {
    const { canvas, frameId, id } = await fromElement()
    const result = await edit(canvas.id, id, [{ op: 'rename_value', prop: 'tone', from: 'a', to: 'z' }])
    expect(result.isError).toBe(false)
    const html = store.getFrame(frameId)!.html
    expect(html).not.toContain('data-tone="a"')
    expect(html.match(/data-tone="z"/g)).toHaveLength(1)
    expect(html).toContain('.other')
    expect(findComponent(canvas.id, id)!.rawCss.match(/\.pill\s*\{/g)).toHaveLength(1)
  })

  it('removes a value and clears a style from every stylesheet, and puts new rules in the source block', async () => {
    const { canvas, frameId, id } = await fromElement()
    await edit(canvas.id, id, [
      { op: 'set_style', element: 'root', when: { tone: 'b' }, declarations: { color: 'blue' } },
      { op: 'remove_value', prop: 'tone', value: 'a', new_default: 'b' },
    ])
    let html = store.getFrame(frameId)!.html
    expect(html).not.toContain('data-tone="a"')
    expect(html).toContain('data-doop-component-source')
    expect(html).toContain('.pill {padding:4px}')
    await edit(canvas.id, id, [{ op: 'clear_style', when: { tone: 'b' } }])
    html = store.getFrame(frameId)!.html
    expect(html).not.toContain('data-tone="b"')
    expect(html).toContain('.other')
  })
})

describe('two mains in one design frame', () => {
  async function twoMains() {
    const canvas = store.createCanvas('Two', OWNER)
    const frameId = await screen(
      canvas.id,
      'Design',
      '<span class="pill" data-doop-id="pil">p</span><span class="tag" data-doop-id="tag">t</span>',
    )
    const frame = store.getFrame(frameId)!
    frame.html = frame.html.replace(
      '<head></head>',
      '<head><style>.pill[data-size="sm"]{color:red} .pill[data-size="lg"]{color:green} .tag[data-size="sm"]{color:blue} .tag[data-size="lg"]{color:teal}</style></head>',
    )
    const make = async (name: string, element: string) =>
      (
        await call('create_component', {
          canvas_id: canvas.id,
          name,
          frame_id: frameId,
          element,
          props: [{ name: 'size', type: 'enum', options: ['sm', 'lg'] }],
        })
      ).data.component.id as string
    const pill = await make('Pill', 'pil')
    const tag = await make('Tag', 'tag')
    return { canvas, frameId, pill, tag }
  }

  it('renames, removes and clears only this main rules and leaves the other main and its revision alone', async () => {
    const { canvas, frameId, pill, tag } = await twoMains()
    const tagBefore = findComponent(canvas.id, tag)!
    const rule = (selector: string) => store.getFrame(frameId)!.html.includes(selector)
    expect((await edit(canvas.id, pill, [{ op: 'rename_value', prop: 'size', from: 'sm', to: 'small' }])).isError).toBe(
      false,
    )
    expect(rule('.pill[data-size="small"]') || rule('.pill [data-size="small"]')).toBe(true)
    expect(rule('.tag[data-size="sm"]')).toBe(true)
    expect(rule('.pill[data-size="sm"]')).toBe(false)
    expect(
      (await edit(canvas.id, pill, [{ op: 'remove_value', prop: 'size', value: 'lg', new_default: 'small' }])).isError,
    ).toBe(false)
    expect(rule('.tag[data-size="lg"]')).toBe(true)
    expect(rule('.pill[data-size="lg"]')).toBe(false)
    expect((await edit(canvas.id, pill, [{ op: 'clear_style', when: { size: 'small' } }])).isError).toBe(false)
    expect(rule('.tag[data-size="sm"]')).toBe(true)
    const tagAfter = findComponent(canvas.id, tag)!
    expect(tagAfter.rev).toBe(tagBefore.rev)
    expect(propsOf(canvas.id, tag).options).toEqual(['sm', 'lg'])
  })

  it('renames and removes a prop in the design stylesheet, leaving the other main on its own prop', async () => {
    const { canvas, frameId, pill, tag } = await twoMains()
    expect((await edit(canvas.id, pill, [{ op: 'rename_prop', prop: 'size', to: 'scale' }])).isError).toBe(false)
    let html = store.getFrame(frameId)!.html
    expect(html).not.toContain('.pill[data-size')
    expect(html).toMatch(/\.pill\[data-scale="sm"\]/)
    expect(html).toContain('.tag[data-size="sm"]')
    expect(findComponent(canvas.id, pill)!.rawCss).toContain('[data-scale="sm"]')
    expect((await edit(canvas.id, pill, [{ op: 'remove_prop', prop: 'scale' }])).isError).toBe(false)
    html = store.getFrame(frameId)!.html
    expect(html).not.toContain('data-scale')
    expect(html).toContain('.tag[data-size="lg"]')
    expect(propsOf(canvas.id, tag).options).toEqual(['sm', 'lg'])
  })

  it("keeps one main's source block out of the other main's stylesheet", async () => {
    const { canvas, pill, tag } = await twoMains()
    await edit(canvas.id, pill, [
      { op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { 'margin-top': '7px' } },
    ])
    await edit(canvas.id, tag, [
      { op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { 'margin-bottom': '3px' } },
    ])
    expect(findComponent(canvas.id, tag)!.rawCss).toContain('margin-bottom: 3px')
    expect(findComponent(canvas.id, tag)!.rawCss).not.toContain('7px')
    expect(findComponent(canvas.id, pill)!.rawCss).toContain('margin-top: 7px')
    expect(findComponent(canvas.id, pill)!.rawCss).not.toContain('3px')
  })

  it('leaves no empty source block behind when only the design stylesheet changed', async () => {
    const { canvas, frameId, pill } = await twoMains()
    await edit(canvas.id, pill, [{ op: 'rename_value', prop: 'size', from: 'sm', to: 'small' }])
    expect(store.getFrame(frameId)!.html).not.toMatch(/data-doop-component-source="[^"]*">\s*<\/style>/)
  })
})

describe('guards', () => {
  it('refuses a stale expected_rev on a real write, a dry run and a no-op', async () => {
    const { canvas, id } = await setup()
    const rev = findComponent(canvas.id, id)!.rev
    for (const extra of [{}, { dry_run: true }]) {
      const stale = await edit(canvas.id, id, [{ op: 'set_default', prop: 'size', value: 'sm' }], {
        expected_rev: rev + 5,
        ...extra,
      })
      expect(stale.isError).toBe(true)
      expect(stale.text).toContain('is at revision')
    }
    const noop = await edit(canvas.id, id, [{ op: 'set_default', prop: 'size', value: 'md' }], {
      expected_rev: rev + 5,
    })
    expect(noop.isError).toBe(true)
  })

  it('moves the revision once for a real edit', async () => {
    const { canvas, id } = await setup()
    const rev = findComponent(canvas.id, id)!.rev
    await edit(canvas.id, id, [
      { op: 'add_value', prop: 'size', value: 'lg' },
      { op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { padding: '9px' } },
    ])
    expect(findComponent(canvas.id, id)!.rev).toBe(rev + 1)
  })

  it('refuses a stored value that could inject into a selector', async () => {
    const canvas = store.createCanvas('Hostile', OWNER)
    const { data } = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Odd',
      html: BUTTON,
      props: [{ name: 'size', type: 'enum', options: ['a"] { color: red } [x="', 'b'] }],
    })
    const result = await edit(canvas.id, data.component.id, [
      { op: 'set_style', element: 'root', when: { size: 'a"] { color: red } [x="' }, declarations: { color: 'blue' } },
    ])
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cannot be styled here')
  })

  it('keeps a :not() rule when its value is removed, and drops the rule that asks for it', async () => {
    const { canvas, id } = await setup(
      `${CSS}\n.btn:not([data-size="sm"]) { opacity: 0.9 }\n.btn[data-size="sm"] { padding: 2px }`,
    )
    await edit(canvas.id, id, [{ op: 'remove_value', prop: 'size', value: 'sm' }])
    const css = findComponent(canvas.id, id)!.rawCss
    expect(css).toContain(':not([data-size="sm"])')
    expect(css).not.toMatch(/\.btn\[data-size="sm"\]\s*\{/)
  })

  it('allows colour, maths and gradients, and refuses functions that load or run', () => {
    for (const value of [
      'calc(100% - 2px)',
      'rgb(0 0 0 / 50%)',
      'linear-gradient(red, blue)',
      'var(--x, 4px)',
      'translate3d(0, 1px, 0)',
    ])
      expect(checkDeclaration('background', value).value).toBe(value)
    for (const value of [
      'image-set("https://x/a.png" 1x)',
      '-webkit-image-set("a" 1x)',
      'src("a")',
      'image("a")',
      'cross-fade(50% "a", red)',
      'attr(data-x)',
      'element(#a)',
      'paint(x)',
    ])
      expect(() => checkDeclaration('background', value)).toThrow(/only colour, maths/)
    expect(() => checkDeclaration('behavior', 'x')).toThrow(/not a CSS property/)
    expect(() => checkDeclaration('color', 'red\u0000')).toThrow(/control characters/)
    expect(() => checkDeclaration('color', 'red\nblue')).toThrow(/control characters/)
  })
})
