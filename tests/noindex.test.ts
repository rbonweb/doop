import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type Server } from './harness.ts'

let hidden: Server
let listed: Server

beforeAll(async () => {
  ;[hidden, listed] = await Promise.all([startServer(4989, { DOOP_NOINDEX: '1' }), startServer(4990)])
}, 70_000)

afterAll(() => {
  hidden?.stop()
  listed?.stop()
})

describe('DOOP_NOINDEX', () => {
  it('marks every response noindex, not only pages', async () => {
    for (const path of ['/healthz', '/robots.txt', '/api/oidc-config']) {
      const res = await fetch(`${hidden.base}${path}`)
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow, noarchive')
    }
  })

  it('lets crawlers fetch pages so they see the noindex, and lists no sitemap', async () => {
    const robots = await (await fetch(`${hidden.base}/robots.txt`)).text()
    expect(robots).toBe('User-agent: *\nAllow: /\n')
    expect((await fetch(`${hidden.base}/sitemap.xml`)).status).toBe(404)
  })

  it('changes nothing when unset', async () => {
    const res = await fetch(`${listed.base}/robots.txt`)
    expect(res.headers.get('x-robots-tag')).toBeNull()
    expect(await res.text()).toContain('Sitemap:')
    expect((await fetch(`${listed.base}/sitemap.xml`)).status).toBe(200)
  })
})
