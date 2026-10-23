import { Router, type Request, type Response } from 'express'
import * as persist from './db/persist.ts'
import { MAX_SEEN_PER_REQUEST, contentStamp } from '../shared/marks.ts'
import { store } from './store.ts'
import { requireCanvas } from './sharing.ts'

/** /api/canvases/:id/seen: what each person has already looked at on a canvas, behind the "new" marks. */
export const seenRouter = Router()

export { MAX_SEEN_PER_REQUEST }

/** The caller and canvas, when this caller may view it (any role); otherwise the response is already sent. */
function canvasFor(req: Request, res: Response) {
  const userId = req.user?.id
  if (!userId) {
    res.status(401).json({ error: 'sign in to track what you have seen' })
    return null
  }
  const canvas = requireCanvas(req, res, String(req.params.id), 'view')
  if (!canvas) return null
  return { userId, canvas }
}

/** The caller's seen map and baseline. The first call on a canvas starts the baseline: what exists now counts as seen. */
seenRouter.get('/:id/seen', async (req, res) => {
  const found = canvasFor(req, res)
  if (!found) return
  try {
    const baselineAt = await persist.ensureCanvasVisit(found.userId, found.canvas.id, Date.now())
    const rows = await persist.listFrameSeen(found.userId, found.canvas.id)
    res.json({ seen: Object.fromEntries(rows.map((r) => [r.frameId, r.seenUpdatedAt])), baselineAt })
  } catch (error) {
    console.error('[seen] could not read the seen state', error)
    res.status(500).json({ error: 'could not read what you have seen' })
  }
})

/**
 * Record `{ frames: { [frameId]: version } }`: the version of each frame the caller saw, where a version is the frame's
 * design stamp (`contentStamp`). The store keeps the larger value, so a stale tab cannot roll a frame back to "new". A
 * value is clamped to the frame's own stamp, so a client can never mark a change that has not happened yet as seen.
 * Frames from other canvases are ignored.
 *
 * With `replace: true` each value is set exactly instead (still clamped), and `null` forgets the frame; this is how
 * "Mark all as seen" is undone, putting the previous state back. Same access check as the plain write.
 */
seenRouter.post('/:id/seen', async (req, res) => {
  const found = canvasFor(req, res)
  if (!found) return
  const frames: unknown = req.body?.frames
  if (!frames || typeof frames !== 'object' || Array.isArray(frames)) {
    return res.status(400).json({ error: 'frames must be an object of frame id to updatedAt' })
  }
  const replace = req.body?.replace === true
  const entries = Object.entries(frames)
  if (entries.length > MAX_SEEN_PER_REQUEST) {
    return res.status(400).json({ error: `report at most ${MAX_SEEN_PER_REQUEST} frames at a time` })
  }
  const writes: Promise<void>[] = []
  for (const [frameId, value] of entries) {
    const forget = replace && value === null
    if (!forget && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ error: 'every updatedAt must be a non-negative number' })
    }
    const frame = store.getFrame(frameId)
    if (!frame || frame.canvasId !== found.canvas.id) continue
    if (forget) {
      writes.push(persist.replaceFrameSeen(found.userId, found.canvas.id, frameId, null))
      continue
    }
    const at = Math.min(Math.floor(value as number), contentStamp(frame))
    writes.push(
      replace
        ? persist.replaceFrameSeen(found.userId, found.canvas.id, frameId, at)
        : persist.saveFrameSeen(found.userId, found.canvas.id, frameId, at),
    )
  }
  try {
    await Promise.all(writes)
    res.json({ ok: true, saved: writes.length })
  } catch (error) {
    console.error('[seen] could not save the seen state', error)
    res.status(500).json({ error: 'could not save what you have seen' })
  }
})
