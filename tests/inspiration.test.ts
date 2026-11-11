import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadEnv } from '../server/env.ts'
import { buildMcpServer } from '../server/mcp.ts'
import {
  clearInspirationCache,
  INSPIRATION_UNAVAILABLE_NOTE,
  InspirationUnavailable,
  describeInspiration,
  inspirationFallback,
  inspirationSearchEnabled,
  searchInspiration,
} from '../server/inspiration.ts'

/**
 * search_inspiration reads One Page Love's API: /v1/search turns the agent's
 * free text into taxonomy filters, /v1/inspirations returns live sites with
 * their full tags. The stubbed fetch below answers both and records each call.
 */

const SITE = {
  title: 'Screen Movie ',
  slug: 'screen-movie',
  url: 'https://screen.movie',
  genre: ['App'],
  color: ['Dark'],
  style: ['Minimal'],
  typeface: ['Inter'],
  sections: ['Pricing', 'FAQ'],
  authors: ['Solt Wagner'],
  screenshot: {
    hero: 'https://assets.onepagelove.com/cdn-cgi/image/w=1280,h=800,fit=cover,g=top,f=auto,q=85/hero.png',
    thumbnail: 'https://assets.onepagelove.com/t.jpg',
  },
  hero_copy: { headline: 'Create beautiful movies from your screen.' },
}

type Route = (url: URL) => unknown
let calls: URL[] = []

function stubApi(routes: { search: Route; inspirations?: Route }, status = 200) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer opl_test')
    const route = url.pathname.endsWith('/search') ? routes.search : routes.inspirations
    return new Response(JSON.stringify(route?.(url) ?? {}), { status })
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  calls = []
  clearInspirationCache()
  vi.stubEnv('ONEPAGELOVE_API_KEY', 'opl_test')
  reloadEnv()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  reloadEnv()
})

describe('searchInspiration', () => {
  it('browses live sites with the filters the search resolved', async () => {
    stubApi({
      search: () => ({
        matched_filters: [
          { taxonomy: 'color', slug: 'dark' },
          { taxonomy: 'sections', slug: 'pricing' },
        ],
      }),
      inspirations: () => ({ results: [SITE] }),
    })
    const [result] = await searchInspiration('dark pricing', 3)
    const browse = calls[1]
    expect(browse?.pathname).toBe('/v1/inspirations')
    expect(browse?.searchParams.get('color')).toBe('dark')
    expect(browse?.searchParams.get('sections')).toBe('pricing')
    expect(browse?.searchParams.get('status')).toBe('live')
    expect(browse?.searchParams.get('limit')).toBe('3')
    expect(result).toMatchObject({
      site: 'Screen Movie',
      source_url: 'https://screen.movie',
      opl_url: 'https://onepagelove.com/screen-movie',
      style: ['Minimal'],
      fonts: ['Inter'],
      thumb_url: 'https://assets.onepagelove.com/cdn-cgi/image/w=1280,h=800,fit=cover,g=top,f=jpeg,q=85/hero.png',
    })
  })

  it('drops the broadest filter first until something matches', async () => {
    stubApi({
      search: () => ({
        matched_filters: [
          { taxonomy: 'genre', slug: 'landing-page' },
          { taxonomy: 'style', slug: 'editorial' },
          { taxonomy: 'sections', slug: 'mockup-product' },
        ],
      }),
      inspirations: (url) => ({ results: url.searchParams.has('sections') ? [] : [SITE] }),
    })
    const results = await searchInspiration('premium audio product landing page editorial industrial')
    expect(results).toHaveLength(1)
    const browses = calls.filter((c) => c.pathname === '/v1/inspirations')
    /* genre goes before sections; style is kept */
    expect(
      browses.map((c) => [...c.searchParams.keys()].filter((k) => k !== 'status' && k !== 'limit' && k !== 'fields')),
    ).toEqual([['genre', 'style', 'sections'], ['style', 'sections'], ['style']])
  })

  it('uses the search hits themselves when nothing resolved to a filter', async () => {
    stubApi({
      search: () => ({ matched_filters: [{ taxonomy: 'post_tag', slug: 'coffee' }], results: { items: [SITE] } }),
    })
    const results = await searchInspiration('coffee')
    expect(results.map((r) => r.site)).toEqual(['Screen Movie'])
    expect(calls).toHaveLength(1)
  })

  it('answers a repeated query from the cache', async () => {
    stubApi({
      search: () => ({ matched_filters: [{ taxonomy: 'style', slug: 'minimal' }] }),
      inspirations: () => ({ results: [SITE] }),
    })
    await searchInspiration('Minimal')
    await searchInspiration('minimal ')
    expect(calls).toHaveLength(2)
  })

  it('shares one round trip between parallel identical searches', async () => {
    stubApi({
      search: () => ({ matched_filters: [{ taxonomy: 'style', slug: 'minimal' }] }),
      inspirations: () => ({ results: [SITE] }),
    })
    const [a, b] = await Promise.all([searchInspiration('minimal'), searchInspiration('Minimal')])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(2)
  })

  it('lets a later call retry after a failed search', async () => {
    stubApi({ search: () => ({}) }, 500)
    await expect(searchInspiration('minimal')).rejects.toThrow('HTTP 500')
    stubApi({
      search: () => ({ matched_filters: [{ taxonomy: 'style', slug: 'minimal' }] }),
      inspirations: () => ({ results: [SITE] }),
    })
    expect(await searchInspiration('minimal')).toHaveLength(1)
  })

  it('reports the gallery as unavailable on 401, 403, 429 and 5xx', async () => {
    for (const status of [401, 403, 429, 503]) {
      clearInspirationCache()
      stubApi({ search: () => ({ error: 'refused' }) }, status)
      await expect(searchInspiration('fintech landing page')).rejects.toBeInstanceOf(InspirationUnavailable)
    }
    stubApi({ search: () => ({ error: 'rate_limited' }) }, 429)
    await expect(searchInspiration('minimal')).rejects.toThrow('HTTP 429')
  })

  it('reports the gallery as unavailable on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.onepagelove.com')
      }),
    )
    await expect(searchInspiration('minimal')).rejects.toBeInstanceOf(InspirationUnavailable)
    await expect(searchInspiration('minimal')).rejects.toThrow('ENOTFOUND')
  })

  it('keeps other failures as plain errors', async () => {
    stubApi({ search: () => ({}) }, 404)
    const failure = await searchInspiration('minimal').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(InspirationUnavailable)
  })

  it('is off without a key', async () => {
    vi.stubEnv('ONEPAGELOVE_API_KEY', '')
    reloadEnv()
    expect(inspirationSearchEnabled()).toBe(false)
    await expect(searchInspiration('minimal')).rejects.toBeInstanceOf(InspirationUnavailable)
    await expect(searchInspiration('minimal')).rejects.toThrow('ONEPAGELOVE_API_KEY')
  })
})

