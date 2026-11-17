import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import type { ComponentDef } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { ExportReactDialog } from '@/components/ExportReactDialog'
import { Button } from '@/components/ui/button'

const meta = { title: 'Screens/Export to React' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

const frame = (id: string, name: string): Frame => ({
  id,
  canvasId: 'canvas',
  name,
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
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

const COMPONENTS = ['Button', 'Card', 'Nav bar', 'Pricing tier', 'Input'].map((name, i) => component(`c${i}`, name))

/* the story answers the export route itself, so the dialog runs its whole flow with no server */
function useFakeExportRoute(outcome: 'ok' | 'issues' | 'error') {
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      if (!String(input).includes('/export/react')) return real(input, init)
      await new Promise((resolve) => setTimeout(resolve, 900))
      if (outcome === 'error') return Response.json({ error: 'Frame “Home” could not be read.' }, { status: 422 })
      return new Response(new Blob(['PK']), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="Acme-react.zip"',
          'X-Doop-Export-Issues': outcome === 'issues' ? '3' : '0',
        },
      })
    }
    return () => {
      window.fetch = real
    }
  }, [outcome])
}

function Demo({ outcome, selected }: { outcome: 'ok' | 'issues' | 'error'; selected: boolean }) {
  const [open, setOpen] = useState(true)
  useFakeExportRoute(outcome)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Export to React…</Button>
      {open && (
        <ExportReactDialog
          canvasId="canvas"
          frames={selected ? [frame('f1', 'Home')] : []}
          page={{ id: 'page1', name: 'Marketing site', frameCount: 4 }}
          components={COMPONENTS}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

export const FrameSelected: Story = { render: () => <Demo outcome="ok" selected /> }
export const NothingSelected: Story = { render: () => <Demo outcome="issues" selected={false} /> }
export const Fails: Story = { render: () => <Demo outcome="error" selected /> }
