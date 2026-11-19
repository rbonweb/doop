import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_INDEX_BYTES, SIGN_IN_PATH, readStorybookIndex } from '../shared/storybook/page.ts'

/* The story-page adapter and the index fetch live once, in shared/storybook/page.ts: the server and the CLI both import them, and neither keeps its own copy. The CLI bundle carries the shared copy, not a second one. */

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverPath = path.join(root, 'server', 'storybookImport.ts')
const cliPath = path.join(root, 'packages', 'doop-import', 'src', 'render.ts')

const built: string[] = []

afterAll(async () => {
  for (const dir of built) await rm(dir, { recursive: true, force: true })
})

/** Records which error the shared code asked for, so a case says what a person would see. */
function recordingErrors() {
  const calls: ({ kind: 'access' } | { kind: 'index'; message: string; readBody: boolean })[] = []
  return {
    calls,
    errors: {
      access: () => {
        calls.push({ kind: 'access' })
        return new Error('access')
      },
      index: (message: string, readBody: boolean) => {
        calls.push({ kind: 'index', message, readBody })
        return new Error(message)
      },
    },
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

const v3 = {
  v: 3,
  stories: {
    'button--primary': { id: 'button--primary', kind: 'Button', name: 'Primary', story: 'Primary' },
  },
}

describe('the shared story-page module', () => {
  it('is what both callers import, and neither keeps a copy', async () => {
    for (const file of [serverPath, cliPath]) {
      const source = await readFile(file, 'utf8')
      expect(source, file).toMatch(
        /import\s*\{[^}]*\bstoryPageAdapter\b[^}]*\}\s*from\s*'[^']*shared\/storybook\/page\.ts'/,
      )
      expect(source, file).toMatch(
        /import\s*\{[^}]*\breadStorybookIndex\b[^}]*\}\s*from\s*'[^']*shared\/storybook\/page\.ts'/,
      )
      for (const gone of [
        'waitForFunction(',
        'isolatedRealm',
        'function readBounded',
        'const SIGN_IN_PATH',
        'const MAX_REDIRECTS',
      ]) {
        expect(source, `${file} still contains ${gone}`).not.toContain(gone)
      }
    }
  })

  it('bundles one copy of the page adapter into the CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doop-import-shared-'))
    built.push(dir)
    const out = path.join(dir, 'cli.mjs')
    await execFileAsync('node', [path.join(root, 'scripts', 'build-doop-import.mjs'), '--out', out], { cwd: root })
    const bundle = await readFile(out, 'utf8')
    expect(bundle).toContain(SIGN_IN_PATH.source)
    const message = 'The story did not finish rendering in time'
    expect(bundle.split(message)).toHaveLength(2)
  }, 60_000)
})

describe('readStorybookIndex', () => {
  const base = new URL('https://story.example/sb/')

  it('says a sign-in redirect is a private Storybook', async () => {
    const { calls, errors } = recordingErrors()
    await expect(
      readStorybookIndex(base, {
        fetchUrl: async () => new Response(null, { status: 302, headers: { location: '/login' } }),
        errors,
        notFoundMessage: 'not found',
        tooLargeMessage: 'too large',
      }),
    ).rejects.toThrow()
    expect(calls).toEqual([{ kind: 'access' }])
  })

  it('refuses a redirect to another address, saying where it goes', async () => {
    const { calls, errors } = recordingErrors()
    await expect(
      readStorybookIndex(base, {
        fetchUrl: async () => new Response(null, { status: 302, headers: { location: 'https://other.example/sb/' } }),
        errors,
        notFoundMessage: 'not found',
        tooLargeMessage: 'too large',
      }),
    ).rejects.toThrow()
    expect(calls).toEqual([
      {
        kind: 'index',
        message: 'The Storybook redirects to another address (https://other.example). Use that URL instead.',
        readBody: false,
      },
    ])
  })

  it('falls back to the v3 stories.json when there is no index.json', async () => {
    const { calls, errors } = recordingErrors()
    const result = await readStorybookIndex(base, {
      fetchUrl: async (url) => (url.pathname.endsWith('/index.json') ? new Response(null, { status: 404 }) : json(v3)),
      errors,
      notFoundMessage: 'not found',
      tooLargeMessage: 'too large',
    })
    expect(calls).toEqual([])
    expect(result.entries.map((entry) => entry.id)).toEqual(['button--primary'])
    expect(result.base.href).toBe(base.href)
  })

  it('refuses an index body over the limit with the caller’s wording', async () => {
    const { calls, errors } = recordingErrors()
    await expect(
      readStorybookIndex(base, {
        fetchUrl: async () =>
          new Response('', { status: 200, headers: { 'content-length': String(MAX_INDEX_BYTES + 1) } }),
        errors,
        notFoundMessage: 'not found',
        tooLargeMessage: 'the index is too large',
      }),
    ).rejects.toThrow()
    expect(calls).toEqual([{ kind: 'index', message: 'the index is too large', readBody: true }])
  })
})
