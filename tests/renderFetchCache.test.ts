import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({ getAsset: vi.fn() }))

vi.mock('../server/assets.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/assets.ts')>()),
  getAsset: mocks.getAsset,
}))

import { env } from '../server/env.ts'
import {
  GOOGLE_CSS_TTL_MS,
  MAX_CACHE_BYTES,
  MAX_ENTRY_BYTES,
  UNPINNED_CSS_TTL_MS,
  cachedRenderResponse,
  clearRenderFetchCache,
  renderFetchCacheStats,
} from '../server/renderFetchCache.ts'
import { findBrowserPath, renderFrame } from '../server/screenshot.ts'

const origin = new URL(env.BETTER_AUTH_URL).origin
const appUrl = (path: string) => new URL(path, origin)

const found = (mime: string, ext: string, buf: Buffer, version = 1) => ({
  meta: { id: 'x', mime, ext, size: buf.length, version },
  buf,
  latest: version,
})

const fetchMock = vi.fn()

beforeEach(() => {
  clearRenderFetchCache()
  mocks.getAsset.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('/a/ assets', () => {
  it('reads the bytes through getAsset once and then serves the cache', async () => {
    mocks.getAsset.mockResolvedValue(found('image/png', 'png', Buffer.from('png-bytes')))
    const first = await cachedRenderResponse(appUrl('/a/abc.png'), 'GET')
    const second = await cachedRenderResponse(appUrl('/a/abc.png'), 'GET')
    expect(first?.body.toString()).toBe('png-bytes')
    expect(first?.contentType).toBe('image/png')
    expect(first?.headers['Access-Control-Allow-Origin']).toBe('*')
    expect(first?.headers['Content-Type']).toBeUndefined()
    expect(second).toBe(first)
    expect(mocks.getAsset).toHaveBeenCalledTimes(1)
    expect(mocks.getAsset).toHaveBeenCalledWith('abc', undefined)
    expect(renderFetchCacheStats()).toMatchObject({ entries: 1, hits: 1, misses: 1 })
  })

  it('answers undefined for a missing asset and does not cache the miss', async () => {
    mocks.getAsset.mockResolvedValue(null)
    expect(await cachedRenderResponse(appUrl('/a/nope.png'), 'GET')).toBeUndefined()
    expect(await cachedRenderResponse(appUrl('/a/nope.png'), 'GET')).toBeUndefined()
    expect(mocks.getAsset).toHaveBeenCalledTimes(2)
    expect(renderFetchCacheStats().entries).toBe(0)
  })

  it('answers undefined when the extension does not match', async () => {
    mocks.getAsset.mockResolvedValue(found('image/png', 'png', Buffer.from('x')))
    expect(await cachedRenderResponse(appUrl('/a/abc.jpg'), 'GET')).toBeUndefined()
  })

  it('answers undefined when the store throws', async () => {
    mocks.getAsset.mockRejectedValue(new Error('storage down'))
    expect(await cachedRenderResponse(appUrl('/a/abc.png'), 'GET')).toBeUndefined()
    expect(renderFetchCacheStats().entries).toBe(0)
  })

  it('keys a pinned revision apart and passes the version to getAsset', async () => {
    mocks.getAsset.mockImplementation(async (_id: string, version?: number) =>
      found('text/css', 'css', Buffer.from(`rev${version ?? 'latest'}`), version ?? 3),
    )
    const pinned = await cachedRenderResponse(appUrl('/a/sheet.css?v=2'), 'GET')
    const latest = await cachedRenderResponse(appUrl('/a/sheet.css'), 'GET')
    expect(pinned?.body.toString()).toBe('rev2')
    expect(latest?.body.toString()).toBe('revlatest')
    expect(mocks.getAsset).toHaveBeenCalledWith('sheet', 2)
    expect(pinned?.headers['Cache-Control']).toContain('immutable')
    expect(latest?.headers['Cache-Control']).toBe('no-cache')
    expect(renderFetchCacheStats().entries).toBe(2)
  })

  it('keeps a pinned stylesheet forever and an unpinned one for 5 seconds', async () => {
    vi.useFakeTimers()
    mocks.getAsset.mockImplementation(async (_id: string, version?: number) =>
      found('text/css', 'css', Buffer.from('body{}'), version ?? 1),
    )
    await cachedRenderResponse(appUrl('/a/sheet.css?v=1'), 'GET')
    await cachedRenderResponse(appUrl('/a/sheet.css'), 'GET')
    expect(mocks.getAsset).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(UNPINNED_CSS_TTL_MS - 1)
    await cachedRenderResponse(appUrl('/a/sheet.css?v=1'), 'GET')
    await cachedRenderResponse(appUrl('/a/sheet.css'), 'GET')
    expect(mocks.getAsset).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(2)
    await cachedRenderResponse(appUrl('/a/sheet.css?v=1'), 'GET')
    await cachedRenderResponse(appUrl('/a/sheet.css'), 'GET')
    expect(mocks.getAsset).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
    await cachedRenderResponse(appUrl('/a/sheet.css?v=1'), 'GET')
    expect(mocks.getAsset).toHaveBeenCalledTimes(3)
  })

  it('does not handle other paths on the app origin or other methods', async () => {
    mocks.getAsset.mockResolvedValue(found('image/png', 'png', Buffer.from('x')))
    expect(await cachedRenderResponse(appUrl('/api/me'), 'GET')).toBeUndefined()
    expect(await cachedRenderResponse(appUrl('/a/abc.png'), 'POST')).toBeUndefined()
    expect(await cachedRenderResponse(appUrl('/a/abc.png'), 'HEAD')).toBeUndefined()
    expect(mocks.getAsset).not.toHaveBeenCalled()
  })

  it('does not handle an /a/ path on another origin', async () => {
    expect(await cachedRenderResponse(new URL('https://evil.example/a/abc.png'), 'GET')).toBeUndefined()
    expect(mocks.getAsset).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Google Fonts', () => {
  const cssUrl = new URL('https://fonts.googleapis.com/css2?family=Inter')
  const fontUrl = new URL('https://fonts.gstatic.com/s/inter/v1/a.woff2')

  it('caches the stylesheet for 24 hours', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async () => new Response('@font-face{}', { headers: { 'content-type': 'text/css' } }))
    const first = await cachedRenderResponse(cssUrl, 'GET')
    expect(first?.contentType).toBe('text/css')
    expect(first?.headers['Access-Control-Allow-Origin']).toBe('*')
    vi.advanceTimersByTime(GOOGLE_CSS_TTL_MS - 1)
    await cachedRenderResponse(cssUrl, 'GET')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2)
    await cachedRenderResponse(cssUrl, 'GET')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches font files without expiry', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      async () => new Response(Buffer.from('woff2'), { headers: { 'content-type': 'font/woff2' } }),
    )
    await cachedRenderResponse(fontUrl, 'GET')
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
    const again = await cachedRenderResponse(fontUrl, 'GET')
    expect(again?.body.toString()).toBe('woff2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not follow redirects and passes on a non-200 or a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }))
    expect(await cachedRenderResponse(fontUrl, 'GET')).toBeUndefined()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await cachedRenderResponse(fontUrl, 'GET')).toBeUndefined()
    expect(renderFetchCacheStats().entries).toBe(0)
  })

  it('refuses a URL with credentials', async () => {
    expect(await cachedRenderResponse(new URL('https://user:pw@fonts.gstatic.com/a.woff2'), 'GET')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one fetch between concurrent misses', async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
    const a = cachedRenderResponse(fontUrl, 'GET')
    const b = cachedRenderResponse(fontUrl, 'GET')
    const c = cachedRenderResponse(fontUrl, 'GET')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    release(new Response('font', { headers: { 'content-type': 'font/woff2' } }))
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(rb).toBe(ra)
    expect(rc).toBe(ra)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('third-party hosts', () => {
  it('are never handled', async () => {
    for (const href of [
      'https://images.example.com/a.png',
      'http://fonts.gstatic.com/a.woff2',
      'https://fonts.gstatic.com.evil.test/a',
    ]) {
      expect(await cachedRenderResponse(new URL(href), 'GET')).toBeUndefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.getAsset).not.toHaveBeenCalled()
  })
})

describe('bounds', () => {
  it('evicts the least recently used entries by bytes', async () => {
    const chunk = MAX_ENTRY_BYTES
    const total = MAX_CACHE_BYTES / chunk
    mocks.getAsset.mockImplementation(async () => found('image/png', 'png', Buffer.alloc(chunk)))
    for (let i = 0; i < total; i++) await cachedRenderResponse(appUrl(`/a/img${i}.png`), 'GET')
    expect(renderFetchCacheStats()).toMatchObject({ entries: total, bytes: MAX_CACHE_BYTES })
    /* touch the oldest so the second oldest goes first */
    await cachedRenderResponse(appUrl('/a/img0.png'), 'GET')
    await cachedRenderResponse(appUrl('/a/extra.png'), 'GET')
    expect(renderFetchCacheStats()).toMatchObject({ entries: total, bytes: MAX_CACHE_BYTES })
    mocks.getAsset.mockClear()
    await cachedRenderResponse(appUrl('/a/img0.png'), 'GET')
    expect(mocks.getAsset).not.toHaveBeenCalled()
    await cachedRenderResponse(appUrl('/a/img1.png'), 'GET')
    expect(mocks.getAsset).toHaveBeenCalledTimes(1)
  })

  it('answers an entry over 8 MB without keeping it', async () => {
    mocks.getAsset.mockResolvedValue(found('image/png', 'png', Buffer.alloc(MAX_ENTRY_BYTES + 1)))
    const response = await cachedRenderResponse(appUrl('/a/big.png'), 'GET')
    expect(response?.body.length).toBe(MAX_ENTRY_BYTES + 1)
    expect(renderFetchCacheStats()).toMatchObject({ entries: 0, bytes: 0 })
  })

  it('does not read a font larger than 8 MB', async () => {
    fetchMock.mockResolvedValue(
      new Response(Buffer.alloc(MAX_ENTRY_BYTES + 1), { headers: { 'content-type': 'font/woff2' } }),
    )
    expect(await cachedRenderResponse(new URL('https://fonts.gstatic.com/big.woff2'), 'GET')).toBeUndefined()
    expect(renderFetchCacheStats().entries).toBe(0)
  })
})

/* A 1x1 red PNG, drawn at 40x40 */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

describe.skipIf(!findBrowserPath())('frame renders', { timeout: 60_000 }, () => {
  const frame = {
    id: 'cache-frame',
    canvasId: 'c',
    name: 'f',
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    html: '<!doctype html><body style="margin:0"><img src="/a/redpx.png" width="80" height="80" style="image-rendering:pixelated"></body>',
    updatedAt: 1,
    updatedBy: 't',
  } as Frame

  it('fetches the image once across two renders and draws the same pixels', async () => {
    mocks.getAsset.mockImplementation(async () => found('image/png', 'png', RED_PNG))
    const t0 = performance.now()
    const first = await renderFrame(frame)
    const t1 = performance.now()
    const second = await renderFrame(frame)
    const t2 = performance.now()
    console.log(`render timings: miss ${(t1 - t0).toFixed(0)} ms, hit ${(t2 - t1).toFixed(0)} ms`)
    expect(mocks.getAsset).toHaveBeenCalledTimes(1)
    expect(renderFetchCacheStats().hits).toBeGreaterThanOrEqual(1)
    expect(first.equals(second)).toBe(true)
    expect(first.length).toBeGreaterThan(100)
  })
})
