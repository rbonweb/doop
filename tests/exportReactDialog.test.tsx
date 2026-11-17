// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'
import { ExportReactDialog } from '../src/components/ExportReactDialog'
import { REACT_EXPORT_STORAGE_KEY } from '../src/lib/reactExportSettings'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame = (id: string, name: string): Frame => ({
  id,
  canvasId: 'canvas',
  name,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
})

const component = (id: string, name: string): ComponentDef => ({
  id,
  name,
  description: '',
  template: '',
  css: '',
  rawCss: '',
  head: [],
  props: [],
  slots: [],
  rev: 1,
  mainFrameId: null,
  history: [],
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
})

const PAGE = { id: 'page1', name: 'Landing', frameCount: 3 }
const COMPONENTS = [component('c1', 'Button'), component('c2', 'Card')]

const fetchMock = vi.fn<typeof fetch>()
let container: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  onClose.mockReset()
  localStorage.clear()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip')
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function open(props: Partial<Parameters<typeof ExportReactDialog>[0]> = {}): Promise<Element> {
  await act(async () => {
    root.render(
      <ExportReactDialog
        canvasId="canvas"
        frames={[frame('f1', 'Home')]}
        page={PAGE}
        components={COMPONENTS}
        onClose={onClose}
        {...props}
      />,
    )
  })
  return document.querySelector('[role="dialog"]')!
}

const radios = (dialog: Element, label: string) =>
  Array.from(dialog.querySelectorAll<HTMLElement>('[role="radiogroup"]')).find(
    (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent === label,
  )!

function pick(group: Element, text: string): HTMLElement {
  return Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).find((item) => item.textContent === text)!
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
}

const downloadButton = (dialog: Element) =>
  Array.from(dialog.querySelectorAll('button')).find((b) => /Download zip|Preparing zip/.test(b.textContent ?? ''))!

function requestBody(): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)) as Record<string, unknown>
}

function zipResponse(headers: Record<string, string> = {}): Response {
  return new Response(new Blob(['PK']), {
    headers: { 'Content-Disposition': 'attachment; filename="Acme-react.zip"', ...headers },
  })
}

it('opens on this frame with CSS Modules and tokens on', async () => {
  const dialog = await open()
  expect(dialog.textContent).toContain('Export to React')
  expect(dialog.textContent).toContain('typed React components')
  const scope = radios(dialog, 'What to export')
  expect(pick(scope, 'This frame').getAttribute('aria-checked')).toBe('true')
  expect(dialog.textContent).toContain('Home')
  const styling = radios(dialog, 'Styling')
  expect(pick(styling, 'CSS Modules').getAttribute('aria-checked')).toBe('true')
  expect(pick(styling, 'Tailwind').getAttribute('aria-checked')).toBe('false')
  expect(dialog.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
})

it('sends the selected frames for the frame scope', async () => {
  fetchMock.mockResolvedValue(zipResponse())
  const dialog = await open({ frames: [frame('f1', 'Home'), frame('f2', 'About')] })
  expect(pick(radios(dialog, 'What to export'), 'Selected frames').getAttribute('aria-checked')).toBe('true')
  expect(dialog.textContent).toContain('2 frames')
  await click(downloadButton(dialog))
  expect(requestBody()).toEqual({ frameIds: ['f1', 'f2'], styling: 'modules', tokens: true, format: 'zip' })
})

it('sends the page for the page scope', async () => {
  fetchMock.mockResolvedValue(zipResponse())
  const dialog = await open()
  await click(pick(radios(dialog, 'What to export'), 'This page'))
  expect(dialog.textContent).toContain('Landing · 3 frames')
  await click(downloadButton(dialog))
  expect(requestBody()).toEqual({ pageId: 'page1', styling: 'modules', tokens: true, format: 'zip' })
})

it('lists the components, all ticked, and sends the ones left ticked', async () => {
  fetchMock.mockResolvedValue(zipResponse())
  const dialog = await open()
  await click(pick(radios(dialog, 'What to export'), 'Components'))
  const boxes = Array.from(dialog.querySelectorAll<HTMLInputElement>('[role="group"] input[type="checkbox"]'))
  expect(boxes).toHaveLength(2)
  expect(boxes.every((box) => box.checked)).toBe(true)
  await click(boxes[1]!)
  expect(dialog.textContent).toContain('1 of 2 selected')
  await click(downloadButton(dialog))
  expect(requestBody()).toEqual({ componentIds: ['c1'], styling: 'modules', tokens: true, format: 'zip' })
})

it('starts from the ticks it is given', async () => {
  const dialog = await open({ frames: [], initialComponentIds: ['c2'] })
  await click(pick(radios(dialog, 'What to export'), 'Components'))
  const boxes = Array.from(dialog.querySelectorAll<HTMLInputElement>('[role="group"] input[type="checkbox"]'))
  expect(boxes.map((box) => box.checked)).toEqual([false, true])
})

it('opens on the page when nothing is selected and turns the frame scope off', async () => {
  const dialog = await open({ frames: [] })
  const scope = radios(dialog, 'What to export')
  expect(pick(scope, 'This page').getAttribute('aria-checked')).toBe('true')
  expect(pick(scope, 'This frame').hasAttribute('disabled')).toBe(true)
})

it('keeps Download off when the scope has nothing to export', async () => {
  const dialog = await open({ frames: [], page: { ...PAGE, frameCount: 0 } })
  expect(pick(radios(dialog, 'What to export'), 'Components').getAttribute('aria-checked')).toBe('true')
  await click(Array.from(dialog.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent === 'Clear')!)
  expect(downloadButton(dialog).hasAttribute('disabled')).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('sends Tailwind and no tokens when they are picked, and remembers both per browser', async () => {
  fetchMock.mockResolvedValue(zipResponse())
  const dialog = await open()
  await click(pick(radios(dialog, 'Styling'), 'Tailwind'))
  await click(dialog.querySelector<HTMLElement>('[role="switch"]')!)
  expect(JSON.parse(localStorage.getItem(REACT_EXPORT_STORAGE_KEY)!)).toEqual({ styling: 'tailwind', tokens: false })
  await click(downloadButton(dialog))
  expect(requestBody()).toMatchObject({ styling: 'tailwind', tokens: false })

  /* a fresh dialog starts from the last pick */
  await act(async () => root.unmount())
  root = createRoot(container)
  const again = await open()
  expect(pick(radios(again, 'Styling'), 'Tailwind').getAttribute('aria-checked')).toBe('true')
  expect(again.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
})

it('shows progress while the zip is made, then the file and what did not carry over', async () => {
  let finish: (res: Response) => void = () => {}
  fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)))
  const dialog = await open()
  await click(downloadButton(dialog))

  expect(downloadButton(dialog).textContent).toContain('Preparing zip…')
  expect(downloadButton(dialog).hasAttribute('disabled')).toBe(true)
  expect(dialog.querySelector('[role="progressbar"]')).not.toBeNull()

  await act(async () => finish(zipResponse({ 'X-Doop-Export-Issues': '3' })))

  expect(dialog.querySelector('[role="progressbar"]')).toBeNull()
  expect(dialog.textContent).toContain('Saved Acme-react.zip')
  expect(dialog.textContent).toContain('3 things did not carry over')
  expect(dialog.textContent).toContain('export-report.json')
  const done = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Done')!
  await click(done)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('says everything carried over when the server reports none', async () => {
  fetchMock.mockResolvedValue(zipResponse({ 'X-Doop-Export-Issues': '0' }))
  const dialog = await open()
  await click(downloadButton(dialog))
  expect(dialog.textContent).toContain('Everything carried over')
})

it('shows the server’s message when the export fails and lets the person try again', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'Frame “Home” could not be read.' }, { status: 422 }))
  const dialog = await open()
  await click(downloadButton(dialog))
  expect(dialog.querySelector('[role="alert"]')!.textContent).toBe('Frame “Home” could not be read.')
  expect(downloadButton(dialog).hasAttribute('disabled')).toBe(false)

  fetchMock.mockResolvedValueOnce(zipResponse())
  await click(downloadButton(dialog))
  expect(dialog.querySelector('[role="alert"]')).toBeNull()
  expect(dialog.textContent).toContain('Saved Acme-react.zip')
})

