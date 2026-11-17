import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { BrowserNotFoundError, findBrowser } from './browser.ts'
import { isLoopbackHost } from './guard.ts'
import { renderStorybook, StorybookError } from './render.ts'
import { serveDirectory, type StaticServer } from './serve.ts'
import { ticketUrl, UploadError, uploadBundle, type ImportResult } from './upload.ts'

export const USAGE = `doop-import: import a React team's Storybook into a Doop canvas as components.

Usage
  npx doop-import --storybook <dir|url> --ticket <upload url> [options]

  --storybook <dir|url>   a \`storybook build\` directory (served on 127.0.0.1 while it runs) or the URL of a running Storybook
  --ticket <url>          the upload URL from Doop's import picker (or an agent's create_import_ticket)
  --package <name>        the npm package the components are imported from in code, for example @acme/ui
  --include <prefix>      only components whose Storybook title starts with this (repeat for several)
  --browser <path>        the Chrome, Chromium or Edge executable to render with
  --dry-run               render and check the bundle, and say what would change; nothing is written and the ticket stays usable
  --out <file>            also write the bundle JSON to this file (with no --ticket, only write it)
  -h, --help              show this text

The browser is --browser, else DOOP_IMPORT_BROWSER, else CHROME_PATH, else a Chromium or Edge found at its usual install path.
Only the rendered HTML and CSS is uploaded, never your source code.`

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  fetch?: typeof fetch
  /** stops the run: the browser and the local server are closed */
  signal?: AbortSignal
  /** whether this process may need Chromium's sandbox off (root in a container) */
  noSandbox?: boolean
}

/** A usage mistake: exit code 2 and the usage text. */
class UsageError extends Error {}

const defaultIo = (): Io => ({
  stdout: (text) => void process.stdout.write(text + '\n'),
  stderr: (text) => void process.stderr.write(text + '\n'),
  env: process.env,
  platform: process.platform,
  noSandbox: typeof process.getuid === 'function' && process.getuid() === 0,
})

interface Options {
  storybook: string
  ticket?: string
  package?: string
  include: string[]
  browser?: string
  dryRun: boolean
  out?: string
}

function parseOptions(argv: string[]): Options | 'help' {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        storybook: { type: 'string' },
        ticket: { type: 'string' },
        package: { type: 'string' },
        include: { type: 'string', multiple: true },
        browser: { type: 'string' },
        'dry-run': { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const v = parsed.values
  if (v.help) return 'help'
  if (!v.storybook) throw new UsageError('--storybook is required: a storybook-static directory or a Storybook URL')
  if (!v.ticket && !v.out) throw new UsageError('--ticket is required (or --out, to only write the bundle to a file)')
  if (v['dry-run'] && !v.ticket) throw new UsageError('--dry-run needs --ticket: the server does the dry run')
  return {
    storybook: v.storybook,
    ticket: v.ticket,
    package: v.package,
    include: v.include ?? [],
    browser: v.browser,
    dryRun: v['dry-run'] === true,
    out: v.out,
  }
}

/** The only addresses `--storybook` takes: a directory, or the URL of a dev server on this machine. A published Storybook is imported by Doop itself, from its own hardened renderer. */
export function checkStorybookUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`--storybook "${value}" is not a valid URL`)
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new StorybookError(
      `--storybook takes a storybook-static directory or a dev server on this machine (localhost, 127.0.0.1 or [::1]), not ${url.hostname}. Use the Storybook URL import in Doop (or import_storybook) for a published Storybook.`,
    )
  }
  return url
}

/** A directory to serve, or the URL of a local dev server to use as it is. */
async function storybookSource(value: string, io: Io): Promise<{ url: URL; server?: StaticServer; label: string }> {
  if (/^https?:\/\//i.test(value)) {
    const url = checkStorybookUrl(value)
    return { url, label: url.href }
  }
  const directory = path.resolve(value)
  const info = await stat(directory).catch(() => undefined)
  if (!info?.isDirectory()) {
    throw new UsageError(
      `--storybook "${value}" is not a directory. For a running Storybook give its full URL, for example http://localhost:6006.`,
    )
  }
  if (!(await stat(path.join(directory, 'iframe.html')).catch(() => undefined))?.isFile()) {
    throw new UsageError(
      `${directory} has no iframe.html, so it is not a Storybook build. Run \`storybook build\` first.`,
    )
  }
  const server = await serveDirectory(directory)
  io.stderr(`Serving ${directory} on ${server.origin}`)
  return { url: new URL(`${server.origin}/`), server, label: directory }
}

