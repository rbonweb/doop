import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({ runStorybookImport: vi.fn(), planStorybookImport: vi.fn() }))
vi.mock('../server/storybookImportRun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/storybookImportRun.ts')>()
  return { ...actual, runStorybookImport: run.runStorybookImport, planStorybookImport: run.planStorybookImport }
})

import { runComponentTool, type ToolContext } from '../server/componentTools.ts'
import { StorybookIndexError, STORYBOOK_IMPORTS_PER_HOUR } from '../server/storybookImport.ts'
import { clearStorybookJobs } from '../server/storybookJobs.ts'
import type { Actor, Canvas } from '../shared/types.ts'

/* import_storybook as an agent calls it (it starts a job; get_import_status and cancel_import read it): the hour is the requesting account's, whoever pays, a URL that could never be read costs nothing, and the edit role is asked again right before the writes. */

const EMPTY = {
  created: [],
  updated: [],
  unchanged: [],
  skipped: [],
  tokens: { created: [], skipped: [] },
  pageId: null,
  issues: [],
}
const canvas = { id: 'canvas-1', components: [], frames: [] } as unknown as Canvas

const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  canvas,
  actor: { name: 'T', kind: 'agent' } as unknown as Actor,
  canRead: () => true,
  canEdit: () => true,
  readableCanvases: () => [],
  userId: 'requester',
  budgetKey: 'payer',
  ...over,
})

const call = (url: string, ctx: ToolContext) => runComponentTool('import_storybook', { url }, ctx)

beforeEach(() => {
  clearStorybookJobs()
  run.planStorybookImport.mockReset()
  run.runStorybookImport.mockReset()
  run.runStorybookImport.mockResolvedValue({ result: EMPTY, issues: [], renders: 1 })
})

