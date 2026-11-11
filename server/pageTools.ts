import { normalizeRotation } from '../shared/frameRotation.ts'
import * as actions from './actions.ts'
import { MAX_PAGES, PageLimitError, store } from './store.ts'
import {
  canvasPages,
  framePageId,
  MAX_PAGE_NAME,
  normalizePageTree,
  samePages,
  validatePageTree,
} from '../shared/pages.ts'
import type { Actor, Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'

/**
 * The page tools every agent gets, whether it connects over MCP
 * (server/mcp.ts) or runs in the server (server/resident.ts): one set of
 * checks for adding a page, saving the page list and moving a frame, so the
 * two surfaces cannot drift apart.
 */

export type PageToolResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type FrameMetaPatch = Partial<
  Pick<Frame, 'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'locked' | 'rotation' | 'slide' | 'speakerNotes'>
>

const MAX_PAGE_ID = 100

/** The canvas's pages as a tool reports them: id, name and the page they nest under, in order. */
export function pageList(canvas: Canvas): CanvasPageInfo[] {
  return canvasPages(canvas).map(({ id, name, parentId }) =>
    parentId === undefined ? { id, name } : { id, name, parentId },
  )
}

/** A page as it crosses the MCP boundary: `parent_id` in snake_case like every other agent-facing field. */
export function toToolPage(page: CanvasPageInfo): { id: string; name: string; parent_id?: string } {
  return page.parentId === undefined
    ? { id: page.id, name: page.name }
    : { id: page.id, name: page.name, parent_id: page.parentId }
}

/** The inverse of `toToolPage`; also takes the camelCase `parentId` the resident agent's list shows. */
export function fromToolPage(page: {
  id: string
  name: string
  parent_id?: string | undefined
  parentId?: string | undefined
}): CanvasPageInfo {
  const parentId = page.parent_id ?? page.parentId
  return parentId === undefined ? { id: page.id, name: page.name } : { id: page.id, name: page.name, parentId }
}

function pageListText(canvas: Canvas): string {
  return pageList(canvas)
    .map((page) => `${page.id} ("${page.name}")`)
    .join(', ')
}

/** A page id the canvas does not have: the error names the pages it does have, so the agent can retry without another read. */
export function noPageMessage(canvas: Canvas, pageId: string): string {
  return `no page with id ${pageId} on this canvas. Its pages: ${JSON.stringify(canvasPages(canvas).map(toToolPage))}`
}

/** A model's page list, checked the way the MCP schema checks it. */
export function parsePageList(raw: unknown): CanvasPageInfo[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'pages must be a non-empty list of { id, name, parent_id? }'
  if (raw.length > MAX_PAGES) return `a canvas holds at most ${MAX_PAGES} pages`
  const pages: CanvasPageInfo[] = []
  for (const entry of raw as unknown[]) {
    const { id, name, parent_id, parentId } = (entry ?? {}) as {
      id?: unknown
      name?: unknown
      parent_id?: unknown
      parentId?: unknown
    }
    const rawParent = parent_id ?? parentId
    const cleanParent = typeof rawParent === 'string' ? rawParent.trim() : ''
    const cleanId = typeof id === 'string' ? id.trim() : ''
    const cleanName = typeof name === 'string' ? name.trim() : ''
    if (!cleanId || cleanId.length > MAX_PAGE_ID) return 'every page needs its id from the current page list'
    if (!cleanName || cleanName.length > MAX_PAGE_NAME)
      return `every page needs a name of 1-${MAX_PAGE_NAME} characters`
    if (rawParent !== undefined && rawParent !== null && (!cleanParent || cleanParent.length > MAX_PAGE_ID))
      return 'parent_id must be the id of another page in the list'
    pages.push(cleanParent ? { id: cleanId, name: cleanName, parentId: cleanParent } : { id: cleanId, name: cleanName })
  }
  return pages
}

/** Add an empty page at the end of the canvas, or at the end of `parentId`'s subpages when nested. The read, append and
 *  save run in one synchronous step, so concurrent calls never lose a page. */
export function addPage(
  canvasId: string,
  name: string,
  actor: Actor,
  parentId?: string,
): PageToolResult<{ page: CanvasPageInfo; pages: CanvasPageInfo[] }> {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return { ok: false, error: 'canvas not found' }
  const current = canvasPages(canvas)
  if (current.length >= MAX_PAGES) return { ok: false, error: new PageLimitError().message }
  if (parentId && !current.some((p) => p.id === parentId)) return { ok: false, error: noPageMessage(canvas, parentId) }
  const candidate: CanvasPageInfo = parentId ? { id: '', name, parentId } : { id: '', name }
  const treeError = validatePageTree([...current, candidate])
  if (treeError) return { ok: false, error: treeError }
  const created = actions.createCanvasPage(canvasId, name, actor, parentId)
  if (!created) return { ok: false, error: 'canvas not found' }
  return { ok: true, value: created }
}

/** Rename, reorder, nest or delete pages by saving the whole ordered list. Refused when
 *  `expected` is not the list as it stands (a collaborator changed it since it
 *  was read), when the list is not a valid tree or when a dropped page still holds frames. */
export function savePages(
  canvas: Canvas,
  expected: unknown,
  pages: CanvasPageInfo[],
  actor: Actor,
): PageToolResult<CanvasPageInfo[]> {
  const current = canvasPages(canvas)
  const expectedPages = Array.isArray(expected)
    ? (expected as unknown[]).map((entry) => {
        const { id, name, parent_id, parentId } = (entry ?? {}) as Record<string, unknown>
        const parent = parent_id ?? parentId
        return { id, name, parentId: typeof parent === 'string' ? parent : undefined }
      })
    : expected
  if (!samePages(expectedPages, current)) {
    const known = new Set(
      Array.isArray(expectedPages) ? expectedPages.map((p) => String((p as { id?: unknown })?.id)) : [],
    )
    const added = current.filter((p) => !known.has(p.id)).map((p) => p.id)
    const removed = Array.isArray(expectedPages)
      ? expectedPages.map((p) => String((p as { id?: unknown })?.id)).filter((id) => !current.some((c) => c.id === id))
      : []
    return {
      ok: false,
      error: `expectedPages does not match the canvas: another collaborator changed its pages since you read them${added.length ? ` (added: ${added.join(', ')})` : ''}${removed.length ? ` (removed: ${removed.join(', ')})` : ''}. Current pages, in order: ${JSON.stringify(current.map(toToolPage))}. Re-apply your change to this list and send it as expectedPages, or call create_canvas_page to add a page without the full list.`,
    }
  }
  const treeError = validatePageTree(pages)
  if (treeError) return { ok: false, error: treeError }
  const normalized = normalizePageTree(pages)
  const stranded = canvas.frames.find((f) => !normalized.some((p) => p.id === framePageId(canvas, f)))
  if (stranded)
    return {
      ok: false,
      error: `Move frames before deleting their page: "${stranded.name}" (${stranded.id}) is still on it — move it with update_frame's pageId`,
    }
  return { ok: true, value: actions.setCanvasPages(canvas.id, normalized, actor) }
}

/** Rename, move, resize or (un)lock a frame, or move it to another page. */
export function updateFrameMeta(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  actor: Actor,
): PageToolResult<Frame> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as FrameMetaPatch
  if (!Object.keys(clean).length) return { ok: false, error: 'nothing to update' }
  if (clean.pageId !== undefined && !canvasPages(canvas).some((p) => p.id === clean.pageId))
    return { ok: false, error: `no page ${clean.pageId} on this canvas — the pages are: ${pageListText(canvas)}` }
  if (clean.rotation !== undefined) {
    if (!Number.isFinite(clean.rotation)) return { ok: false, error: 'rotation must be a finite number of degrees' }
    clean.rotation = normalizeRotation(clean.rotation)
  }
  const frame = actions.updateFrame(frameId, clean, actor)
  return frame ? { ok: true, value: frame } : { ok: false, error: `frame ${frameId} not found` }
}
