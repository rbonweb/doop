import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { nanoid } from 'nanoid'
import {
  MAX_PAGE_DEPTH,
  addPage,
  canNestPage,
  canvasPages,
  framePageId,
  movePage,
  pageAncestors,
  pageDepth,
  pageDescendants,
  pageTree,
  removePage,
  samePages,
  type PageNode,
} from '../../shared/pages'
import type { CanvasPageInfo } from '../../shared/types'
import { useStore } from '../lib/store'
import { downloadDeckPdf } from '../lib/deckExport'
import { deckOf } from '../../shared/slides'
import { savePages, moveFramesToPage } from '../lib/pageEdits'
import { loadCollapsedPages, saveCollapsedPages } from '../lib/pageCollapse'
import { ApiError } from '../lib/api'
import { Button } from './ui/button'
import { ChevronRightIcon, PlusIcon } from './ui/icons'
import { cn } from '../lib/utils'
import { MenuHint } from './ui/menu'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from './ui/context-menu'

/** Horizontal step per nesting level, in px. */
const INDENT = 14
/** Width of the chevron gutter that appears once any page has subpages, in px. */
const GUTTER = 16

interface Row {
  page: CanvasPageInfo
  depth: number
  /** direct subpages */
  childCount: number
  collapsed: boolean
}

interface Drop {
  placement: Parameters<typeof movePage>[2]
  next: CanvasPageInfo[]
  targetId: string
  /** the row the insertion line is drawn on, and whether on its bottom edge */
  lineRowId: string
  lineAfter: boolean
  lineDepth: number
  into: boolean
}

