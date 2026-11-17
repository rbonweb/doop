// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  componentSource,
  copyComponentAsReact,
  downloadReactZip,
  fetchReactFiles,
  ReactExportError,
  type ReactExportReport,
} from '../src/lib/reactExport'
import { REACT_EXPORT_STORAGE_KEY, readReactExportSettings } from '../src/lib/reactExportSettings'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const report: ReactExportReport = {
  styling: 'modules',
  components: [{ id: 'c1', name: 'Button', file: 'src/components/Button.tsx' }],
  pages: [],
  issues: [],
  inlined: [],
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  localStorage.clear()
  useStore.setState({ notice: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function lastRequest(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1)!
  return { url: String(url), init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> }
}

it('posts the body with format zip and saves the zip under the server file name', async () => {
  const saved: { href: string; download: string }[] = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip')
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.href, download: this.download })
  })
  fetchMock.mockResolvedValue(
    new Response(new Blob(['PK']), {
      headers: { 'Content-Disposition': 'attachment; filename="Acme-react.zip"', 'X-Doop-Export-Issues': '2' },
    }),
  )

  const result = await downloadReactZip('can/vas', { pageId: 'p1', styling: 'tailwind', tokens: false })

  expect(result).toEqual({ fileName: 'Acme-react.zip', issueCount: 2 })
  const { url, init, body } = lastRequest()
  expect(url).toBe('/api/canvases/can%2Fvas/export/react')
  expect(init.method).toBe('POST')
  expect(body).toEqual({ pageId: 'p1', styling: 'tailwind', tokens: false, format: 'zip' })
  expect(saved).toEqual([{ href: 'blob:zip', download: 'Acme-react.zip' }])
})

it('falls back to a file name and no issue count when the server sends neither', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip')
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fetchMock.mockResolvedValue(new Response(new Blob(['PK'])))
  expect(await downloadReactZip('c', { frameIds: ['f'] })).toEqual({ fileName: 'react-export.zip', issueCount: null })
})

it('asks for json and returns the files and the report', async () => {
  const files = [{ path: 'src/components/Button.tsx', content: 'export function Button() {}' }]
  fetchMock.mockResolvedValue(Response.json({ files, report }))

  const result = await fetchReactFiles('c', { componentIds: ['c1'] })

  expect(result).toEqual({ files, report })
  expect(lastRequest().body).toEqual({ componentIds: ['c1'], format: 'json' })
})

it('explains a 413 in its own words, not the server’s', async () => {
  fetchMock.mockResolvedValue(Response.json({ error: 'payload too large' }, { status: 413 }))
  const error = await fetchReactFiles('c', { pageId: 'p' }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(ReactExportError)
  expect((error as ReactExportError).status).toBe(413)
  expect((error as ReactExportError).message).toMatch(/too large/i)
  expect((error as ReactExportError).message).not.toContain('payload')
})

it('surfaces the server’s error text', async () => {
  fetchMock.mockResolvedValue(Response.json({ error: 'Frame “Home” could not be read.' }, { status: 422 }))
  await expect(downloadReactZip('c', { frameIds: ['f'] })).rejects.toMatchObject({
    message: 'Frame “Home” could not be read.',
    status: 422,
  })
})

it('says something plain when the answer has no error text or the network fails', async () => {
  fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
  await expect(downloadReactZip('c', {})).rejects.toThrow('Couldn’t export to React')
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await expect(downloadReactZip('c', {})).rejects.toThrow('Couldn’t export to React')
})

it('rejects a json answer that has no files', async () => {
  fetchMock.mockResolvedValue(Response.json({ nope: true }))
  await expect(fetchReactFiles('c', {})).rejects.toBeInstanceOf(ReactExportError)
})

it('finds a component’s file by the report, else the one under src/components', () => {
  const files = [
    { path: 'src/cx.ts', content: 'cx' },
    { path: 'src/components/Button.tsx', content: 'BUTTON' },
  ]
  expect(componentSource({ files, report }, { id: 'c1', name: 'Button' })).toBe('BUTTON')
  expect(componentSource({ files, report: { ...report, components: [] } }, { id: 'x', name: 'Button' })).toBe('BUTTON')
  expect(componentSource({ files: [files[0]!], report }, { id: 'c1', name: 'Button' })).toBeUndefined()
})

it('remembers styling and tokens per browser, each field on its own', () => {
  expect(readReactExportSettings(null)).toEqual({ styling: 'modules', tokens: true })
  expect(readReactExportSettings(JSON.stringify({ styling: 'tailwind', tokens: 'yes' }))).toEqual({
    styling: 'tailwind',
    tokens: true,
  })
  expect(readReactExportSettings('{broken')).toEqual({ styling: 'modules', tokens: true })
  expect(REACT_EXPORT_STORAGE_KEY).toBe('doop:react-export')
})

it('copies one component’s tsx in the last styling and says so in a toast', async () => {
  localStorage.setItem(REACT_EXPORT_STORAGE_KEY, JSON.stringify({ styling: 'tailwind', tokens: true }))
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  fetchMock.mockResolvedValue(
    Response.json({ files: [{ path: 'src/components/Button.tsx', content: 'BUTTON SOURCE' }], report }),
  )

  await copyComponentAsReact('c', { id: 'c1', name: 'Button' })

  expect(lastRequest().body).toEqual({ componentIds: ['c1'], styling: 'tailwind', tokens: false, format: 'json' })
  expect(writeText).toHaveBeenCalledWith('BUTTON SOURCE')
  expect(useStore.getState().notice?.text).toBe('Copied Button as React')
})

it('toasts the failure and copies nothing when the export fails', async () => {
  const writeText = vi.fn()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  fetchMock.mockResolvedValue(Response.json({ error: 'nope' }, { status: 413 }))
  await copyComponentAsReact('c', { id: 'c1', name: 'Button' })
  expect(writeText).not.toHaveBeenCalled()
  expect(useStore.getState().notice?.text).toMatch(/too large/i)
})

it('names the package when the component maps to one and has no file', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
  fetchMock.mockResolvedValue(
    Response.json({
      files: [],
      report: { ...report, components: [{ id: 'c1', name: 'Button', importedFrom: '@acme/ui', exportName: 'Button' }] },
    }),
  )
  await copyComponentAsReact('c', { id: 'c1', name: 'Button' })
  expect(useStore.getState().notice?.text).toBe('Button maps to @acme/ui, so there is no file to copy.')
})
