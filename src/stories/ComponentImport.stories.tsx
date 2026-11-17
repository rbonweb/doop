import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import type { Canvas } from '../../shared/types'
import { CliImportSection } from '@/components/CliImportSection'
import { StorybookImportSection, type StorybookPhase } from '@/components/StorybookImportSection'
import { Modal } from '@/components/ui/modal'
import type { ImportResult } from '@/lib/componentImport'
import { useStore } from '@/lib/store'

const meta = { title: 'Screens/Import components' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

const noop = () => {}

const RESULT: ImportResult = {
  created: ['Button', 'Input', 'Select', 'Card', 'Badge'].map((name) => ({ name, id: name })),
  updated: [{ name: 'Tabs', id: 'Tabs' }],
  unchanged: [{ name: 'Avatar', id: 'Avatar' }],
  skipped: [{ name: 'Tooltip', reason: 'it only renders inside a portal' }],
  tokens: { created: ['--brand', '--radius'], skipped: [] },
  pageId: 'imported',
  issues: [
    ...['as', 'size', 'asChild'].map((prop) => ({
      component: 'Tabs',
      code: 'argtypes_dropped',
      message: `${prop}: it has no control Doop can read`,
    })),
    { component: 'Tabs', code: 'css_rules_dropped', message: 'a :has() rule was dropped' },
  ],
}

function Storybook({ phase, url = 'https://storybook.acme.com' }: { phase: StorybookPhase; url?: string }) {
  return (
    <Modal size="xl" className="sm:max-w-[820px]" onClose={noop}>
      <StorybookImportSection
        canvasId="canvas"
        onBack={noop}
        onUseCli={noop}
        onOpenPage={noop}
        initialPhase={phase}
        initialUrl={url}
      />
    </Modal>
  )
}

export const StorybookIdle: Story = { render: () => <Storybook phase={{ kind: 'idle' }} url="" /> }

const PLAN = ['Inputs/Button', 'Inputs/Select', 'Inputs/Checkbox', 'Layout/Card', 'Layout/Stack', 'Feedback/Toast'].map(
  (group) => ({ name: group.split('/')[1]!, group, stories: 3, renders: 7 }),
)

export const StorybookPreview: Story = {
  render: () => <Storybook phase={{ kind: 'preview', plan: PLAN, result: RESULT }} />,
}

/** One component: nothing to narrow, so the preview has no checklist. */
/** 211 components found: the first 60 are ticked, the rest wait behind the cap, and a filter narrows the list. */
export const StorybookLargePlan: Story = {
  render: () => (
    <Storybook
      phase={{
        kind: 'preview',
        found: 211,
        plan: Array.from({ length: 80 }, (_, i) => ({
          name: `Part${i}`,
          group: `${['Inputs', 'Layout', 'Feedback', 'Data'][i % 4]}/Part${i}`,
          stories: 2,
          renders: 5,
        })),
        result: { ...RESULT, created: Array.from({ length: 80 }, (_, i) => ({ name: `Part${i}`, id: `p${i}` })) },
      }}
    />
  ),
}

export const StorybookRateLimited: Story = {
  render: () => (
    <Storybook
      phase={{
        kind: 'refused',
        code: 'rate_limited',
        message: 'At most 3 Storybook imports an hour.',
        retryAfter: 1800,
      }}
    />
  ),
}

export const StorybookPreviewSingle: Story = {
  render: () => <Storybook phase={{ kind: 'preview', plan: PLAN.slice(0, 1), result: RESULT }} />,
}

export const StorybookStarting: Story = {
  render: () => <Storybook phase={{ kind: 'running', rendered: 0, total: 0, component: null }} />,
}

export const StorybookCancelled: Story = { render: () => <Storybook phase={{ kind: 'idle', cancelled: true }} /> }

export const StorybookFailed: Story = {
  render: () => (
    <Storybook
      phase={{ kind: 'refused', code: 'invalid', message: 'The story “Button/Primary” threw while rendering.' }}
    />
  ),
}

export const StorybookRunning: Story = {
  render: () => <Storybook phase={{ kind: 'running', rendered: 12, total: 34, component: 'Select' }} />,
}

export const StorybookDone: Story = { render: () => <Storybook phase={{ kind: 'done', result: RESULT }} /> }

export const StorybookPrivate: Story = {
  render: () => <Storybook phase={{ kind: 'refused', code: 'private', message: '' }} url="https://internal.acme.com" />,
}

const storyComponent = (id: string, rev: number, origin?: 'cli') => ({
  id,
  name: id,
  rev,
  props: [],
  slots: [],
  history: [],
  ...(origin ? { code: { exportName: id, origin: { kind: origin } } } : {}),
})

/* the story answers the ticket route itself, so the card runs its whole flow with no server */
function Cli({ lifetimeMs, landed = false }: { lifetimeMs: number; landed?: boolean }) {
  /* the card reads the canvas and asks for its ticket as it opens, before any effect of this wrapper runs,
     so the store and the fake route are in place first */
  const [real] = useState(() => {
    const original = window.fetch
    useStore.setState({ canvas: { id: 'canvas', components: [storyComponent('Existing', 1)] } as unknown as Canvas })
    window.fetch = async (input, init) => {
      if (!String(input).includes('/component-import/ticket')) return original(input, init)
      return Response.json({
        upload_url: 'https://doop.design/import/Zk3x9P',
        expires_at: new Date(Date.now() + lifetimeMs).toISOString(),
        command:
          'npx --yes --allow-remote=all https://doop.design/cli/doop-import-0.1.0.tgz --storybook ./storybook-static --ticket https://doop.design/import/Zk3x9P',
        curl: 'curl -T bundle.json https://doop.design/import/Zk3x9P',
      })
    }
    return original
  })
  useEffect(() => {
    const arrive = landed
      ? window.setTimeout(
          () =>
            useStore.setState({
              canvas: {
                id: 'canvas',
                components: [
                  storyComponent('Existing', 1),
                  storyComponent('Button', 1, 'cli'),
                  storyComponent('Card', 1, 'cli'),
                ],
              } as unknown as Canvas,
            }),
          600,
        )
      : undefined
    return () => {
      window.fetch = real
      window.clearTimeout(arrive)
      useStore.setState({ canvas: null })
    }
  }, [real, landed])
  return (
    <Modal size="xl" className="sm:max-w-[820px]" onClose={noop}>
      <CliImportSection canvasId="canvas" onBack={noop} onOpenPage={noop} />
    </Modal>
  )
}

export const CliTicket: Story = { render: () => <Cli lifetimeMs={15 * 60_000} /> }
export const CliExpired: Story = { render: () => <Cli lifetimeMs={-1000} /> }
/** The command was used: its components landed, so it shows dimmed and a new one is offered. */
export const CliComponentsLanded: Story = { render: () => <Cli lifetimeMs={14 * 60_000} landed /> }
