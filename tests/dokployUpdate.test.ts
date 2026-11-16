import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupFailed } from '../server/dbBackup.ts'
import { DokployClient, DokployError, withTag } from '../server/dokploy.ts'
import { DokployUpdater } from '../server/dokployUpdate.ts'
import { reloadEnv } from '../server/env.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const KEY = 'dk_live_SUPER-SECRET-KEY-123'
const COMPOSE = 'cmp_abc123'

interface Call {
  method: string
  procedure: string
  query: URLSearchParams
  body: Record<string, unknown> | null
  key: string | undefined
}

interface Panel {
  url: string
  calls: Call[]
  /** the compose Environment the panel holds */
  env: string
  /** what deployment.allByCompose answers */
  deployments: unknown
  /** runs when compose.redeploy arrives */
  onRedeploy: () => void
  /** replaces the answer to one procedure: [status, raw body] */
  override: Map<string, { status: number; body: string; headers?: Record<string, string> }>
  close(): Promise<void>
}

const panels: Panel[] = []
const dirs: string[] = []

afterEach(async () => {
  unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(panels.splice(0).map((p) => p.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function startPanel(initialEnv: string): Promise<Panel> {
  const panel: Panel = {
    url: '',
    calls: [],
    env: initialEnv,
    deployments: [],
    onRedeploy: () => {},
    override: new Map(),
    close: async () => {},
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://panel')
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const procedure = url.pathname.replace(/^\/api\//, '')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      panel.calls.push({
        method: req.method ?? '',
        procedure,
        query: url.searchParams,
        body,
        key: req.headers['x-api-key'] as string | undefined,
      })
      const forced = panel.override.get(procedure)
      if (forced) {
        res.writeHead(forced.status, { 'content-type': 'application/json', ...forced.headers })
        return res.end(forced.body)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (procedure === 'compose.one') return res.end(JSON.stringify({ composeId: COMPOSE, env: panel.env }))
      if (procedure === 'compose.update') {
        panel.env = String(body?.env ?? '')
        return res.end('{}')
      }
      if (procedure === 'compose.redeploy') {
        panel.onRedeploy()
        return res.end('{}')
      }
      if (procedure === 'deployment.allByCompose') return res.end(JSON.stringify(panel.deployments))
      res.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  panel.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  panel.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  panels.push(panel)
  return panel
}

function statusDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'doop-dokploy-'))
  dirs.push(dir)
  return dir
}

function record(dir: string): { state: string; tag: string; previous: string; message: string; at: number } {
  return JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'))
}

function updater(panel: Panel, dir: string, extra: Partial<ConstructorParameters<typeof DokployUpdater>[0]> = {}) {
  return new DokployUpdater({
    current: 'v1',
    config: { url: panel.url, apiKey: KEY, composeId: COMPOSE },
    statusDir: dir,
    backup: async () => '/backups/x.sql.gz',
    pollMs: 1,
    sleep: async () => {},
    ...extra,
  })
}

/** Everything a test run printed, to prove the key is in none of it. */
function captureOutput(): () => string {
  const lines: string[] = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    })
  }
  return () => lines.join('\n')
}

const writes = (panel: Panel) => panel.calls.filter((c) => c.method === 'POST')

describe('withTag', () => {
  it('changes only the DOOP_TAG line and keeps CRLF and the final newline', () => {
    const before = 'BETTER_AUTH_URL=https://doop.test\r\nDOOP_TAG=v1\r\nPOSTGRES_PASSWORD=a=b#c\r\n'
    const after = withTag(before, 'v2')
    expect(after.env).toBe('BETTER_AUTH_URL=https://doop.test\r\nDOOP_TAG=v2\r\nPOSTGRES_PASSWORD=a=b#c\r\n')
    expect(after.previous).toBe('v1')
    expect(withTag('A=1\nDOOP_TAG=v1', 'v2').env).toBe('A=1\nDOOP_TAG=v2')
    expect(withTag('DOOP_TAG="v1"\n', 'v2')).toEqual({ env: 'DOOP_TAG=v2\n', previous: 'v1' })
  })

  it('refuses no DOOP_TAG line and more than one', () => {
    expect(() => withTag('A=1\nB=2\n', 'v2')).toThrow(/no DOOP_TAG= line/)
    expect(() => withTag('', 'v2')).toThrow(DokployError)
    expect(() => withTag('DOOP_TAG=v1\nDOOP_TAG=v0\n', 'v2')).toThrow(/more than one/)
    /* a variable that merely starts with the name is not it */
    expect(() => withTag('DOOP_TAG_X=1\n', 'v2')).toThrow(/no DOOP_TAG= line/)
  })
})

