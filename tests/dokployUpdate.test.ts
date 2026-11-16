import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupFailed } from '../server/dbBackup.ts'
import { DokployError, triggerDeploy } from '../server/dokploy.ts'
import { DokployUpdater } from '../server/dokployUpdate.ts'
import { env, isPrivateHost, reloadEnv, retiredDokployVars } from '../server/env.ts'
import { unstubAllEnvs } from './envStub.ts'

const TOKEN = 'SECRETtoken_0123456789abcdef'
const HOOK_PATH = `/api/deploy/compose/${TOKEN}`

interface Call {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

interface Panel {
  /** the webhook URL, token included */
  url: string
  origin: string
  calls: Call[]
  /** what the webhook answers: [status, body, extra headers] */
  answer: { status: number; body: string; headers?: Record<string, string> }
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

async function startPanel(): Promise<Panel> {
  const panel: Panel = {
    url: '',
    origin: '',
    calls: [],
    answer: { status: 200, body: JSON.stringify({ message: 'Compose deployed successfully' }) },
    close: async () => {},
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      panel.calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.writeHead(panel.answer.status, { 'content-type': 'application/json', ...panel.answer.headers })
      res.end(panel.answer.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  panel.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  panel.url = `${panel.origin}${HOOK_PATH}`
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
    webhookUrl: panel.url,
    statusDir: dir,
    backup: async () => '/backups/x.sql.gz',
    ...extra,
  })
}

async function runUpdate(up: DokployUpdater, tag = 'v2'): Promise<void> {
  expect(up.reserve()).toBe(true)
  await up.start(tag)
  await up.idle
}

/** Everything a test run printed, to prove the webhook URL is in none of it. */
function captureOutput(): () => string {
  const lines: string[] = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    })
  }
  return () => lines.join('\n')
}

describe('the webhook call', () => {
  it('posts an empty JSON object, with no GitHub event header, and accepts a 200', async () => {
    const panel = await startPanel()
    await triggerDeploy(panel.url)
    expect(panel.calls).toHaveLength(1)
    const call = panel.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe(HOOK_PATH)
    expect(call.body).toBe('{}')
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.headers['x-github-event']).toBeUndefined()
  })

  it('says what to do for each answer Dokploy gives', async () => {
    const panel = await startPanel()
    const ask = async (status: number, body: string, headers?: Record<string, string>) => {
      panel.answer = { status, body, headers }
      return triggerDeploy(panel.url).then(
        () => 'ok',
        (e: unknown) => (e as Error).message,
      )
    }
    expect(await ask(400, JSON.stringify({ message: 'Automatic deployments are disabled for this compose' }))).toBe(
      'Turn on Autodeploy for this service in Dokploy (General tab).',
    )
    expect(await ask(404, JSON.stringify({ message: 'Compose Not Found' }))).toBe(
      "Dokploy does not know this webhook; copy it again from the service's Deployments tab.",
    )
    const git = 'Dokploy refused the webhook: this service deploys from git; Update now needs a Raw compose.'
    expect(await ask(301, JSON.stringify({ message: 'Branch Not Match' }))).toBe(git)
    /* a 301 that also names a Location is still not followed */
    const elsewhere = await startPanel()
    expect(await ask(301, '{}', { location: `${elsewhere.origin}/somewhere` })).toBe(git)
    expect(elsewhere.calls).toHaveLength(0)
    expect(await ask(500, 'boom')).toBe('Dokploy answered the webhook with 500.')
    expect(await ask(400, JSON.stringify({ message: 'Error deploying Compose' }))).toBe(
      'Dokploy answered the webhook with 400.',
    )
  })

  it('reports a panel that is down or silent without naming the URL', async () => {
    const down = http.createServer()
    await new Promise<void>((resolve) => down.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(down.address() as AddressInfo).port}${HOOK_PATH}`
    await new Promise<void>((resolve) => down.close(() => resolve()))
    const unreachable = (await triggerDeploy(url).catch((e: unknown) => e)) as Error
    expect(unreachable).toBeInstanceOf(DokployError)
    expect(unreachable.message).toBe('The Dokploy webhook could not be reached.')

    const hang = http.createServer(() => {})
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve))
    const silent = (await triggerDeploy(`http://127.0.0.1:${(hang.address() as AddressInfo).port}${HOOK_PATH}`, {
      timeoutMs: 150,
    }).catch((e: unknown) => e)) as Error
    expect(silent.message).toBe('The Dokploy webhook did not answer in time.')
    hang.closeAllConnections()
    hang.close()
    for (const error of [unreachable, silent]) expect(error.message).not.toContain(TOKEN)
  })

  it('stops reading an answer past 2 MB', async () => {
    const panel = await startPanel()
    panel.answer = { status: 400, body: `Automatic deployments are disabled ${'x'.repeat(2 * 1024 * 1024 + 10)}` }
    await expect(triggerDeploy(panel.url)).rejects.toThrow('Dokploy answered the webhook with 400.')
  })
})

