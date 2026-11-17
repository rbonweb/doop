import { ApiError, req } from './api'
import { getLocale } from './i18n/locale'
import { useStore } from './store'
import { canvasPages, IMPORTED_COMPONENTS_PAGE } from '../../shared/pages'

/** What the importer answers, for the dry run and the real run alike (contract: "Result"). */
export interface ImportResult {
  created: { name: string; id: string }[]
  updated: { name: string; id: string }[]
  unchanged: { name: string; id: string }[]
  skipped: { name: string; reason: string }[]
  tokens: { created: string[]; skipped: string[] }
  pageId: string | null
  issues: { component?: string; code: string; message: string; detail?: { from: string; to: string } }[]
}

export interface PlannedComponent {
  name: string
  group?: string
  stories: number
  renders: number
}

/** Why the server stopped a Storybook import (contract: "Storybook REST progress"). */
export type StorybookErrorCode = 'private' | 'unreachable' | 'too_many' | 'busy' | 'invalid' | 'needs_worker'

export type StorybookEvent =
  | { type: 'plan'; components: PlannedComponent[]; renders: number; total?: number; capped?: boolean }
  | { type: 'progress'; rendered: number; total: number; component?: string }
  | { type: 'result'; result: ImportResult; issues?: ImportResult['issues'] }
  | { type: 'error'; code: StorybookErrorCode; message: string }

export interface StorybookImportInput {
  url: string
  package?: string
  /** only components whose Storybook title is one of these or sits under one of them, matched up to a `/` (the server takes at most 60) */
  include?: string[]
  dryRun?: boolean
}

const ERROR_CODES: readonly string[] = ['private', 'unreachable', 'too_many', 'busy', 'invalid', 'needs_worker']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** One parsed line, or null for a shape this client does not know (a newer server may add events). */
export function parseStorybookEvent(line: string): StorybookEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.type === 'plan' && Array.isArray(value.components)) {
    return {
      type: 'plan',
      components: value.components.filter(isRecord).map((c) => ({
        name: String(c.name ?? ''),
        group: typeof c.group === 'string' ? c.group : undefined,
        stories: Number(c.stories) || 0,
        renders: Number(c.renders) || 0,
      })),
      renders: Number(value.renders) || 0,
      total: typeof value.total === 'number' ? value.total : undefined,
      capped: value.capped === true ? true : undefined,
    }
  }
  if (value.type === 'progress') {
    return {
      type: 'progress',
      rendered: Number(value.rendered) || 0,
      total: Number(value.total) || 0,
      component: typeof value.component === 'string' ? value.component : undefined,
    }
  }
  if (value.type === 'result' && isRecord(value.result)) {
    const result = value.result as Partial<ImportResult>
    return {
      type: 'result',
      result: {
        created: result.created ?? [],
        updated: result.updated ?? [],
        unchanged: result.unchanged ?? [],
        skipped: result.skipped ?? [],
        tokens: result.tokens ?? { created: [], skipped: [] },
        pageId: result.pageId ?? null,
        issues: result.issues ?? [],
      },
      issues: Array.isArray(value.issues) ? (value.issues as ImportResult['issues']) : undefined,
    }
  }
  if (value.type === 'error') {
    const code = String(value.code)
    return {
      type: 'error',
      code: (ERROR_CODES.includes(code) ? code : 'invalid') as StorybookErrorCode,
      message: String(value.message ?? ''),
    }
  }
  return null
}

/** A refusal before the stream starts: the status and body as everywhere, and the seconds a 429 says to wait. */
export class StorybookRequestError extends ApiError {
  retryAfterSeconds: number | null
  constructor(status: number, text: string, retryAfter: string | null) {
    super(status, text)
    const seconds = Number(retryAfter)
    this.retryAfterSeconds = retryAfter && Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }
}

/**
 * Runs a Storybook import and hands every NDJSON line to `onEvent` as it arrives.
 * Resolves with the last event (a result or an error); aborting `signal` closes the
 * request, which is what stops the import on the server. A refusal before streaming
 * starts is an `ApiError`, as everywhere else.
 */
