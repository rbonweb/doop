/* Builds the doop-import CLI and packs it as <out>/doop-import-<version>-<hash>.tgz (default dist/cli), the tarball every Doop instance serves at /cli/
   (server/cliDownload.ts) and `npx` installs. Not `npm pack`: the Docker build stage has no npm, and the tarball is three files.
   The hash is the first 12 hex digits of the tarball's sha256, so a changed byte anywhere in the CLI is a new file name and the immutable URL can never serve stale code.
   Deterministic: sorted entries, fixed times and owners, gzip with no timestamp, so the same sources give the same bytes.
   `--out <dir>` writes somewhere else (and `--package <dir>` packs another copy of the package); the bundle is built in a private work directory, so two runs never write the same file. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { buildCli } from './build-doop-import.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
/* `--package <dir>` packs another copy of the package (its package.json, README.md and src/bin.ts), for a test that changes a source byte; it must sit two levels under the repo root, as packages/doop-import does, for its imports of shared/ to resolve */
const source = `${flag('--package', `${root}packages/doop-import`).replace(/\/*$/, '/')}`
const outDir = flag('--out', `${root}dist/cli`).replace(/\/*$/, '/')
/* npm's own fixed time for packed files: 1985-10-26T08:15:00Z */
const MTIME = 499162500

/* inside the repo so the bundle's own imports resolve if anything runs it from here */
await mkdir(`${root}node_modules/.cache`, { recursive: true })
const work = await mkdtemp(`${root}node_modules/.cache/doop-import-pack-`)
try {
  const bundle = await buildCli(`${work}/cli.mjs`, `${source}src/bin.ts`)
  const manifest = JSON.parse(await readFile(`${source}package.json`, 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(manifest.version))
    throw new Error(`bad CLI version ${manifest.version}`)

  const files = [
    ['package/README.md', await readFile(`${source}README.md`), 0o644],
    ['package/dist/cli.mjs', await readFile(bundle), 0o755],
    ['package/package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644],
  ].sort(([a], [b]) => (a < b ? -1 : 1))

  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0'

  /** One ustar entry: a 512 byte header, the data, padding to a whole block. */
  const entry = (name, data, mode) => {
    const header = Buffer.alloc(512)
    if (Buffer.byteLength(name) > 100) throw new Error(`${name} is too long for a ustar header`)
    header.write(name, 0, 'utf8')
    header.write(octal(mode, 8), 100)
    header.write(octal(0, 8), 108)
    header.write(octal(0, 8), 116)
    header.write(octal(data.length, 12), 124)
    header.write(octal(MTIME, 12), 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  }

  const tar = Buffer.concat([...files.map(([name, data, mode]) => entry(name, data, mode)), Buffer.alloc(1024)])
  const tgz = gzipSync(tar, { level: 9 })
  const hash = createHash('sha256').update(tgz).digest('hex').slice(0, 12)
  await mkdir(outDir, { recursive: true })
  /* one CLI at a time: an older tarball must not linger beside the new one */
  for (const name of await readdir(outDir)) if (/^doop-import-.*\.tgz$/.test(name)) await rm(`${outDir}${name}`)
  const target = `${outDir}doop-import-${manifest.version}-${hash}.tgz`
  await writeFile(target, tgz)
  console.log(`packed ${target}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
