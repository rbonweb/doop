import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ storybookBundle: vi.fn(), importComponentBundle: vi.fn() }))
vi.mock('../server/storybookImport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/storybookImport.ts')>()
  return { ...actual, storybookBundle: mocks.storybookBundle }
})
vi.mock('../server/componentBundleImport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/componentBundleImport.ts')>()
  return { ...actual, importComponentBundle: mocks.importComponentBundle }
})

import { ComponentError } from '../server/componentActions.ts'
import { RendererBusyError } from '../server/renderBrowser.ts'
import { StorybookAccessError, StorybookBusyError, StorybookIndexError } from '../server/storybookImport.ts'
import { failedBeforeRendering, runStorybookImport, storybookFailure } from '../server/storybookImportRun.ts'
import { BundleImportError } from '../shared/storybook/bundle.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'T', kind: 'human' } as unknown as Actor
const RESULT = {
  created: [],
  updated: [],
  unchanged: [],
  skipped: [],
  tokens: { created: [], skipped: [] },
  pageId: null,
  issues: [],
}

const base = (over: Partial<Parameters<typeof runStorybookImport>[0]> = {}) => ({
  canvasId: 'canvas-1',
  actor,
  url: 'https://sb.test/',
  dryRun: false,
  canEdit: () => true,
  ...over,
})

beforeEach(() => {
  mocks.storybookBundle.mockReset()
  mocks.importComponentBundle.mockReset()
  mocks.storybookBundle.mockResolvedValue({
    bundle: { version: 1, source: { kind: 'storybook' }, components: [] },
    issues: [],
    renders: 2,
  })
  mocks.importComponentBundle.mockReturnValue(RESULT)
})

describe('the role is checked again after the render', () => {
  it('writes nothing when the account lost the edit role while the Storybook rendered', async () => {
    let allowed = true
    mocks.storybookBundle.mockImplementation(async () => {
      allowed = false
      return { bundle: { version: 1, source: { kind: 'storybook' }, components: [] }, issues: [], renders: 2 }
    })
    await expect(runStorybookImport(base({ canEdit: () => allowed }))).rejects.toThrow(
      new ComponentError('You can no longer edit this canvas, so nothing was imported'),
    )
    expect(mocks.importComponentBundle).not.toHaveBeenCalled()
  })

  it('writes nothing when the request was closed during the render', async () => {
    const controller = new AbortController()
    mocks.storybookBundle.mockImplementation(async () => {
      controller.abort(new Error('closed'))
      return { bundle: { version: 1, source: { kind: 'storybook' }, components: [] }, issues: [], renders: 2 }
    })
    await expect(runStorybookImport(base({ signal: controller.signal }))).rejects.toThrow('closed')
    expect(mocks.importComponentBundle).not.toHaveBeenCalled()
  })

  it('imports when the role still holds, a dry run included', async () => {
    await runStorybookImport(base())
    await runStorybookImport(base({ dryRun: true }))
    expect(mocks.importComponentBundle).toHaveBeenCalledTimes(2)
    expect(mocks.importComponentBundle.mock.calls[1]![2]).toEqual({ dryRun: true })
  })
})

describe('what a failure says', () => {
  it('answers an error this import raised with its own message', () => {
    expect(storybookFailure(new StorybookAccessError())).toMatchObject({ code: 'private', status: 400 })
    expect(storybookFailure(new StorybookIndexError('No Storybook index.json was found'))).toEqual({
      code: 'unreachable',
      message: 'No Storybook index.json was found',
      status: 400,
    })
    expect(storybookFailure(new BundleImportError('No component could be imported'))).toMatchObject({ code: 'invalid' })
    expect(storybookFailure(new StorybookBusyError())).toMatchObject({ code: 'busy', status: 503 })
  })

  it('maps the renderer being busy to busy', () => {
    expect(storybookFailure(new RendererBusyError('queue full'))).toMatchObject({ code: 'busy', status: 503 })
  })

  it('never lets an internal error message out, and logs it instead', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = storybookFailure(new Error('connect ECONNREFUSED 10.0.0.5:9222 (browser at /home/doop/.cache)'))
    expect(failure).toEqual({ code: 'unreachable', message: 'The Storybook import failed', status: 502 })
    expect(JSON.stringify(failure)).not.toContain('10.0.0.5')
    expect(log).toHaveBeenCalledWith('[storybook-import]', expect.any(Error))
    log.mockRestore()
  })
})

describe('failedBeforeRendering', () => {
  it('is true for what happens before a story is rendered, never for an abort or a later failure', () => {
    for (const error of [
      new StorybookAccessError(),
      new StorybookIndexError('x'),
      new StorybookBusyError(),
      new RendererBusyError('queue full'),
    ]) {
      expect(failedBeforeRendering(error)).toBe(true)
    }
    for (const error of [
      new StorybookAccessError(undefined, true),
      new StorybookIndexError('The Storybook index is too large', true),
      new DOMException('aborted', 'AbortError'),
      new BundleImportError('x'),
      new ComponentError('x'),
      new Error('x'),
    ]) {
      expect(failedBeforeRendering(error)).toBe(false)
    }
  })
})
