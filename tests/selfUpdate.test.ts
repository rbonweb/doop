import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const LATEST = 'v1.2.0-fork.3'

let github: http.Server
let updatable: Server
let manual: Server
let admin: Client
let member: Client
let manualAdmin: Client
let updateDir: string

beforeAll(async () => {
  /* GitHub's releases API, answering for one repository only */
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
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(github.address() as AddressInfo).port}`
  updateDir = mkdtempSync(path.join(tmpdir(), 'doop-update-'))
  const common = { DOOP_VERSION: 'v1.2.0-fork.2', DOOP_UPDATE_REPO: 'acme/doop', DOOP_UPDATE_API: api }
  ;[updatable, manual] = await Promise.all([
    startServer(4983, { ...common, DOOP_UPDATE_DIR: updateDir, ADMIN_EMAILS: 'admin@example.test' }),
    startServer(4984, { ...common, ADMIN_EMAILS: 'admin@example.test' }),
  ])
  admin = await new Client(updatable).signUp('admin@example.test', 'Admin')
  member = await new Client(updatable).signUp('member@example.test', 'Member')
  manualAdmin = await new Client(manual).signUp('admin@example.test', 'Admin')
}, 70_000)

afterAll(() => {
  updatable?.stop()
  manual?.stop()
  github?.close()
  if (updateDir) rmSync(updateDir, { recursive: true, force: true })
})

describe('self-update', () => {
  it('is invisible to anyone but an admin', async () => {
    expect((await member.get('/api/admin/update')).status).toBe(404)
    expect((await member.post('/api/admin/update', { tag: LATEST })).status).toBe(404)
  })

  it('reports the running version against the latest release', async () => {
    const info = await (await admin.get('/api/admin/update')).json()
    expect(info).toMatchObject({
      current: 'v1.2.0-fork.2',
      enabled: true,
      updateAvailable: true,
      latest: { tag: LATEST, name: 'Doop 1.2.0, fork build 3' },
      status: { state: 'idle' },
    })
  })

  it('installs only the latest release, once', async () => {
    const wrong = await admin.post('/api/admin/update', { tag: 'v1.0.0' })
    expect(wrong.status).toBe(409)

    const res = await admin.post('/api/admin/update', { tag: LATEST })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await res.json()).status).toMatchObject({ state: 'requested', tag: LATEST })
    const request = JSON.parse(readFileSync(path.join(updateDir, 'request.json'), 'utf8'))
    expect(request).toMatchObject({ tag: LATEST, requestedBy: 'admin@example.test' })

    expect((await admin.post('/api/admin/update', { tag: LATEST })).status).toBe(409)
  })

  it('shows what the host reports while it installs', async () => {
    rmSync(path.join(updateDir, 'request.json'))
    writeFileSync(
      path.join(updateDir, 'status.json'),
      JSON.stringify({ state: 'failed', tag: LATEST, at: Date.now(), message: 'the image could not be pulled' }),
    )
    const info = await (await admin.get('/api/admin/update')).json()
    expect(info.status).toMatchObject({ state: 'failed', message: 'the image could not be pulled' })
  })

  it('offers no button where the host runs no updater', async () => {
    const info = await (await manualAdmin.get('/api/admin/update')).json()
    expect(info).toMatchObject({ enabled: false, updateAvailable: true })
    expect((await manualAdmin.post('/api/admin/update', { tag: LATEST })).status).toBe(409)
  })
})
