import type { Page } from 'puppeteer-core'
import type { StoryPage } from './bundle.ts'
import { parseStorybookIndex, type StoryEntry, type StorybookIssue } from './index.ts'
import { STORYBOOK_LIMITS } from './plan.ts'
import { probeAppliedAttribute, probeAttribute } from './probe.ts'

/** Pure: no node or server imports, since the CLI bundles it. The two things both importers do against a Storybook: read its story index without credentials or redirects off the address, and drive one story page in a fresh browser context inside the render's deadline. The callers keep their own error classes and wording; this file only says where and when to raise them. */

/** The largest index body read, in bytes. */
export const MAX_INDEX_BYTES = 10_000_000
/** Redirect hops followed while reading an index file. */
export const MAX_REDIRECTS = 3
/** The viewport a story page renders at. */
export const STORY_VIEWPORT = { width: 1280, height: 800 }
/** an evaluate in the last moments of a render still gets this long, so a render stays within its limit by at most a second */
export const MIN_STEP_MS = 1000
/** A path that means a sign-in wall, not a story. */
export const SIGN_IN_PATH =
  /(?:^|[/_-])(?:log-?in|sign-?in|sign-?on|sso|oauth2?|authorize|auth|session|account|saml)(?:$|[/_.-])/i

/** The caller's error classes: a sign-in wall, and an index problem, which may say a body was downloaded (server work was spent). */
export interface IndexErrors {
  access(): Error
  index(message: string, readBody: boolean): Error
}

/** What the page adapter raises: a sign-in wall, and a render failure, whose cause is the caller's to keep or drop. */
export interface StoryPageErrors {
  access(): Error
  render(message: string, cause?: unknown): Error
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

function joinChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function readBounded(
  response: Response,
  max: number,
  errors: IndexErrors,
  tooLargeMessage: string,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > max) throw errors.index(tooLargeMessage, true)
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
      throw errors.index(tooLargeMessage, true)
    }
    chunks.push(value)
  }
  return joinChunks(chunks)
}

/** A redirect to a sign-in path means a private Storybook. One to another address is refused too, but as a redirect, not a sign-in; http to https on the same host is followed. */
function checkRedirect(from: URL, to: URL, errors: IndexErrors): void {
  if (SIGN_IN_PATH.test(to.pathname) && !SIGN_IN_PATH.test(from.pathname)) throw errors.access()
  const upgrade = from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname
  if (to.origin !== from.origin && !upgrade) {
    throw errors.index(`The Storybook redirects to another address (${to.origin}). Use that URL instead.`, false)
  }
}

interface IndexOptions {
  fetchUrl: (url: URL, init: RequestInit) => Promise<Response>
  parseUrl?: (raw: string) => URL
  headers?: Record<string, string>
  errors: IndexErrors
  tooLargeMessage: string
  notFoundMessage: string
  signal?: AbortSignal
}

/** One JSON file of a Storybook, or undefined when it is not there. No cookies or credentials are sent. */
async function fetchJson(url: URL, options: IndexOptions): Promise<{ json: unknown; url: URL } | undefined> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await options.fetchUrl(current, {
      headers: { accept: 'application/json', ...options.headers },
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]),
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw options.errors.access()
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw options.errors.index('The Storybook redirected without saying where', false)
      const raw = new URL(location, current).href
      const next = options.parseUrl ? options.parseUrl(raw) : new URL(raw)
      checkRedirect(current, next, options.errors)
      current = next
      continue
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw options.errors.index(`The Storybook answered ${response.status}`, false)
    }
    const text = await readBounded(response, MAX_INDEX_BYTES, options.errors, options.tooLargeMessage)
    try {
      return { json: JSON.parse(text) as unknown, url: current }
    } catch {
      throw options.errors.index('That address does not serve a Storybook story index (index.json)', true)
    }
  }
  throw options.errors.index('The Storybook redirected too many times', false)
}

/** The stories of a published Storybook: `index.json` (v4, v5), else the older `stories.json` (v3). */
export async function readStorybookIndex(
  base: URL,
  options: IndexOptions,
): Promise<{ entries: StoryEntry[]; issues: StorybookIssue[]; base: URL }> {
  for (const file of ['index.json', 'stories.json']) {
    const found = await fetchJson(new URL(file, base), options)
    if (found === undefined) continue
    const parsed = parseStorybookIndex(found.json)
    if (!parsed.entries.length) {
      throw options.errors.index(parsed.issues[0]?.message ?? 'The Storybook lists no stories', true)
    }
    /* an http address that sent us to https: the stories load from there */
    const landed = new URL(base.href)
    landed.protocol = found.url.protocol
    landed.host = found.url.host
    return { ...parsed, base: landed }
  }
  throw options.errors.index(options.notFoundMessage, false)
}

