// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { FrameContextMenu } from '../src/components/FrameContextMenu'
import { FrameExportModal } from '../src/components/FrameExportModal'
import { BATCH_PAUSE_MS } from '../src/lib/frameExport'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'export-frame',
  canvasId: 'canvas',
  name: 'Poster',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openFrameMenu(): Promise<Element> {
  await act(async () => {
    root.render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button>Frame</button>
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={{ current: { x: 0, y: 0 } }} />
      </ContextMenu>,
    )
  })
  await act(async () => {
    container
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  return document.querySelector('[role="menu"]')!
}

async function openExportDialog(): Promise<Element> {
  const menu = await openFrameMenu()
  const exportItem = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    /* "Export…" or "Export N frames…" for a selection, followed by the ⌘E hint */
    (item) => /^Export( \d+ frames)?…/.test(item.textContent ?? ''),
  )!
  await act(async () => {
    exportItem.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return document.querySelector('[role="dialog"]')!
}

it('keeps Copy image URL in the frame menu, not the export dialog', async () => {
  const menu = await openFrameMenu()
  expect(menu.textContent).toContain('Copy image URL')
  expect(menu.textContent).toContain('Export…')
  expect(menu.textContent).not.toContain('Download PNG')
})

it('hands focus from the frame menu to a persistent export dialog and dismisses with Escape', async () => {
  const dialog = await openExportDialog()

  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(dialog.textContent).toContain('Export “Poster”')
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(dialog.textContent).toContain('Download PNG')
  /* the scale picker starts at 2x */
  expect(dialog.textContent).toContain('2x')
  expect(dialog.textContent).toContain('Download SVG')
  expect(dialog.textContent).not.toMatch(/PSD|Canva|Figma/)
  expect(dialog.textContent).toContain('Download PDF')
  expect(dialog.textContent).not.toContain('Copy image URL')
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.style.pointerEvents).not.toBe('none')
})

it('offers the whole selection as one PDF', async () => {
  useStore.setState({
    canvas: {
      id: 'canvas',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      frames: [frame, { ...frame, id: 'other', name: 'Other' }],
    },
    selectedIds: [frame.id, 'other'],
  })
  const dialog = await openExportDialog()
  expect(dialog.textContent).toContain('Download PDF of 2 frames')
  expect(dialog.textContent).toContain('One vector page per frame')
})

function frameNamed(name: string): Frame {
  return { ...frame, id: `frame-${name.toLowerCase()}`, name }
}

async function renderModal(frames: Frame[], pageFrames?: Frame[]): Promise<Element> {
  await act(async () => {
    root.render(<FrameExportModal frame={frames[0]!} groupFrames={frames} pageFrames={pageFrames} onClose={() => {}} />)
  })
  return document.querySelector('[role="dialog"]')!
}

function buttonStarting(dialog: Element, label: string): HTMLButtonElement {
  return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(label))!
}

it('renders the single-frame dialog for one frame', async () => {
  const dialog = await renderModal([frame])

  expect(dialog.textContent).toContain('Export “Poster”')
  expect(dialog.querySelector('ul')).toBeNull()
  expect(dialog.textContent).toContain('Download PNG')
})

it('renders a counted dialog listing every frame for a selection', async () => {
  const dialog = await renderModal([frameNamed('Hero'), frameNamed('Pricing'), frameNamed('Footer')])

  expect(dialog.textContent).toContain('Export 3 frames')
  expect(Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['Hero', 'Pricing', 'Footer'])
  expect(dialog.textContent).toContain('Download PNG')
  expect(dialog.textContent).toContain('Download JPG')
  expect(dialog.textContent).toContain('Download SVG')
})

it('opens the page picker with the selection checked and exports only what stays checked', async () => {
  const page = [frameNamed('Hero'), frameNamed('Pricing'), frameNamed('Footer')]
  const dialog = await renderModal([page[1]!], page)

  const boxes = () => Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
  expect(boxes().map((box) => box.checked)).toEqual([false, true, false])
  expect(dialog.textContent).toContain('Export “Pricing”')

  await act(async () => {
    boxes()[0]!.click()
  })
  expect(dialog.textContent).toContain('Export 2 frames')
  expect(dialog.textContent).toContain('Download PDF of 2 frames')

  await act(async () => {
    buttonStarting(dialog, 'Clear').click()
  })
  expect(boxes().every((box) => !box.checked)).toBe(true)
  expect(buttonStarting(dialog, 'Download PNG').disabled).toBe(true)
  expect(buttonStarting(dialog, 'Download PDF').disabled).toBe(true)
})

it('checks every frame of the page when no selection is given', async () => {
  const page = [frameNamed('Hero'), frameNamed('Pricing')]
  const dialog = await renderModal([], page)

  expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((b) => b.checked)).toEqual(
    [true, true],
  )
  expect(dialog.textContent).toContain('Export 2 frames')
})

it('shows "Exporting N of M…" while a selection downloads, then a done state listing failures per frame', async () => {
  const downloads: Array<(res: Response) => void> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => downloads.push(resolve))),
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
  vi.useFakeTimers()
  try {
    const dialog = await renderModal([frameNamed('Hero'), frameNamed('Pricing')])
    await act(async () => {
      buttonStarting(dialog, 'Download PNG').click()
    })
    expect(dialog.textContent).toContain('Exporting 1 of 2…')
    expect(buttonStarting(dialog, 'Stop')).toBeDefined()

    await act(async () => {
      downloads[0]!(new Response('png', { headers: { 'Content-Disposition': 'attachment; filename="Hero.png"' } }))
      await vi.advanceTimersByTimeAsync(BATCH_PAUSE_MS)
    })
    expect(dialog.textContent).toContain('Exporting 2 of 2…')

    await act(async () => {
      downloads[1]!(Response.json({ error: 'Renderer is busy' }, { status: 500 }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(dialog.textContent).toContain('1 of 2 exported — 1 failed')
    expect(dialog.textContent).toContain('Pricing')
    expect(dialog.textContent).toContain('Renderer is busy')
    expect(buttonStarting(dialog, 'Done')).toBeDefined()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