export async function streamStorybookImport(
  canvasId: string,
  input: StorybookImportInput,
  signal: AbortSignal,
  onEvent: (event: StorybookEvent) => void,
): Promise<StorybookEvent | null> {
  const res = await fetch(`/api/canvases/${canvasId}/import/storybook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: input.url,
      package: input.package || undefined,
      include: input.include?.length ? input.include : undefined,
      dryRun: input.dryRun || undefined,
    }),
    signal,
  })
  if (!res.ok) throw new StorybookRequestError(res.status, await res.text(), res.headers.get('Retry-After'))
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let last: StorybookEvent | null = null
  const take = (line: string) => {
    if (!line.trim()) return
    const event = parseStorybookEvent(line)
    if (!event) return
    last = event
    onEvent(event)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    lines.forEach(take)
  }
  take(buffered + decoder.decode())
  return last
}

/** The answer of `POST /api/canvases/:id/component-import/ticket`. */
export interface ImportTicket {
  upload_url: string
  expires_at: string
  /** the CLI command; null when this Doop server cannot hand one out, with the reason in `command_unavailable` (curl still works) */
  command: string | null
  command_unavailable?: string
  curl: string
}

const mintTicket = (canvasId: string) =>
  req<ImportTicket>(`/api/canvases/${canvasId}/component-import/ticket`, { method: 'POST' })

/* one ticket per canvas is in flight or live at a time: a screen that mounts twice (StrictMode in development,
   a quick close and reopen) reuses it instead of spending another of the five an hour */
const tickets = new Map<string, Promise<ImportTicket>>()
const TICKET_MARGIN_MS = 5_000

/** A live ticket for the canvas: the one already minted or being minted, else a new one (`fresh` forces it). */
export function createImportTicket(
  canvasId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ImportTicket> {
  const held = tickets.get(canvasId)
  if (held && !fresh) {
    return held.then((ticket) =>
      Date.parse(ticket.expires_at) - Date.now() > TICKET_MARGIN_MS
        ? ticket
        : createImportTicket(canvasId, { fresh: true }),
    )
  }
  const next = mintTicket(canvasId)
  tickets.set(canvasId, next)
  next.catch(() => {
    if (tickets.get(canvasId) === next) tickets.delete(canvasId)
  })
  return next
}

/** Forgets the canvas's ticket: its command was used (a success consumes it), so the next opening mints anew. */
export function forgetImportTicket(canvasId: string): void {
  tickets.delete(canvasId)
}

/** The page the importer made, on the open canvas: the result's id, else the page by its name. */
export function importedPageId(canvasId: string, pageId?: string | null): string | null {
  const canvas = useStore.getState().canvas
  if (!canvas || canvas.id !== canvasId) return null
  const pages = canvasPages(canvas)
  return pages.find((p) => p.id === pageId)?.id ?? pages.find((p) => p.name === IMPORTED_COMPONENTS_PAGE)?.id ?? null
}

/** Shows the imported mains: switches to their page and opens the Components tab. */
export function openImportedComponents(canvasId: string, pageId?: string | null): void {
  const id = importedPageId(canvasId, pageId)
  const store = useStore.getState()
  if (id) store.setActivePage(id)
  store.setLayersTab('components')
}

/** "in 12 minutes", "in 40 seconds", from now to `at` (ms). */
export function relativeIn(at: number, now: number, locale: string = getLocale()): string {
  return relativeInSeconds(Math.max(0, Math.round((at - now) / 1000)), locale)
}

/** "in 12 minutes", "in 40 seconds": a wait of `seconds`. */
export function relativeInSeconds(seconds: number, locale: string = getLocale()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' })
  return seconds >= 60 ? format.format(Math.round(seconds / 60), 'minute') : format.format(seconds, 'second')
}

/** What a kind of import note is about, in the words the card uses for it. */
export type IssueGroupKey =
  'worker' | 'props' | 'noProps' | 'styles' | 'variants' | 'markup' | 'files' | 'unsafe' | 'limits' | 'other'

const ISSUE_GROUP: Record<string, IssueGroupKey> = {
  story_needs_worker: 'worker',
  argtypes_dropped: 'props',
  text_arg_ambiguous: 'props',
  unsafe_prop_value: 'unsafe',
  argtypes_unavailable: 'noProps',
  css_cross_origin: 'styles',
  css_import_dropped: 'styles',
  css_rules_dropped: 'styles',
  css_rules_oversize: 'styles',
  css_scan_capped: 'styles',
  shared_css_capped: 'styles',
  unsafe_css: 'styles',
  variant_css_at_rule: 'variants',
  variant_html_unsupported: 'variants',
  variants_not_diffable: 'variants',
  dropped_element: 'markup',
  multiple_roots: 'markup',
  too_deep: 'markup',
  too_large: 'markup',
  inline_data: 'files',
  unsafe_url: 'unsafe',
  unsafe_token: 'unsafe',
  components_capped: 'limits',
  renders_capped: 'limits',
  more_issues: 'limits',
}

export interface IssueGroup {
  key: IssueGroupKey
  items: { component?: string; message: string }[]
}

/** The import's notes grouped by what they are about, biggest first, each keeping its raw lines for the details. */
export function groupImportIssues(issues: ImportResult['issues']): IssueGroup[] {
  const groups = new Map<IssueGroupKey, IssueGroup>()
  for (const issue of issues) {
    const key = ISSUE_GROUP[issue.code] ?? 'other'
    const group = groups.get(key) ?? { key, items: [] }
    group.items.push({ component: issue.component, message: issue.message })
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length)
}
