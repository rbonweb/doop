import { Router } from 'express'
import * as actions from './actions.ts'
import { requireCanvas } from './sharing.ts'

/** /api/comments: routes on existing comments that live apart from the
 *  main server file so they can be tested on their own. */
export const commentAnchorRouter = Router()

/** The browser that re-found a pin's element after an edit reports the
 *  element's new CSS path, so the next load takes the fast path. */
commentAnchorRouter.patch('/:id/anchor', (req, res) => {
  const found = actions.findComment(String(req.params.id))
  if (!found) return res.status(404).json({ error: 'comment not found' })
  /* healing rewrites the stored pin, so it takes the right to comment, not just to look */
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  const selector: unknown = req.body?.selector
  if (typeof selector !== 'string' || !selector.trim() || selector.length > actions.MAX_SELECTOR_LENGTH) {
    return res.status(400).json({ error: `selector must be a string of 1-${actions.MAX_SELECTOR_LENGTH} characters` })
  }
  const root = actions.healCommentSelector(found.id, selector)
  res.json({ ok: true, selector: root?.selector ?? selector })
})