const list = (names: string[]) => names.join(', ')

/** The import result as plain lines. */
export function formatResult(result: ImportResult, dryRun: boolean): string[] {
  const lines: string[] = []
  const count = (title: string, names: string[]) => {
    if (names.length) lines.push(`${title} ${names.length}: ${list(names)}`)
  }
  count(
    dryRun ? 'Would create' : 'Created',
    result.created.map((item) => item.name),
  )
  count(
    dryRun ? 'Would update' : 'Updated',
    result.updated.map((item) => item.name),
  )
  count(
    dryRun ? 'Would leave unchanged' : 'Unchanged',
    result.unchanged.map((item) => item.name),
  )
  for (const item of result.skipped) lines.push(`Skipped ${item.name}: ${item.reason}`)
  if (result.tokens.created.length) lines.push(`Tokens created: ${list(result.tokens.created)}`)
  if (result.tokens.skipped.length)
    lines.push(`Tokens left alone (already on the canvas): ${list(result.tokens.skipped)}`)
  if (!lines.length) lines.push('Nothing to import.')
  for (const issue of result.issues) lines.push(`  ! ${issue.component ? `${issue.component}: ` : ''}${issue.message}`)
  return lines
}

/** Runs the CLI and returns its exit code: 0 done, 1 failed, 2 a usage mistake. */
export async function main(argv: string[], partial: Partial<Io> = {}): Promise<number> {
  const io: Io = { ...defaultIo(), ...partial }
  let server: StaticServer | undefined
  try {
    const options = parseOptions(argv)
    if (options === 'help') {
      io.stdout(USAGE)
      return 0
    }
    const ticket = options.ticket ? ticketUrl(options.ticket, options.dryRun) : undefined
    if (/^https?:\/\//i.test(options.storybook)) checkStorybookUrl(options.storybook)
    const browser = findBrowser({ flag: options.browser, env: io.env, platform: io.platform })
    io.stderr(`Browser: ${browser.path} (${browser.source})`)

    const source = await storybookSource(options.storybook, io)
    server = source.server
    io.stderr(`Rendering ${source.label}`)
    const rendered = await renderStorybook({
      url: source.url,
      browserPath: browser.path,
      package: options.package,
      include: options.include.length ? options.include : undefined,
      signal: io.signal,
      noSandbox: io.noSandbox,
      /* a static build has no reason to call other local ports; a dev server does (HMR, APIs) */
      guardRequests: source.server !== undefined,
      onProgress: (done, total) => io.stderr(`Captured ${done} of ${total} components`),
    })
    await server?.close()
    server = undefined

    const { bundle } = rendered
    io.stderr(`Built a bundle of ${bundle.components.length} components from ${rendered.renders} renders`)
    for (const issue of rendered.issues) {
      io.stderr(`  ! ${issue.component ? `${issue.component}: ` : ''}${issue.message}`)
    }
    if (options.out) {
      await writeFile(options.out, JSON.stringify(bundle, null, 2) + '\n')
      io.stderr(`Wrote ${options.out}`)
    }
    if (!ticket) return 0

    io.stderr(options.dryRun ? 'Checking the bundle with Doop (dry run)' : 'Uploading to Doop')
    const result = await uploadBundle(bundle, ticket, { fetch: io.fetch, signal: io.signal })
    for (const line of formatResult(result, options.dryRun)) io.stdout(line)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`doop-import: ${error.message}\n`)
      io.stderr(USAGE)
      return 2
    }
    if (io.signal?.aborted) {
      io.stderr('doop-import: stopped')
      return 1
    }
    const known =
      error instanceof UploadError || error instanceof StorybookError || error instanceof BrowserNotFoundError
    io.stderr(`doop-import: ${error instanceof Error ? error.message : String(error)}`)
    if (!known && error instanceof Error && error.stack && io.env.DOOP_IMPORT_DEBUG) io.stderr(error.stack)
    return 1
  } finally {
    await server?.close()
  }
}
