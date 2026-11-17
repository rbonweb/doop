import { z } from 'zod'
import type { Actor } from '../shared/types.ts'
import type { PlannedComponent } from '../shared/storybook/bundle.ts'
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
    .describe('Only components whose Storybook title starts with one of these, e.g. ["Inputs", "Layout/Card"]'),
}

export interface StorybookRun {
  canvasId: string
  actor: Actor
  url: string
  package?: string
  include?: string[]
  dryRun: boolean
  signal?: AbortSignal
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
    throw new StorybookIndexError(plan.issues[0]?.message ?? 'No story matched, so there is nothing to import')
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

/** An error from the import as the code and message a caller shows. */
export function storybookFailure(error: unknown): { code: StorybookFailureCode; message: string; status: number } {
  if (error instanceof StorybookAccessError) return { code: 'private', message: error.message, status: 400 }
  if (error instanceof StorybookBusyError) return { code: 'busy', message: error.message, status: 503 }
  if (error instanceof StorybookRateLimitError) return { code: 'too_many', message: error.message, status: 429 }
  if (error instanceof StorybookIndexError) return { code: 'unreachable', message: error.message, status: 400 }
  if (error instanceof ComponentError || error instanceof WorkBudgetError) {
    return { code: /holds at most/.test(error.message) ? 'too_many' : 'invalid', message: error.message, status: 400 }
  }
  return {
    code: 'unreachable',
    message: error instanceof Error ? error.message.slice(0, 300) : 'The Storybook import failed',
    status: 502,
  }
}
