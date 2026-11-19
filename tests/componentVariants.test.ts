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
    /* the edit is one revision */
    expect(findComponent(canvas.id, id)!.rev).toBe(def.rev)
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
