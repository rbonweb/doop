import { createReadStream, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type express from 'express'
import { env } from './env.ts'

/**
 * The doop-import CLI, served by the instance itself (no npm): `bun run build` packs it as dist/cli/doop-import-<version>.tgz
 * (scripts/pack-doop-import.mjs) and `bun run dev` packs it once at start. Two public routes, no session:
 *   GET /cli/doop-import-<version>.tgz   the file, immutable
 *   GET /cli/doop-import.tgz             a 302 to the current versioned name, never cached
 * and nothing else under /cli/: the name is matched against the one file that is there, never joined into a path.
 */

/* next to server/ in the image and in the repo: dist/cli */
const CLI_DIRECTORY = fileURLToPath(new URL('../dist/cli/', import.meta.url))
const TARBALL = /^doop-import-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/

export interface CliTarball {
  version: string
  /** `doop-import-<version>.tgz` */
  name: string
  path: string
  bytes: number
}

/** The packed CLI this instance holds, or null when the build did not make one. */
export function currentCli(directory: string = CLI_DIRECTORY): CliTarball | null {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return null
  }
  /* the newest name that is a file: a directory or anything else with that name is not the CLI */
  for (const name of names
    .filter((candidate) => TARBALL.test(candidate))
    .sort()
    .reverse()) {
    const file = path.join(directory, name)
    try {
      const info = statSync(file)
      if (info.isFile()) return { version: TARBALL.exec(name)![1]!, name, path: file, bytes: info.size }
    } catch {
      /* gone since the listing */
    }
  }
  return null
}

/** The address `npx` installs the CLI from: this instance's own tarball. Without one (a build that skipped the pack step) the unversioned address, which answers 404 and says so. */
export function cliUrl(origin: string, directory?: string): string {
  const cli = currentCli(directory)
  return `${origin.replace(/\/+$/, '')}/cli/${cli ? cli.name : 'doop-import.tgz'}`
}

/** The one command everywhere (the ticket answer, the import picker, the agent guide). `--allow-remote=all` because npm 12 refuses to fetch a package from a URL unless told to (EALLOWREMOTE); older npm only warns that it does not know the flag. */
export function importCommand(uploadUrl: string, origin: string = env.BETTER_AUTH_URL, directory?: string): string {
  return `npx --yes --allow-remote=all ${cliUrl(origin, directory)} --storybook ./storybook-static --ticket ${uploadUrl}`
}

const NOT_FOUND = (res: express.Response) => res.status(404).type('text/plain').send('not found')

/** `GET /cli/:file` */
export function serveCli(
  req: express.Request,
  res: express.Response,
  directory?: string,
  origin: string = env.BETTER_AUTH_URL,
) {
  const cli = currentCli(directory)
  const file = req.params.file ?? ''
  if (!cli) return NOT_FOUND(res)
  if (file === 'doop-import.tgz') {
    res.set('Cache-Control', 'no-cache')
    return res.redirect(302, `${origin.replace(/\/+$/, '')}/cli/${cli.name}`)
  }
  if (file !== cli.name) return NOT_FOUND(res)
  res.set({
    'Content-Type': 'application/gzip',
    'Content-Length': String(cli.bytes),
    'Content-Disposition': `attachment; filename="${cli.name}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(cli.path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
