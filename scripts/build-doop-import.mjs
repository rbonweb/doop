/* Bundles packages/doop-import/src/bin.ts, with the shared Storybook capture code it reuses, into packages/doop-import/dist/cli.mjs.
   puppeteer-core stays external (it is the package's one dependency); everything else, zod included, is inlined. The app's own build does not run this. */
import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const outfile = `${root}packages/doop-import/dist/cli.mjs`

await build({
  entryPoints: [`${root}packages/doop-import/src/bin.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['puppeteer-core'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'info',
})
await chmod(outfile, 0o755)