describe('the Dokploy client', () => {
  it('sends the key to the panel, as a header, and refuses a redirect elsewhere', async () => {
    const elsewhere = await startPanel('')
    const panel = await startPanel('DOOP_TAG=v1\n')
    panel.override.set('compose.one', {
      status: 302,
      body: '',
      headers: { location: `${elsewhere.url}/api/compose.one` },
    })
    const client = new DokployClient({ url: panel.url, apiKey: KEY, composeId: COMPOSE })
    await expect(client.composeEnv()).rejects.toThrow(DokployError)
    expect(panel.calls[0]?.key).toBe(KEY)
    expect(elsewhere.calls).toHaveLength(0)
  })

  it('gives up on a panel that does not answer', async () => {
    const hang = http.createServer(() => {})
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve))
    const client = new DokployClient({
      url: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
      apiKey: KEY,
      composeId: COMPOSE,
      timeoutMs: 150,
    })
    await expect(client.composeEnv()).rejects.toThrow(/did not answer compose.one in time/)
    hang.closeAllConnections()
    hang.close()
  })

  it('treats an unexpected shape as an error, not a crash', async () => {
    const panel = await startPanel('')
    const client = new DokployClient({ url: panel.url, apiKey: KEY, composeId: COMPOSE })
    panel.override.set('compose.one', { status: 200, body: JSON.stringify({ env: 5 }) })
    await expect(client.composeEnv()).rejects.toThrow(/shape Doop does not recognise/)
    panel.override.set('compose.one', { status: 200, body: JSON.stringify(['x']) })
    await expect(client.composeEnv()).rejects.toThrow(DokployError)
    panel.override.set('compose.one', { status: 200, body: 'not json' })
    await expect(client.composeEnv()).rejects.toThrow(/other than JSON/)
    panel.override.set('deployment.allByCompose', { status: 200, body: JSON.stringify({ a: 1 }) })
    await expect(client.deployments()).rejects.toThrow(/shape Doop does not recognise/)
    panel.override.set('deployment.allByCompose', { status: 200, body: JSON.stringify([{ status: 'done' }]) })
    expect(await client.deployments()).toEqual([{ id: null, status: 'done', createdAt: null }])
  })
})

