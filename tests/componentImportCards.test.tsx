// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'
import type { ComponentDef } from '../shared/components'
import { CliImportSection } from '../src/components/CliImportSection'
import { importSources } from '../src/components/importSourceList'
import { StorybookImportSection } from '../src/components/StorybookImportSection'
import { Modal } from '../src/components/ui/modal'
import { forgetImportTicket } from '../src/lib/componentImport'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn<typeof fetch>()
const onBack = vi.fn()
const onUseCli = vi.fn()
const onOpenPage = vi.fn()
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  forgetImportTicket('canvas')
  onBack.mockReset()
  onUseCli.mockReset()
  onOpenPage.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useStore.setState({ canvas: null })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function show(node: React.ReactNode): Promise<Element> {
  await act(async () => {
    root.render(<Modal onClose={() => {}}>{node}</Modal>)
  })
  return document.querySelector('[role="dialog"]')!
}

const button = (dialog: Element, label: RegExp) =>
  Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => label.test(b.textContent ?? ''))!

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** An NDJSON answer the test feeds line by line, and that errors like fetch does when its request is aborted. */
function stream(signal?: AbortSignal | null) {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
  return {
    response: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send: async (event: object) => {
      await act(async () => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      })
    },
    sendRaw: async (text: string) => {
      await act(async () => {
        controller.enqueue(encoder.encode(text))
      })
    },
    end: async () => {
      await act(async () => {
        controller.close()
      })
    },
  }
}

function answerWith(make: (signal: AbortSignal | null | undefined) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (_url, init) => make(init?.signal))
}

const sentBody = (call = -1): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls.at(call)![1]!.body)) as Record<string, unknown>

const RESULT = {
  created: [{ name: 'Button', id: 'c1' }],
  updated: [{ name: 'Card', id: 'c2' }],
  unchanged: [],
  skipped: [{ name: 'Tooltip', reason: 'needs a portal' }],
  tokens: { created: ['--brand'], skipped: [] },
  pageId: 'page-imported',
  issues: [{ component: 'Card', code: 'css', message: 'a hover rule was dropped' }],
}

async function startStorybook() {
  const dialog = await show(
    <StorybookImportSection canvasId="canvas" onBack={onBack} onUseCli={onUseCli} onOpenPage={onOpenPage} />,
  )
  return dialog
}

