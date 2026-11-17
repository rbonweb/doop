import type { Page } from 'puppeteer-core'
import { storyState } from '../shared/storybook/capture.ts'
import { buildComponentBundle, type BundleResult, type StoryPage } from '../shared/storybook/bundle.ts'
import { parseStorybookIndex, type StoryEntry } from '../shared/storybook/index.ts'
import { STORYBOOK_LIMITS, storybookBasePath } from '../shared/storybook/plan.ts'
import { fetchPinnedPublicUrl, guardPublicPageRequests, parsePublicHttpUrl } from './publicUrl.ts'
import { openIsolatedPage } from './screenshot.ts'

/**
 * Storybook URL import: a published Storybook becomes a ComponentBundle (shared/componentBundle.ts). Its code is the customer's, so it runs only in the hardened renderer: an isolated browser context with no cookies or credentials, every request through the public-only pinned fetch (`guardPublicPageRequests`), at most STORYBOOK_LIMITS.concurrentImports imports at once. Everything read from the page is plain data that the bundle schema validates again; the server never evaluates it.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 DoopImporter/1.0'
const MAX_INDEX_BYTES = 10_000_000
const MAX_REDIRECTS = 3
const VIEWPORT = { width: 1280, height: 800 }
/** a story that rendered but would not capture gets this long past its render deadline */
const EVALUATE_GRACE_MS = 5000
const SIGN_IN_PATH =
  /(?:^|[/_-])(?:log-?in|sign-?in|sign-?on|sso|oauth2?|authorize|auth|session|account|saml)(?:$|[/_.-])/i

/** The Storybook is not public: it answered 401 or 403, or sent the visitor to a sign-in page. */
export class StorybookAccessError extends Error {
  constructor(
    message = 'This Storybook needs a sign-in, so Doop cannot import it. Publish it publicly, or run the Doop CLI on your machine.',
  ) {
    super(message)
    this.name = 'StorybookAccessError'
  }
}

/** The URL is not a Storybook, or its index could not be read. */
export class StorybookIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorybookIndexError'
  }
}

/** Too many imports are running; try again after `retryAfterSeconds`. */
export class StorybookBusyError extends Error {
  readonly retryAfterSeconds = 30
  constructor() {
    super(`Doop is already importing ${STORYBOOK_LIMITS.concurrentImports} Storybooks. Try again in about 30 seconds.`)
    this.name = 'StorybookBusyError'
  }
}

/** What a test swaps to reach a fake Storybook on this machine; the server never passes any of it. */
export interface StorybookImportDeps {
  fetchUrl?: typeof fetchPinnedPublicUrl
  parseUrl?: (raw: string) => URL
  guard?: Parameters<typeof guardPublicPageRequests>[1]
}

export interface StorybookImportOptions {
  /** the npm package the components are imported from in code, "@acme/ui" */
  package?: string
  /** only components whose Storybook title starts with one of these */
  include?: string[]
  signal?: AbortSignal
}

let running = 0

async function readBounded(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > max) throw new StorybookIndexError('The Storybook index is too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new StorybookIndexError('The Storybook index is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A redirect that leaves the Storybook's origin, or lands on a sign-in path, is a private Storybook. */
function assertStaysPublic(from: URL, to: URL): void {
  if (to.origin !== from.origin || (SIGN_IN_PATH.test(to.pathname) && !SIGN_IN_PATH.test(from.pathname))) {
    throw new StorybookAccessError()
  }
}

/** One JSON file of a Storybook, or undefined when it is not there. No cookies or credentials are sent. */
async function fetchJson(
  url: URL,
  deps: Required<Pick<StorybookImportDeps, 'fetchUrl' | 'parseUrl'>>,
  signal?: AbortSignal,
): Promise<unknown | undefined> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await deps.fetchUrl(current, {
      headers: { accept: 'application/json', 'user-agent': UA },
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw new StorybookAccessError()
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw new StorybookIndexError('The Storybook redirected without saying where')
      const next = deps.parseUrl(new URL(location, current).href)
      assertStaysPublic(url, next)
      current = next
      continue
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new StorybookIndexError(`The Storybook answered ${response.status}`)
    }
    const text = await readBounded(response, MAX_INDEX_BYTES)
    try {
      return JSON.parse(text)
    } catch {
      throw new StorybookIndexError('That address does not serve a Storybook story index (index.json)')
    }
  }
  throw new StorybookIndexError('The Storybook redirected too many times')
}

