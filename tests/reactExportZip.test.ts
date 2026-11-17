import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { ReactExportResult } from '../server/reactExport/index.ts'
import { zipExport } from '../server/reactExport/zip.ts'

const report = { styling: 'modules', components: [], pages: [], issues: [], inlined: [] } as const

function resultOf(files: { path: string; content: string }[]): ReactExportResult {
  return { files, report: { ...report, components: [], pages: [], issues: [], inlined: [] } }
}

const FILES = [
  { path: 'src/pages/Home.tsx', content: 'export function Home() { return <p>{"héllo ✓ 日本"}</p> }\n' },
  { path: 'README.md', content: '# Doop export\n' },
  { path: 'src/components/Button.tsx', content: 'export {}\n' },
  { path: 'src/tokens.json', content: '{}\n' },
]

describe('zipExport', () => {
  it('puts every file under the root directory, with folder entries, and round-trips the text', async () => {
    const zip = await JSZip.loadAsync(await zipExport(resultOf(FILES), 'acme-react'))
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual([
      'acme-react/',
      'acme-react/README.md',
      'acme-react/src/',
      'acme-react/src/components/',
      'acme-react/src/components/Button.tsx',
      'acme-react/src/pages/',
      'acme-react/src/pages/Home.tsx',
      'acme-react/src/tokens.json',
    ])
    expect(await zip.file('acme-react/src/pages/Home.tsx')!.async('string')).toBe(FILES[0]!.content)
    expect(zip.files['acme-react/src/']!.dir).toBe(true)
  })

  it('is byte-identical for the same files, whatever order they arrive in', async () => {
    const first = await zipExport(resultOf(FILES), 'acme-react')
    const second = await zipExport(resultOf([...FILES].reverse()), 'acme-react')
    expect(second.equals(first)).toBe(true)
  })

  it('carries a fixed date and plain modes, never the clock', async () => {
    const zip = await JSZip.loadAsync(await zipExport(resultOf(FILES), 'acme-react'), { createFolders: false })
    for (const entry of Object.values(zip.files)) {
      expect(entry.date.getUTCFullYear()).toBe(2000)
      expect(Number(entry.unixPermissions) & 0o777).toBe(entry.dir ? 0o755 : 0o644)
    }
  })

  it('refuses a path that could leave the archive, and duplicates', async () => {
    for (const path of ['../evil.tsx', '/abs.tsx', 'src//a.tsx', 'src/./a.tsx', 'src\\a.tsx', '', 'src/a\u0000.tsx']) {
      await expect(zipExport(resultOf([{ path, content: 'x' }]), 'acme-react'), JSON.stringify(path)).rejects.toThrow(
        /unsafe path/,
      )
    }
    await expect(
      zipExport(
        resultOf([
          { path: 'a.ts', content: '1' },
          { path: 'a.ts', content: '2' },
        ]),
        'acme-react',
      ),
    ).rejects.toThrow(/duplicate path/)
  })

  it('refuses a root that is not one plain directory name', async () => {
    for (const root of ['', '..', '.', 'a/b', '/etc', 'a\\b']) {
      await expect(zipExport(resultOf(FILES), root), JSON.stringify(root)).rejects.toThrow(/zip root/)
    }
  })

  it('makes a valid archive of nothing but the root', async () => {
    const zip = await JSZip.loadAsync(await zipExport(resultOf([]), 'empty-react'))
    expect(Object.keys(zip.files)).toEqual(['empty-react/'])
  })
})