/** Rows in display order: a collapsed page hides its whole subtree. */
function visibleRows(nodes: PageNode[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  const visit = (node: PageNode) => {
    const isCollapsed = node.children.length > 0 && collapsed.has(node.page.id)
    rows.push({ page: node.page, depth: node.depth, childCount: node.children.length, collapsed: isCollapsed })
    if (!isCollapsed) node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return rows
}

/** Names for a native <option>, which cannot indent with CSS. */
function indentedName(pages: CanvasPageInfo[], page: CanvasPageInfo) {
  return `${'— '.repeat(Math.max(pageDepth(pages, page.id) - 1, 0))}${page.name}`
}

export function PagesPanel({ fill = false }: { fill?: boolean }) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  const canvasId = canvas?.id
  /* how many slides a page's deck has: the page menu offers the PDF only when there are some */
  const slideCount = (pageId: string) =>
    canvas ? deckOf(canvas.frames.filter((f) => framePageId(canvas, f) === pageId)).length : 0
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null)
  const [fold, setFold] = useState(() => ({
    canvasId,
    ids: canvasId ? loadCollapsedPages(canvasId) : new Set<string>(),
  }))
  if (fold.canvasId !== canvasId) setFold({ canvasId, ids: canvasId ? loadCollapsedPages(canvasId) : new Set() })
  const didDrag = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  if (!canvas) return null
  const pages = canvasPages(canvas)
  const tree = pageTree(pages)
  const rows = visibleRows(tree, fold.ids)
  const nested = pages.some((page) => page.parentId !== undefined)
  const activeAncestors = new Set(pageAncestors(pages, activePageId ?? '').map((page) => page.id))
  const dragged = drag ? new Set([drag.id, ...pageDescendants(pages, drag.id).map((page) => page.id)]) : null

  function setCollapsed(id: string, collapsed: boolean) {
    if (!canvas || fold.ids.has(id) === collapsed) return
    const ids = new Set(fold.ids)
    if (collapsed) ids.add(id)
    else ids.delete(id)
    saveCollapsedPages(canvas.id, ids)
    setFold({ canvasId: canvas.id, ids })
  }

  async function save(next: CanvasPageInfo[], selectId?: string, rename?: string) {
    if (!canvas || busy) return
    setBusy(true)
    try {
      await savePages(canvas, next, selectId)
      if (useStore.getState().canvas?.id !== canvas.id) return
      const created = rename ? next.find((page) => page.id === rename) : undefined
      setRenaming(created?.id ?? null)
      if (created) setName(created.name)
    } catch (error) {
      if (useStore.getState().canvas?.id !== canvas.id) return
      useStore
        .getState()
        .pushNotice(
          error instanceof ApiError && typeof error.body.error === 'string' ? error.body.error : 'Could not save pages',
        )
    } finally {
      setBusy(false)
    }
  }

  function addSubpage(parent: CanvasPageInfo) {
    const page = { id: nanoid(10), name: `Page ${pages.length + 1}` }
    setCollapsed(parent.id, false)
    void save(addPage(pages, page, parent.id), page.id, page.id)
  }

  function nestPage(id: string, placement: Parameters<typeof movePage>[2]) {
    const next = movePage(pages, id, placement)
    if (!next || samePages(next, pages)) return
    if (placement.type === 'into') setCollapsed(placement.targetId, false)
    void save(next)
  }

  function dropFor(id: string, targetId: string, fraction: number): Drop | null {
    if (targetId === id) return null
    const zone = fraction < 1 / 3 ? 'before' : fraction > 2 / 3 ? 'after' : 'into'
    const placement = { type: zone, targetId } as const
    const next = movePage(pages, id, placement)
    if (!next || samePages(next, pages)) return null
    const index = rows.findIndex((row) => row.page.id === targetId)
    const target = rows[index]
    if (!target) return null
    /* An insertion after a parent that shows its subpages belongs below the last of them. */
    let last = index
    while (zone === 'after' && rows[last + 1] && rows[last + 1]!.depth > target.depth) last++
    return {
      placement,
      next,
      targetId,
      lineRowId: rows[last]!.page.id,
      lineAfter: zone === 'after',
      lineDepth: target.depth,
      into: zone === 'into',
    }
  }

  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (busy || e.button !== 0 || e.detail > 1) return
    stopDrag.current?.()
    const startY = e.clientY
    const startX = e.clientX
    const pointerId = e.pointerId
    const controller = new AbortController()
    let moving = false
    let drop: Drop | null = null
    const cleanup = () => {
      controller.abort()
      stopDrag.current = null
      setDrag(null)
    }
    stopDrag.current = cleanup
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!moving && Math.abs(event.clientY - startY) + Math.abs(event.clientX - startX) < 4) return
      moving = true
      didDrag.current = true
      event.preventDefault()
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-page-id]')
      const targetId = row?.dataset.pageId
      if (targetId && row) {
        const box = row.getBoundingClientRect()
        drop = dropFor(id, targetId, (event.clientY - box.y) / box.height)
      } else drop = null
      setDrag({ id, drop })
    }
    window.addEventListener('pointermove', move, { signal: controller.signal, passive: false })
    window.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== pointerId) return
        cleanup()
        if (!moving || !drop) return
        if (drop.placement.type === 'into') setCollapsed(drop.placement.targetId, false)
        void save(drop.next)
      },
      { signal: controller.signal },
    )
    window.addEventListener('pointercancel', cleanup, { signal: controller.signal })
  }

  /* Tree keyboard model: up/down walk the visible rows, right opens or enters a
     parent, left closes it or climbs to its parent, Enter (the button's own
     click) opens the page. */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-page-id]')
    if (!current || !(e.target as HTMLElement).matches('button[data-page-name]')) return
    const index = rows.findIndex((row) => row.page.id === current.dataset.pageId)
    const row = rows[index]
    if (!row) return
    const focusRow = (id: string | undefined) => {
      if (!id) return
      e.currentTarget.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"] button[data-page-name]`)?.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]?.page.id)
        break
      case 'ArrowUp':
        focusRow(rows[index - 1]?.page.id)
        break
      case 'Home':
        focusRow(rows[0]?.page.id)
        break
      case 'End':
        focusRow(rows[rows.length - 1]?.page.id)
        break
      case 'ArrowRight':
        if (row.collapsed) setCollapsed(row.page.id, false)
        else if (row.childCount) focusRow(rows[index + 1]?.page.id)
        break
      case 'ArrowLeft':
        if (row.childCount && !row.collapsed) setCollapsed(row.page.id, true)
        else focusRow(row.page.parentId)
        break
      default:
        return
    }
    e.preventDefault()
  }

  async function moveSelection(pageId: string) {
    if (!canvas || busy) return
    setBusy(true)
    try {
      await moveFramesToPage(canvas, selectedIds, pageId)
    } catch {
      if (useStore.getState().canvas?.id !== canvas.id) return
      useStore.getState().pushNotice('Could not move all selected frames. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn('overflow-y-auto px-3 py-2', fill ? 'min-h-0 flex-1' : 'max-h-[35vh] border-b border-line-soft')}
    >
      <div className="flex items-center justify-between py-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        <span data-slot="page-section-heading">Pages</span>
        <Button
          variant="bare"
          size="icon-sm"
          className="size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink"
          aria-label="Add page"
          disabled={busy}
          onClick={() => {
            const page = { id: nanoid(10), name: `Page ${pages.length + 1}` }
            void save([...pages, page], page.id)
          }}
        >
          <PlusIcon width={12} height={12} />
        </Button>
      </div>
      <div role="tree" aria-label="Pages" onKeyDown={onKeyDown}>
        {rows.map(({ page, depth, childCount, collapsed }) => {
          const active = page.id === activePageId
          const holdsActive = collapsed && activeAncestors.has(page.id)
          const dropHere = drag?.drop
          const lineHere = dropHere?.lineRowId === page.id ? dropHere : null
          const moveTargets = pages.filter(
            (target) => target.id !== page.parentId && canNestPage(pages, page.id, target.id),
          )
          const atMaxDepth = depth >= MAX_PAGE_DEPTH
          return (
            <ContextMenu key={page.id}>
              <ContextMenuTrigger asChild>
                <div
                  data-page-id={page.id}
                  role="treeitem"
                  aria-level={depth}
                  aria-selected={active}
                  aria-expanded={childCount ? !collapsed : undefined}
                  style={{ paddingLeft: (depth - 1) * INDENT }}
                  onContextMenu={() => useStore.getState().setActivePage(page.id)}
                  className={cn(
                    'group relative flex h-[26px] items-center gap-0.5 rounded-md text-[12.5px] text-ink hover:bg-paper-deep',
                    holdsActive && 'bg-brand/10 shadow-[inset_2px_0_0_var(--brand)] hover:bg-brand/15',
                    active && 'bg-brand text-white hover:bg-brand',
                    dragged?.has(page.id) && 'opacity-40',
                    dropHere?.into && dropHere.targetId === page.id && 'bg-brand/15 ring-1 ring-inset ring-brand',
                  )}
                >
                  {lineHere && (
                    <div
                      className={cn(
                        'pointer-events-none absolute right-0 h-0.5 rounded-full bg-brand',
                        lineHere.lineAfter ? 'bottom-0' : 'top-0',
                      )}
                      style={{ left: (lineHere.lineDepth - 1) * INDENT }}
                    />
                  )}
                  {nested && (
                    <span className="flex shrink-0 items-center justify-center" style={{ width: GUTTER }}>
                      {childCount > 0 && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${page.name}`}
                          aria-expanded={!collapsed}
                          className={cn(
                            'flex size-4 items-center justify-center rounded-[4px] text-ink-soft hover:text-ink',
                            active && 'text-white/80 hover:text-white',
                          )}
                          onClick={() => setCollapsed(page.id, !collapsed)}
                        >
                          <ChevronRightIcon
                            width={11}
                            height={11}
                            className={cn('transition-transform duration-150', !collapsed && 'rotate-90')}
                          />
                        </button>
                      )}
                    </span>
                  )}
                  {renaming === page.id ? (
                    <form
                      className="min-w-0 flex-1"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (name.trim())
                          void save(pages.map((p) => (p.id === page.id ? { ...p, name: name.trim() } : p)))
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Page name"
                        maxLength={100}
                        disabled={busy}
                        onFocus={(e) => e.target.select()}
                        className="w-full rounded border border-line bg-paper px-2 py-1 text-xs text-ink"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      data-page-name=""
                      className={`min-w-0 flex-1 touch-none select-none truncate py-1.5 pr-2 text-left text-[12.5px] ${nested ? 'pl-1' : 'pl-2'} ${drag ? 'cursor-grabbing' : 'cursor-grab'} ${active || holdsActive ? 'font-semibold' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onPointerDown={(e) => {
                        didDrag.current = false
                        startDrag(e, page.id)
                      }}
                      onClick={(e) => {
                        if (didDrag.current) {
                          e.preventDefault()
                          return
                        }
                        useStore.getState().setActivePage(page.id)
                      }}
                      onDoubleClick={() => {
                        if (busy || didDrag.current) return
                        setRenaming(page.id)
                        setName(page.name)
                      }}
                    >
                      {page.name}
                    </button>
                  )}
                  {collapsed && renaming !== page.id && (
                    <span
                      className={cn(
                        'mr-2 shrink-0 font-mono text-[10px] tabular-nums text-ink-faint',
                        active && 'text-white/80',
                      )}
                      title={`${pageDescendants(pages, page.id).length} hidden subpages`}
                    >
                      {pageDescendants(pages, page.id).length}
                    </span>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={(e) => {
                  if (renaming) e.preventDefault()
                }}
              >
                <ContextMenuItem
                  disabled={busy}
                  onSelect={() => {
                    setRenaming(page.id)
                    setName(page.name)
                  }}
                >
                  Rename
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={busy || atMaxDepth}
                  title={atMaxDepth ? `Pages can only be nested ${MAX_PAGE_DEPTH} levels deep.` : undefined}
                  onSelect={() => addSubpage(page)}
                >
                  New subpage
                  {atMaxDepth && <MenuHint>Too deep</MenuHint>}
                </ContextMenuItem>
                {page.parentId !== undefined && (
                  <ContextMenuItem disabled={busy} onSelect={() => nestPage(page.id, { type: 'top' })}>
                    Move to top level
                  </ContextMenuItem>
                )}
                {moveTargets.length > 0 && (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={busy}>Move into…</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {moveTargets.map((target) => (
                        <ContextMenuItem
                          key={target.id}
                          onSelect={() => nestPage(page.id, { type: 'into', targetId: target.id })}
                        >
                          <span className="truncate">{indentedName(pages, target)}</span>
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                )}
                {slideCount(page.id) > 0 && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() => void downloadDeckPdf(canvasId!, page.id, page.name, slideCount(page.id))}
                    >
                      Export deck as PDF
                      <MenuHint>{slideCount(page.id)} slides</MenuHint>
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                  tone="danger"
                  disabled={busy || pages.length === 1}
                  onSelect={() => void save(removePage(pages, page.id))}
                >
                  Delete page
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      {selectedIds.length > 0 && pages.length > 1 && (
        <select
          aria-label="Move selected frames to page"
          className="mt-2 w-full rounded border border-line bg-paper p-1 text-xs"
          value=""
          disabled={busy}
          onChange={(e) => void moveSelection(e.target.value)}
        >
          <option value="" disabled>
            Move selection to page…
          </option>
          {pages
            .filter((p) => p.id !== activePageId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {indentedName(pages, p)}
              </option>
            ))}
        </select>
      )}
    </div>
  )
}
