import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { ComponentBundle } from '../../../shared/componentBundle.ts'
import { buildComponentBundle, type StoryPage } from '../../../shared/storybook/bundle.ts'
import { parseStorybookIndex, type StoryEntry, type StorybookIssue } from '../../../shared/storybook/index.ts'
import { probeAttribute } from '../../../shared/storybook/probe.ts'
import { STORYBOOK_LIMITS, storybookBasePath } from '../../../shared/storybook/plan.ts'

/**
 * Renders a Storybook in a browser on this machine and builds the ComponentBundle with the same capture code the Doop server runs (shared/storybook). The Storybook is the team's own and runs here, so a local address is fine; what leaves the machine is the bundle, nothing else. Everything read from a page is plain data that the bundle schema validates again.
 */

const MAX_INDEX_BYTES = 10_000_000
const MAX_REDIRECTS = 3
const VIEWPORT = { width: 1280, height: 800 }
/** an evaluate in the last moments of a render still gets this long, so a render stays within its limit by at most a second */
const MIN_STEP_MS = 1000
const SIGN_IN_PATH =
  /(?:^|[/_-])(?:log-?in|sign-?in|sign-?on|sso|oauth2?|authorize|auth|session|account|saml)(?:$|[/_.-])/i

/** The Storybook could not be read or is not reachable; the message says what to do. */
export class StorybookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorybookError'
  }
}

interface IsolatedRealm {
  evaluate(pageFunction: unknown, ...args: unknown[]): Promise<unknown>
  waitForFunction(
    pageFunction: string,
    options: { timeout: number; polling: number },
  ): Promise<{ jsonValue(): Promise<unknown> }>
}

const SIGN_IN_HINT =
  'This Storybook asks for a sign-in, and doop-import sends no credentials. Run it against a local build (storybook build) or a dev server that needs no login.'

