import type { Canvas, CanvasPageInfo, Frame } from './types.ts'

export function canvasPages(canvas: Pick<Canvas, 'id' | 'pages'>): CanvasPageInfo[] {
  return canvas.pages?.length ? canvas.pages : [{ id: `${canvas.id}:page1`, name: 'Page 1' }]
}

export function framePageId(canvas: Pick<Canvas, 'id' | 'pages'>, frame: Frame): string {
  return frame.pageId ?? canvasPages(canvas)[0]!.id
}

export function pageFrames(canvas: Canvas, pageId: string): Frame[] {
  return canvas.frames.filter((frame) => framePageId(canvas, frame) === pageId)
}

export function samePages(a: unknown, b: CanvasPageInfo[]): boolean {
  return (
    Array.isArray(a) &&
    a.length === b.length &&
    a.every(
      (page, i) =>
        page?.id === b[i]!.id && page?.name === b[i]!.name && (page?.parentId ?? undefined) === b[i]!.parentId,
    )
  )
}

/** Top level is depth 1, so 3 allows two levels of nesting. */
export const MAX_PAGE_DEPTH = 3

export interface PageNode {
  page: CanvasPageInfo
  /** 1 for a top-level page */
  depth: number
  children: PageNode[]
}

function indexPages(pages: CanvasPageInfo[]): Map<string, CanvasPageInfo> {
  const byId = new Map<string, CanvasPageInfo>()
  for (const page of pages) if (!byId.has(page.id)) byId.set(page.id, page)
  return byId
}

/** 1 for a top-level page, 0 for an unknown id, Infinity when the parent chain loops. */
export function pageDepth(pages: CanvasPageInfo[], id: string): number {
  const byId = indexPages(pages)
  const seen = new Set<string>()
  let depth = 0
  for (let page = byId.get(id); page; page = page.parentId ? byId.get(page.parentId) : undefined) {
    if (seen.has(page.id)) return Infinity
    seen.add(page.id)
    depth++
  }
  return depth
}

/** The pages above this one, outermost first. */
export function pageAncestors(pages: CanvasPageInfo[], id: string): CanvasPageInfo[] {
  const byId = indexPages(pages)
  const seen = new Set<string>([id])
  const ancestors: CanvasPageInfo[] = []
  for (let parent = parentOf(byId, byId.get(id)); parent && !seen.has(parent.id); parent = parentOf(byId, parent)) {
    seen.add(parent.id)
    ancestors.unshift(parent)
  }
  return ancestors
}

function parentOf(byId: Map<string, CanvasPageInfo>, page: CanvasPageInfo | undefined): CanvasPageInfo | undefined {
  return page?.parentId ? byId.get(page.parentId) : undefined
}

/** Every page below this one in pre-order, children before the next sibling. */
export function pageDescendants(pages: CanvasPageInfo[], id: string): CanvasPageInfo[] {
  const found: CanvasPageInfo[] = []
  const seen = new Set<string>([id])
  const visit = (parentId: string) => {
    for (const page of pages) {
      if (page.parentId !== parentId || seen.has(page.id)) continue
      seen.add(page.id)
      found.push(page)
      visit(page.id)
    }
  }
  visit(id)
  return found
}

/** Levels in the subtree rooted at this page: 1 for a page without children. */
export function pageHeight(pages: CanvasPageInfo[], id: string): number {
  const heights = new Map<string, number>()
  let tallest = 0
  for (const page of pageDescendants(pages, id)) {
    const height = (heights.get(page.parentId!) ?? 1) + 1
    heights.set(page.id, height)
    tallest = Math.max(tallest, height)
  }
  return Math.max(tallest, 1)
}

/** The first problem that makes the list an invalid tree, or null. The list need not be in pre-order. */
export function validatePageTree(pages: CanvasPageInfo[]): string | null {
  const ids = new Set<string>()
  for (const page of pages) {
    if (ids.has(page.id)) return 'Page IDs must be unique.'
    ids.add(page.id)
  }
  const byId = indexPages(pages)
  for (const page of pages) {
    if (page.parentId === undefined) continue
    if (page.parentId === page.id) return 'A page cannot be nested under itself.'
    if (!byId.has(page.parentId)) return 'A page is nested under a page that does not exist.'
  }
  for (const page of pages) {
    const depth = pageDepth(pages, page.id)
    if (depth === Infinity) return 'Pages cannot be nested under their own subpages.'
    if (depth > MAX_PAGE_DEPTH) return `Pages can be nested at most ${MAX_PAGE_DEPTH - 1} levels deep.`
  }
  return null
}

