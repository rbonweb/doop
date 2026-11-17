import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type express from 'express'
import { MAX_BUNDLE_BYTES } from '../shared/componentBundle.ts'
import { canEdit } from './access.ts'
import { getAccessProfile } from './auth.ts'
import { ComponentError } from './componentActions.ts'
import { importComponentBundle } from './componentBundleImport.ts'
import { beginImportUpload, endImportUpload, peekImportTicket } from './componentImportTickets.ts'
import { store } from './store.ts'
import { runOperation, WorkBudgetError } from './workBudget.ts'

const gunzipAsync = promisify(gunzip)

/** A body read past its cap: the request is cut off and the caller told. */
class BodyTooLarge extends Error {}

async function readBody(req: express.Request, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > cap) throw new BodyTooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** The bundle's JSON text: gunzipped when the request says so, with the cap applied to the bytes it unpacks to. */
async function bundleText(req: express.Request): Promise<string> {
  const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase()
  if (encoding !== 'identity' && encoding !== 'gzip')
    throw new ComponentError(`Content-Encoding ${encoding} is not supported: send plain JSON or gzip`)
  const raw = await readBody(req, MAX_BUNDLE_BYTES)
  if (encoding === 'identity') return raw.toString('utf8')
  try {
    return (await gunzipAsync(raw, { maxOutputLength: MAX_BUNDLE_BYTES })).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new BodyTooLarge()
    throw new ComponentError('the body is not valid gzip')
  }
}

const isDryRun = (value: unknown) => value === '1' || value === 'true'

/**
 * PUT /import/:token: the bundle a ticket (server/componentImportTickets.ts) was made for. No session: the token is the
 * capability, and the person it was made for must still hold the edit role on the canvas when the bytes arrive.
 * A success uses the ticket up; a failed upload leaves it for a retry until it expires, and `?dry_run=1` never uses it.
 */
export async function uploadComponentBundle(req: express.Request, res: express.Response) {
  const token = req.params.token ?? ''
  const dryRun = isDryRun(req.query.dry_run)
  const ticket = dryRun ? peekImportTicket(token) : beginImportUpload(token)
  if (!ticket)
    return res.status(410).json({
      error:
        'invalid, expired or already-used import ticket — ask for a new one (create_import_ticket, or the import picker)',
    })
  let success = false
  let release: (() => void) | undefined
  try {
    /* on any early rejection destroy the request stream, or the sender keeps sending a body nobody reads */
    if (Number(req.headers['content-length'] || 0) > MAX_BUNDLE_BYTES) {
      res.status(413).json({ error: `the bundle is larger than ${MAX_BUNDLE_BYTES / 1_000_000} MB` })
      req.destroy()
      return
    }
    const who = await getAccessProfile(ticket.userId)
    await store.load(ticket.canvasId)
    release = store.hold(ticket.canvasId)
    const canvas = store.getCanvas(ticket.canvasId)
    if (!canvas) return res.status(404).json({ error: 'the canvas was deleted' })
    if (!who || !canEdit(who, canvas)) {
      res.status(403).json({ error: 'the account this ticket was made for can no longer edit this canvas' })
      req.destroy()
      return
    }
    let text: string
    try {
      text = await bundleText(req)
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        res.status(413).json({ error: `the bundle is larger than ${MAX_BUNDLE_BYTES / 1_000_000} MB once unpacked` })
        req.destroy()
        return
      }
      throw error
    }
    let bundle: unknown
    try {
      bundle = JSON.parse(text)
    } catch {
      return res.status(400).json({ error: 'the body is not JSON' })
    }
    const context = { canvasId: ticket.canvasId, actor: ticket.actor }
    const result = dryRun
      ? runOperation('component-import', ticket.canvasId, () =>
          importComponentBundle(context, bundle, { dryRun: true }),
        )
      : importComponentBundle(
          { ...context, batch: (work) => runOperation('component-import', ticket.canvasId, work) },
          bundle,
        )
    success = !dryRun
    res.json({ ok: true, dry_run: dryRun, ...result })
  } catch (error) {
    if (error instanceof ComponentError || error instanceof WorkBudgetError)
      res.status(400).json({ error: error.message })
    else {
      console.error('[component-import]', error)
      res.status(500).json({ error: 'the import failed' })
    }
  } finally {
    release?.()
    if (!dryRun) endImportUpload(token, success)
  }
}