describe('Update now through Dokploy', () => {
  it('backs up, swaps the tag, redeploys, then waits to be replaced', async () => {
    const panel = await startPanel('BETTER_AUTH_URL=https://doop.test\r\nDOOP_TAG=v1\r\n')
    panel.deployments = [{ deploymentId: 'd1', status: 'done', createdAt: '2026-11-01T00:00:00Z' }]
    const dir = statusDir()
    const order: string[] = []
    const backup = vi.fn(async (label: string) => {
      order.push(`backup:${label}`)
      return '/backups/x.sql.gz'
    })
    let reachedWatch: () => void = () => {}
    const watching = new Promise<void>((resolve) => (reachedWatch = resolve))
    const up = updater(panel, dir, {
      backup,
      /* the old process is replaced while it waits: this sleep never returns */
      sleep: () => {
        reachedWatch()
        return new Promise(() => {})
      },
    })
    expect(up.reserve()).toBe(true)
    expect(up.reserve()).toBe(false)
    await up.start('v2')
    expect(record(dir)).toMatchObject({ state: 'running', tag: 'v2', previous: 'v1' })
    await watching

    expect(backup).toHaveBeenCalledWith('before-v2')
    expect(panel.calls.map((c) => c.procedure)).toEqual([
      'compose.one',
      'compose.one',
      'deployment.allByCompose',
      'compose.update',
      'compose.redeploy',
    ])
    expect(writes(panel)[0]?.body).toEqual({
      composeId: COMPOSE,
      env: 'BETTER_AUTH_URL=https://doop.test\r\nDOOP_TAG=v2\r\n',
    })
    expect(panel.calls.every((c) => c.key === KEY)).toBe(true)
    expect(record(dir).message).toBe('Dokploy is installing v2; Doop restarts and this page reloads.')

    /* the new process boots as v2 and finishes the record */
    const next = updater(panel, dir, { current: 'v2' })
    expect(await next.status()).toMatchObject({ state: 'succeeded', tag: 'v2' })
    expect(record(dir).state).toBe('succeeded')
  })

  it('puts the previous tag back when the deployment fails', async () => {
    const panel = await startPanel('A=1\nDOOP_TAG=v1\n')
    panel.deployments = [{ deploymentId: 'd1', status: 'done', createdAt: '2026-11-01T00:00:00Z' }]
    panel.onRedeploy = () => {
      panel.deployments = [
        { deploymentId: 'd2', status: 'error', createdAt: new Date().toISOString() },
        { deploymentId: 'd1', status: 'done', createdAt: '2026-11-01T00:00:00Z' },
      ]
    }
    const dir = statusDir()
    const up = updater(panel, dir)
    up.reserve()
    await up.start('v2')
    await up.idle

    expect(panel.env).toBe('A=1\nDOOP_TAG=v1\n')
    expect(writes(panel).map((c) => c.procedure)).toEqual(['compose.update', 'compose.redeploy', 'compose.update'])
    expect(record(dir)).toMatchObject({ state: 'failed', tag: 'v2', previous: 'v1' })
    expect(record(dir).message).toMatch(/failed.*DOOP_TAG is back at v1, which is still running/)
    expect(up.busy).toBe(false)
  })

  it('ignores deployments that were there before the redeploy', async () => {
    const panel = await startPanel('DOOP_TAG=v1\n')
    /* an old failed deployment is not this update's */
    panel.deployments = [{ deploymentId: 'old', status: 'error', createdAt: '2026-10-01T00:00:00Z' }]
    const dir = statusDir()
    let now = 1_000
    const up = updater(panel, dir, {
      now: () => now,
      watchMs: 5_000,
      sleep: async () => {
        now += 1_000
      },
    })
    up.reserve()
    await up.start('v2')
    await up.idle
    expect(record(dir).message).toMatch(/did not finish installing v2/)
    expect(panel.env).toBe('DOOP_TAG=v1\n')
  })

  it('stops before anything is written when the backup fails', async () => {
    const panel = await startPanel('DOOP_TAG=v1\n')
    const dir = statusDir()
    const up = updater(panel, dir, {
      backup: async () => {
        throw new BackupFailed('The database backup failed (pg_dump exited with 1).')
      },
    })
    up.reserve()
    await up.start('v2')
    await up.idle
    expect(writes(panel)).toHaveLength(0)
    expect(panel.env).toBe('DOOP_TAG=v1\n')
    expect(record(dir)).toMatchObject({ state: 'failed', tag: 'v2' })
    expect(record(dir).message).toBe(
      'The database backup failed (pg_dump exited with 1). Nothing was changed; v1 is still running.',
    )
  })

  it('refuses a missing or doubled DOOP_TAG before the backup and before any write', async () => {
    for (const env of ['A=1\n', 'DOOP_TAG=v1\nDOOP_TAG=v0\n']) {
      const panel = await startPanel(env)
      const dir = statusDir()
      const backup = vi.fn(async () => '/x')
      const up = updater(panel, dir, { backup })
      up.reserve()
      await up.start('v2')
      await up.idle
      expect(backup).not.toHaveBeenCalled()
      expect(writes(panel)).toHaveLength(0)
      expect(record(dir).state).toBe('failed')
      expect(record(dir).message).toMatch(/DOOP_TAG= line/)
    }
  })

  it('treats a compose it cannot read as a failed update', async () => {
    const panel = await startPanel('')
    panel.override.set('compose.one', { status: 200, body: JSON.stringify({ env: { not: 'a string' } }) })
    const dir = statusDir()
    const up = updater(panel, dir)
    up.reserve()
    await up.start('v2')
    await up.idle
    expect(record(dir).message).toMatch(/shape Doop does not recognise.*Nothing was changed/)
  })

  it('never lets the API key reach the status file, a log line or an error', async () => {
    const output = captureOutput()
    for (const [status, body] of [
      [401, JSON.stringify({ code: 'UNAUTHORIZED', message: `bad key ${KEY}` })],
      [500, JSON.stringify({ code: 'INTERNAL_SERVER_ERROR', message: `crashed with ${KEY}` })],
    ] as const) {
      for (const procedure of ['compose.one', 'compose.update', 'compose.redeploy']) {
        const panel = await startPanel('DOOP_TAG=v1\n')
        panel.override.set(procedure, { status, body })
        const dir = statusDir()
        const up = updater(panel, dir)
        up.reserve()
        await up.start('v2')
        await up.idle
        const written = readFileSync(path.join(dir, 'status.json'), 'utf8')
        expect(written).not.toContain(KEY)
        expect(record(dir).state).toBe('failed')
        expect(JSON.stringify(await up.status())).not.toContain(KEY)
      }
    }
    /* the client's own errors, too */
    const panel = await startPanel('')
    panel.override.set('compose.one', { status: 401, body: `{"message":"${KEY}"}` })
    const client = new DokployClient({ url: panel.url, apiKey: KEY, composeId: COMPOSE })
    const error = await client.composeEnv().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DokployError)
    expect(String((error as Error).message)).not.toContain(KEY)
    expect(String((error as Error).message)).toMatch(/refused the API key/)
    expect(output()).not.toContain(KEY)
  })

  it('reports a key refused on compose.update as nothing changed', async () => {
    const panel = await startPanel('DOOP_TAG=v1\n')
    panel.override.set('compose.update', { status: 401, body: '{}' })
    const dir = statusDir()
    const up = updater(panel, dir)
    up.reserve()
    await up.start('v2')
    await up.idle
    expect(panel.calls.filter((c) => c.procedure === 'compose.redeploy')).toHaveLength(0)
    expect(record(dir).state).toBe('failed')
  })
})

