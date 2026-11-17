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
import * as actions from '../server/actions.ts'
import { activeComponents, type ComponentDef } from '../shared/components.ts'
import { MAX_CODE_BYTES } from '../shared/componentCode.ts'
import { validCode } from '../server/componentCodeMap.ts'

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }

const CSS = '.card { padding: 16px } .card[data-tone="ghost"] { border: 1px solid }'
const CARD =
  '<article class="card"><h3 data-doop-prop="title">Title</h3><span data-doop-if="badge">New</span><div data-doop-slot="actions">Action</div></article>'
const CARD_PROPS = [
  { name: 'tone', type: 'enum', options: ['primary', 'ghost'] },
  { name: 'badge', type: 'boolean' },
]

let client: Client

type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }

/* tool results are whatever JSON each tool returns; the assertions are the type check */
async function call(
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line typescript/no-explicit-any
): Promise<{ data: any; text: string; isError: boolean }> {
  const response = (await client.callTool({ name, arguments: { ...AGENT, ...args } })) as ToolResponse
  /* instances follow a changed main in the background: tests read the settled canvas */
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

function newCanvas(name = 'Canvas') {
  return store.createCanvas(name, OWNER)
}

/** A card with an enum, a derived boolean, a text prop and a slot: the shape a mapping names. */
function card(canvasId: string, code?: unknown) {
  return call('create_component', {
    canvas_id: canvasId,
    name: 'Card',
    html: CARD,
    css: CSS,
    props: CARD_PROPS,
    ...(code !== undefined ? { code } : {}),
  })
}

async function read(canvasId: string, name = 'Card') {
  return (await call('get_component', { canvas_id: canvasId, component: name })).data
}

const LEGACY = {
  path: 'src/components/ui/card.tsx',
  name: 'Card',
  snippet: '<Card title="Pro" tone="ghost" />',
}

/* a definition with the props a mapping may name, for the checks the tool schema blocks first */
const DEF = {
  name: 'Card',
  props: [
    { name: 'tone', type: 'enum', options: ['primary', 'ghost'] },
    { name: 'badge', type: 'boolean' },
    { name: 'title', type: 'text' },
  ],
  slots: [{ name: 'actions', suggested: [] }],
} as unknown as Pick<ComponentDef, 'name' | 'props' | 'slots'>

beforeEach(async () => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'component-code-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('a legacy code value', () => {
  it('reads back byte-for-byte through create, update and get_component', async () => {
    const canvas = newCanvas()
    const created = await card(canvas.id, LEGACY)
    expect(created.isError).toBe(false)
    expect((await read(canvas.id)).code).toEqual(LEGACY)

    const next = { path: 'src/components/Card.tsx', name: 'CardView', snippet: '<CardView />' }
    const updated = await call('update_component', { canvas_id: canvas.id, component: 'Card', code: next })
    expect(updated.isError).toBe(false)
    expect((await read(canvas.id)).code).toEqual(next)
  })

  it('drops unknown keys and keeps the known ones as written', async () => {
    const canvas = newCanvas()
    await card(canvas.id, { ...LEGACY, colour: 'red', origin: { kind: 'manual' } })
    expect((await read(canvas.id)).code).toEqual({ ...LEGACY, origin: { kind: 'manual' } })
  })
})

const MAPPING = {
  importFrom: '@acme/ui',
  exportName: 'Card',
  props: { tone: { name: 'variant' } },
  slots: { actions: 'children' },
}

describe('what a write returns', () => {
  it('returns the code as stored, the full legacy value and the full mapping', async () => {
    const canvas = newCanvas()
    const created = await card(canvas.id, LEGACY)
    expect(created.data.component.code).toEqual(LEGACY)
    const updated = await call('update_component', { canvas_id: canvas.id, component: 'Card', code: MAPPING })
    expect(updated.data.component.code).toEqual(MAPPING)
    const mapped = await card(newCanvas().id, MAPPING)
    expect(mapped.data.component.code).toEqual(MAPPING)
  })
})