/**
 * Repair a tree that older clients or concurrent edits left broken, and order it
 * pre-order (each parent before its descendants, siblings in their existing
 * relative order). A dangling or cyclic parent lifts the page to top level, a
 * too-deep page lifts to its deepest ancestor that can still host it.
 */
export function normalizePageTree(pages: CanvasPageInfo[]): CanvasPageInfo[] {
  const byId = indexPages(pages)
  const unique = pages.filter((page) => byId.get(page.id) === page)
  const rawChildren = new Map<string, CanvasPageInfo[]>()
  for (const page of unique) {
    if (page.parentId === undefined || page.parentId === page.id || !byId.has(page.parentId)) continue
    rawChildren.set(page.parentId, [...(rawChildren.get(page.parentId) ?? []), page])
  }
  const parentOfPage = new Map<string, string | undefined>()
  const settle = (root: CanvasPageInfo) => {
    parentOfPage.set(root.id, undefined)
    const queue: { page: CanvasPageInfo; depth: number }[] = [{ page: root, depth: 1 }]
    for (let next = queue.shift(); next; next = queue.shift()) {
      for (const child of rawChildren.get(next.page.id) ?? []) {
        if (parentOfPage.has(child.id)) continue
        if (next.depth < MAX_PAGE_DEPTH) {
          parentOfPage.set(child.id, next.page.id)
          queue.push({ page: child, depth: next.depth + 1 })
        } else {
          parentOfPage.set(child.id, parentOfPage.get(next.page.id))
          queue.push({ page: child, depth: next.depth })
        }
      }
    }
  }
  for (const page of unique) {
    if (page.parentId === undefined || page.parentId === page.id || !byId.has(page.parentId)) settle(page)
  }
  /* Whatever is left only reaches itself through a cycle: open the cycle at the first page in list order. */
  for (const page of unique) if (!parentOfPage.has(page.id)) settle(page)
  const children = new Map<string | undefined, CanvasPageInfo[]>()
  for (const page of unique) {
    const parentId = parentOfPage.get(page.id)
    children.set(parentId, [...(children.get(parentId) ?? []), page])
  }
  const ordered: CanvasPageInfo[] = []
  const place = (parentId: string | undefined) => {
    for (const page of children.get(parentId) ?? []) {
      const { parentId: _old, ...rest } = page
      const parent = parentOfPage.get(page.id)
      ordered.push(parent === undefined ? rest : { ...rest, parentId: parent })
      place(page.id)
    }
  }
  place(undefined)
  return ordered
}

