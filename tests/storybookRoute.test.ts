import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({ runStorybookImport: vi.fn(), planStorybookImport: vi.fn() }))
vi.mock('../server/storybookImportRun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/storybookImportRun.ts')>()
  return { ...actual, runStorybookImport: run.runStorybookImport, planStorybookImport: run.planStorybookImport }
})

import { importStorybookRoute } from '../server/storybookRoutes.ts'
import { STORYBOOK_IMPORTS_PER_HOUR, StorybookAccessError, StorybookBusyError } from '../server/storybookImport.ts'
import type { Actor } from '../shared/types.ts'

/* The route's own behaviour with the import mocked: what is JSON before streaming, what is a line, and that closing the request reaches the import as an abort. */

const actor = { name: 'T', kind: 'human' } as unknown as Actor
const EMPTY_RESULT = {
  created: [],
  updated: [],
  unchanged: [],
  skipped: [],
  tokens: { created: [], skipped: [] },
  pageId: null,
  issues: [],
}

class FakeRes extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: string[] = []
  writableEnded = false
  destroyed = false
  jsonBody: unknown
  status(code: number) {
    this.statusCode = code
    return this
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  json(body: unknown) {
    this.jsonBody = body
    this.writableEnded = true
    return this
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk)
    return true
  }
  end() {
    this.writableEnded = true
    this.emit('close')
  }
  get lines() {
    return this.chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string })
  }
}

const call = (body: unknown, user = `user-${Math.random()}`) => {
  const res = new FakeRes()
  const done = importStorybookRoute({ body } as never, res as never, 'canvas-1', actor, user, {
    deps: { parseUrl: (raw) => new URL(raw) },
  })
  return { res, done }
}

beforeEach(() => {
  run.runStorybookImport.mockReset()
  run.planStorybookImport.mockReset()
})

describe('before streaming', () => {
  it.each<unknown[]>([
    [{}],
    [{ url: 'https://sb.test/', package: 'Bad Name' }],
    [{ url: 'https://sb.test/', include: 'x' }],
    [{ url: 'https://sb.test/', include: Array.from({ length: 51 }, () => 'x') }],
    [{ url: 'https://sb.test/', dryRun: 'yes' }],
    [{ url: 'x'.repeat(2001) }],
  ])('answers %j with a 400 JSON error', async (body) => {
    const { res, done } = call(body)
    await done
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toMatchObject({ code: 'invalid' })
    expect(run.runStorybookImport).not.toHaveBeenCalled()
  })

  it('answers a 429 with Retry-After once the hour is used, and a dry run does not use it', async () => {
    run.runStorybookImport.mockResolvedValue({ result: EMPTY_RESULT, issues: [], renders: 1 })
    run.planStorybookImport.mockResolvedValue({ components: [], result: EMPTY_RESULT, issues: [] })
    const user = 'rate-limited'
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR; i++) {
      const { res, done } = call({ url: 'https://sb.test/' }, user)
      await done
      expect(res.statusCode).toBe(200)
    }
    const { res, done } = call({ url: 'https://sb.test/' }, user)
    await done
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.jsonBody).toMatchObject({ code: 'too_many' })
    const dry = call({ url: 'https://sb.test/', dryRun: true }, user)
    await dry.done
    expect(dry.res.statusCode).toBe(200)
  })
})

describe('streaming', () => {
  it('writes the plan, each progress, then the result, one JSON object a line', async () => {
    run.runStorybookImport.mockImplementation(async (options) => {
      options.onPlan([{ name: 'Button', group: 'Inputs/Button', stories: 2, renders: 1 }])
      options.onRender({ rendered: 1, total: 1, component: 'Button' })
      options.onRender({ rendered: 2, total: 3, component: 'Button' })
      return { result: EMPTY_RESULT, issues: [{ code: 'x', message: 'y' }], renders: 2 }
    })
    const { res, done } = call({ url: 'https://sb.test/sb/', package: '@acme/ui', include: ['Inputs'] })
    await done
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.lines).toEqual([
      { type: 'plan', components: [{ name: 'Button', group: 'Inputs/Button', stories: 2, renders: 1 }], renders: 1 },
      { type: 'progress', rendered: 1, total: 1, component: 'Button' },
      { type: 'progress', rendered: 2, total: 3, component: 'Button' },
      { type: 'result', result: EMPTY_RESULT, issues: [{ code: 'x', message: 'y' }] },
    ])
    expect(run.runStorybookImport.mock.calls[0]![0]).toMatchObject({
      package: '@acme/ui',
      include: ['Inputs'],
      dryRun: false,
      canvasId: 'canvas-1',
    })
  })

  it('a dry run plans only: the plan, then the result, and no import runs', async () => {
    run.planStorybookImport.mockResolvedValue({
      components: [{ name: 'Button', group: 'Inputs/Button', stories: 1, renders: 1 }],
      result: { ...EMPTY_RESULT, created: [{ name: 'Button', id: '' }] },
      issues: [],
    })
    const { res, done } = call({ url: 'https://sb.test/', dryRun: true })
    await done
    expect(res.lines.map((line) => line.type)).toEqual(['plan', 'result'])
    expect(run.runStorybookImport).not.toHaveBeenCalled()
  })

  it.each([
    [new StorybookAccessError(), 'private'],
    [new StorybookBusyError(), 'busy'],
    [new Error('the renderer blew up'), 'unreachable'],
  ])('ends with an error line for %s', async (error, code) => {
    run.runStorybookImport.mockRejectedValue(error)
    const { res, done } = call({ url: 'https://sb.test/' })
    await done
    expect(res.lines.at(-1)).toMatchObject({ type: 'error', code })
    expect(res.writableEnded).toBe(true)
  })

  it('closing the request aborts the import and writes nothing more', async () => {
    let signal: AbortSignal | undefined
    run.runStorybookImport.mockImplementation(
      (options: { signal: AbortSignal; onPlan: (c: unknown[]) => void; onRender: (e: unknown) => void }) =>
        new Promise((_resolve, reject) => {
          signal = options.signal
          options.signal.addEventListener('abort', () => {
            options.onRender({ rendered: 1, total: 1, component: 'late' })
            reject(options.signal.reason)
          })
        }),
    )
    const { res, done } = call({ url: 'https://sb.test/' })
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal!.aborted).toBe(false)
    res.emit('close')
    await done
    expect(signal!.aborted).toBe(true)
    expect(res.lines.filter((line) => line.type === 'error')).toEqual([])
  })
})
