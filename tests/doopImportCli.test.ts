import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, request, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserNotFoundError, findBrowser, installedBrowserPaths } from '../packages/doop-import/src/browser.ts'
import { main } from '../packages/doop-import/src/cli.ts'
import { blockedRequest, isLoopbackHost, isPrivateAddress } from '../packages/doop-import/src/guard.ts'
import { renderStorybook } from '../packages/doop-import/src/render.ts'
import { resolveRequestPath, serveDirectory, type StaticServer } from '../packages/doop-import/src/serve.ts'
import { ticketUrl, UploadError, uploadBundle } from '../packages/doop-import/src/upload.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/* The doop-import CLI (packages/doop-import): its static server, its browser lookup and its upload, and the whole run against a tiny storybook-static build and a real ticket on a test server. */

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = path.join(root, 'tests', 'fixtures', 'storybook-static')
const browserPath = findBrowserPath()

/** a raw request, so a path is sent exactly as written (fetch would tidy a `..` away) */
function raw(origin: string, urlPath: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(origin)
    const req = request({ host: url.hostname, port: url.port, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the static server', () => {
  it('refuses any path that leaves the directory', () => {
    const base = path.resolve('/srv/sb')
    expect(resolveRequestPath(base, '/iframe.html')).toBe(path.join(base, 'iframe.html'))
    expect(resolveRequestPath(base, '/')).toBe(path.join(base, 'index.html'))
    expect(resolveRequestPath(base, '/sb/')).toBe(path.join(base, 'sb', 'index.html'))
    for (const bad of [
      '/../etc/passwd',
      '/a/../../etc/passwd',
      '/%2e%2e/etc/passwd',
      '/%2E%2E%2fetc/passwd',
      '/a%5c..%5cb',
      '/a\\..\\b',
      '/ok%00.html',
      '/%zz',
      'iframe.html',
      '//..//x',
    ]) {
      expect(resolveRequestPath(base, bad), bad).toBeNull()
    }
  })

  describe('serving a directory', () => {
    let server: StaticServer
    beforeAll(async () => {
      server = await serveDirectory(fixture)
    })
    afterAll(async () => {
      await server.close()
    })

    it('listens on 127.0.0.1 and serves the build', async () => {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const index = await fetch(`${server.origin}/index.json`)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('application/json')
      expect(await (await fetch(`${server.origin}/iframe.html`)).text()).toContain('storybook-root')
      expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404)
    })

    it('answers a traversal with an error and a file nowhere near the build', async () => {
      for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/a/%2e%2e/%2e%2e/x']) {
        const answer = await raw(server.origin, bad)
        expect([400, 404], bad).toContain(answer.status)
        expect(answer.body).not.toContain('"name"')
      }
    })

    it('reads only: other methods and another Host header are refused', async () => {
      expect((await fetch(`${server.origin}/index.json`, { method: 'POST', body: 'x' })).status).toBe(405)
      expect((await raw(server.origin, '/index.json', { host: 'evil.example' })).status).toBe(403)
    })
  })
})

