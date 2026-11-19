import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { ComponentBundle } from '../../../shared/componentBundle.ts'
import { buildComponentBundle, type StoryPage } from '../../../shared/storybook/bundle.ts'
import type { StorybookIssue, StoryEntry } from '../../../shared/storybook/index.ts'
import {
  readStorybookIndex as readPageIndex,
  STORY_VIEWPORT,
  storyPageAdapter,
} from '../../../shared/storybook/page.ts'
import { STORYBOOK_LIMITS, storybookBasePath } from '../../../shared/storybook/plan.ts'
import { blockedRequest, isLoopbackHost } from './guard.ts'

/**
 * Renders a Storybook in a browser on this machine and builds the ComponentBundle with the same capture code the Doop server runs (shared/storybook). The Storybook is the team's own and runs here, so a local address is fine; what leaves the machine is the bundle, nothing else. Everything read from a page is plain data that the bundle schema validates again.
 */

/** The Storybook could not be read or is not reachable; the message says what to do. */
export class StorybookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorybookError'
  }
}

const SIGN_IN_HINT =
  'This Storybook asks for a sign-in, and doop-import sends no credentials. Run it against a local build (storybook build) or a dev server that needs no login.'

/** The stories of a Storybook: `index.json` (v4, v5), else the older `stories.json` (v3). */
export async function readStorybookIndex(
  base: URL,
  signal?: AbortSignal,
): Promise<{ entries: StoryEntry[]; issues: StorybookIssue[]; base: URL }> {
  return readPageIndex(base, {
    fetchUrl: (url, init) =>
      fetch(url, init).catch((cause: unknown) => {
        if (signal?.aborted) throw cause
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new StorybookError(`Could not reach ${url.origin}. Is the Storybook running? (${message})`)
      }),
    errors: {
      access: () => new StorybookError(SIGN_IN_HINT),
      index: (message) => new StorybookError(message),
    },
    notFoundMessage:
      'No Storybook index.json was found at that address. Point --storybook at a `storybook build` directory or a running Storybook.',
    tooLargeMessage: 'The story index is too large',
    signal,
  })
}

/** One story render's page: a fresh browser context (no cookies, nothing shared with another render), every step inside the render's deadline. */
async function openStoryPage(
  browser: Browser,
  origin: string,
  denied: (error: Error) => void,
  guardRequests: boolean,
): Promise<{ page: StoryPage; close: () => Promise<void> }> {
  const context = await browser.createBrowserContext()
  try {
    const raw: Page = await context.newPage()
    await raw.setViewport(STORY_VIEWPORT)
    if (guardRequests) {
      /* a Storybook on someone else's server must not reach this machine or its network: its own origin and the public internet only */
      await raw.setRequestInterception(true)
      raw.on('request', (request) => {
        void blockedRequest(request.url(), origin).then(
          (reason) => (reason ? request.abort('blockedbyclient') : request.continue()),
          () => request.abort('blockedbyclient'),
        )
      })
    }
    const page = storyPageAdapter(raw, {
      origin,
      errors: {
        access: () => new StorybookError(SIGN_IN_HINT),
        /* the CLI is running on the person's own machine: its own failures show what happened */
        render: (message, cause) => {
          const text = cause instanceof Error ? cause.message : message
          return cause === undefined ? new Error(text) : new Error(text, { cause })
        },
      },
      denied,
    })
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
  /** stop story pages reaching private and loopback addresses; by default on for a Storybook that is not on this machine */
  guardRequests?: boolean
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
    const guardRequests = options.guardRequests ?? !isLoopbackHost(index.base.hostname)
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
        const opened = await openStoryPage(live, index.base.origin, (error) => controller.abort(error), guardRequests)
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
