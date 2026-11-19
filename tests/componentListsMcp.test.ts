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

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }

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

const MENU = `<nav class="menu"><ul><li data-doop-each="links"><a data-doop-prop="href:url,label">Home</a></li></ul></nav>`

async function menu(canvasId: string, props?: unknown[]) {
  const { data } = await call('create_component', {
    canvas_id: canvasId,
    name: 'Menu',
    description: 'A row of links',
    html: MENU,
    css: '.menu li { display: inline-block }',
    ...(props ? { props } : {}),
  })
  return data
}

async function framed(canvasId: string, body: string) {
  const { data } = await call('create_frame', {
    canvas_id: canvasId,
    name: 'Screen',
    html: `<!doctype html><html><head></head><body>${body}</body></html>`,
  })
  return data.frame.id as string
}

const shown = (frameId: string) =>
  [...store.getFrame(frameId)!.html.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((match) =>
    match[0].replace(/ data-doop-[a-z]+="[^"]*"/g, ''),
  )

beforeEach(async () => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'lists-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('list props for an agent', () => {
  it('infers the list prop and its fields from the markup, and shows them in the signature', async () => {
    const canvas = store.createCanvas('Lists', OWNER)
    const created = await menu(canvas.id)
    expect(created.ok).toBe(true)
    expect(created.component.signature).toBe('Menu(links: list(url: link, label: text))')
    expect(created.component.usage).toContain(`links='[{"url":"…","label":"…"}]'`)
    const detail = await call('get_component', { canvas_id: canvas.id, component: 'Menu' })
    expect(detail.data.props).toEqual([
      { name: 'links', type: 'list', fields: { url: { type: 'link' }, label: { type: 'text' } } },
    ])
    expect(detail.data.parts.find((part: { repeats_for?: string }) => part.repeats_for)).toBeDefined()
  })

  it('declares fields on create_component, and refuses a list with none', async () => {
    const canvas = store.createCanvas('Lists', OWNER)
    const bad = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Bad',
      html: MENU,
      props: [{ name: 'links', type: 'list' }],
    })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('needs fields')
    const ok = await menu(canvas.id, [
      {
        name: 'links',
        type: 'list',
        fields: { label: { type: 'text' }, url: { type: 'link' }, new: { type: 'boolean' } },
      },
    ])
    expect(ok.component.signature).toBe('Menu(links: list(label: text, url: link, new: boolean))')
  })

  it('takes items in <doop-use>, insert_instance and update_instances, as an array or as JSON text', async () => {
    const canvas = store.createCanvas('Lists', OWNER)
    await menu(canvas.id)
    const frameId = await framed(
      canvas.id,
      `<main data-doop-id="mainid"><doop-use component="Menu" links='[{"label":"One","url":"/one"}]'></doop-use></main>`,
    )
    expect(shown(frameId)).toEqual(['<li><a href="/one">One</a></li>'])

    const placed = await call('insert_instance', {
      canvas_id: canvas.id,
      frame_id: frameId,
      component: 'Menu',
      target: 'mainid',
      props: { links: [{ label: 'A', url: '/a' }, { label: 'B' }] },
    })
    expect(placed.isError).toBe(false)
    expect(shown(frameId).slice(1)).toEqual(['<li><a href="/a">A</a></li>', '<li><a>B</a></li>'])

    const changed = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: placed.data.instance_id, props: { links: [{ label: 'Only' }] } }],
    })
    expect(changed.isError).toBe(false)
    expect(shown(frameId).slice(1)).toEqual(['<li><a>Only</a></li>'])

    const asText = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: placed.data.instance_id, props: { links: '[{"label":"Text"},{"label":"Two"}]' } }],
    })
    expect(asText.isError).toBe(false)
    expect(shown(frameId).slice(1)).toEqual(['<li><a>Text</a></li>', '<li><a>Two</a></li>'])

    const none = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: placed.data.instance_id, props: { links: [] } }],
    })
    expect(none.isError).toBe(false)
    expect(shown(frameId)).toHaveLength(1)
  })

  it('refuses a bad list from both tools, naming the fields, and never writes it', async () => {
    const canvas = store.createCanvas('Lists', OWNER)
    await menu(canvas.id)
    const frameId = await framed(canvas.id, '<main data-doop-id="mainid"></main>')
    const before = store.getFrame(frameId)!.html
    const evil = await call('insert_instance', {
      canvas_id: canvas.id,
      frame_id: frameId,
      component: 'Menu',
      props: { links: [{ label: 'x', url: 'javascript:alert(1)' }] },
    })
    expect(evil.isError).toBe(true)
    expect(evil.text).toContain('url (link), label (text)')
    expect(evil.text).not.toContain('alert(1)"')
    expect(store.getFrame(frameId)!.html).toBe(before)
    const many = await call('insert_instance', {
      canvas_id: canvas.id,
      frame_id: frameId,
      component: 'Menu',
      props: { links: Array.from({ length: 101 }, () => ({ label: 'x' })) },
    })
    expect(many.isError).toBe(true)
  })

  it('says in a frame write what a list dropped', async () => {
    const canvas = store.createCanvas('Lists', OWNER)
    await menu(canvas.id)
    const created = await call('create_frame', {
      canvas_id: canvas.id,
      name: 'Screen',
      html: `<!doctype html><html><head></head><body><doop-use component="Menu" links='[{"label":"One","secret":"x"}]'></doop-use></body></html>`,
    })
    expect(created.text).toContain('Menu: links gave 1 value the list has no field for, dropped')
    expect(created.text).toContain('item 0: secret')
    expect(created.text).toContain('url (link), label (text)')
    expect(shown(created.data.frame.id)).toEqual(['<li><a>One</a></li>'])
  })
})