describe('the browser lookup', () => {
  const only = (...files: string[]) => ({ isExecutable: (file: string) => files.includes(file) })

  it('takes --browser first, then DOOP_IMPORT_BROWSER, then CHROME_PATH', () => {
    const all = only('/flag', '/doop', '/chrome', ...installedBrowserPaths('linux', {}))
    const env = { DOOP_IMPORT_BROWSER: '/doop', CHROME_PATH: '/chrome' }
    expect(findBrowser({ flag: '/flag', env, platform: 'linux', ...all })).toEqual({
      path: '/flag',
      source: '--browser',
    })
    expect(findBrowser({ env, platform: 'linux', ...all })).toEqual({ path: '/doop', source: 'DOOP_IMPORT_BROWSER' })
    expect(findBrowser({ env: { CHROME_PATH: '/chrome' }, platform: 'linux', ...all })).toEqual({
      path: '/chrome',
      source: 'CHROME_PATH',
    })
  })

  it('falls back to a browser at a usual install path, per platform', () => {
    const [first, second] = installedBrowserPaths('linux', {})
    expect(findBrowser({ env: {}, platform: 'linux', ...only(second!) })).toEqual({
      path: second,
      source: 'installed',
    })
    expect(first).toBeTruthy()
    const mac = installedBrowserPaths('darwin', {})
    expect(mac.every((file) => file.startsWith('/Applications/'))).toBe(true)
    const windows = installedBrowserPaths('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    })
    expect(windows.some((file) => file.includes('msedge.exe') && file.startsWith('C:\\Program Files'))).toBe(true)
    expect(windows.some((file) => file.startsWith('C:\\Users\\a\\AppData\\Local'))).toBe(true)
  })

  it('accepts a chrome-headless-shell binary, as @puppeteer/browsers installs it', async () => {
    const { chmod, mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(path.join(tmpdir(), 'doop-import-shell-'))
    try {
      const shell = path.join(directory, 'chrome-headless-shell')
      await writeFile(shell, '#!/bin/sh\n')
      await chmod(shell, 0o755)
      expect(findBrowser({ flag: shell, env: {}, platform: 'linux' })).toEqual({ path: shell, source: '--browser' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('makes a named path absolute and wants a file, not a directory', () => {
    const seen: string[] = []
    const record = { isExecutable: (file: string) => (seen.push(file), true) }
    expect(findBrowser({ flag: 'bin/browser', env: {}, platform: 'linux', ...record }).path).toBe(
      path.resolve('bin/browser'),
    )
    expect(path.isAbsolute(seen[0]!)).toBe(true)
    expect(() => findBrowser({ flag: fixture, env: {}, platform: 'linux' })).toThrow(/not an executable file/)
  })

  it('names the fix when nothing is found, and never falls past a path that was named', () => {
    expect(() => findBrowser({ env: {}, platform: 'linux', ...only() })).toThrow(
      /--browser <path>.*DOOP_IMPORT_BROWSER/,
    )
    const installed = only('/usr/bin/chromium')
    expect(() => findBrowser({ flag: '/nope', env: {}, platform: 'linux', ...installed })).toThrow(BrowserNotFoundError)
    expect(() => findBrowser({ env: { DOOP_IMPORT_BROWSER: '/nope' }, platform: 'linux', ...installed })).toThrow(
      /DOOP_IMPORT_BROWSER is "\/nope"/,
    )
  })
})

describe("the request guard for a Storybook on someone else's server", () => {
  const origin = 'https://sb.example.com'
  const publicDns = async () => ['93.184.216.34']

  it('knows loopback and private addresses', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '[::1]'])
      expect(isLoopbackHost(host), host).toBe(true)
    for (const host of ['example.com', '10.0.0.1', '192.168.1.1']) expect(isLoopbackHost(host), host).toBe(false)
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.0.9',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('blocks the machine and its network, lets the Storybook and the public internet through', async () => {
    for (const url of [
      'http://127.0.0.1:3000/x',
      'http://localhost:8080/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://2130706433/',
      'http://printer.local/',
      'ws://10.0.0.5/socket',
    ]) {
      expect(await blockedRequest(url, origin, publicDns), url).toBeTruthy()
    }
    expect(await blockedRequest('https://cdn.example.org/font.woff2', origin, publicDns)).toBeUndefined()
    expect(await blockedRequest('https://sb.example.com/iframe.html', origin, async () => ['10.0.0.1'])).toBeUndefined()
    expect(await blockedRequest('data:image/png;base64,AAAA', origin, publicDns)).toBeUndefined()
    expect(await blockedRequest('blob:https://sb.example.com/1', origin, publicDns)).toBeUndefined()
  })

  it('blocks a name that resolves to a private address', async () => {
    expect(await blockedRequest('https://rebind.example.net/x', origin, async () => ['10.0.0.8'])).toMatch(
      /private address/,
    )
    expect(
      await blockedRequest('https://rebind.example.net/x', origin, async () => ['93.184.216.34', '127.0.0.1']),
    ).toMatch(/private/)
  })

  describe.skipIf(!browserPath)('in the browser', { timeout: 60_000 }, () => {
    let leak: HttpServer
    let leaked = 0
    let storybook: HttpServer

    beforeAll(async () => {
      leak = createServer((_req, res) => {
        leaked++
        res.end('x')
      })
      await new Promise<void>((resolve) => leak.listen(0, '127.0.0.1', resolve))
      const leakUrl = `http://127.0.0.1:${(leak.address() as AddressInfo).port}/leak.png`
      const iframe = (await readFile(path.join(fixture, 'iframe.html'), 'utf8')).replace(
        '<div id="storybook-root"></div>',
        `<div id="storybook-root"></div><img src="${leakUrl}" alt="">`,
      )
      const index = await readFile(path.join(fixture, 'index.json'), 'utf8')
      storybook = createServer((req, res) => {
        const file = (req.url ?? '').startsWith('/iframe.html')
          ? iframe
          : (req.url ?? '').startsWith('/index.json')
            ? index
            : undefined
        res.writeHead(file === undefined ? 404 : 200, {
          'content-type': file === iframe ? 'text/html' : 'application/json',
        })
        res.end(file ?? '')
      })
      await new Promise<void>((resolve) => storybook.listen(0, '127.0.0.1', resolve))
    })
    afterAll(async () => {
      await Promise.all([leak, storybook].map((server) => new Promise((resolve) => server.close(resolve))))
    })

    const render = (guardRequests: boolean) =>
      renderStorybook({
        url: new URL(`http://127.0.0.1:${(storybook.address() as AddressInfo).port}/`),
        browserPath: browserPath!,
        guardRequests,
      })

    it('stops the story page reaching another local address when the guard is on, and not when it is off', async () => {
      const guarded = await render(true)
      expect(guarded.bundle.components.length).toBe(2)
      expect(leaked).toBe(0)
      await render(false)
      expect(leaked).toBeGreaterThan(0)
    })
  })
})

describe('the ticket and the upload', () => {
  it('reads a ticket URL and adds dry_run for a dry run', () => {
    const token = 'A'.repeat(43)
    expect(ticketUrl(`https://doop.test/import/${token}`, false).search).toBe('')
    expect(ticketUrl(`https://doop.test/import/${token}`, true).searchParams.get('dry_run')).toBe('1')
    expect(() => ticketUrl('not a url', false)).toThrow(UploadError)
    expect(() => ticketUrl('ftp://doop.test/import/' + token, false)).toThrow(/http/)
    /* plain http only to this machine */
    expect(() => ticketUrl(`http://doop.example.com/import/${token}`, false)).toThrow(/plain http/)
    expect(() => ticketUrl(`http://192.168.1.5:4400/import/${token}`, false)).toThrow(/plain http/)
    for (const host of ['localhost:4400', '127.0.0.1:4400', '127.1.2.3', '[::1]:4400', 'doop.localhost']) {
      expect(ticketUrl(`http://${host}/import/${token}`, false).protocol).toBe('http:')
    }
    expect(() => ticketUrl('https://doop.test/u/' + token, false)).toThrow(/import ticket/)
  })

  it('sends gzipped JSON with a PUT and does not follow a redirect', async () => {
    const bundle = { version: 1, source: { kind: 'cli' }, components: [{ name: 'X', html: '<p>x</p>' }] } as never
    let seen: { method?: string; encoding?: string | null; body?: string; redirect?: string } = {}
    const answer = {
      created: [{ name: 'X', id: 'c1' }],
      updated: [],
      unchanged: [],
      skipped: [],
      tokens: { created: [], skipped: [] },
      pageId: null,
      issues: [],
    }
    const fake = (async (_url: unknown, init: RequestInit) => {
      seen = {
        method: init.method,
        encoding: new Headers(init.headers).get('content-encoding'),
        body: gunzipSync(Buffer.from(init.body as Uint8Array)).toString('utf8'),
        redirect: init.redirect,
      }
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
    const result = await uploadBundle(bundle, new URL('https://doop.test/import/' + 'B'.repeat(43)), { fetch: fake })
    expect(result.created).toEqual([{ name: 'X', id: 'c1' }])
    expect(seen.method).toBe('PUT')
    expect(seen.encoding).toBe('gzip')
    expect(JSON.parse(seen.body!)).toEqual(bundle)
    expect(seen.redirect).toBe('error')

    const refusing = (async () =>
      new Response(JSON.stringify({ error: 'invalid, expired' }), { status: 410 })) as unknown as typeof fetch
    await expect(
      uploadBundle(bundle, new URL('https://doop.test/import/' + 'B'.repeat(43)), { fetch: refusing }),
    ).rejects.toThrow(/refused the upload: invalid, expired/)
  })
})

const execFileAsync = promisify(execFile)

type Component = { id: string; name: string; template: string; props?: { name: string; type: string }[] }

describe.skipIf(!browserPath)(
  'the CLI against a storybook-static build and a real ticket',
  { timeout: 120_000 },
  () => {
    let server: Server
    let owner: Client
    let canvasId: string
    let otherCanvasId: string

    const ticket = async (id: string) => {
      const res = await owner.post(`/api/canvases/${id}/component-import/ticket`)
      expect(res.status).toBe(200)
      return ((await res.json()) as { upload_url: string }).upload_url
    }
    const components = async (id: string) =>
      ((await (await owner.get(`/api/canvases/${id}`)).json()) as { components?: Component[] }).components ?? []

    /** one run of main with its output collected */
    async function run(args: string[]) {
      const out: string[] = []
      const err: string[] = []
      const code = await main(['--browser', browserPath!, ...args], {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        env: {},
      })
      return { code, out: out.join('\n'), err: err.join('\n') }
    }

    beforeAll(async () => {
      server = await startServer()
      owner = await new Client(server).signUp('owner@cli.test', 'Owner')
      canvasId = ((await (await owner.post('/api/canvases', { name: 'CLI import' })).json()) as { id: string }).id
      otherCanvasId = ((await (await owner.post('/api/canvases', { name: 'CLI dist' })).json()) as { id: string }).id
    }, 90_000)

    afterAll(() => {
      server?.stop()
    })

    it('a dry run renders, says what would change and leaves the ticket and the canvas alone', async () => {
      const url = await ticket(canvasId)
      const result = await run(['--storybook', fixture, '--ticket', url, '--package', '@acme/ui', '--dry-run'])
      expect(result.err).toContain('Serving')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toMatch(/Would create 2: .*Button/)
      expect(result.out).toContain('Badge')
      expect((await components(canvasId)).length).toBe(0)

      /* the same ticket still works for the real upload */
      const real = await run(['--storybook', fixture, '--ticket', url, '--package', '@acme/ui'])
      expect(real.code, real.err).toBe(0)
      expect(real.out).toMatch(/Created 2: /)
      const imported = await components(canvasId)
      expect(imported.map((component) => component.name).sort()).toEqual(['Badge', 'Button'])
      const button = imported.find((component) => component.name === 'Button')!
      expect(button.template).toContain('btn')
      expect(button.props?.map((prop) => prop.name)).toEqual(expect.arrayContaining(['tone', 'disabled', 'label']))
      expect(JSON.stringify(imported)).not.toContain('<script')

      /* the ticket was used up */
      const again = await run(['--storybook', fixture, '--ticket', url])
      expect(again.code).toBe(1)
      expect(again.err).toMatch(/refused the upload/)
    })

    it('writes the bundle with --out, and only that when there is no ticket', async () => {
      const file = path.join(root, 'node_modules', '.cache', `doop-import-${process.pid}.json`)
      const { mkdir, readFile, rm } = await import('node:fs/promises')
      await mkdir(path.dirname(file), { recursive: true })
      try {
        const result = await run(['--storybook', fixture, '--include', 'Data', '--out', file])
        expect(result.code, result.err).toBe(0)
        const bundle = JSON.parse(await readFile(file, 'utf8')) as {
          source: { kind: string }
          components: { name: string }[]
        }
        expect(bundle.source.kind).toBe('cli')
        expect(bundle.components.map((component) => component.name)).toEqual(['Badge'])
      } finally {
        await rm(file, { force: true })
      }
    })

    it('stops with a usage message for a missing flag or a directory that is not a Storybook', async () => {
      const missing = await run(['--ticket', 'https://doop.test/import/' + 'C'.repeat(43)])
      expect(missing.code).toBe(2)
      expect(missing.err).toContain('--storybook is required')
      const notStorybook = await run([
        '--storybook',
        path.join(root, 'tests', 'fixtures', 'fonts'),
        '--out',
        '/dev/null',
      ])
      expect(notStorybook.code).toBe(2)
      expect(notStorybook.err).toContain('not a Storybook build')
    })

    it('the esbuild output runs end to end under node', async () => {
      await execFileAsync('node', [path.join(root, 'scripts', 'build-doop-import.mjs')], { cwd: root })
      const url = await ticket(otherCanvasId)
      const { stdout } = await execFileAsync(
        'node',
        [
          path.join(root, 'packages', 'doop-import', 'dist', 'cli.mjs'),
          '--storybook',
          fixture,
          '--ticket',
          url,
          '--browser',
          browserPath!,
        ],
        { cwd: root, timeout: 90_000, env: { ...process.env, CHROME_PATH: browserPath! } },
      )
      expect(stdout).toMatch(/Created 2: /)
      expect((await components(otherCanvasId)).map((component) => component.name).sort()).toEqual(['Badge', 'Button'])
    })
  },
)
