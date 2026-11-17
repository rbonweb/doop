import type express from 'express'
import { z } from 'zod'
import { parsePublicHttpUrl } from './publicUrl.ts'
import { planStorybookImport, runStorybookImport, storybookFailure, storybookInput } from './storybookImportRun.ts'
import {
  resolveDeps,
  takeStorybookImport,
  StorybookRateLimitError,
  type StorybookImportDeps,
} from './storybookImport.ts'
import type { Actor } from '../shared/types.ts'

/**
 * POST /api/canvases/:id/import/storybook { url, package?, include?, dryRun? } (session, edit role, checked by the caller).
 * The answer is application/x-ndjson, one JSON object a line, flushed as it goes:
 *   { type: 'plan', components: [{ name, group, stories, renders }], renders }   once the index is read
 *   { type: 'progress', rendered, total, component }                              after each render (total only grows)
 *   { type: 'result', result, issues } or { type: 'error', code, message }       the last line
 * A dry run reads the index and plans only. A refusal before streaming starts is an ordinary JSON error. Closing the
 * request aborts the import.
 */

const body = z.object({ ...storybookInput, dryRun: z.boolean().optional() })

export interface StorybookRouteOptions {
  /** a test reaches a fake Storybook on this machine through this; the server mounts the route without it */
  deps?: StorybookImportDeps
}

export async function importStorybookRoute(
  req: express.Request,
  res: express.Response,
  canvasId: string,
  actor: Actor,
  userId: string,
  options: StorybookRouteOptions = {},
) {
  const parsed = body.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid request' })
  }
  const { url, include, dryRun = false } = parsed.data
  const packageName = parsed.data.package
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
  try {
    ;(resolveDeps(options.deps).parseUrl ?? parsePublicHttpUrl)(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'not a valid URL'
    return res.status(400).json({ code: /not reachable/.test(message) ? 'private' : 'invalid', error: message })
  }
  if (!dryRun) {
    try {
      takeStorybookImport(userId)
    } catch (error) {
      if (!(error instanceof StorybookRateLimitError)) throw error
      res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return res.status(429).json({ code: 'too_many', error: error.message })
    }
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
      deps: options.deps,
    }
    if (dryRun) {
      const planned = await planStorybookImport(run)
      line({ type: 'plan', components: planned.components, renders: planned.components.length })
      line({ type: 'result', result: planned.result, issues: planned.issues })
    } else {
      let planned = 0
      const { result, issues } = await runStorybookImport({
        ...run,
        dryRun: false,
        onPlan: (components) => {
          planned = components.length
          line({ type: 'plan', components, renders: planned })
        },
        onRender: ({ rendered, total, component }) => line({ type: 'progress', rendered, total, component }),
      })
      line({ type: 'result', result, issues })
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const failure = storybookFailure(error)
      if (failure.status === 502) console.error('[storybook-import]', error)
      line({ type: 'error', code: failure.code, message: failure.message })
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
}
