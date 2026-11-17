import type { Page } from 'puppeteer-core'
import {
  buildComponentBundle,
  KnownRenderError,
  type BundleResult,
  type PlannedComponent,
  type StoryPage,
} from '../shared/storybook/bundle.ts'
import { parseStorybookIndex, type StoryEntry } from '../shared/storybook/index.ts'
import { probeAttribute } from '../shared/storybook/probe.ts'
import { groupStories, STORYBOOK_LIMITS, storybookBasePath } from '../shared/storybook/plan.ts'
import { env } from './env.ts'
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
/** an evaluate in the last moments of a render still gets this long, so a render stays within its limit by at most a second */
const MIN_STEP_MS = 1000
const SIGN_IN_PATH =
  /(?:^|[/_-])(?:log-?in|sign-?in|sign-?on|sso|oauth2?|authorize|auth|session|account|saml)(?:$|[/_.-])/i

/** The Storybook is not public: it answered 401 or 403, or sent the visitor to a sign-in page. */
export class StorybookAccessError extends Error {
  constructor(
    message = 'This Storybook needs a sign-in, so Doop cannot import it. Publish it publicly, or run the Doop CLI on your machine.',
    /** raised by a story page, after rendering began: browser work was spent, so the import slot is not given back */
    readonly duringRender = false,
  ) {
    super(message)
    this.name = 'StorybookAccessError'
  }
}

/** The URL is not a Storybook, or its index could not be read. */
export class StorybookIndexError extends Error {
  constructor(
    message: string,
    /** a body was downloaded and read (up to 10 MB) before this failed: server work was spent, so the import slot is not given back */
    readonly readBody = false,
  ) {
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
  /** the Storybook may be on a private address (the operator turned DOOP_STORYBOOK_PRIVATE_HOSTS on): its own origin is reached directly, nothing else private is */
  privateHosts?: boolean
  /** sees the size of each answer that came back from the page, for tests */
  observe?: (event: { step: 'capture' | 'meta'; bytes: number }) => void
}

export interface StorybookImportOptions {
  /** the components the import will render, as soon as the index is read */
  onPlan?: (groups: PlannedComponent[]) => void
  /** after each render, with what is planned so far */
  onRender?: (event: { rendered: number; total: number; component: string }) => void
  /** the npm package the components are imported from in code, "@acme/ui" */
  package?: string
  /** only components whose Storybook title starts with one of these */
  include?: string[]
  signal?: AbortSignal
}

interface IsolatedRealm {
  evaluate(pageFunction: unknown, ...args: unknown[]): Promise<unknown>
  waitForFunction(
    pageFunction: string,
    options: { timeout: number; polling: number },
  ): Promise<{ jsonValue(): Promise<unknown> }>
}

/** What came back from the page, in characters: a string's length, else the JSON of what it was (a small refusal object, null). */
function answerSize(result: unknown): number {
  if (typeof result === 'string') return result.length
  try {
    return JSON.stringify(result)?.length ?? 0
  } catch {
    return 0
  }
}

/** An operator's own Storybook on a private network: plain http(s) addresses, no credentials in the URL. */
function anyHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed')
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed')
  return url
}

/** The dependencies an import runs with: what a test passed, else the public-only defaults, else (an operator's opt-in) private hosts for the Storybook's own origin. */
export function resolveDeps(deps: StorybookImportDeps = {}): StorybookImportDeps {
  if (!deps.privateHosts && !env.DOOP_STORYBOOK_PRIVATE_HOSTS) return deps
  return {
    ...deps,
    privateHosts: true,
    parseUrl: deps.parseUrl ?? anyHttpUrl,
    fetchUrl: deps.fetchUrl ?? ((raw, init) => fetch(raw as never, init as never)),
  }
}

/** The Storybook URL as an import would read it, or the reason it never could (a bare domain gets https). `private` is a host Doop will not reach. */
export function checkStorybookUrl(
  rawUrl: string,
  rawDeps: StorybookImportDeps = {},
): { ok: true; url: URL } | { ok: false; private: boolean; message: string } {
  try {
    const parse = resolveDeps(rawDeps).parseUrl ?? parsePublicHttpUrl
    return { ok: true, url: parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'not a valid URL'
    return { ok: false, private: /not reachable/.test(message), message }
  }
}

let running = 0

async function readBounded(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > max) throw new StorybookIndexError('The Storybook index is too large', true)
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
      throw new StorybookIndexError('The Storybook index is too large', true)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A redirect to a sign-in path means a private Storybook. One to another address is refused too, but as a redirect, not a sign-in; http to https on the same host is followed. */
function checkRedirect(from: URL, to: URL): void {
  if (SIGN_IN_PATH.test(to.pathname) && !SIGN_IN_PATH.test(from.pathname)) throw new StorybookAccessError()
  const upgrade = from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname
  if (to.origin !== from.origin && !upgrade) {
    throw new StorybookIndexError(`The Storybook redirects to another address (${to.origin}). Use that URL instead.`)
  }
}

/** One JSON file of a Storybook, or undefined when it is not there. No cookies or credentials are sent. */
async function fetchJson(
  url: URL,
  deps: Required<Pick<StorybookImportDeps, 'fetchUrl' | 'parseUrl'>>,
  signal?: AbortSignal,
): Promise<{ json: unknown; url: URL } | undefined> {
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
      checkRedirect(current, next)
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
      return { json: JSON.parse(text) as unknown, url: current }
    } catch {
      throw new StorybookIndexError('That address does not serve a Storybook story index (index.json)', true)
    }
  }
  throw new StorybookIndexError('The Storybook redirected too many times')
}

