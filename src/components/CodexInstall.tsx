import { useState } from 'react'
import { addToCodex, canAddToCodex, codexDesktopLink } from '../lib/codexConnection'
import { isDesktopShell } from '../lib/shell'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { InstallBlock } from './ui/install-block'

export function CodexInstall({ mcpUrl, canvasId }: { mcpUrl: string; canvasId?: string }) {
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle')
  const [error, setError] = useState('')

  async function connect() {
    setState('adding')
    setError('')
    try {
      await addToCodex()
      setState('added')
      posthog.capture('codex_connection_configured')
    } catch (err) {
      setState('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const manual = (
    <>
      <p>Run this in a terminal with Codex CLI installed:</p>
      <CodeBlock text={`codex mcp add doop --url ${mcpUrl}`} className="mt-2" />
    </>
  )

  if (canAddToCodex()) {
    return (
      <InstallBlock
        action={
          <Button variant="solid" disabled={state !== 'idle'} onClick={() => void connect()}>
            {state === 'adding' ? 'Adding Doop…' : state === 'added' ? 'Added to Codex' : 'Add to Codex'}
          </Button>
        }
        status={state === 'added' && 'Doop is configured. Open a new Codex chat, then sign in to Doop when prompted.'}
        error={error}
        manual={manual}
      />
    )
  }
  if (isDesktopShell()) {
    return (
      <InstallBlock
        action={<p>Update Doop Desktop to add Codex directly, or use the manual setup below.</p>}
        manual={manual}
      />
    )
  }
  return (
    <InstallBlock
      action={
        <Button asChild variant="solid">
          <a
            href={codexDesktopLink(new URL(mcpUrl).origin, canvasId)}
            onClick={() => posthog.capture('codex_desktop_setup_opened')}
          >
            Open Doop Desktop
          </a>
        </Button>
      }
      status="Requires the updated Doop desktop app. Click Add to Codex there to finish setup. If the app doesn’t open, use the manual setup below."
      manual={manual}
    />
  )
}
