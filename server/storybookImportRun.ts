import { z } from 'zod'
import type { Actor } from '../shared/types.ts'
import { BundleImportError, type PlannedComponent } from '../shared/storybook/bundle.ts'
import { importComponentBundle, type ImportIssue, type ImportResult } from './componentBundleImport.ts'
import { ComponentError } from './componentActions.ts'
import { detached } from './journal.ts'
import {
  storybookBundle,
  storybookPlan,
  StorybookAccessError,
  StorybookBusyError,
  StorybookIndexError,
  StorybookRateLimitError,
  type StorybookImportDeps,
} from './storybookImport.ts'
import { RendererBusyError } from './renderBrowser.ts'
import { runOperation, WorkBudgetError } from './workBudget.ts'

/** What the MCP tool, the resident tool and the REST route share: a Storybook URL to components on a canvas. The long part (a browser rendering the Storybook) runs outside any write boundary; only the importer's own writes are units of their own. */

/** An npm package name, "react-ui" or "@acme/ui": what becomes every component's `importFrom`. */
export const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

export const storybookInput = {
  url: z.string().min(1).max(2000).describe('The published Storybook root, https://storybook.example.com'),
  package: z
    .string()
    .max(214)
    .regex(PACKAGE_NAME, 'an npm package name such as "@acme/ui"')
    .optional()
    .describe('The npm package the components are imported from in code, e.g. "@acme/ui"'),
  include: z
    .array(z.string().min(1).max(200))
    .max(50)
    .optional()
    .describe(
      'Only components whose Storybook title is one of these or sits under one of these folders (matched up to a /, so "Inputs" is not "InputsLegacy"), e.g. ["Inputs", "Layout/Card"]',
    ),
}

export interface StorybookRun {
  canvasId: string
  actor: Actor
  url: string
  package?: string
  include?: string[]
  dryRun: boolean
  signal?: AbortSignal
  /** asked again right before the importer writes, since the render took minutes: whether the account may still edit this canvas */
  canEdit: () => boolean
  onPlan?: (groups: PlannedComponent[]) => void
  onRender?: (event: { rendered: number; total: number; component: string }) => void
  /** a test swaps what reaches a fake Storybook on this machine */
  deps?: StorybookImportDeps
}

export interface StorybookRunResult {
  result: ImportResult
  /** what the capture noticed, then what the importer did to it */
  issues: ImportIssue[]
  renders: number
}

const MAX_ISSUES = 200

/** Renders the Storybook and imports what came out, or only reports what would happen. */
export async function runStorybookImport(run: StorybookRun): Promise<StorybookRunResult> {
  const { bundle, issues, renders } = await detached(() =>
    storybookBundle(
      run.url,
      {
        package: run.package,
        include: run.include,
        signal: run.signal,
        onPlan: run.onPlan,
        onRender: run.onRender,
      },
      run.deps,
    ),
  )
  /* the render took minutes: the account may have been demoted, or the request closed, since it began */
  run.signal?.throwIfAborted()
  if (!run.canEdit()) throw new ComponentError('You can no longer edit this canvas, so nothing was imported')
  const context = { canvasId: run.canvasId, actor: run.actor }
  const result = run.dryRun
    ? detached(() =>
        runOperation('storybook-import', run.canvasId, () => importComponentBundle(context, bundle, { dryRun: true })),
      )
    : detached(() =>
        importComponentBundle(
          { ...context, batch: (work) => runOperation('storybook-import', run.canvasId, work) },
          bundle,
        ),
      )
  const merged = [...issues, ...result.issues]
  return {
    result,
    issues: merged.length > MAX_ISSUES ? merged.slice(0, MAX_ISSUES) : merged,
    renders,
  }
}

/** A dry run that reads only the index: what would be created or updated, by name, with nothing rendered. The importer answers it from placeholder components so "updated" means what a real run would match. */
export async function planStorybookImport(
  run: Pick<StorybookRun, 'canvasId' | 'actor' | 'url' | 'package' | 'include' | 'signal' | 'deps'>,
): Promise<{ components: PlannedComponent[]; result: ImportResult; issues: ImportIssue[] }> {
  const plan = await detached(() => storybookPlan(run.url, { include: run.include, signal: run.signal }, run.deps))
  const components = plan.components.map(({ story: _story, ...entry }) => entry)
  if (!components.length) {
    throw new StorybookIndexError(plan.issues[0]?.message ?? 'No story matched, so there is nothing to import', true)
  }
  const placeholder = {
    version: 1,
    source: { kind: 'storybook', url: plan.baseUrl },
    ...(run.package ? { package: run.package } : {}),
    components: components.map((entry) => ({
      name: entry.name,
      group: entry.group,
      html: '<div></div>',
      code: {
        exportName: /^[A-Za-z_$][\w$]*$/.test(entry.name) ? entry.name : undefined,
        origin: { kind: 'storybook' },
      },
    })),
  }
  const result = detached(() =>
    runOperation('storybook-import', run.canvasId, () =>
      importComponentBundle({ canvasId: run.canvasId, actor: run.actor }, placeholder, { dryRun: true }),
    ),
  )
  return {
    components,
    result: { ...result, issues: [] },
    issues: plan.issues,
  }
}

export type StorybookFailureCode = 'private' | 'unreachable' | 'too_many' | 'busy' | 'invalid'

/** An error from the import as the code and message a caller shows. Only errors this import raised on purpose carry their own message; anything else (a browser or network failure, a bug) is logged and answered with a fixed line, since its text can name internal addresses. */
export function storybookFailure(error: unknown): { code: StorybookFailureCode; message: string; status: number } {
  if (error instanceof StorybookAccessError) return { code: 'private', message: error.message, status: 400 }
  if (error instanceof StorybookBusyError) return { code: 'busy', message: error.message, status: 503 }
  if (error instanceof RendererBusyError) {
    return { code: 'busy', message: "Doop's renderer is busy. Try again in a minute.", status: 503 }
  }
  if (error instanceof StorybookRateLimitError) return { code: 'too_many', message: error.message, status: 429 }
  if (error instanceof StorybookIndexError) return { code: 'unreachable', message: error.message, status: 400 }
  if (error instanceof BundleImportError) return { code: 'invalid', message: error.message, status: 400 }
  if (error instanceof ComponentError || error instanceof WorkBudgetError) {
    return { code: /holds at most/.test(error.message) ? 'too_many' : 'invalid', message: error.message, status: 400 }
  }
  console.error('[storybook-import]', error)
  return { code: 'unreachable', message: 'The Storybook import failed', status: 502 }
}

/** Whether the import slot is given back: only for a failure that cost the server next to nothing and that no one can farm. The server being busy; and an index that could not be reached or was refused without a body being read (connect or DNS failure, 401, 403, 404, a refused redirect). Never an abort, an index body that was downloaded (too large, not JSON, no stories), a story page that answered 401 or 403 (browser work was spent), or anything after rendering began. */
export function failedBeforeRendering(error: unknown): boolean {
  if (error instanceof StorybookBusyError || error instanceof RendererBusyError) return true
  if (error instanceof StorybookAccessError) return !error.duringRender
  if (error instanceof StorybookIndexError) return !error.readBody
  return false
}