it('explains a 413', async () => {
  fetchMock.mockResolvedValue(new Response('too big', { status: 413 }))
  const dialog = await open()
  await click(downloadButton(dialog))
  expect(dialog.querySelector('[role="alert"]')!.textContent).toMatch(/too large/i)
})

it('opens on the components scope with only the asked-for component ticked', async () => {
  const dialog = await open({ initialScope: 'components', initialComponentIds: ['c2'] })
  expect(pick(radios(dialog, 'What to export'), 'Components').getAttribute('aria-checked')).toBe('true')
  const boxes = Array.from(dialog.querySelectorAll<HTMLInputElement>('[role="group"] input[type="checkbox"]'))
  expect(boxes.map((box) => box.checked)).toEqual([false, true])
})

const seeLink = (dialog: Element) =>
  Array.from(dialog.querySelectorAll('button')).find((b) =>
    /See what did not carry over|Hide the list/.test(b.textContent ?? ''),
  )

it('lists what did not carry over from the same scope as json, and hides it again', async () => {
  fetchMock.mockResolvedValueOnce(zipResponse({ 'X-Doop-Export-Issues': '2' }))
  const dialog = await open()
  await click(pick(radios(dialog, 'What to export'), 'This page'))
  await click(pick(radios(dialog, 'Styling'), 'Tailwind'))
  await click(downloadButton(dialog))

  fetchMock.mockResolvedValueOnce(
    Response.json({
      files: [],
      report: {
        styling: 'tailwind',
        components: [],
        pages: [],
        inlined: [],
        issues: [
          { kind: 'script', detail: 'A script was removed', file: 'src/pages/Home.tsx' },
          { kind: 'css', detail: 'Keyframes stayed in the stylesheet', file: 'src/components/Card.tsx' },
        ],
      },
    }),
  )
  await click(seeLink(dialog)!)

  expect(requestBody()).toEqual({ pageId: 'page1', styling: 'tailwind', tokens: true, format: 'json' })
  const list = dialog.querySelector('ul[aria-label="What did not carry over"]')!
  expect(Array.from(list.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
    'A script was removedsrc/pages/Home.tsx',
    'Keyframes stayed in the stylesheetsrc/components/Card.tsx',
  ])

  await click(seeLink(dialog)!)
  expect(dialog.querySelector('ul[aria-label="What did not carry over"]')).toBeNull()
})

it('offers no list when the zip carried no issues or no count', async () => {
  fetchMock.mockResolvedValueOnce(zipResponse({ 'X-Doop-Export-Issues': '0' }))
  const dialog = await open()
  await click(downloadButton(dialog))
  expect(seeLink(dialog)).toBeUndefined()
})

it('says why the list could not be loaded', async () => {
  fetchMock.mockResolvedValueOnce(zipResponse({ 'X-Doop-Export-Issues': '5' }))
  const dialog = await open()
  await click(downloadButton(dialog))
  fetchMock.mockResolvedValueOnce(new Response('too big', { status: 413 }))
  await click(seeLink(dialog)!)
  expect(dialog.querySelector('[role="alert"]')!.textContent).toMatch(/too large/i)
})