it('storybook idle: asks for an address and package, and Preview waits for the address', async () => {
  const dialog = await startStorybook()
  expect(dialog.textContent).toContain('Import from Storybook')
  expect(dialog.textContent).toContain('Package name')
  const preview = button(dialog, /^Preview$/)
  expect(preview.disabled).toBe(true)
  await type(dialog.querySelector('#storybook-url')!, 'storybook.acme.com')
  expect(button(dialog, /^Preview$/).disabled).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('storybook preview: a dry run lists what would be created, updated and skipped, then Import runs it', async () => {
  const dryRun = stream()
  answerWith(() => dryRun.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'storybook.acme.com')
  await type(dialog.querySelector('#storybook-package')!, '@acme/ui')
  await click(button(dialog, /^Preview$/))
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/canvases/canvas/import/storybook')
  expect(sentBody()).toEqual({ url: 'https://storybook.acme.com', package: '@acme/ui', dryRun: true })
  expect(dialog.textContent).toContain('Reading Storybook')

  await dryRun.send({ type: 'plan', components: [{ name: 'Button', stories: 3, renders: 6 }], renders: 6 })
  await dryRun.send({ type: 'result', result: RESULT })
  await dryRun.end()
  expect(dialog.textContent).toContain('What would change')
  expect(dialog.textContent).toContain('1 component would be created')
  expect(dialog.textContent).toContain('1 component would be updated')
  expect(dialog.textContent).toContain('1 component would be skipped')
  expect(dialog.textContent).toContain('Tooltip: needs a portal')
  expect(dialog.textContent).toContain('6 renders to read')

  const real = stream()
  answerWith(() => real.response)
  await click(button(dialog, /^Import$/))
  expect(sentBody()).toEqual({ url: 'https://storybook.acme.com', package: '@acme/ui' })
})

it('storybook stream: a line split across two chunks, and a last line with no newline, are both read', async () => {
  const dry = stream()
  answerWith(() => dry.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  const plan = JSON.stringify({ type: 'plan', components: [{ name: 'Button', stories: 1, renders: 2 }], renders: 2 })
  await dry.sendRaw(plan.slice(0, 20))
  await dry.sendRaw(`${plan.slice(20)}\n`)
  const result = JSON.stringify({ type: 'result', result: RESULT })
  await dry.sendRaw(result.slice(0, 30))
  await dry.sendRaw(result.slice(30))
  expect(dialog.textContent).toContain('Reading Storybook')
  await dry.end()
  expect(dialog.textContent).toContain('What would change')
  expect(dialog.textContent).toContain('2 renders to read')
  expect(dialog.textContent).toContain('1 component would be created')
})

it('storybook running then done: shows rendered of total and the component, then the result and the page button', async () => {
  const run = stream()
  answerWith(() => {
    return run.response
  })
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  // a preview with something to import, so Import is enabled
  const dry = stream()
  answerWith(() => dry.response)
  await click(button(dialog, /^Preview$/))
  await dry.send({ type: 'result', result: RESULT })
  await dry.end()
  answerWith(() => run.response)
  await click(button(dialog, /^Import$/))

  expect(dialog.textContent).toContain('Starting')
  await run.send({ type: 'plan', components: [{ name: 'Button', stories: 2, renders: 5 }], renders: 5 })
  await run.send({ type: 'progress', rendered: 2, total: 5, component: 'Button' })
  expect(dialog.textContent).toContain('Rendered 2 of 5')
  expect(dialog.textContent).toContain('Now reading Button')
  expect(dialog.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2')

  await run.send({ type: 'result', result: RESULT, issues: RESULT.issues })
  await run.end()
  expect(dialog.textContent).toContain('Import finished')
  expect(dialog.textContent).toContain('1 created')
  expect(dialog.textContent).toContain('1 updated')
  expect(dialog.textContent).toContain('1 token added')
  expect(dialog.textContent).toContain('Card: a hover rule was dropped')
  await click(button(dialog, /Open Imported components/))
  expect(onOpenPage).toHaveBeenCalledWith('page-imported')
})

it('storybook running: Cancel aborts the request and goes back to the form', async () => {
  const dry = stream()
  answerWith(() => dry.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await dry.send({ type: 'result', result: RESULT })
  await dry.end()

  let signal: AbortSignal | null | undefined
  answerWith((s) => {
    signal = s
    return stream(s).response
  })
  await click(button(dialog, /^Import$/))
  expect(button(dialog, /^Cancel$/)).toBeTruthy()
  await click(button(dialog, /^Cancel$/))
  expect(signal?.aborted).toBe(true)
  expect(dialog.textContent).toContain('Import cancelled.')
  expect(dialog.querySelector<HTMLInputElement>('#storybook-url')!.value).toBe('https://storybook.acme.com')
})

it('storybook refused: a private Storybook says why and offers the CLI card', async () => {
  const run = stream()
  answerWith(() => run.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://internal.acme.com')
  await click(button(dialog, /^Preview$/))
  await run.send({ type: 'error', code: 'private', message: 'redirected to a sign-in page' })
  await run.end()
  expect(dialog.textContent).toContain('Doop could not open that Storybook')
  expect(dialog.textContent).toContain('behind a login')
  await click(button(dialog, /Use the command line instead/))
  expect(onUseCli).toHaveBeenCalledTimes(1)
  expect(button(dialog, /^Try again$/)).toBeTruthy()
})

it('storybook refused before streaming: a 4xx JSON error is shown as it is', async () => {
  answerWith(() => Response.json({ error: 'at most 3 imports an hour' }, { status: 403 }))
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('at most 3 imports an hour')
})

const TICKET = {
  upload_url: 'https://doop.test/import/tok',
  expires_at: '',
  command: 'npx doop-import --storybook ./storybook-static --ticket https://doop.test/import/tok',
  curl: 'curl -T bundle.json https://doop.test/import/tok',
}

const component = (id: string, rev = 1, origin: 'cli' | 'storybook' | null = 'cli'): ComponentDef =>
  ({
    id,
    name: id,
    rev,
    props: [],
    slots: [],
    history: [],
    ...(origin ? { code: { exportName: id, origin: { kind: origin } } } : {}),
  }) as unknown as ComponentDef

function openCanvas(components: ComponentDef[]) {
  useStore.setState({ canvas: { id: 'canvas', components } as unknown as Canvas })
}

it('cli: mints a ticket when opened and shows the command, its expiry and the agent line', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/canvases/canvas/component-import/ticket')
  expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST')
  expect(dialog.querySelector('[data-slot="code-block"]')?.textContent).toContain(TICKET.command)
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toBe('Works once. Expires in 15 minutes.')
  expect(dialog.textContent).toContain('--storybook http://localhost:6006')
  expect(dialog.textContent).toContain('--package @acme/ui')
  expect(dialog.textContent).toContain('Ask your agent to import your components')
  expect(button(dialog, /New command/)).toBeTruthy()
  expect(dialog.querySelector('[data-slot="cli-command-spent"]')).toBeNull()
})

it('cli: the command lapses at its expiry and "New command" mints another', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 90_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toContain('in 2 minutes')
  /* the label re-renders on the minute, then once more as the ticket lapses */
  await act(async () => {
    vi.advanceTimersByTime(31_000)
  })
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toContain('in 1 minute')
  await act(async () => {
    vi.advanceTimersByTime(60_000)
  })
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toBe('This command has expired.')
  await click(button(dialog, /New command/))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toContain('Works once')
})

it('cli: says so when a command cannot be made, and offers another try', async () => {
  answerWith(() => Response.json({ error: 'too many import commands this hour' }, { status: 429 }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('too many import commands this hour')
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 60_000 * 15).toISOString() }))
  await click(button(dialog, /New command/))
  expect(dialog.querySelector('[data-slot="code-block"]')?.textContent).toContain(TICKET.command)
})

it('cli: components arriving over the room show as landed, with a button to open the page', async () => {
  openCanvas([component('old')])
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(dialog.textContent).not.toContain('arrived')
  await act(async () => {
    openCanvas([component('old'), component('new-1'), component('new-2')])
  })
  expect(dialog.textContent).toContain('2 components arrived')
  await click(button(dialog, /Open Imported components/))
  expect(onOpenPage).toHaveBeenCalledWith(null)
  // an update to a component that was already there counts too
  await act(async () => {
    openCanvas([component('old', 2), component('new-1'), component('new-2')])
  })
  expect(dialog.textContent).toContain('3 components arrived')
})

it('cli: a collaborator editing or adding their own components is not the command arriving', async () => {
  openCanvas([component('mine', 1, null)])
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  await act(async () => {
    openCanvas([component('mine', 2, null), component('theirs', 1, null), component('from-storybook', 1, 'storybook')])
  })
  expect(dialog.textContent).not.toContain('arrived')
})

it('cli: a screen that mounts twice (StrictMode) mints one ticket, and a reopening reuses it', async () => {
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  await act(async () => {
    root.render(
      <StrictMode>
        <Modal onClose={() => {}}>
          <CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />
        </Modal>
      </StrictMode>,
    )
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount())
  root = createRoot(container)
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(dialog.querySelector('[data-slot="code-block"]')?.textContent).toContain(TICKET.command)
})

it('the picker lists both cards for an editor and neither for a viewer', () => {
  const ids = (components: boolean) => importSources(undefined, { components }).map((s) => s.id)
  expect(ids(true)).toEqual(expect.arrayContaining(['storybook', 'cli']))
  expect(ids(false)).not.toContain('storybook')
  expect(ids(false)).not.toContain('cli')
  expect(importSources().map((s) => s.id)).toEqual(expect.arrayContaining(['website', 'github', 'storybook', 'cli']))
})

const PLAN = [
  { name: 'Button', group: 'Inputs/Button', stories: 3, renders: 6 },
  { name: 'Select', group: 'Inputs/Select', stories: 2, renders: 4 },
  { name: 'Card', group: 'Layout/Card', stories: 1, renders: 2 },
]

/** Types an address, runs the dry run and answers it with `plan`, leaving the preview open. */
async function previewOf(plan: typeof PLAN) {
  const dry = stream()
  answerWith(() => dry.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await dry.send({ type: 'plan', components: plan, renders: 12 })
  await dry.send({ type: 'result', result: RESULT })
  await dry.end()
  return dialog
}

const checkboxes = (dialog: Element) =>
  Array.from(dialog.querySelectorAll<HTMLInputElement>('[data-slot="storybook-choose"] input[type="checkbox"]'))

it('storybook error: an invalid failure shows the server message, never the address copy', async () => {
  const run = stream()
  answerWith(() => run.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await run.send({ type: 'error', code: 'invalid', message: 'The story “Button/Primary” threw while rendering.' })
  await run.end()
  const alert = dialog.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('The import did not finish')
  expect(alert.textContent).toContain('The story “Button/Primary” threw while rendering.')
  expect(alert.textContent).not.toContain('does not look like')
  expect(alert.textContent).not.toContain('Use the command line')
})

it('storybook choose: every title is ticked, unticking sends the rest as include', async () => {
  const dialog = await previewOf(PLAN)
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('3 of 3 selected')
  const boxes = checkboxes(dialog)
  expect(boxes).toHaveLength(3)
  expect(boxes.every((b) => b.checked)).toBe(true)
  await click(boxes[2]!)
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('2 of 3 selected')

  const real = stream()
  answerWith(() => real.response)
  await click(button(dialog, /^Import$/))
  expect(sentBody().include).toEqual(['Inputs/Button', 'Inputs/Select'])
  expect(sentBody().dryRun).toBeUndefined()
})

it('storybook choose: with everything ticked no include is sent, and Clear leaves nothing to import', async () => {
  const dialog = await previewOf(PLAN)
  await click(button(dialog, /^Clear$/))
  expect(button(dialog, /^Import$/).disabled).toBe(true)
  await click(button(dialog, /^Select all$/))
  expect(button(dialog, /^Import$/).disabled).toBe(false)
  const real = stream()
  answerWith(() => real.response)
  await click(button(dialog, /^Import$/))
  expect('include' in sentBody()).toBe(false)
})

it('storybook choose: a one-component plan has no checklist', async () => {
  const dialog = await previewOf(PLAN.slice(0, 1))
  expect(dialog.querySelector('[data-slot="storybook-choose"]')).toBeNull()
})

it('storybook starting: the bar is indeterminate until the first plan line, and the screen height is one value', async () => {
  const dialog = await previewOf(PLAN)
  const run = stream()
  answerWith(() => run.response)
  await click(button(dialog, /^Import$/))
  expect(dialog.querySelector('[role="progressbar"]')?.getAttribute('data-state')).toBe('indeterminate')
  expect(dialog.querySelector('[data-slot="import-screen"]')?.className ?? '').not.toContain('min-h')
  await run.send({ type: 'progress', rendered: 1, total: 12, component: 'Button' })
  expect(dialog.querySelector('[role="progressbar"]')?.getAttribute('data-state')).toBe('loading')
})

it('storybook cancel: the notice is a visible status callout', async () => {
  const dialog = await previewOf(PLAN)
  answerWith((s) => stream(s).response)
  await click(button(dialog, /^Import$/))
  await click(button(dialog, /^Cancel$/))
  expect(dialog.querySelector('[data-slot="storybook-cancelled"]')?.getAttribute('role')).toBe('status')
})

it('cli: once components have landed the command shows as used and a new one starts a new count', async () => {
  openCanvas([component('old')])
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  expect(dialog.querySelector('[data-slot="code-block"]')).not.toBeNull()
  await act(async () => {
    openCanvas([component('old'), component('new-1')])
  })
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toBe(
    'Used. Make a new command to import again.',
  )
  expect(dialog.querySelector('[data-slot="cli-command-spent"]')?.textContent).toContain(TICKET.command)
  expect(dialog.querySelector('[data-slot="code-block"]')).toBeNull()
  expect(dialog.textContent).toContain('1 component arrived')

  await click(button(dialog, /New command/))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(dialog.querySelector('[data-slot="code-block"]')).not.toBeNull()
  expect(dialog.textContent).not.toContain('arrived')
  expect(dialog.querySelector('[data-slot="cli-expiry"]')?.textContent).toContain('Works once')
})

it('cli: New command is there while the command is still good', async () => {
  answerWith(() => Response.json({ ...TICKET, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }))
  const dialog = await show(<CliImportSection canvasId="canvas" onBack={onBack} onOpenPage={onOpenPage} />)
  await click(button(dialog, /New command/))
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('storybook rate limit: the hourly 429 shows the server message and the wait, not the busy copy', async () => {
  answerWith(() =>
    Response.json(
      { code: 'too_many', error: 'At most 3 Storybook imports an hour.' },
      { status: 429, headers: { 'Retry-After': '1800' } },
    ),
  )
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  const alert = dialog.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('At most 3 Storybook imports an hour.')
  expect(alert.textContent).toContain('You can try again in 30 minutes.')
  expect(alert.textContent).not.toContain('busy')
})

it('storybook busy: a real busy code keeps the busy copy', async () => {
  const run = stream()
  answerWith(() => run.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await run.send({ type: 'error', code: 'busy', message: 'renderer busy' })
  await run.end()
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Doop is busy with other imports')
})

it('storybook choose: the counts and renders in the header follow what is ticked', async () => {
  const dialog = await previewOf(PLAN)
  const preview = () => dialog.querySelector('[data-slot="storybook-preview"]')!.textContent ?? ''
  expect(preview()).toContain('12 renders to read')
  expect(preview()).toContain('1 component would be created')
  expect(preview()).toContain('1 component would be updated')
  const boxes = checkboxes(dialog)
  await click(boxes[0]!) // Inputs/Button: the one that would be created
  expect(preview()).toContain('6 renders to read')
  expect(preview()).not.toContain('component would be created')
  expect(preview()).toContain('1 component would be updated')
  await click(boxes[2]!) // Layout/Card: the one that would be updated
  expect(preview()).not.toContain('would be updated')
  expect(preview()).toContain('Nothing to import')
  expect(button(dialog, /^Import$/).disabled).toBe(true)
})

const BIG_PLAN = Array.from({ length: 70 }, (_, i) => ({
  name: `Part${i}`,
  group: `Kit/Part${i}`,
  stories: 1,
  renders: 2,
}))

async function bigPreview() {
  const dry = stream()
  answerWith(() => dry.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await dry.send({ type: 'plan', components: BIG_PLAN, renders: 140, total: 211, capped: true })
  await dry.send({
    type: 'result',
    result: { ...RESULT, created: BIG_PLAN.map((c) => ({ name: c.name, id: c.name })) },
  })
  await dry.end()
  return dialog
}

it('storybook large plan: says how many were found, preselects the first 60, and stops at 60', async () => {
  const dialog = await bigPreview()
  expect(dialog.querySelector('[data-slot="storybook-found"]')?.textContent).toBe(
    '211 components found. Pick up to 60.',
  )
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('60 of 70 selected')
  const boxes = checkboxes(dialog)
  expect(boxes.slice(0, 60).every((b) => b.checked)).toBe(true)
  expect(boxes.slice(60).every((b) => !b.checked && b.disabled)).toBe(true)
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('most one import takes')
  // freeing one lets another be picked
  await click(boxes[0]!)
  expect(checkboxes(dialog)[60]!.disabled).toBe(false)
  await click(checkboxes(dialog)[60]!)
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('60 of 70 selected')
  // the import names the ticked titles
  const real = stream()
  answerWith(() => real.response)
  await click(button(dialog, /^Import$/))
  const include = sentBody().include as string[]
  expect(include).toHaveLength(60)
  expect(include).toContain('Kit/Part60')
  expect(include).not.toContain('Kit/Part0')
})

it('storybook large plan: a filter field narrows the list, and Select all takes what it shows', async () => {
  const dialog = await bigPreview()
  await click(button(dialog, /^Clear$/))
  await type(dialog.querySelector('[data-slot="search-field"] input')!, 'Part6')
  const rows = Array.from(dialog.querySelectorAll('[data-slot="storybook-choose"] label')).filter((l) =>
    l.querySelector('input[type="checkbox"]'),
  )
  expect(rows.map((r) => r.textContent)).toEqual([
    'Kit/Part6',
    'Kit/Part60',
    'Kit/Part61',
    'Kit/Part62',
    'Kit/Part63',
    'Kit/Part64',
    'Kit/Part65',
    'Kit/Part66',
    'Kit/Part67',
    'Kit/Part68',
    'Kit/Part69',
  ])
  await click(button(dialog, /^Select all$/))
  expect(dialog.querySelector('[data-slot="selection-bar"]')?.textContent).toContain('11 of 70 selected')
})

it('storybook done: notes are grouped by kind in plain words, with the raw lines folded away', async () => {
  const run = stream()
  answerWith(() => run.response)
  const dialog = await startStorybook()
  await type(dialog.querySelector('#storybook-url')!, 'https://storybook.acme.com')
  await click(button(dialog, /^Preview$/))
  await run.send({
    type: 'result',
    result: {
      ...RESULT,
      issues: [
        ...['as', 'size', 'variant'].map((prop) => ({
          component: 'Button',
          code: 'argtypes_dropped',
          message: `${prop}: it has no control Doop can read`,
        })),
        { component: 'Card', code: 'unsafe_css', message: 'a rule with url(javascript:) was removed' },
        { component: 'Card', code: 'something_new', message: 'a future note' },
      ],
    },
  })
  await run.end()
  // a dry run ends on the preview: run the real import to reach the result
  const real = stream()
  answerWith(() => real.response)
  await click(button(dialog, /^Import$/))
  await real.send({
    type: 'result',
    result: {
      ...RESULT,
      issues: [
        ...['as', 'size', 'variant'].map((prop) => ({
          component: 'Button',
          code: 'argtypes_dropped',
          message: `${prop}: it has no control Doop can read`,
        })),
        { component: 'Card', code: 'unsafe_css', message: 'a rule with url(javascript:) was removed' },
        { component: 'Card', code: 'something_new', message: 'a future note' },
      ],
    },
  })
  await real.end()
  const issues = dialog.querySelector('[data-slot="storybook-issues"]')!
  const summary = issues.querySelector('ul')!.textContent ?? ''
  expect(summary).toContain('3 props skipped because Storybook has no control for them')
  expect(summary).toContain('1 style rule or import was left out')
  expect(summary).toContain('1 other note')
  expect(summary).toContain('1 component was skipped')
  expect(summary).not.toContain('it has no control Doop can read')
  expect(issues.querySelector('[data-slot="disclosure"]')?.textContent).toContain(
    'Button: as: it has no control Doop can read',
  )
})