/** The pages as nested nodes (normalized first, so a broken list still renders). */
export function pageTree(pages: CanvasPageInfo[]): PageNode[] {
  const roots: PageNode[] = []
  const nodes = new Map<string, PageNode>()
  for (const page of normalizePageTree(pages)) {
    const parent = page.parentId ? nodes.get(page.parentId) : undefined
    const node: PageNode = { page, depth: (parent?.depth ?? 0) + 1, children: [] }
    nodes.set(page.id, node)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** True when this page (with its whole subtree) may sit under `parentId` (undefined = top level). */
export function canNestPage(pages: CanvasPageInfo[], id: string, parentId: string | undefined): boolean {
  if (parentId === undefined) return pages.some((page) => page.id === id)
  if (parentId === id || !pages.some((page) => page.id === id)) return false
  if (pageDescendants(pages, id).some((page) => page.id === parentId)) return false
  const parentDepth = pageDepth(pages, parentId)
  return parentDepth > 0 && parentDepth + pageHeight(pages, id) <= MAX_PAGE_DEPTH
}

export type PagePlacement =
  | { type: 'into'; targetId: string }
  | { type: 'before'; targetId: string }
  | { type: 'after'; targetId: string }
  | { type: 'top' }

/**
 * Move a page together with its subtree. `into` makes it the last child of the
 * target, `before`/`after` make it a sibling of the target, `top` appends it at
 * top level. Returns null when the move is not allowed.
 */
export function movePage(pages: CanvasPageInfo[], id: string, placement: PagePlacement): CanvasPageInfo[] | null {
  const page = pages.find((candidate) => candidate.id === id)
  if (!page) return null
  const subtree = [page, ...pageDescendants(pages, id)]
  const inSubtree = new Set(subtree.map((p) => p.id))
  const rest = pages.filter((p) => !inSubtree.has(p.id))
  let parentId: string | undefined
  let index = rest.length
  if (placement.type !== 'top') {
    const target = rest.find((p) => p.id === placement.targetId)
    if (!target) return null
    const at = rest.indexOf(target)
    const afterTarget = at + 1 + pageDescendants(rest, target.id).length
    if (placement.type === 'into') {
      parentId = target.id
      index = afterTarget
    } else {
      parentId = target.parentId
      index = placement.type === 'before' ? at : afterTarget
    }
  }
  if (!canNestPage(pages, id, parentId)) return null
  const { parentId: _old, ...head } = page
  const moved = [parentId === undefined ? head : { ...head, parentId }, ...subtree.slice(1)]
  return [...rest.slice(0, index), ...moved, ...rest.slice(index)]
}

/** Insert a new page as the last child of `parentId` (undefined = last top-level page). */
export function addPage(pages: CanvasPageInfo[], page: CanvasPageInfo, parentId?: string): CanvasPageInfo[] {
  const index = parentId
    ? pages.findIndex((p) => p.id === parentId) + 1 + pageDescendants(pages, parentId).length
    : pages.length
  const { parentId: _old, ...head } = page
  return [...pages.slice(0, index), parentId ? { ...head, parentId } : head, ...pages.slice(index)]
}

/** Remove a page; its children take its place under its parent, keeping their order. */
export function removePage(pages: CanvasPageInfo[], id: string): CanvasPageInfo[] {
  const removed = pages.find((page) => page.id === id)
  if (!removed) return pages
  return pages
    .filter((page) => page.id !== id)
    .map((page) => {
      if (page.parentId !== id) return page
      const { parentId: _old, ...rest } = page
      return removed.parentId === undefined ? rest : { ...rest, parentId: removed.parentId }
    })
}

/** Apply one local page edit to the current list, preserving collaborators' additions. */
export function applyPageChanges(
  current: CanvasPageInfo[],
  from: CanvasPageInfo[],
  to: CanvasPageInfo[],
): CanvasPageInfo[] {
  let next = current.map((page) => ({ ...page }))
  for (const page of from) {
    const target = to.find((candidate) => candidate.id === page.id)
    const existing = next.find((candidate) => candidate.id === page.id)
    if (!target) {
      if (existing && existing.name !== page.name) throw new Error('This page was renamed by a collaborator.')
      next = next.filter((candidate) => candidate.id !== page.id)
    } else if (target.name !== page.name || target.parentId !== page.parentId) {
      if (!existing) throw new Error('This page no longer exists.')
      if (target.name !== page.name) {
        if (existing.name !== page.name && existing.name !== target.name)
          throw new Error('This page was renamed by a collaborator.')
        existing.name = target.name
      }
      if (target.parentId !== page.parentId) {
        if (existing.parentId !== page.parentId && existing.parentId !== target.parentId)
          throw new Error('This page was moved by a collaborator.')
        setParent(existing, target.parentId)
      }
    }
  }
  for (const [index, page] of to.entries()) {
    if (from.some((candidate) => candidate.id === page.id)) continue
    const existing = next.find((candidate) => candidate.id === page.id)
    if (existing) {
      if (existing.name !== page.name || existing.parentId !== page.parentId)
        throw new Error('A different page already uses this ID.')
      continue
    }
    const following = to.slice(index + 1).find((candidate) => next.some((p) => p.id === candidate.id))
    const previous = to
      .slice(0, index)
      .reverse()
      .find((candidate) => next.some((p) => p.id === candidate.id))
    const position = following
      ? next.findIndex((p) => p.id === following.id)
      : previous
        ? next.findIndex((p) => p.id === previous.id) + 1
        : next.length
    next.splice(position, 0, { ...page })
  }
  const sharedIds = new Set(
    from.filter((page) => to.some((p) => p.id === page.id) && next.some((p) => p.id === page.id)).map((p) => p.id),
  )
  const originalOrder = from.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
  const targetOrder = to.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
  if (originalOrder.some((id, i) => id !== targetOrder[i])) {
    const currentOrder = next.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
    if (
      JSON.stringify(currentOrder) !== JSON.stringify(originalOrder) &&
      JSON.stringify(currentOrder) !== JSON.stringify(targetOrder)
    )
      throw new Error('Page order changed. Please try again.')
    const ordered = targetOrder.map((id) => next.find((p) => p.id === id)!)
    let index = 0
    next = next.map((page) => (sharedIds.has(page.id) ? ordered[index++]! : page))
  }
  for (const page of to) {
    const parent = page.parentId
    if (from.some((candidate) => candidate.id === page.id && candidate.parentId === parent)) continue
    if (parent !== undefined && !next.some((candidate) => candidate.id === parent))
      throw new Error('The page you moved this into no longer exists.')
  }
  return normalizePageTree(next)
}

function setParent(page: CanvasPageInfo, parentId: string | undefined) {
  if (parentId === undefined) delete page.parentId
  else page.parentId = parentId
}
