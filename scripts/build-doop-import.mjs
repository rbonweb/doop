/* Bundles packages/doop-import/src/bin.ts, with the shared Storybook capture code it reuses, into one file: packages/doop-import/dist/cli.mjs, or `--out <file>`.
   puppeteer-core stays external (it is the package's one dependency); everything else, zod included, is inlined. The app's own build runs it through scripts/pack-doop-import.mjs. */
import { chmod } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Writes the bundle of `entry` to `outfile` (absolute paths). A file outside the repo cannot find puppeteer-core, so a test that runs it puts it under node_modules/.cache. */
export async function buildCli(
  outfile = `${root}packages/doop-import/dist/cli.mjs`,
  entry = `${root}packages/doop-import/src/bin.ts`,
) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['puppeteer-core'],
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    logLevel: 'warning',
  })
  await chmod(outfile, 0o755)
  return outfile
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--out')
  const file = await buildCli(at === -1 ? undefined : process.argv[at + 1])
  console.log(`built ${file}`)
}