/** The stories of a published Storybook: `index.json` (v4, v5), else the older `stories.json` (v3). */
export async function fetchStorybookIndex(
  base: URL,
  deps: Required<Pick<StorybookImportDeps, 'fetchUrl' | 'parseUrl'>>,
  signal?: AbortSignal,
): Promise<{ entries: StoryEntry[]; issues: { code: string; message: string }[]; base: URL }> {
  for (const file of ['index.json', 'stories.json']) {
    const found = await fetchJson(new URL(file, base), deps, signal)
    if (found === undefined) continue
    const parsed = parseStorybookIndex(found.json)
    if (!parsed.entries.length) {
      throw new StorybookIndexError(parsed.issues[0]?.message ?? 'The Storybook lists no stories', true)
    }
    /* an http address that sent us to https: the stories load from there */
    const landed = new URL(base.href)
    landed.protocol = found.url.protocol
    landed.host = found.url.host
    return { ...parsed, base: landed }
  }
  throw new StorybookIndexError('No Storybook index.json was found at that address')
}

/** One story render's page: a fresh isolated context, public-only network, every step inside the render's deadline. */
async function openStoryPage(
  origin: string,
  deps: StorybookImportDeps,
  denied: (error: StorybookAccessError) => void,
): Promise<{ page: StoryPage; close: () => Promise<void> }> {
  /* background: an import never takes a slot an interactive render is waiting for */
  const isolated = await openIsolatedPage({ priority: 'background' })
  try {
    const raw: Page = isolated.page
    await guardPublicPageRequests(
      raw,
      deps.privateHosts
        ? { ...deps.guard, allowUrl: (url) => url.origin === origin || (deps.guard?.allowUrl?.(url) ?? false) }
        : deps.guard,
    )
    await raw.setViewport(VIEWPORT)
    await raw.setUserAgent(UA)
    const deadline = Date.now() + STORYBOOK_LIMITS.renderMs
    const left = () => Math.max(MIN_STEP_MS, deadline - Date.now())
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new KnownRenderError('The story took too long to render')), left())
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    /* the capture runs in an isolated world: it sees the DOM and CSSOM but none of the page's JavaScript, so page script cannot change what it measures or returns */
    /* `isolatedRealm` is in puppeteer-core's CDP frame but not in its public types (25.9, the pinned version); the browser test fails if an upgrade drops it */
    const isolatedWorld = () => (raw.mainFrame() as unknown as { isolatedRealm(): IsolatedRealm }).isolatedRealm()
    const page: StoryPage = {
      installProbe: (source) => raw.evaluateOnNewDocument(source).then(() => undefined),
      async goto(url, timeoutMs) {
        /* a navigation failure's own text can name internal hosts and ports: only a fixed line leaves */
        const response = await raw
          .goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, left()) })
          .catch(() => {
            throw new KnownRenderError('The story page could not be loaded in time')
          })
        const status = response?.status() ?? 0
        if (status === 401 || status === 403) {
          const error = new StorybookAccessError(undefined, true)
          denied(error)
          throw error
        }
        if (status >= 400) throw new KnownRenderError(`Storybook answered ${status} for the story`)
        const landed = new URL(raw.url())
        if (SIGN_IN_PATH.test(landed.pathname) && !SIGN_IN_PATH.test(new URL(url).pathname)) {
          const error = new StorybookAccessError(undefined, true)
          denied(error)
          throw error
        }
        if (landed.origin !== origin) {
          throw new KnownRenderError(`Storybook redirected the story to another address (${landed.origin})`)
        }
      },
      async waitForState(probe, timeoutMs) {
        /* the probe leaves its verdict on the document element; the wait itself runs in the isolated world, where page script cannot touch it. `probe` is a random hex name we made, never page text */
        const handle = await isolatedWorld()
          .waitForFunction(`document.documentElement.getAttribute(${JSON.stringify(probeAttribute(probe))}) || false`, {
            timeout: Math.min(timeoutMs, left()),
            polling: 100,
          })
          .catch(() => {
            throw new KnownRenderError('The story did not finish rendering in time')
          })
        return (await handle.jsonValue()) === 'error' ? 'error' : 'ready'
      },
      async readMeta(probe, storyId) {
        /* a plain Runtime.evaluate of an expression: it needs nothing from the page's builtins */
        const result = await bounded(raw.evaluate(`window[${JSON.stringify(probe)}].meta(${JSON.stringify(storyId)})`))
        deps.observe?.({ step: 'meta', bytes: answerSize(result) })
        return result
      },
      async evaluate(fn, arg) {
        const result = await bounded(isolatedWorld().evaluate(fn as never, arg as never))
        deps.observe?.({ step: 'capture', bytes: answerSize(result) })
        return result as never
      },
      evaluateSource: (source) => bounded(isolatedWorld().evaluate(source)),
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
  rawDeps: StorybookImportDeps = {},
): Promise<BundleResult> {
  const deps = resolveDeps(rawDeps)
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
  if (options.signal?.aborted) controller.abort(options.signal.reason)
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
      source: { kind: 'storybook', url: index.base.href },
      baseUrl: index.base.href,
      package: options.package,
      include: options.include,
      onPlan: options.onPlan,
      onRender: options.onRender,
      signal: controller.signal,
      concurrency: 2,
      withPage: async (use) => {
        const opened = await openStoryPage(index.base.origin, deps, (error) => controller.abort(error))
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

/** Imports of a Storybook one account may start in an hour. */
export const STORYBOOK_IMPORTS_PER_HOUR = 3
/** Plan-only dry runs (the index is read, nothing is rendered) one account may make in an hour. */
export const STORYBOOK_PLANS_PER_HOUR = 20

/** The account is over its hourly Storybook imports. */
export class StorybookRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    what = `You have started ${STORYBOOK_IMPORTS_PER_HOUR} Storybook imports in the last hour, the most Doop runs for one account`,
  ) {
    super(`${what}. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes, or run the Doop CLI on your machine.`)
    this.name = 'StorybookRateLimitError'
  }
}