describe('a structured code mapping', () => {
  const MAPPING = {
    importFrom: '@acme/ui',
    exportName: 'Card',
    defaultExport: false,
    props: {
      tone: { name: 'variant', values: { primary: 'default', ghost: 'outline' } },
      badge: { omit: true, values: { true: true, false: false } },
    },
    slots: { actions: 'children' },
    origin: { kind: 'storybook', storyId: 'components-card--primary', url: 'https://storybook.acme.com/' },
  }

  it('is accepted and returned whole by get_component', async () => {
    const canvas = newCanvas()
    expect((await card(canvas.id, MAPPING)).isError).toBe(false)
    expect((await read(canvas.id)).code).toEqual(MAPPING)
  })

  it('is shown as its export by list_components, and not at all when nothing is mapped', async () => {
    const canvas = newCanvas()
    await card(canvas.id, MAPPING)
    await call('create_component', {
      canvas_id: canvas.id,
      name: 'Summary',
      html: '<p>Text</p>',
      code: LEGACY,
    })
    const listed = await call('list_components', { canvas_id: canvas.id })
    const entries = listed.data.components as { name: string; code?: unknown }[]
    expect(entries.find((entry) => entry.name === 'Card')?.code).toEqual({
      importFrom: '@acme/ui',
      exportName: 'Card',
    })
    expect(entries.find((entry) => entry.name === 'Summary')?.code).toBeUndefined()
  })

  it('is cleared by update_component with code: null', async () => {
    const canvas = newCanvas()
    await card(canvas.id, MAPPING)
    const cleared = await call('update_component', { canvas_id: canvas.id, component: 'Card', code: null })
    expect(cleared.isError).toBe(false)
    expect((await read(canvas.id)).code).toBeUndefined()
    expect((await call('list_components', { canvas_id: canvas.id })).data.components[0].code).toBeUndefined()
  })
})

describe('a mapping against the component it names', () => {
  const refused = async (canvasId: string, code: Record<string, unknown>, expected: RegExp) => {
    const result = await card(canvasId, code)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(expected)
    /* a refused create leaves nothing behind */
    expect(activeComponents(store.getCanvas(canvasId)!.components)).toEqual([])
  }

  it('refuses a prop the component does not have, and lists its props', async () => {
    await refused(newCanvas().id, { props: { nope: { name: 'yes' } } }, /code\.props “nope”.*its props are .*tone/)
  })

  it('refuses a slot the component does not have, and lists its slots', async () => {
    await refused(newCanvas().id, { slots: { footer: 'children' } }, /code\.slots “footer”.*its slots are actions/)
  })

  it('refuses values on a prop that is not an enum or boolean', async () => {
    await refused(
      newCanvas().id,
      { props: { title: { values: { a: 'b' } } } },
      /code\.props\.title\.values belongs to an enum or boolean prop/,
    )
  })

  it('refuses an enum value that is not one of its options', async () => {
    await refused(newCanvas().id, { props: { tone: { values: { neon: 'x' } } } }, /code\.props\.tone\.values “neon”/)
  })

  it('refuses a boolean value that is not true or false', async () => {
    await refused(newCanvas().id, { props: { badge: { values: { yes: true } } } }, /code\.props\.badge\.values “yes”/)
  })

  it('refuses names that are not JavaScript identifiers', async () => {
    await refused(newCanvas().id, { exportName: 'not a name' }, /code\.exportName/)
    await refused(newCanvas().id, { props: { tone: { name: 'has-dash' } } }, /code\.props\.tone\.name/)
    await refused(newCanvas().id, { slots: { actions: 'not a name' } }, /code\.slots\.actions/)
  })

  it('accepts children as a slot value, which is no identifier to check', async () => {
    const canvas = newCanvas()
    expect((await card(canvas.id, { slots: { actions: 'children' } })).isError).toBe(false)
  })
})

