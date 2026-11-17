import JSZip from 'jszip'
import type { ReactExportResult } from './index.ts'

/** Every entry carries this date, so the same files always make the same archive (the zip format has no earlier year than 1980). */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1))

const FILE_MODE = 0o644
const DIR_MODE = 0o755

/** A path that stays inside the archive: relative, POSIX, no empty, `.` or `..` segment, no backslash or control character. */
function isSafeEntryPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  if (Array.from(path).some((char) => char.charCodeAt(0) < 0x20)) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The export as one zip, every file under `rootDir/`. Deterministic: entries sorted by path, fixed dates and modes, so two runs
 * over the same files give the same bytes. A path or root that could leave the archive throws, whatever put it there.
 */
export async function zipExport(result: ReactExportResult, rootDir: string): Promise<Buffer> {
  if (!isSafeEntryPath(rootDir) || rootDir.includes('/')) throw new Error('zip root must be one plain directory name')
  const zip = new JSZip()
  const directories = new Set<string>()
  const files = [...result.files].sort((a, b) => byText(a.path, b.path))
  const seen = new Set<string>()
  for (const file of files) {
    if (!isSafeEntryPath(file.path)) throw new Error(`unsafe path in export: ${JSON.stringify(file.path)}`)
    if (seen.has(file.path)) throw new Error(`duplicate path in export: ${JSON.stringify(file.path)}`)
    seen.add(file.path)
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  zip.file(`${rootDir}/`, '', { dir: true, date: FIXED_DATE, unixPermissions: DIR_MODE, createFolders: false })
  for (const directory of [...directories].sort(byText)) {
    zip.file(`${rootDir}/${directory}/`, '', {
      dir: true,
      date: FIXED_DATE,
      unixPermissions: DIR_MODE,
      createFolders: false,
    })
  }
  for (const file of files) {
    zip.file(`${rootDir}/${file.path}`, file.content, {
      date: FIXED_DATE,
      unixPermissions: FILE_MODE,
      createFolders: false,
    })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}
