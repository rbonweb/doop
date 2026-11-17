import { Router } from 'express'
import { clientIp } from './rateLimit.ts'
import {
  contentBytes,
  exportCanvasReact,
  MAX_INLINE_EXPORT_BYTES,
  reactExportRequest,
  reactExportRetryAfter,
  takeReactExportSlot,
} from './reactExport/canvasExport.ts'
import { zipExport } from './reactExport/zip.ts'
import { requireCanvas } from './sharing.ts'

/** `POST /api/canvases/:id/export/react`: a canvas's components and screens as React code. Apart from the main server file so it can be tested on its own. */
export const reactExportRouter = Router()

/** The header the zip answer carries so the dialog can say how much did not carry over without opening the archive. */
export const ISSUE_COUNT_HEADER = 'X-Doop-Export-Issues'

reactExportRouter.post('/:id/export/react', async (req, res) => {
  /* the view gate every read route uses: the role resolver, a password link's unlock cookie included. Reading is all an export does. */
  const canvas = requireCanvas(req, res, String(req.params.id), 'view')
  if (!canvas) return
  const body = reactExportRequest.safeParse(req.body ?? {})
  if (!body.success) {
    const issue = body.error.issues[0]
    return res
      .status(400)
      .json({ error: `invalid export request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim() })
  }
  const key = req.user?.id ?? clientIp(req)
  if (!takeReactExportSlot(key)) {
    res.set('Retry-After', String(reactExportRetryAfter(key)))
    return res.status(429).json({ error: 'React export rate limit — try again in a minute' })
  }
  const exported = exportCanvasReact(canvas, body.data)
  if (!exported.ok) return res.status(exported.status).json({ error: exported.error })
  const { result } = exported
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
  if (body.data.format === 'json') {
    if (contentBytes(result) > MAX_INLINE_EXPORT_BYTES) {
      return res.status(413).json({
        error: `The files are over ${MAX_INLINE_EXPORT_BYTES / 1024} KB: download the zip, or export fewer frames or components`,
      })
    }
    return res.json({ files: result.files, report: result.report })
  }
  try {
    const zip = await zipExport(result, exported.rootDir)
    res.set({
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename="${exported.fileName}"`,
      [ISSUE_COUNT_HEADER]: String(result.report.issues.length),
    })
    return res.send(zip)
  } catch {
    return res.status(500).json({ error: 'The export failed' })
  }
})