describe('validCode checks that the tool schema cannot reach', () => {
  it('keeps the legacy length limits', () => {
    expect(() => validCode({ path: 'x'.repeat(501) }, DEF)).toThrow(/code\.path is 501 characters; at most 500/)
    expect(() => validCode({ name: 'x'.repeat(201) }, DEF)).toThrow(/code\.name is 201 characters; at most 200/)
    expect(() => validCode({ snippet: 'x'.repeat(4001) }, DEF)).toThrow(
      /code\.snippet is 4001 characters; at most 4000/,
    )
    expect(() => validCode({ importFrom: 'x'.repeat(301) }, DEF)).toThrow(
      /code\.importFrom is 301 characters; at most 300/,
    )
  })

  it('refuses an origin that is not a code origin or has a bad url', () => {
    expect(() => validCode({ origin: { kind: 'web' } }, DEF)).toThrow(
      /code\.origin\.kind “web” must be one of manual, storybook, cli, agent/,
    )
    expect(() => validCode({ origin: { kind: 'manual', url: 'ftp://acme.com' } }, DEF)).toThrow(
      /code\.origin\.url must be an http\(s\) URL/,
    )
    expect(() => validCode({ origin: { kind: 'manual', url: `https://${'a'.repeat(2000)}` } }, DEF)).toThrow(
      /code\.origin\.url is 2008 characters; at most 2000/,
    )
    expect(() => validCode({ origin: { kind: 'storybook', storyId: 'x'.repeat(201) } }, DEF)).toThrow(
      /code\.origin\.storyId is 201 characters; at most 200/,
    )
  })

  it('refuses a value that is not a string, number or boolean', () => {
    expect(() => validCode({ props: { tone: { values: { primary: { nested: true } } } } }, DEF)).toThrow(
      /code\.props\.tone\.values\.primary must be a string, number or boolean/,
    )
  })

  it('refuses a mapping larger than its byte limit, and lets undefined through', () => {
    const options = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`value-${index}`, 'x']))
    const def = {
      ...DEF,
      props: [{ name: 'tone', type: 'enum' as const, options: Object.keys(options) }],
    }
    expect(() => validCode({ props: { tone: { values: options } } }, def)).toThrow(
      new RegExp(`code is \\d+ characters; at most ${MAX_CODE_BYTES}`),
    )
    expect(validCode(undefined, DEF)).toBeUndefined()
  })
})

describe('what the room is told when a mapping is saved', () => {
  const CODE = { importFrom: '@acme/ui', exportName: 'Card' }

  /** Every component message the room hears while `run` works, in order. */
  async function heardDuring(run: () => Promise<unknown>) {
    const sent: { type: string; component?: ComponentDef | null }[] = []
    actions.wire(
      (_canvasId, msg) => sent.push(msg as (typeof sent)[number]),
      () => {},
    )
    try {
      await run()
    } finally {
      actions.wire(
        () => {},
        () => {},
      )
    }
    return sent.filter((msg) => msg.type === 'component')
  }

  it('is the definition with the new mapping on update, so an open panel shows it without a reload', async () => {
    const canvas = newCanvas()
    await card(canvas.id)
    const heard = await heardDuring(async () => {
      const done = await call('update_component', { canvas_id: canvas.id, component: 'Card', code: CODE })
      expect(done.isError).toBe(false)
    })
    expect(heard.length).toBeGreaterThan(0)
    /* a client applies each message in order, so the last one is what its panel keeps */
    expect(heard.at(-1)?.component?.code).toEqual(CODE)
  })

  it('carries the mapping when a component is made from html', async () => {
    const canvas = newCanvas()
    const heard = await heardDuring(async () => {
      expect((await card(canvas.id, CODE)).isError).toBe(false)
    })
    expect(heard.at(-1)?.component?.code).toEqual(CODE)
  })

  it('carries the mapping when a component is made from an element', async () => {
    const canvas = newCanvas()
    const frame = actions.createFrame(
      canvas.id,
      {
        name: 'Page',
        html: '<!doctype html><html><body><article class="card" data-doop-id="el1"><h3>Title</h3></article></body></html>',
      },
      { name: 'Tester', kind: 'user' },
    )!
    const heard = await heardDuring(async () => {
      const made = await call('create_component', {
        canvas_id: canvas.id,
        name: 'Card',
        frame_id: frame.id,
        element: 'el1',
        code: CODE,
      })
      expect(made.isError).toBe(false)
    })
    expect(heard.at(-1)?.component?.code).toEqual(CODE)
  })

  it('carries the mapping when a component is duplicated', async () => {
    const canvas = newCanvas()
    await card(canvas.id, CODE)
    const heard = await heardDuring(async () => {
      expect((await call('duplicate_component', { canvas_id: canvas.id, component: 'Card' })).isError).toBe(false)
    })
    expect(heard.at(-1)?.component?.name).toBe('Card copy')
    expect(heard.at(-1)?.component?.code).toEqual(CODE)
  })
})
