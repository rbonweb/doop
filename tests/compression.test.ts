import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compressedBundle, compressedOnce, immutableAssets, negotiateCoding } from '../server/compression.ts'

describe('negotiateCoding', () => {
  it.each([
    ['gzip, deflate, br, zstd', 'br'],
    ['gzip, deflate', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0, br;q=0', null],
    ['*', 'br'],
    ['identity', null],
    ['', null],
    [undefined, null],
    ['BR', 'br'],
  ])('%s → %s', (header, coding) => {
    expect(negotiateCoding(header)).toBe(coding)
  })
})

describe('compressedOnce', () => {
  const body = Buffer.from('.card{padding:16px;border-radius:12px}\n'.repeat(500))

  it('round-trips with either coding', async () => {
    expect(zlib.brotliDecompressSync(await compressedOnce('t:a', body, 'br'))).toEqual(body)
    expect(zlib.gunzipSync(await compressedOnce('t:a', body, 'gzip'))).toEqual(body)
  })

  it('compresses a key once, however many ask', async () => {
    const [first, second] = await Promise.all([compressedOnce('t:b', body, 'br'), compressedOnce('t:b', body, 'br')])
    expect(first).toBe(second)
    expect(first.length).toBeLessThan(body.length / 10)
  })
})

describe('the hashed bundle', () => {
  let dir: string
  let base: string
  let close: () => void
  const js = 'export function render(){return "frame"}\n'.repeat(2000)

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'doop-dist-'))
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), js)
    writeFileSync(path.join(dir, 'assets', 'logo-abc123.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
    const app = express()
    app.use(compressedBundle(dir))
    app.use(express.static(dir, { setHeaders: immutableAssets }))
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })

  afterAll(() => {
    close?.()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves brotli when asked, cached for good', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'Accept-Encoding': 'gzip, br' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('vary')).toContain('Accept-Encoding')
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(Number(res.headers.get('content-length'))).toBeLessThan(js.length / 10)
    expect(await res.text()).toBe(js)
  })

  it('falls back to gzip, then to the plain file', async () => {
    const gz = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(await gz.text()).toBe(js)
    const plain = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'Accept-Encoding': 'identity' } })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(Number(plain.headers.get('content-length'))).toBe(js.length)
  })

  it('answers HEAD without a body', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(await res.text()).toBe('')
  })

  it('leaves binary assets and the page to express.static, immutable only under /assets', async () => {
    const png = await fetch(`${base}/assets/logo-abc123.png`, { headers: { 'Accept-Encoding': 'br' } })
    expect(png.headers.get('content-encoding')).toBeNull()
    expect(png.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const page = await fetch(`${base}/index.html`)
    expect(page.headers.get('cache-control')).toBe('public, max-age=0')
    expect((await fetch(`${base}/assets/missing-abc.js`)).status).toBe(404)
  })
})
