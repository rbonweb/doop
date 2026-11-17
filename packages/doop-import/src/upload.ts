import { gzipSync } from 'node:zlib'
import { MAX_BUNDLE_BYTES, type ComponentBundle } from '../../../shared/componentBundle.ts'

/** The bundle to the ticket: gzipped JSON, `PUT /import/<token>`. Nothing but the bundle is sent, and no cookie or credential. */

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export interface ImportResult {
  created: { name: string; id: string }[]
  updated: { name: string; id: string }[]
  unchanged: { name: string; id: string }[]
  skipped: { name: string; reason: string }[]
  tokens: { created: string[]; skipped: string[] }
  pageId: string | null
  issues: { component?: string; code: string; message: string }[]
  dry_run?: boolean
}

/** A ticket address: http or https, the token as the last path segment. A dry run adds `?dry_run=1`, which leaves the ticket usable. */
export function ticketUrl(raw: string, dryRun: boolean): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UploadError('--ticket is not a URL. Copy the whole upload URL from the Doop import picker.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UploadError('--ticket must be an http(s) URL')
  if (!/^\/(?:.*\/)?import\/[A-Za-z0-9_-]{16,}\/?$/.test(url.pathname)) {
    throw new UploadError('--ticket does not look like a Doop import ticket (…/import/<token>)')
  }
  if (dryRun) url.searchParams.set('dry_run', '1')
  return url
}

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

/** Whether sending the ticket here would cross a network in the clear. */
export function isInsecureTicket(url: URL): boolean {
  return url.protocol === 'http:' && !loopback(url.hostname)
}

/** Uploads `bundle` (already checked against the schema) and returns the importer's answer. */
export async function uploadBundle(
  bundle: ComponentBundle,
  ticket: URL,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ImportResult> {
  const json = Buffer.from(JSON.stringify(bundle), 'utf8')
  if (json.length > MAX_BUNDLE_BYTES) {
    throw new UploadError(
      `The bundle is ${(json.length / 1_000_000).toFixed(1)} MB; a ticket takes ${MAX_BUNDLE_BYTES / 1_000_000} MB. Use --include to import part of the Storybook.`,
    )
  }
  const body = gzipSync(json)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(ticket, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: new Uint8Array(body),
      /* the ticket is a secret in the URL: never follow it somewhere else */
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]),
    })
  } catch (error) {
    throw new UploadError(`Could not reach ${ticket.origin}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    answer = undefined
  }
  const record = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {}
  if (!response.ok) {
    const reason = typeof record.error === 'string' ? record.error : `the server answered ${response.status}`
    throw new UploadError(`Doop refused the upload: ${reason}`, response.status)
  }
  if (!Array.isArray(record.created)) throw new UploadError('Doop answered, but not with an import result')
  return record as unknown as ImportResult
}
