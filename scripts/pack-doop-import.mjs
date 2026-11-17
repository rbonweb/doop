/* Builds the doop-import CLI and packs it as dist/cli/doop-import-<version>.tgz, the tarball every Doop instance serves at /cli/ (server/cliDownload.ts)
   and `npx --yes <instance>/cli/doop-import-<version>.tgz` installs. Not `npm pack`: the Docker build stage has no npm, and the tarball is three files.
   Deterministic: sorted entries, fixed times and owners, gzip with no timestamp, so the same sources give the same bytes. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import './build-doop-import.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = `${root}packages/doop-import/`
const outDir = `${root}dist/cli/`
/* npm's own fixed time for packed files: 1985-10-26T08:15:00Z */
const MTIME = 499162500

const manifest = JSON.parse(await readFile(`${source}package.json`, 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
  throw new Error(`bad CLI version ${manifest.version}`)

const files = [
  ['package/README.md', await readFile(`${source}README.md`), 0o644],
  ['package/dist/cli.mjs', await readFile(`${source}dist/cli.mjs`), 0o755],
  ['package/package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644],
].sort(([a], [b]) => (a < b ? -1 : 1))

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

/** One ustar entry: a 512 byte header, the data, padding to a whole block. */
function entry(name, data, mode) {
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
await mkdir(outDir, { recursive: true })
/* one CLI at a time: an older version's tarball must not linger beside the new one */
for (const name of await readdir(outDir)) if (/^doop-import-.*\.tgz$/.test(name)) await rm(`${outDir}${name}`)
const target = `${outDir}doop-import-${manifest.version}.tgz`
await writeFile(target, gzipSync(tar, { level: 9 }))
console.log(`packed ${target}`)