describe('inspirationFallback', () => {
  it('sends the agent to view_website on real sites and names the reason', () => {
    const text = inspirationFallback('copper jewellery landing page', 'HTTP 403')
    expect(text).toContain('copper jewellery landing page')
    expect(text).toContain('HTTP 403')
    expect(text).toContain('view_website')
  })
})

describe('describeInspiration', () => {
  it('credits One Page Love and the authors', async () => {
    stubApi({
      search: () => ({ matched_filters: [{ taxonomy: 'style', slug: 'minimal' }] }),
      inspirations: () => ({ results: [SITE] }),
    })
    const [result] = await searchInspiration('minimal')
    const text = describeInspiration(result!, 0)
    expect(text).toContain('#1 — Screen Movie (https://screen.movie)')
    expect(text).toContain('designed by Solt Wagner')
    expect(text).toContain('via One Page Love: https://onepagelove.com/screen-movie')
    expect(text).toContain('hero headline: "Create beautiful movies from your screen."')
  })
})

describe('search_inspiration when the gallery is unavailable', () => {
  async function callSearchInspiration() {
    const server = buildMcpServer('Test Owner', 'inspiration-owner')
    const client = new Client({ name: 'inspiration-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      return await client.callTool({
        name: 'search_inspiration',
        arguments: { query: 'copper jewellery landing page', agent_name: 'Agent' },
      })
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('gives the agent the view_website fallback instead of an error when the gallery refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'refused' }), { status: 403 })),
    )
    const result = await callSearchInspiration()
    expect(result.isError).toBeFalsy()
    const text = JSON.stringify(result.content)
    expect(text).toContain('HTTP 403')
    expect(text).toContain('view_website')
  })

  it('gives the same fallback when no key is set', async () => {
    vi.stubEnv('ONEPAGELOVE_API_KEY', '')
    reloadEnv()
    const result = await callSearchInspiration()
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('view_website')
  })
})

describe('search_logos without an inspiration key', () => {
  it('still searches for logos', async () => {
    vi.stubEnv('ONEPAGELOVE_API_KEY', '')
    reloadEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    )
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'inspiration-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = (await client.callTool({
        name: 'search_logos',
        arguments: { query: 'vercel.com', agent_name: 'Tester' },
      })) as { content: { text?: string }[] }
      expect(JSON.stringify(result.content)).not.toContain(INSPIRATION_UNAVAILABLE_NOTE)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