describe('Update now through the webhook', () => {
  it('backs up, calls the webhook once, then waits to be replaced', async () => {
    const panel = await startPanel()
    const dir = statusDir()
    const order: string[] = []
    const backup = vi.fn(async (label: string) => {
      order.push(`backup:${label}`)
      return '/backups/x.sql.gz'
    })
    const up = updater(panel, dir, { backup })
    expect(up.reserve()).toBe(true)
    expect(up.reserve()).toBe(false)
    await up.start('v2')
    expect(record(dir)).toMatchObject({ state: 'running', tag: 'v2', previous: 'v1' })
    await up.idle

    expect(backup).toHaveBeenCalledWith('before-v2')
    /* the webhook is the only thing Doop sends to Dokploy */
    expect(panel.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${HOOK_PATH}`])
    expect(record(dir)).toMatchObject({
      state: 'running',
      message: 'Dokploy is installing v2; Doop restarts and this page reloads.',
    })
    expect(up.busy).toBe(false)

    /* the new process boots as v2 and finishes the record */
    const next = updater(panel, dir, { current: 'v2' })
    expect(await next.status()).toMatchObject({ state: 'succeeded', tag: 'v2' })
    expect(record(dir).state).toBe('succeeded')
  })

  it('stops before the webhook when the backup fails', async () => {
    const panel = await startPanel()
    const dir = statusDir()
    const up = updater(panel, dir, {
      backup: async () => {
        throw new BackupFailed('The database backup failed (pg_dump exited with 1).')
      },
    })
    await runUpdate(up)
    expect(panel.calls).toHaveLength(0)
    expect(record(dir)).toMatchObject({ state: 'failed', tag: 'v2' })
    expect(record(dir).message).toBe(
      'The database backup failed (pg_dump exited with 1). Nothing was changed; v1 is still running.',
    )
    expect(up.busy).toBe(false)
  })

  it('records the four webhook failures as written for the admin', async () => {
    const cases: [number, string, string, Record<string, string>?][] = [
      [
        400,
        JSON.stringify({ message: 'Automatic deployments are disabled for this compose' }),
        'Turn on Autodeploy for this service in Dokploy (General tab).',
      ],
      [
        404,
        '{"message":"Compose Not Found"}',
        "Dokploy does not know this webhook; copy it again from the service's Deployments tab.",
      ],
      [
        301,
        '{"message":"Branch Not Match"}',
        'Dokploy refused the webhook: this service deploys from git; Update now needs a Raw compose.',
      ],
      [502, '', 'Dokploy answered the webhook with 502.'],
    ]
    for (const [status, body, message] of cases) {
      const panel = await startPanel()
      panel.answer = { status, body }
      const dir = statusDir()
      await runUpdate(updater(panel, dir))
      expect(record(dir)).toMatchObject({ state: 'failed', tag: 'v2', message })
    }
  })

  it('never lets the webhook URL reach the status file, a log line, an error or a status read', async () => {
    const output = captureOutput()
    const answers: [number, string][] = [
      [200, `{"echo":"${TOKEN}"}`],
      [400, `Automatic deployments are disabled ${TOKEN}`],
      [404, TOKEN],
      [301, TOKEN],
      [500, `crashed ${HOOK_PATH}`],
    ]
    for (const [status, body] of answers) {
      const panel = await startPanel()
      panel.answer = { status, body }
      const dir = statusDir()
      const up = updater(panel, dir)
      await runUpdate(up)
      expect(readFileSync(path.join(dir, 'status.json'), 'utf8')).not.toContain(TOKEN)
      expect(JSON.stringify(await up.status())).not.toContain(TOKEN)
    }
    /* a dead panel, and a backup that throws something unexpected */
    const down = await startPanel()
    const deadUrl = down.url
    await down.close()
    const dir = statusDir()
    await runUpdate(
      new DokployUpdater({ current: 'v1', webhookUrl: deadUrl, statusDir: dir, backup: async () => '/x' }),
    )
    expect(readFileSync(path.join(dir, 'status.json'), 'utf8')).not.toContain(TOKEN)
    const odd = statusDir()
    await runUpdate(
      new DokployUpdater({
        current: 'v1',
        webhookUrl: deadUrl,
        statusDir: odd,
        backup: async () => {
          throw new Error(`failed at ${deadUrl}`)
        },
      }),
    )
    expect(record(odd).message).toBe(
      'An unexpected error stopped the update. Nothing was changed; v1 is still running.',
    )
    expect(readFileSync(path.join(odd, 'status.json'), 'utf8')).not.toContain(TOKEN)
    expect(output()).not.toContain(TOKEN)
  })
})

describe('settling a record at boot', () => {
  function seed(dir: string, data: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data))
  }
  const base = { tag: 'v2', previous: 'v1', message: 'Dokploy is installing v2; Doop restarts and this page reloads.' }
  const idle = (dir: string, current: string) =>
    new DokployUpdater({ current, webhookUrl: `http://127.0.0.1:1${HOOK_PATH}`, statusDir: dir })

  it('succeeds when the running version is the tag', async () => {
    const dir = statusDir()
    seed(dir, { ...base, state: 'running', at: Date.now() })
    await idle(dir, 'v2').settleAtBoot()
    expect(record(dir)).toMatchObject({ state: 'succeeded', tag: 'v2' })
  })

  it('fails a running record older than 20 minutes when another version runs', async () => {
    const dir = statusDir()
    seed(dir, { ...base, state: 'running', at: Date.now() - 21 * 60_000 })
    await idle(dir, 'v1').settleAtBoot()
    expect(record(dir).state).toBe('failed')
    expect(record(dir).message).toBe(
      "Dokploy has not installed v2 after 20 minutes. Check the service's deployment log in Dokploy. If DOOP_TAG is set in its Environment, clear it so the service follows the latest release.",
    )
  })

  it('leaves a recent running record alone, and reads no file as idle', async () => {
    const dir = statusDir()
    const up = idle(dir, 'v1')
    expect(await up.status()).toEqual({ state: 'idle' })
    seed(dir, { ...base, state: 'running', at: Date.now() - 60_000 })
    expect(await up.status()).toMatchObject({ state: 'running', tag: 'v2' })
  })
})

describe('the Dokploy environment variable', () => {
  const stubRepo = () => vi.stubEnv('DOOP_UPDATE_REPO', 'acme/doop')
  const url = (u: string) => vi.stubEnv('DOOP_DOKPLOY_WEBHOOK_URL', u)

  it('accepts the compose webhook shape over https, and http on a private host', () => {
    stubRepo()
    for (const good of [
      `https://dokploy.example.com${HOOK_PATH}`,
      `http://127.0.0.1:3000${HOOK_PATH}`,
      `http://192.168.1.5:3000${HOOK_PATH}`,
      `http://dokploy:3000${HOOK_PATH}`,
      'https://dokploy.example.com/api/deploy/compose/abcdefgh',
    ]) {
      url(good)
      expect(() => reloadEnv(), good).not.toThrow()
    }
    expect(env.DOOP_DOKPLOY_WEBHOOK_URL).toBe('https://dokploy.example.com/api/deploy/compose/abcdefgh')
  })

  it('refuses a wrong path, a query, a fragment, credentials, a short token and a public http host', () => {
    stubRepo()
    for (const bad of [
      'https://dokploy.example.com/api/deploy/abcdefghij',
      'https://dokploy.example.com/api/deploy/compose/',
      'https://dokploy.example.com/api/deploy/compose/short',
      `https://dokploy.example.com${HOOK_PATH}/extra`,
      `https://dokploy.example.com${HOOK_PATH}?x=1`,
      `https://dokploy.example.com${HOOK_PATH}#frag`,
      `https://user:pw@dokploy.example.com${HOOK_PATH}`,
      `http://dokploy.example.com${HOOK_PATH}`,
      `http://[2606:4700::1111]${HOOK_PATH}`,
      `http://10.example.com${HOOK_PATH}`,
      `ftp://dokploy.example.com${HOOK_PATH}`,
      'not a url',
    ]) {
      url(bad)
      expect(() => reloadEnv(), bad).toThrow(/DOOP_DOKPLOY_WEBHOOK_URL/)
    }
  })

  it('never puts the value in the error it throws', () => {
    stubRepo()
    for (const bad of [`https://dokploy.example.com${HOOK_PATH}?x=1`, `http://dokploy.example.com${HOOK_PATH}`]) {
      url(bad)
      let message = ''
      try {
        reloadEnv()
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/DOOP_DOKPLOY_WEBHOOK_URL/)
      expect(message).not.toContain(TOKEN)
    }
  })

  it('needs DOOP_UPDATE_REPO, and refuses a folder updater beside it, naming both', () => {
    url(`https://dokploy.example.com${HOOK_PATH}`)
    expect(() => reloadEnv()).toThrow(/DOOP_UPDATE_REPO: missing/)
    stubRepo()
    expect(() => reloadEnv()).not.toThrow()
    vi.stubEnv('DOOP_UPDATE_DIR', '/opt/doop')
    expect(() => reloadEnv()).toThrow(/DOOP_UPDATE_DIR.*DOOP_DOKPLOY_WEBHOOK_URL/)
  })

  it('names the retired API variables, and ignores them', () => {
    expect(retiredDokployVars()).toEqual([])
    vi.stubEnv('DOOP_DOKPLOY_URL', 'https://dokploy.example.com')
    vi.stubEnv('DOOP_DOKPLOY_API_KEY', 'dk_old')
    vi.stubEnv('DOOP_DOKPLOY_COMPOSE_ID', 'cmp_old')
    expect(retiredDokployVars()).toEqual(['DOOP_DOKPLOY_URL', 'DOOP_DOKPLOY_API_KEY', 'DOOP_DOKPLOY_COMPOSE_ID'])
    /* no error, and nothing of them in the parsed environment */
    expect(() => reloadEnv()).not.toThrow()
    expect(env.DOOP_DOKPLOY_WEBHOOK_URL).toBeUndefined()
    expect(Object.keys(env)).not.toContain('DOOP_DOKPLOY_API_KEY')
  })

  it('judges a private host by its parsed address, not its text', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.5',
      '172.16.0.1',
      '[::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      'localhost',
      'dokploy',
    ]) {
      expect(isPrivateHost(host), host).toBe(true)
    }
    for (const host of [
      '[2606:4700::1111]',
      '[::ffff:8.8.8.8]',
      '[::ffff:127.0.0.1]',
      '10.example.com',
      '127.evil.com',
      '192.168.1.evil.net',
      '8.8.8.8',
      '172.32.0.1',
      'dokploy.example.com',
    ]) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })
})
