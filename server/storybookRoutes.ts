import type express from 'express'
import { z } from 'zod'
import { cleanLabel } from './componentBundleImport.ts'
import {
  failedBeforeRendering,
  planStorybookImport,
  runStorybookImport,
  storybookFailure,
  storybookInput,
} from './storybookImportRun.ts'
import {
  checkStorybookUrl,
  takeStorybookImport,
  takeStorybookPlan,
  StorybookRateLimitError,
  type StorybookImportDeps,
} from './storybookImport.ts'
import type { Actor } from '../shared/types.ts'

/**
 * POST /api/canvases/:id/import/storybook { url, package?, include?, dryRun? } (session, edit role, checked by the caller).
 * The answer is application/x-ndjson, one JSON object a line, flushed as it goes:
 *   { type: 'plan', components: [{ name, group, stories, renders }], renders }   once the index is read
 *   { type: 'progress', rendered, total, component }                              after each component (total is the plan's `renders`, fixed)
 *   { type: 'result', result, issues } or { type: 'error', code, message }       the last line
 * A dry run reads the index and plans only. A refusal before streaming starts is an ordinary JSON error. Closing the
 * request aborts the import.
 */

const body = z.object({ ...storybookInput, dryRun: z.boolean().optional() })

export interface StorybookRouteOptions {
  /** a test reaches a fake Storybook on this machine through this; the server mounts the route without it */
  deps?: StorybookImportDeps
}

/** A plan entry as the stream shows it: the name and group the importer will use. */
const cleaned = <T extends { name: string; group: string }>(entry: T): T => ({
  ...entry,
  name: cleanLabel(entry.name) || 'Component',
  group: cleanLabel(entry.group, 200),
})

export async function importStorybookRoute(
  req: express.Request,
  res: express.Response,
  canvasId: string,
  actor: Actor,
  userId: string,
  /** whether the account still holds the edit role: asked again right before the importer writes */
  canEdit: () => boolean,
  options: StorybookRouteOptions = {},
) {
  const parsed = body.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid request' })
  }
  const { url, include, dryRun = false } = parsed.data
  const packageName = parsed.data.package
  const checked = checkStorybookUrl(url, options.deps)
  if (!checked.ok) {
    return res.status(400).json({ code: checked.private ? 'private' : 'invalid', error: checked.message })
  }
  const raw = checked.url.href
  /* what is counted: an import is 3 an hour, a plan-only preview has a larger hour of its own; a slot is given back if the import fails before rendering */
  let refund = () => {}
  try {
    refund = dryRun ? takeStorybookPlan(userId) : takeStorybookImport(userId)
  } catch (error) {
    if (!(error instanceof StorybookRateLimitError)) throw error
    res.setHeader('Retry-After', String(error.retryAfterSeconds))
    return res.status(429).json({ code: 'too_many', error: error.message })
  }

  /* closing the request stops the import, and the browser with it */
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('the request was closed'))
  })
  res.status(200)
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders()
  const line = (value: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(value)}\n`)
  }

  try {
    const run = {
      canvasId,
      actor,
      url: raw,
      package: packageName,
      include,
      signal: controller.signal,
      canEdit,
      deps: options.deps,
    }
    if (dryRun) {
      const planned = await planStorybookImport(run)
      line({
        type: 'plan',
        components: planned.components.map(cleaned),
        renders: planned.info.importing,
        total: planned.info.total,
        ...(planned.info.capped ? { capped: true } : {}),
      })
      line({ type: 'result', result: planned.result, issues: planned.issues })
    } else {
      const { result, issues } = await runStorybookImport({
        ...run,
        dryRun: false,
        onPlan: (components, info) => {
          line({
            type: 'plan',
            components: components.map(cleaned),
            renders: info.importing,
            total: info.total,
            ...(info.capped ? { capped: true } : {}),
          })
        },
        onRender: ({ rendered, total, component }) =>
          line({ type: 'progress', rendered, total, component: cleanLabel(component) || 'Component' }),
      })
      line({ type: 'result', result, issues })
    }
  } catch (error) {
    /* a failure before anything rendered gives the slot back; an abort never does */
    if (!controller.signal.aborted && failedBeforeRendering(error)) refund()
    if (!controller.signal.aborted) {
      const failure = storybookFailure(error)
      line({ type: 'error', code: failure.code, message: failure.message })
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
}