async function readBounded(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get('content-length') || 0) > max)
    throw new StorybookError('The story index is too large')
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
      throw new StorybookError('The story index is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One JSON file of the Storybook, or undefined when it is not there. Redirects stay on the same address (http to https aside). */
async function fetchJson(url: URL, signal?: AbortSignal): Promise<{ json: unknown; url: URL } | undefined> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response
    try {
      response = await fetch(current, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new StorybookError(
        `Could not reach ${current.origin}. Is the Storybook running? (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw new StorybookError(SIGN_IN_HINT)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw new StorybookError('The Storybook redirected without saying where')
      const next = new URL(location, current)
      if (SIGN_IN_PATH.test(next.pathname) && !SIGN_IN_PATH.test(current.pathname))
        throw new StorybookError(SIGN_IN_HINT)
      const upgrade = current.protocol === 'http:' && next.protocol === 'https:' && current.hostname === next.hostname
      if (next.origin !== current.origin && !upgrade) {
        throw new StorybookError(`The Storybook redirects to another address (${next.origin}). Use that URL instead.`)
      }
      current = next
      continue
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new StorybookError(`The Storybook answered ${response.status}`)
    }
    const text = await readBounded(response, MAX_INDEX_BYTES)
    try {
      return { json: JSON.parse(text) as unknown, url: current }
    } catch {
      throw new StorybookError('That address does not serve a Storybook story index (index.json)')
    }
  }
  throw new StorybookError('The Storybook redirected too many times')
}

/** The stories of a Storybook: `index.json` (v4, v5), else the older `stories.json` (v3). */
export async function readStorybookIndex(
  base: URL,
  signal?: AbortSignal,
): Promise<{ entries: StoryEntry[]; issues: StorybookIssue[]; base: URL }> {
  for (const file of ['index.json', 'stories.json']) {
    const found = await fetchJson(new URL(file, base), signal)
    if (found === undefined) continue
    const parsed = parseStorybookIndex(found.json)
    if (!parsed.entries.length) {
      throw new StorybookError(parsed.issues[0]?.message ?? 'The Storybook lists no stories')
    }
    const landed = new URL(base.href)
    landed.protocol = found.url.protocol
    landed.host = found.url.host
    return { ...parsed, base: landed }
  }
  throw new StorybookError(
    'No Storybook index.json was found at that address. Point --storybook at a `storybook build` directory or a running Storybook.',
  )
}

/** One story render's page: a fresh browser context (no cookies, nothing shared with another render), every step inside the render's deadline. */
async function openStoryPage(
  browser: Browser,
  origin: string,
  denied: (error: StorybookError) => void,
): Promise<{ page: StoryPage; close: () => Promise<void> }> {
  const context = await browser.createBrowserContext()
  try {
    const raw: Page = await context.newPage()
    await raw.setViewport(VIEWPORT)
    const deadline = Date.now() + STORYBOOK_LIMITS.renderMs
    const left = () => Math.max(MIN_STEP_MS, deadline - Date.now())
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('The story took too long to render')), left())
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    /* the capture runs in an isolated world: it sees the DOM and CSSOM but none of the page's JavaScript, so page script cannot change what it measures or returns */
    /* `isolatedRealm` is in puppeteer-core's CDP frame but not in its public types (25.9); the CLI test fails if an upgrade drops it */
    const isolatedWorld = () => (raw.mainFrame() as unknown as { isolatedRealm(): IsolatedRealm }).isolatedRealm()
    const page: StoryPage = {
      installProbe: (source) => raw.evaluateOnNewDocument(source).then(() => undefined),
      async goto(url, timeoutMs) {
        const response = await raw.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, left()) })
        const status = response?.status() ?? 0
        if (status === 401 || status === 403) {
          const error = new StorybookError(SIGN_IN_HINT)
          denied(error)
          throw error
        }
        if (status >= 400) throw new Error(`Storybook answered ${status} for the story`)
        const landed = new URL(raw.url())
        if (SIGN_IN_PATH.test(landed.pathname) && !SIGN_IN_PATH.test(new URL(url).pathname)) {
          const error = new StorybookError(SIGN_IN_HINT)
          denied(error)
          throw error
        }
        if (landed.origin !== origin) {
          throw new Error(`Storybook redirected the story to another address (${landed.origin})`)
        }
      },
      async waitForState(probe, timeoutMs) {
        /* the probe leaves its verdict on the document element; the wait runs in the isolated world, where page script cannot touch it. `probe` is a random hex name we made, never page text */
        const handle = await isolatedWorld().waitForFunction(
          `document.documentElement.getAttribute(${JSON.stringify(probeAttribute(probe))}) || false`,
          { timeout: Math.min(timeoutMs, left()), polling: 100 },
        )
        return (await handle.jsonValue()) === 'error' ? 'error' : 'ready'
      },
      readMeta: (probe, storyId) =>
        bounded(raw.evaluate(`window[${JSON.stringify(probe)}].meta(${JSON.stringify(storyId)})`)),
      evaluate: async (fn, arg) => (await bounded(isolatedWorld().evaluate(fn as never, arg as never))) as never,
      evaluateSource: (source) => bounded(isolatedWorld().evaluate(source)),
    }
    return { page, close: () => context.close().catch(() => {}) }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}

export interface RenderOptions {
  /** the Storybook's address: a directory's local server, or the URL the person gave */
  url: URL
  /** the browser executable */
  browserPath: string
  package?: string
  include?: string[]
  signal?: AbortSignal
  /** the CLI is run as root in containers, where Chromium's sandbox cannot start */
  noSandbox?: boolean
  onProgress?: (done: number, total: number) => void
}

export interface RenderedStorybook {
  bundle: ComponentBundle
  issues: StorybookIssue[]
  renders: number
}

/** A Storybook to a validated ComponentBundle and the issues found on the way. Always closes the browser it started. */
export async function renderStorybook(options: RenderOptions): Promise<RenderedStorybook> {
  const base = new URL(options.url.href)
  base.pathname = storybookBasePath(base.pathname)
  base.search = ''
  base.hash = ''

  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`The import took longer than ${STORYBOOK_LIMITS.importMs / 60_000} minutes`)),
    STORYBOOK_LIMITS.importMs + 30_000,
  )
  timer.unref()

  let browser: Browser | undefined
  try {
    const index = await readStorybookIndex(base, controller.signal)
    browser = await puppeteer.launch({
      executablePath: options.browserPath,
      headless: true,
      args: [
        '--no-first-run',
        '--disable-extensions',
        '--hide-scrollbars',
        ...(options.noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ],
    })
    const live = browser
    const result = await buildComponentBundle({
      entries: index.entries,
      source: { kind: 'cli', url: index.base.href },
      baseUrl: index.base.href,
      package: options.package,
      include: options.include,
      signal: controller.signal,
      concurrency: 2,
      onProgress: options.onProgress,
      withPage: async (use) => {
        const opened = await openStoryPage(live, index.base.origin, (error) => controller.abort(error))
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
    if (controller.signal.aborted && controller.signal.reason instanceof StorybookError) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    await browser?.close().catch(() => {})
  }
}
