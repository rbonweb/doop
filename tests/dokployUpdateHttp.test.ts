import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Update now on a real server configured for the Dokploy deploy webhook, against a fake GitHub and a fake Dokploy panel.
 * There is no Postgres here (the harness runs the embedded database), so the backup step fails, which
 * is the case worth proving end to end: nothing reaches Dokploy beyond a read, and the key stays put.
 */

const CURRENT = 'v1.2.0-fork.2'
const LATEST = 'v1.2.0-fork.3'
const TOKEN = 'HTTPsecrettoken_456789abcdef'

let github: http.Server
let panel: http.Server
let server: Server
let admin: Client
let member: Client
let backups: string
const panelCalls: string[] = []

beforeAll(async () => {
  github = http.createServer((req, res) => {
    if (req.url !== '/repos/acme/doop/releases/latest') return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        tag_name: LATEST,
        name: 'Doop 1.2.0, fork build 3',
        html_url: 'https://github.com/acme/doop/releases/tag/v1.2.0-fork.3',
        published_at: '2026-10-01T00:00:00Z',
      }),
    )
  })
  /* slow enough that a second click arrives while the first update still holds the slot */
  panel = http.createServer((req, res) => {
    panelCalls.push(`${req.method} ${req.url}`)
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }, 400)
  })
  await Promise.all([
    new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => panel.listen(0, '127.0.0.1', resolve)),
  ])
  backups = mkdtempSync(path.join(tmpdir(), 'doop-backups-'))
  server = await startServer({
    DOOP_VERSION: CURRENT,
    DOOP_UPDATE_REPO: 'acme/doop',
    DOOP_UPDATE_API: `http://127.0.0.1:${(github.address() as AddressInfo).port}`,
    DOOP_DOKPLOY_WEBHOOK_URL: `http://127.0.0.1:${(panel.address() as AddressInfo).port}/api/deploy/compose/${TOKEN}`,
    DOOP_BACKUP_DIR: backups,
    ADMIN_EMAILS: 'admin@example.test',
  })
  admin = await new Client(server).signUp('admin@example.test', 'Admin')
  member = await new Client(server).signUp('member@example.test', 'Member')
}, 70_000)

afterAll(() => {
  server?.stop()
  github?.closeAllConnections()
  github?.close()
  panel?.closeAllConnections()
  panel?.close()
  if (backups) rmSync(backups, { recursive: true, force: true })
})

describe('Update now through Dokploy', () => {
  it('is for admins, and says it installs through Dokploy without showing the webhook', async () => {
    expect((await member.get('/api/admin/update')).status).toBe(404)
    const res = await admin.get('/api/admin/update')
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toMatchObject({
      enabled: true,
      mode: 'dokploy',
      updateAvailable: true,
      status: { state: 'idle' },
    })
  })

  it('refuses a tag that is not the latest and keeps the slot free', async () => {
    expect((await admin.post('/api/admin/update', { tag: 'v1.0.0' })).status).toBe(409)
  })

  it('lets one update run at a time, and a failed backup never reaches Dokploy', async () => {
    const [first, second] = await Promise.all([
      admin.post('/api/admin/update', { tag: LATEST }),
      admin.post('/api/admin/update', { tag: LATEST }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    const ok = first.status === 200 ? first : second
    expect((await ok.json()).status).toMatchObject({
      state: 'running',
      tag: LATEST,
      message: 'Backing up the database…',
    })

    await vi.waitFor(
      async () => {
        const info = await (await admin.get('/api/admin/update')).json()
        expect(info.status.state).toBe('failed')
      },
      { timeout: 15_000, interval: 100 },
    )
    const info = await (await admin.get('/api/admin/update')).json()
    expect(info.status.message).toContain('DATABASE_URL')
    expect(info.status.message).toContain(`Nothing was changed; ${CURRENT} is still running.`)
    expect(JSON.stringify(info)).not.toContain(TOKEN)

    /* the backup came first and failed, so nothing reached Dokploy at all */
    expect(panelCalls).toEqual([])
    const file = readFileSync(path.join(server.dataDir, 'data', 'updates', 'status.json'), 'utf8')
    expect(file).not.toContain(TOKEN)

    /* the slot is free again */
    const again = await admin.post('/api/admin/update', { tag: LATEST })
    expect(again.status).toBe(200)
  })
})
