import type { ComponentDef } from '../../shared/components'
import { t } from './i18n'
import { getLocale } from './i18n/locale'
import { saveBlob } from './frameExport'
import { getReactExportSettings, type ReactStyling } from './reactExportSettings'
import { useStore } from './store'

/** The body `POST /api/canvases/:id/export/react` takes: what to export (frames, a page, components; the server joins them) and how. */
export interface ReactExportBody {
  frameIds?: string[]
  pageId?: string
  componentIds?: string[]
  styling?: ReactStyling
  tokens?: boolean
  format?: 'zip' | 'json'
}

export interface ReactExportFile {
  path: string
  content: string
}

/** What the export left out or changed, as the server reports it (the same shape as `export-report.json` in the zip). */
export interface ReactExportReport {
  styling: ReactStyling
  components: { id: string; name: string; file?: string; importedFrom?: string; exportName?: string }[]
  pages: { frameId: string; name: string; file: string }[]
  issues: { kind: string; detail: string; path?: string; file: string }[]
  inlined: { file: string; component: string; reason: string }[]
}

export interface ReactFilesResult {
  files: ReactExportFile[]
  report: ReactExportReport
}

/** A refused or failed export; `message` is fit to show to the person. */
export class ReactExportError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ReactExportError'
    this.status = status
  }
}

/* The server renders and zips in one request; past this it is stuck and the dialog must not spin forever. */
const REACT_EXPORT_TIMEOUT_MS = 2 * 60_000

/** The header an answer may carry with the number of things the export dropped, so the dialog can say so without opening the zip. */
export const ISSUE_COUNT_HEADER = 'X-Doop-Export-Issues'

const exportUrl = (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/export/react`

async function failureOf(res: Response): Promise<ReactExportError> {
  if (res.status === 413) return new ReactExportError(t('reactExport.tooLarge'), 413)
  if (res.status === 429) return new ReactExportError(t('reactExport.rateLimited'), 429)
  const body: unknown = await res.json().catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  return new ReactExportError(typeof error === 'string' && error ? error : t('reactExport.failed'), res.status)
}

async function post(canvasId: string, body: ReactExportBody): Promise<Response> {
  let res: Response
  try {
    res = await fetch(exportUrl(canvasId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REACT_EXPORT_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw new ReactExportError(t('reactExport.timedOut'))
    throw new ReactExportError(t('reactExport.failed'))
  }
  if (!res.ok) throw await failureOf(res)
  return res
}

function fileNameOf(res: Response, fallback: string): string {
  const header = res.headers.get('Content-Disposition') ?? ''
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback
}

function issueCountOf(res: Response): number | null {
  const raw = res.headers.get(ISSUE_COUNT_HEADER)
  if (raw === null || raw.trim() === '') return null
  const count = Number(raw)
  return Number.isInteger(count) && count >= 0 ? count : null
}

export interface ReactZipResult {
  fileName: string
  /** how many things the export dropped, when the server says (null: read export-report.json in the zip) */
  issueCount: number | null
}

/** Ask for the zip and hand it to the browser, or the desktop shell's save panel. Throws a `ReactExportError`. */
export async function downloadReactZip(canvasId: string, body: ReactExportBody): Promise<ReactZipResult> {
  const res = await post(canvasId, { ...body, format: 'zip' })
  const blob = await res.blob()
  const fileName = fileNameOf(res, 'react-export.zip')
  try {
    saveBlob(blob, fileName)
  } catch {
    throw new ReactExportError(t('reactExport.failed'))
  }
  return { fileName, issueCount: issueCountOf(res) }
}

/** The export's files and report as data, for "Copy as React". Throws a `ReactExportError`. */
export async function fetchReactFiles(canvasId: string, body: ReactExportBody): Promise<ReactFilesResult> {
  const res = await post(canvasId, { ...body, format: 'json' })
  const data: unknown = await res.json().catch(() => null)
  const shaped = data as { files?: unknown; report?: unknown } | null
  if (!shaped || !Array.isArray(shaped.files) || typeof shaped.report !== 'object' || shaped.report === null) {
    throw new ReactExportError(t('reactExport.failed'), res.status)
  }
  return { files: shaped.files as ReactExportFile[], report: shaped.report as ReactExportReport }
}

/** The component's own .tsx among an export's files: the report names it, else the one under src/components. */
export function componentFile(
  result: ReactFilesResult,
  def: Pick<ComponentDef, 'id' | 'name'>,
): ReactExportFile | undefined {
  const file = result.report.components.find((entry) => entry.id === def.id)?.file
  const own = file ? result.files.find((candidate) => candidate.path === file) : undefined
  return own ?? result.files.find((candidate) => /^src\/components\/[^/]+\.tsx$/.test(candidate.path))
}

/** The relative files a copied .tsx imports (`./Card.module.css`, `./Button`, `../cx`), by the name they carry, in order and once each. Those are not on the clipboard. */
export function localImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/^\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"](\.{1,2}\/[^'"\n]+)['"]/gm)) {
    const name = match[1]?.split('/').pop()
    if (name && !found.includes(name)) found.push(name)
  }
  return found
}

type ExportRequest = { componentIds: string[] }
const exportRequests = new Set<(request: ExportRequest) => void>()

/** Ask the canvas page for the Export to React dialog, scoped to these components. The page listens while it is open. */
export function requestReactExport(componentIds: string[]): void {
  exportRequests.forEach((listener) => listener({ componentIds }))
}

export function onReactExportRequest(listener: (request: ExportRequest) => void): () => void {
  exportRequests.add(listener)
  return () => exportRequests.delete(listener)
}

/** "Card.module.css, Button and cx" */
function listNames(names: string[]): string {
  return new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(names)
}

/** "Copy as React": one component's .tsx on the clipboard, in the styling last picked, reporting through the canvas toast. */
export async function copyComponentAsReact(canvasId: string, def: Pick<ComponentDef, 'id' | 'name'>): Promise<void> {
  const { pushNotice } = useStore.getState()
  if (!('clipboard' in navigator) || typeof navigator.clipboard.writeText !== 'function') {
    pushNotice(t('reactExport.copyUnsupported'))
    return
  }
  pushNotice(t('reactExport.copying'), { busy: true })
  try {
    const { styling } = getReactExportSettings()
    const result = await fetchReactFiles(canvasId, { componentIds: [def.id], styling, tokens: false })
    const copied = componentFile(result, def)
    if (!copied) {
      const mapped = result.report.components.find((entry) => entry.id === def.id)
      pushNotice(
        mapped?.importedFrom
          ? t('reactExport.copyMapped', { name: def.name, from: mapped.importedFrom })
          : t('reactExport.copyNothing', { name: def.name }),
      )
      return
    }
    await navigator.clipboard.writeText(copied.content)
    /* the clipboard holds the component alone: say what it leans on that stayed behind */
    const imports = localImports(copied.content)
    if (imports.length === 0) {
      pushNotice(t('reactExport.copied', { name: def.name }))
      return
    }
    pushNotice(
      t('reactExport.copiedImports', { file: copied.path.split('/').pop() ?? def.name, files: listNames(imports) }),
      {
        action: { label: t('reactExport.copiedExport'), run: () => requestReactExport([def.id]) },
      },
    )
  } catch (err) {
    pushNotice(err instanceof ReactExportError ? err.message : t('reactExport.copyFailed', { name: def.name }))
  }
}
