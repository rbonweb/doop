import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'

/* saving pages writes through to the database, which these in-memory tests do not open */
vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/db/persist.ts')>()),
  saveCanvas: () => undefined,
}))

interface ToolInputSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

describe('MCP website tool contract', () => {
  it('separates read-only website viewing from editable webpage imports', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const view = tools.find((tool) => tool.name === 'view_website')
      const importWebpage = tools.find((tool) => tool.name === 'import_webpage')

      expect(view).toBeDefined()
      expect(importWebpage).toBeDefined()
      expect(view!.annotations?.readOnlyHint).toBe(true)
      expect(importWebpage!.annotations?.readOnlyHint).toBe(false)

      const viewSchema = view!.inputSchema as ToolInputSchema
      expect(viewSchema.properties).not.toHaveProperty('save_reference')
      expect(viewSchema.properties).not.toHaveProperty('canvas_id')
      expect(new Set(viewSchema.required)).toEqual(new Set(['url', 'agent_name']))

      const importSchema = importWebpage!.inputSchema as ToolInputSchema
      expect(importSchema.properties).toEqual(
        expect.objectContaining({
          url: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(importSchema.required)).toEqual(new Set(['url', 'canvas_id', 'agent_name']))

      expect(client.getInstructions()).toContain('call import_webpage FIRST')
      expect(client.getInstructions()).toContain('view_website is only for read-only inspection')
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('MCP generate_image tool contract', () => {
  it('scopes a generation to a canvas and lets the agent choose aspect and quality', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const generate = tools.find((tool) => tool.name === 'generate_image')
      expect(generate).toBeDefined()
      const schema = generate!.inputSchema as ToolInputSchema
      expect(schema.properties).toEqual(
        expect.objectContaining({
          prompt: expect.any(Object),
          aspect: expect.any(Object),
          quality: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(schema.required)).toEqual(new Set(['prompt', 'canvas_id', 'agent_name']))
      expect(client.getInstructions()).toContain('generate_image')

      /* an unknown canvas must be refused before anything is spent */
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a red circle', canvas_id: 'nope', agent_name: 'Test' },
      })
      expect(result.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

it('requires the original page list and rejects stale agent replacements', async () => {
  const { store } = await import('../server/store.ts')
  const canvas = {
    id: 'mcp-page-conflict',
    ownerId: 'test-owner-id',
    name: 'Pages',
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'collaborator', name: 'New' },
    ],
    frames: [],
    createdAt: 0,
    updatedAt: 0,
  }
  store.canvases.set(canvas.id, canvas)
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'pages-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    const tool = (await client.listTools()).tools.find((tool) => tool.name === 'set_canvas_pages')!
    expect(tool.inputSchema.required).toContain('expectedPages')
    const result = await client.callTool({
      name: 'set_canvas_pages',
      arguments: {
        canvas_id: canvas.id,
        pages: [{ id: 'first', name: 'Renamed' }],
        expectedPages: [{ id: 'first', name: 'Main' }],
        agent_name: 'Agent',
      },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Pages changed')
    expect(canvas.pages).toHaveLength(2)
  } finally {
    store.canvases.delete(canvas.id)
    await client.close()
    await server.close()
  }
})

it('nests pages through parent_id, shows the parent in get_canvas and rejects invalid trees', async () => {
  const { store } = await import('../server/store.ts')
  const canvas = {
    id: 'mcp-page-tree',
    ownerId: 'test-owner-id',
    name: 'Pages',
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration' },
    ],
    frames: [],
    createdAt: 0,
    updatedAt: 0,
  }
  store.canvases.set(canvas.id, canvas)
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'pages-tree-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: 'set_canvas_pages', arguments: { canvas_id: canvas.id, agent_name: 'Agent', ...args } })
  try {
    const tool = (await client.listTools()).tools.find((tool) => tool.name === 'set_canvas_pages')!
    expect(JSON.stringify(tool.inputSchema)).toContain('parent_id')
    const expectedPages = [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration' },
    ]
    const bad = await call({
      expectedPages,
      pages: [
        { id: 'first', name: 'Main', parent_id: 'second' },
        { id: 'second', name: 'Exploration', parent_id: 'first' },
      ],
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad)).toContain('own subpages')
    const missing = await call({ expectedPages, pages: [{ id: 'first', name: 'Main', parent_id: 'ghost' }] })
    expect(missing.isError).toBe(true)
    expect(canvas.pages).toEqual(expectedPages)

    const ok = await call({
      expectedPages,
      pages: [
        { id: 'second', name: 'Exploration', parent_id: 'first' },
        { id: 'first', name: 'Main' },
      ],
    })
    expect(JSON.stringify(ok)).not.toContain('error')
    expect(canvas.pages).toEqual([
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration', parentId: 'first' },
    ])
    const read = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: canvas.id } })
    const [part] = read.content as { text: string }[]
    expect(JSON.parse(part!.text).pages).toEqual([
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration', parent_id: 'first' },
    ])
    /* the parent_id read from get_canvas is the expectedPages shape */
    const again = await call({
      expectedPages: [
        { id: 'first', name: 'Main' },
        { id: 'second', name: 'Exploration', parent_id: 'first' },
      ],
      pages: [
        { id: 'first', name: 'Main' },
        { id: 'second', name: 'Exploration' },
      ],
    })
    expect(again.isError).toBeFalsy()
    expect(canvas.pages).toEqual(expectedPages)
  } finally {
    store.canvases.delete(canvas.id)
    await client.close()
    await server.close()
  }
})