/** A sliding hour per account: `take` counts one use and returns a function that gives it back. */
function hourlyLimit(max: number, what: string) {
  const starts = new Map<string, number[]>()
  return (account: string, now = Date.now()): (() => void) => {
    const recent = (starts.get(account) ?? []).filter((at) => now - at < 3_600_000)
    if (recent.length >= max) {
      starts.set(account, recent)
      throw new StorybookRateLimitError(Math.max(1, Math.ceil((recent[0]! + 3_600_000 - now) / 1000)), what)
    }
    recent.push(now)
    starts.set(account, recent)
    /* the map holds only accounts with a use in the last hour */
    if (starts.size > 5000) {
      for (const [key, list] of starts) if (list.every((at) => now - at >= 3_600_000)) starts.delete(key)
    }
    return () => {
      const list = starts.get(account)
      const index = list ? list.indexOf(now) : -1
      if (list && index !== -1) list.splice(index, 1)
    }
  }
}

/** Counts one import against `account`'s hour; throws StorybookRateLimitError when it is over. Returns a refund, for an import that failed before anything was rendered. */
export const takeStorybookImport = hourlyLimit(
  STORYBOOK_IMPORTS_PER_HOUR,
  `You have started ${STORYBOOK_IMPORTS_PER_HOUR} Storybook imports in the last hour, the most Doop runs for one account`,
)

/** Counts one plan-only dry run against `account`'s hour. */
export const takeStorybookPlan = hourlyLimit(
  STORYBOOK_PLANS_PER_HOUR,
  `You have previewed ${STORYBOOK_PLANS_PER_HOUR} Storybooks in the last hour, the most Doop reads for one account`,
)

/** What a dry run shows: the components the Storybook would bring in, from its index alone (no story is rendered, no browser is opened). */
export async function storybookPlan(
  rawUrl: string,
  options: Pick<StorybookImportOptions, 'include' | 'signal'> = {},
  rawDeps: StorybookImportDeps = {},
): Promise<{
  components: (PlannedComponent & { story: string })[]
  issues: { code: string; message: string }[]
  baseUrl: string
}> {
  const deps = resolveDeps(rawDeps)
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
  const index = await fetchStorybookIndex(
    base,
    { fetchUrl: deps.fetchUrl ?? fetchPinnedPublicUrl, parseUrl },
    options.signal,
  )
  const grouped = groupStories(index.entries, { include: options.include })
  return {
    components: grouped.groups.map((group) => ({
      name: group.name,
      group: group.title,
      stories: group.stories.length,
      renders: 1,
      story: group.defaultStory.id,
    })),
    issues: [...index.issues, ...grouped.issues],
    baseUrl: index.base.href,
  }
}
