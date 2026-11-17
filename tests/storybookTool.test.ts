import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({ runStorybookImport: vi.fn() }))
vi.mock('../server/storybookImportRun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/storybookImportRun.ts')>()
  return { ...actual, runStorybookImport: run.runStorybookImport }
})

import { runComponentTool, type ToolContext } from '../server/componentTools.ts'
import { StorybookIndexError, STORYBOOK_IMPORTS_PER_HOUR } from '../server/storybookImport.ts'
import type { Actor, Canvas } from '../shared/types.ts'

/* import_storybook as an agent calls it: the hour is the requesting account's, whoever pays, a URL that could never be read costs nothing, and the edit role is asked again right before the writes. */

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
  run.runStorybookImport.mockReset()
  run.runStorybookImport.mockResolvedValue({ result: EMPTY, issues: [], renders: 1 })
})

describe('import_storybook', () => {
  it("hands the caller's abort signal to the import and puts only a cleaned label in progress messages", async () => {
    const controller = new AbortController()
    const messages: string[] = []
    run.runStorybookImport.mockImplementation(
      async (options: { signal?: AbortSignal; onRender?: (e: unknown) => void }) => {
        expect(options.signal).toBe(controller.signal)
        options.onRender?.({ rendered: 1, total: 2, component: 'Button\u0000\n<script>alert(1)</script> '.repeat(20) })
        options.onRender?.({ rendered: 2, total: 2, component: '\u0000' })
        return { result: EMPTY, issues: [], renders: 2 }
      },
    )
    const ctx = context({
      userId: 'u-signal',
      signal: controller.signal,
      progress: ({ message }) => messages.push(message),
    })
    expect((await call('https://sb.test/', ctx)).ok).toBe(true)
    expect(messages).toHaveLength(2)
    expect(messages[0]).not.toMatch(/[\n<>]/)
    expect(messages[0]).not.toContain(String.fromCharCode(0))
    expect(messages[0]!.length).toBeLessThan(140)
    expect(messages[1]).toBe('Rendered Component (2 of 2)')
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