describe('import_storybook', () => {
  it("starts a job on a signal of its own, not the caller's, and puts only a cleaned label in what it reports", async () => {
    const controller = new AbortController()
    run.runStorybookImport.mockImplementation(
      async (options: { signal?: AbortSignal; onRender?: (e: unknown) => void }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal)
        expect(options.signal).not.toBe(controller.signal)
        options.onRender?.({ rendered: 1, total: 2, component: 'Button\u0000\n<script>alert(1)</script> '.repeat(20) })
        options.onRender?.({ rendered: 2, total: 2, component: '\u0000' })
        return { result: EMPTY, issues: [], renders: 2 }
      },
    )
    const out = await call('https://sb.test/', context({ userId: 'u-signal' }))
    expect(out.ok).toBe(true)
    const data = (out as { result: { data: { status: string; component: string } } }).result.data
    expect(data.status).toBe('done')
    expect(data.component).toBe('Component')
    expect(data.component).not.toMatch(/[\n<>]/)
    controller.abort()
  })

  it('answers a running job at once and lets get_import_status and cancel_import follow it', async () => {
    let finish!: () => void
    run.runStorybookImport.mockImplementation(
      (options: { signal: AbortSignal; onPlan: (c: unknown[], i: unknown) => void }) =>
        new Promise((resolve, reject) => {
          options.onPlan([{ name: 'Button', group: 'Inputs', stories: 1, renders: 1 }], { total: 1, importing: 1 })
          options.signal.addEventListener('abort', () => reject(options.signal.reason))
          finish = () => resolve({ result: EMPTY, issues: [], renders: 1 })
        }),
    )
    const ctx = context({ userId: 'u-job' })
    const started = await call('https://sb.test/', ctx)
    const data = (started as { result: { data: { job_id: string; status: string; planned: unknown } } }).result.data
    expect(data).toMatchObject({ status: 'running', planned: { renders: 1 } })
    const status = await runComponentTool('get_import_status', { job_id: data.job_id }, ctx)
    expect(status).toMatchObject({ ok: true, result: { data: { status: 'running' } } })
    /* a view-only account that did not start it does not find it */
    const stranger = context({ userId: 'u-stranger', canEdit: () => false })
    expect(await runComponentTool('get_import_status', { job_id: data.job_id }, stranger)).toMatchObject({
      ok: false,
      error: expect.stringContaining('No import job'),
    })
    expect(await runComponentTool('cancel_import', { job_id: data.job_id }, stranger)).toMatchObject({ ok: false })
    expect(await runComponentTool('get_import_status', { job_id: 'gone' }, ctx)).toMatchObject({
      ok: true,
      result: { data: { status: 'unknown' }, note: expect.stringContaining('Start the import again') },
    })
    finish()
  })

  it('answers cancel_import on a job that already ended plainly, with the job as it stands', async () => {
    const ctx = context({ userId: 'u-late' })
    const started = (await call('https://sb.test/', ctx)) as { result: { data: { job_id: string; status: string } } }
    expect(started.result.data.status).toBe('done')
    const out = await runComponentTool('cancel_import', { job_id: started.result.data.job_id }, ctx)
    expect(out).toMatchObject({
      ok: true,
      result: { data: { status: 'done' }, note: expect.stringContaining('Nothing to cancel') },
    })
  })

  it('a dry run only plans, in the call, and counts a plan against its own hour', async () => {
    run.planStorybookImport.mockResolvedValue({
      components: [{ name: 'Button', group: 'Inputs', stories: 1, renders: 1 }],
      info: { total: 1, capped: false, importing: 1 },
      result: { ...EMPTY, created: [{ name: 'Button', id: '' }] },
      issues: [],
    })
    const out = await runComponentTool(
      'import_storybook',
      { url: 'https://sb.test/', dry_run: true },
      context({ userId: 'u-plan' }),
    )
    expect(out).toMatchObject({ ok: true, result: { data: { dry_run: true, planned: { renders: 1 } } } })
    expect(run.runStorybookImport).not.toHaveBeenCalled()
  })

  it('counts the hour against the requesting account, not the payer', async () => {
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR; i++) {
      expect((await call('https://sb.test/', context({ budgetKey: `payer-${i}`, userId: 'u-requester' }))).ok).toBe(
        true,
      )
    }
    const refused = await call('https://sb.test/', context({ budgetKey: 'a-new-payer', userId: 'u-requester' }))
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Storybook imports in the last hour') })
    expect((await call('https://sb.test/', context({ userId: 'someone-else' }))).ok).toBe(true)
  })

  it('takes no slot for a URL that could never be read, and gives it back when the index is not there', async () => {
    const ctx = context({ userId: 'u-refund' })
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR + 2; i++) {
      const bad = await call('ftp://sb.test/', ctx)
      expect(bad.ok).toBe(false)
    }
    run.runStorybookImport.mockRejectedValue(new StorybookIndexError('No Storybook index.json was found'))
    for (let i = 0; i < STORYBOOK_IMPORTS_PER_HOUR + 2; i++) {
      expect(await call('https://sb.test/', ctx)).toMatchObject({
        ok: false,
        error: 'No Storybook index.json was found',
      })
    }
    run.runStorybookImport.mockResolvedValue({ result: EMPTY, issues: [], renders: 1 })
    expect((await call('https://sb.test/', ctx)).ok).toBe(true)
  })

  it('hands the import a check of the edit role on this canvas', async () => {
    const canEdit = vi.fn(() => false)
    await call('https://sb.test/', context({ canEdit, userId: 'u-role' }))
    const options = run.runStorybookImport.mock.calls[0]![0] as { canEdit: () => boolean }
    expect(options.canEdit()).toBe(false)
    expect(canEdit).toHaveBeenCalledWith('canvas-1')
  })

  it('never shows an internal error message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    run.runStorybookImport.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:9222'))
    const out = await call('https://sb.test/', context({ userId: 'u-leak' }))
    expect(out).toEqual({ ok: false, error: 'The Storybook import failed' })
    log.mockRestore()
  })
})
