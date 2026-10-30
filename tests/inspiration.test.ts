import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InspirationUnavailable, searchInspiration } from '../server/inspiration.ts'
import { buildMcpServer } from '../server/mcp.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function refuse(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'Please refresh the page and try again.' }), { status })),
  )
}

describe('search_inspiration when the gallery refuses', () => {
  it('reports the gallery as unavailable on 403, 429 and 5xx', async () => {
    for (const status of [403, 429, 503]) {
      refuse(status)
      await expect(searchInspiration('fintech landing page')).rejects.toBeInstanceOf(InspirationUnavailable)
    }
  })

  it('gives the agent the view_website fallback instead of an error', async () => {
    refuse(403)
    const server = buildMcpServer('Test Owner', 'inspiration-owner')
    const client = new Client({ name: 'inspiration-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const result = await client.callTool({
        name: 'search_inspiration',
        arguments: { query: 'copper jewellery landing page', agent_name: 'Agent' },
      })
      expect(result.isError).toBeFalsy()
      const text = JSON.stringify(result.content)
      expect(text).toContain('HTTP 403')
      expect(text).toContain('view_website')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