/** One story render's page: every step inside the render's deadline, the capture in an isolated world. The deadline starts when the adapter is built. */
export function storyPageAdapter(
  raw: Page,
  options: {
    origin: string
    errors: StoryPageErrors
    /** tells the caller a sign-in wall ended the render (the server aborts the import); the error is thrown after */
    denied: (error: Error) => void
    /** sees the size of each answer that came back from the page, for tests */
    observe?: (event: { step: 'capture' | 'meta'; bytes: number }) => void
  },
): StoryPage {
  const deadline = Date.now() + STORYBOOK_LIMITS.renderMs
  const left = () => Math.max(MIN_STEP_MS, deadline - Date.now())
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(options.errors.render('The story took too long to render')), left())
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  /* the capture runs in an isolated world: it sees the DOM and CSSOM but none of the page's JavaScript, so page script cannot change what it measures or returns */
  /* `isolatedRealm` is in puppeteer-core's CDP frame but not in its public types (25.9, the pinned version); the browser test fails if an upgrade drops it */
  const isolatedWorld = () => (raw.mainFrame() as unknown as { isolatedRealm(): IsolatedRealm }).isolatedRealm()
  return {
    installProbe: (source) => raw.evaluateOnNewDocument(source).then(() => undefined),
    async goto(url, timeoutMs) {
      /* a navigation failure's own text can name internal hosts and ports: only a fixed line leaves */
      const response = await raw
        .goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, left()) })
        .catch((cause: unknown) => {
          throw options.errors.render('The story page could not be loaded in time', cause)
        })
      const status = response?.status() ?? 0
      if (status === 401 || status === 403) {
        const error = options.errors.access()
        options.denied(error)
        throw error
      }
      if (status >= 400) throw options.errors.render(`Storybook answered ${status} for the story`)
      const landed = new URL(raw.url())
      if (SIGN_IN_PATH.test(landed.pathname) && !SIGN_IN_PATH.test(new URL(url).pathname)) {
        const error = options.errors.access()
        options.denied(error)
        throw error
      }
      if (landed.origin !== options.origin) {
        throw options.errors.render(`Storybook redirected the story to another address (${landed.origin})`)
      }
    },
    async waitForState(probe, timeoutMs) {
      /* the probe leaves its verdict on the document element; the wait itself runs in the isolated world, where page script cannot touch it. `probe` is a random hex name we made, never page text */
      const handle = await isolatedWorld()
        .waitForFunction(`document.documentElement.getAttribute(${JSON.stringify(probeAttribute(probe))}) || false`, {
          timeout: Math.min(timeoutMs, left()),
          polling: 100,
        })
        .catch((cause: unknown) => {
          throw options.errors.render('The story did not finish rendering in time', cause)
        })
      const verdict = await handle.jsonValue()
      return verdict === 'error' || verdict === 'needs_worker' ? verdict : 'ready'
    },
    async applyArgs(probe, storyId, args) {
      /* both strings are ours: the random probe name, and the args as JSON text embedded as a string literal */
      await bounded(
        raw.evaluate(
          `window[${JSON.stringify(probe)}].applyArgs(${JSON.stringify(storyId)}, ${JSON.stringify(JSON.stringify(args))})`,
        ),
      )
      const handle = await isolatedWorld()
        .waitForFunction(
          `document.documentElement.getAttribute(${JSON.stringify(probeAppliedAttribute(probe))}) || false`,
          { timeout: Math.min(STORYBOOK_LIMITS.renderMs, left()), polling: 100 },
        )
        .catch((cause: unknown) => {
          throw options.errors.render('The story did not render again with those args in time', cause)
        })
      return (await handle.jsonValue()) === 'error' ? 'error' : 'ready'
    },
    async readMeta(probe, storyId) {
      /* a plain Runtime.evaluate of an expression: it needs nothing from the page's builtins */
      const result = await bounded(raw.evaluate(`window[${JSON.stringify(probe)}].meta(${JSON.stringify(storyId)})`))
      options.observe?.({ step: 'meta', bytes: answerSize(result) })
      return result
    },
    async evaluate(fn, arg) {
      const result = await bounded(isolatedWorld().evaluate(fn as never, arg as never))
      options.observe?.({ step: 'capture', bytes: answerSize(result) })
      return result as never
    },
    evaluateSource: (source) => bounded(isolatedWorld().evaluate(source)),
  }
}
