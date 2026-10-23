/* Which parent pages are folded in the Pages panel, remembered per canvas in this browser only. */
const storageKey = (canvasId: string) => `doop-pages-collapsed:${canvasId}`

export function loadCollapsedPages(canvasId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(canvasId)) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveCollapsedPages(canvasId: string, collapsed: ReadonlySet<string>) {
  try {
    if (collapsed.size) localStorage.setItem(storageKey(canvasId), JSON.stringify([...collapsed]))
    else localStorage.removeItem(storageKey(canvasId))
  } catch {
    /* storage unavailable (private mode, quota): the fold state just won't persist */
  }
}