/** The stories of a published Storybook: `index.json` (v4, v5), else the older `stories.json` (v3). */
export async function fetchStorybookIndex(
  base: URL,
  deps: Required<Pick<StorybookImportDeps, 'fetchUrl' | 'parseUrl'>>,
  signal?: AbortSignal,
): Promise<{ entries: StoryEntry[]; issues: { code: string; message: string }[] }> {
  for (const file of ['index.json', 'stories.json']) {
    const json = await fetchJson(new URL(file, base), deps, signal)
    if (json === undefined) continue
    const parsed = parseStorybookIndex(json)
    if (!parsed.entries.length) {
      throw new StorybookIndexError(parsed.issues[0]?.message ?? 'The Storybook lists no stories')
    }
    return parsed
  }
  throw new StorybookIndexError('No Storybook index.json was found at that address')
}

/** One story render's page: a fresh isolated context, public-only network, every step inside the render's deadline. */
async function openStoryPage(
  origin: string,
  deps: StorybookImportDeps,
  denied: (error: StorybookAccessError) => void,
): Promise<{ page: StoryPage; close: () => Promise<void> }> {
  const isolated = await openIsolatedPage()
  try {
    const raw: Page = isolated.page
    await guardPublicPageRequests(raw, deps.guard)
    await raw.setViewport(VIEWPORT)
    await raw.setUserAgent(UA)
    const deadline = Date.now() + STORYBOOK_LIMITS.renderMs
    const left = () => Math.max(1000, deadline - Date.now())
    const bounded = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('The story took too long to render')), left() + EVALUATE_GRACE_MS).unref(),
        ),
      ])
    const page: StoryPage = {
      async goto(url, timeoutMs) {
        const response = await raw.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, left()) })
        const status = response?.status() ?? 0
        if (status === 401 || status === 403) {
          const error = new StorybookAccessError()
          denied(error)
          throw error
        }
        if (status >= 400) throw new Error(`Storybook answered ${status} for the story`)
        if (new URL(raw.url()).origin !== origin) {
          const error = new StorybookAccessError()
          denied(error)
          throw error
        }
      },
      async waitForState(timeoutMs) {
        await raw.waitForFunction(`(${storyState.toString()})() !== 'pending'`, {
          timeout: Math.min(timeoutMs, left()),
        })
        return (await bounded(raw.evaluate(storyState))) === 'error' ? 'error' : 'ready'
      },
      evaluate: (fn, arg) => bounded(raw.evaluate(fn as never, arg as never)) as never,
      evaluateSource: (source) => bounded(raw.evaluate(source)),
    }
    return { page, close: () => isolated.close() }
  } catch (error) {
    await isolated.close()
    throw error
  }
}

/** A published Storybook to a validated ComponentBundle and the issues found on the way. Refuses a private address, a 401 or 403, and a sign-in redirect; throws StorybookBusyError when the server's import slots are taken. */
export async function storybookBundle(
  rawUrl: string,
  options: StorybookImportOptions = {},
  deps: StorybookImportDeps = {},
): Promise<BundleResult> {
  const parseUrl = deps.parseUrl ?? parsePublicHttpUrl
  let url: URL
  try {
    url = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
  } catch (error) {
    throw new StorybookIndexError(error instanceof Error ? error.message : 'not a valid URL')
  }
  const base = new URL(url.href)
  base.pathname = storybookBasePath(base.pathname)
  base.search = ''
  base.hash = ''
  const fetchDeps = { fetchUrl: deps.fetchUrl ?? fetchPinnedPublicUrl, parseUrl }

  if (running >= STORYBOOK_LIMITS.concurrentImports) throw new StorybookBusyError()
  running++
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`The import took longer than ${STORYBOOK_LIMITS.importMs / 60_000} minutes`)),
    STORYBOOK_LIMITS.importMs + 30_000,
  )
  timer.unref()
  try {
    const index = await fetchStorybookIndex(base, fetchDeps, controller.signal)
    const result = await buildComponentBundle({
      entries: index.entries,
      source: { kind: 'storybook', url: base.href },
      baseUrl: base.href,
      package: options.package,
      include: options.include,
      signal: controller.signal,
      concurrency: 2,
      withPage: async (use) => {
        const opened = await openStoryPage(base.origin, deps, (error) => controller.abort(error))
        try {
          return await use(opened.page)
        } finally {
          await opened.close()
        }
      },
    })
    result.issues.unshift(...index.issues)
    return result
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof StorybookAccessError) {
      throw controller.signal.reason
    }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    running--
  }
}
