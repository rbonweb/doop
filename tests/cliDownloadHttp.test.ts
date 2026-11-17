import { execFile } from 'node:child_process'
import { cp, mkdir, symlink, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandFields, commandUnavailable, currentCli, importCommand } from '../server/cliDownload.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/* Each Doop instance serves the doop-import CLI itself (server/cliDownload.ts): the route and its headers, the redirect, the allowlist of one file, what is inside the tarball, the command every surface shows, and the served tarball run by npm against a real ticket. */

const run = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = path.join(root, 'tests', 'fixtures', 'storybook-static')
const browserPath = findBrowserPath()

/** the names in a tar stream, and one file's text */
function readTar(tar: Buffer): Map<string, string> {
  const files = new Map<string, string>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '')
    if (!name) break
    const size = parseInt(tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/s, ''), 8)
    files.set(name, tar.toString('utf8', offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

let server: Server
let version: string
let tarName: string
/* this file's own output: it never writes where another test file (or the app build) does */
let packed: string

const pack = (...args: string[]) =>
  run('node', [path.join(root, 'scripts', 'pack-doop-import.mjs'), ...args], { cwd: root })

beforeAll(async () => {
  packed = await mkdtemp(path.join(tmpdir(), 'doop-cli-pack-'))
  /* the build step the app's `bun run build` runs, into a directory of its own that the server is pointed at */
  await pack('--out', packed)
  const cli = currentCli(packed)
  expect(cli).not.toBeNull()
  version = cli!.version
  tarName = cli!.name
  server = await startServer({ DOOP_CLI_DIR: packed })
}, 120_000)

afterAll(async () => {
  server?.stop()
  await rm(packed, { recursive: true, force: true })
})

describe('the helper', () => {
  it('builds the command from the origin and the packed file, and falls back to the unversioned address', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'doop-cli-dir-'))
    try {
      expect(currentCli(directory)).toBeNull()
      expect(importCommand('https://doop.test/import/tok', 'https://doop.test/', directory)).toBe(
        'npx --yes --allow-remote=root --package=https://doop.test/cli/doop-import.tgz doop-import --storybook ./storybook-static --ticket https://doop.test/import/tok',
      )
      await writeFile(path.join(directory, 'doop-import-1.2.3-0123456789ab.tgz'), 'x')
      await writeFile(path.join(directory, 'doop-import-1.2.3.tgz'), 'x')
      await writeFile(path.join(directory, 'doop-import-1.2.3-xyz.tgz'), 'x')
      await writeFile(path.join(directory, 'notes.txt'), 'x')
      await mkdir(path.join(directory, 'doop-import-9.9.9-ffffffffffff.tgz'))
      expect(currentCli(directory)?.version).toBe('1.2.3')
      expect(importCommand('https://doop.test/import/tok', 'https://doop.test', directory)).toBe(
        'npx --yes --allow-remote=root --package=https://doop.test/cli/doop-import-1.2.3-0123456789ab.tgz doop-import --storybook ./storybook-static --ticket https://doop.test/import/tok',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('the helper: symlinks and plain http', () => {
  it('never serves a symlink under the CLI name, whatever it points at', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'doop-cli-link-'))
    try {
      const real = path.join(directory, 'real.bin')
      await writeFile(real, 'x')
      await symlink(real, path.join(directory, 'doop-import-1.2.3-0123456789ab.tgz'))
      expect(currentCli(directory)).toBeNull()
      /* a real file beside the link is still found */
      await writeFile(path.join(directory, 'doop-import-1.2.2-0123456789ab.tgz'), 'x')
      expect(currentCli(directory)?.version).toBe('1.2.2')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('hands out the command over https and to this machine, and the reason (no command) on public http', () => {
    const upload = 'https://doop.test/import/tok'
    expect(commandUnavailable('https://doop.example.com')).toBeUndefined()
    const secure = commandFields(upload, 'https://doop.example.com')
    expect(secure.command).toContain('--package=https://doop.example.com/cli/')
    expect(secure.command_unavailable).toBeUndefined()
    for (const origin of [
      'http://localhost:4400',
      'http://127.0.0.1:4400',
      'http://127.4.5.6',
      'http://[::1]:4400',
      'http://doop.localhost',
    ]) {
      expect(commandFields(upload, origin).command, origin).toContain(`--package=${origin}/cli/`)
    }
    for (const origin of [
      'http://doop.example.com',
      'http://192.168.1.5:4400',
      'http://10.0.0.2',
      'http://127.evil.com',
      'http://[2606:4700::1111]',
    ]) {
      expect(commandFields(upload, origin), origin).toEqual({
        command: null,
        command_unavailable: 'this Doop server must use https for the command-line import',
      })
    }
    expect(commandFields(upload, 'not a url').command).toBeNull()
  })
})

describe('GET /cli', () => {
  it('serves the tarball with the headers npm wants and an immutable cache', async () => {
    const res = await fetch(`${server.base}/cli/${tarName}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length)
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    const head = await fetch(`${server.base}/cli/${tarName}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
  })

  it('needs no session', async () => {
    expect((await fetch(`${server.base}/cli/${tarName}`, { headers: { cookie: '' } })).status).toBe(200)
  })

  it('redirects the unversioned name to the current file, uncached', async () => {
    const res = await fetch(`${server.base}/cli/doop-import.tgz`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${server.base}/cli/${tarName}`)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    const followed = await fetch(`${server.base}/cli/doop-import.tgz`)
    expect(followed.status).toBe(200)
    expect(followed.url).toBe(`${server.base}/cli/${tarName}`)
  })

  it('answers 404 for any other name, with no way out of the directory', async () => {
    for (const name of [
      'other.tgz',
      'doop-import-9.9.9.tgz',
      'doop-import-9.9.9-0123456789ab.tgz',
      tarName.replace(/-[0-9a-f]{12}\.tgz$/, '.tgz'),
      tarName.replace(/[0-9a-f]\.tgz$/, (m) => (m[0] === '0' ? '1' : '0') + '.tgz'),
      `${tarName}.map`,
      '..%2Fpackage.json',
      '%2e%2e%2f%2e%2e%2fpackage.json',
      '..%5Cpackage.json',
      '.',
      'doop-import-%00.tgz',
    ]) {
      const res = await fetch(`${server.base}/cli/${name}`)
      expect(res.status, name).toBe(404)
      expect(res.headers.get('content-type'), name).not.toContain('gzip')
    }
    const nested = await fetch(`${server.base}/cli/a/${tarName}`)
    expect(nested.headers.get('content-type') ?? '').not.toContain('gzip')
  })

  it('serves a tarball with the package.json (bin), README.md and dist/cli.mjs', async () => {
    const bytes = Buffer.from(await (await fetch(`${server.base}/cli/${tarName}`)).arrayBuffer())
    const files = readTar(gunzipSync(bytes))
    expect([...files.keys()].sort()).toEqual(['package/README.md', 'package/dist/cli.mjs', 'package/package.json'])
    const manifest = JSON.parse(files.get('package/package.json')!) as {
      name: string
      version: string
      bin: Record<string, string>
      type: string
      dependencies: Record<string, string>
    }
    expect(manifest.name).toBe('doop-import')
    expect(manifest.version).toBe(version)
    expect(manifest.bin).toEqual({ 'doop-import': 'dist/cli.mjs' })
    expect(manifest.type).toBe('module')
    expect(Object.keys(manifest.dependencies)).toEqual(['puppeteer-core'])
    expect(files.get('package/dist/cli.mjs')!.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(files.get('package/README.md')).toContain('doop-import')
  })

  it('packs the same bytes and name twice, and a changed source byte gives a new name', async () => {
    const before = Buffer.from(await (await fetch(`${server.base}/cli/${tarName}`)).arrayBuffer())
    const again = await mkdtemp(path.join(tmpdir(), 'doop-cli-pack-'))
    /* a copy of the package two levels under the repo root, as packages/doop-import is, so its imports of shared/ resolve */
    const copy = path.join(root, 'packages', `.tmp-pack-${process.pid}-${Date.now()}`)
    try {
      await pack('--out', again)
      const same = currentCli(again)!
      expect(same.name).toBe(tarName)
      expect((await readFile(same.path)).equals(before)).toBe(true)
      expect(tarName).toMatch(new RegExp(`^doop-import-${version.replace(/\./g, '\\.')}-[0-9a-f]{12}\\.tgz$`))

      await cp(path.join(root, 'packages', 'doop-import', 'src'), path.join(copy, 'src'), { recursive: true })
      for (const file of ['package.json', 'README.md'])
        await cp(path.join(root, 'packages', 'doop-import', file), path.join(copy, file))
      await pack('--package', copy, '--out', again)
      /* the bundle's own path comments name the directory, so a copy has a name of its own; what matters is that it is stable */
      const unchanged = currentCli(again)!.name
      await pack('--package', copy, '--out', again)
      expect(currentCli(again)!.name).toBe(unchanged)
      /* a byte of the code that ships (a comment would not survive the bundle) */
      const upload = path.join(copy, 'src', 'upload.ts')
      await writeFile(
        upload,
        (await readFile(upload, 'utf8')).replace('not with an import result', 'not with an import results'),
      )
      await pack('--package', copy, '--out', again)
      const changed = currentCli(again)!
      expect(changed.version).toBe(version)
      expect(changed.name).not.toBe(unchanged)
      expect(changed.name).toMatch(/-[0-9a-f]{12}\.tgz$/)
    } finally {
      await rm(again, { recursive: true, force: true })
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('the ticket command', () => {
  it('names this instance and the served tarball', async () => {
    const owner = await new Client(server).signUp('owner@cli-serve.test', 'Owner')
    const canvasId = ((await (await owner.post('/api/canvases', { name: 'Serve' })).json()) as { id: string }).id
    const answer = (await (await owner.post(`/api/canvases/${canvasId}/component-import/ticket`)).json()) as {
      command: string
      upload_url: string
    }
    expect(answer.command).toBe(
      `npx --yes --allow-remote=root --package=${server.base}/cli/${tarName} doop-import --storybook ./storybook-static --ticket ${answer.upload_url}`,
    )
  })
})

describe.skipIf(!browserPath)('the served tarball, run by npx', { timeout: 240_000 }, () => {
  it('runs the very command the ticket answers with and imports the fixture', async (ctx) => {
    const owner = await new Client(server).signUp('runner@cli-serve.test', 'Runner')
    const canvasId = ((await (await owner.post('/api/canvases', { name: 'Run' })).json()) as { id: string }).id
    const answer = (await (await owner.post(`/api/canvases/${canvasId}/component-import/ticket`)).json()) as {
      command: string
    }
    /* a project directory with a storybook-static in it, as the command expects, and nothing else for npm or node to pick up */
    const cwd = await mkdtemp(path.join(tmpdir(), 'doop-cli-npx-'))
    try {
      await cp(fixture, path.join(cwd, 'storybook-static'), { recursive: true })
      let stdout = ''
      try {
        ;({ stdout } = await run('sh', ['-c', `${answer.command} --browser "$DOOP_TEST_BROWSER"`], {
          cwd,
          timeout: 200_000,
          env: { ...process.env, DOOP_TEST_BROWSER: browserPath!, npm_config_update_notifier: 'false' },
        }))
      } catch (error) {
        const text = `${(error as { stderr?: string }).stderr ?? ''}${(error as Error).message}`
        /* puppeteer-core comes from the npm registry: an offline machine with a cold cache cannot install it */
        if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|registry\.npmjs/i.test(text)) {
          ctx.skip('npm cannot reach the registry for puppeteer-core (offline with a cold cache)')
        }
        throw error
      }
      expect(stdout).toMatch(/Created 2: /)
      const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as {
        components?: { name: string }[]
      }
      expect((canvas.components ?? []).map((component) => component.name).sort()).toEqual(['Badge', 'Button'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