describe('settling a record at boot', () => {
  function seed(dir: string, record: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify(record))
  }
  const base = { tag: 'v2', previous: 'v1', message: 'Dokploy is installing v2; Doop restarts and this page reloads.' }

  it('succeeds when the running version is the tag', async () => {
    const dir = statusDir()
    seed(dir, { ...base, state: 'running', at: Date.now() })
    const up = new DokployUpdater({
      current: 'v2',
      config: { url: 'http://127.0.0.1:1', apiKey: KEY, composeId: COMPOSE },
      statusDir: dir,
    })
    await up.settleAtBoot()
    expect(record(dir)).toMatchObject({ state: 'succeeded', tag: 'v2' })
  })

  it('fails a running record older than 20 minutes when another version runs', async () => {
    const dir = statusDir()
    seed(dir, { ...base, state: 'running', at: Date.now() - 21 * 60_000 })
    const up = new DokployUpdater({
      current: 'v1',
      config: { url: 'http://127.0.0.1:1', apiKey: KEY, composeId: COMPOSE },
      statusDir: dir,
    })
    await up.settleAtBoot()
    expect(record(dir)).toMatchObject({ state: 'failed', message: 'Dokploy did not install v2; v1 is running.' })
  })

  it('leaves a recent running record alone, and reads no file as idle', async () => {
    const dir = statusDir()
    const up = new DokployUpdater({
      current: 'v1',
      config: { url: 'http://127.0.0.1:1', apiKey: KEY, composeId: COMPOSE },
      statusDir: dir,
    })
    expect(await up.status()).toEqual({ state: 'idle' })
    seed(dir, { ...base, state: 'running', at: Date.now() - 60_000 })
    expect(await up.status()).toMatchObject({ state: 'running', tag: 'v2' })
  })
})

describe('the Dokploy environment variables', () => {
  it('want all three together', () => {
    vi.stubEnv('DOOP_DOKPLOY_URL', 'https://dokploy.example.com')
    expect(() => reloadEnv()).toThrow(/DOOP_DOKPLOY_API_KEY, DOOP_DOKPLOY_COMPOSE_ID: missing/)
    unstubAllEnvs()
    expect(() => stubEnv('DOOP_DOKPLOY_API_KEY', KEY)).toThrow(/DOOP_DOKPLOY_URL, DOOP_DOKPLOY_COMPOSE_ID: missing/)
  })

  it('refuse a folder updater beside them, naming both', () => {
    vi.stubEnv('DOOP_DOKPLOY_URL', 'https://dokploy.example.com')
    vi.stubEnv('DOOP_DOKPLOY_API_KEY', KEY)
    vi.stubEnv('DOOP_DOKPLOY_COMPOSE_ID', COMPOSE)
    vi.stubEnv('DOOP_UPDATE_DIR', '/opt/doop')
    expect(() => reloadEnv()).toThrow(/DOOP_UPDATE_DIR.*DOOP_DOKPLOY_URL/)
    vi.stubEnv('DOOP_UPDATE_DIR', '')
    expect(() => reloadEnv()).not.toThrow()
  })

  it('take an origin only: https, or http on a private network', () => {
    vi.stubEnv('DOOP_DOKPLOY_API_KEY', KEY)
    vi.stubEnv('DOOP_DOKPLOY_COMPOSE_ID', COMPOSE)
    const accepted = [
      'https://dokploy.example.com',
      'http://127.0.0.1:3000',
      'http://192.168.1.5:3000',
      'http://dokploy:3000',
    ]
    for (const url of accepted) {
      vi.stubEnv('DOOP_DOKPLOY_URL', url)
      expect(() => reloadEnv(), url).not.toThrow()
    }
    const refused = [
      'http://dokploy.example.com',
      'https://dokploy.example.com/panel',
      'https://user:pw@dokploy.example.com',
      'https://dokploy.example.com/?x=1',
      'ftp://dokploy.example.com',
      'not a url',
    ]
    for (const url of refused) {
      vi.stubEnv('DOOP_DOKPLOY_URL', url)
      expect(() => reloadEnv(), url).toThrow(/DOOP_DOKPLOY_URL/)
    }
  })
})
