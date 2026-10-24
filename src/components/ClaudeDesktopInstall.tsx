import { useState } from 'react'
import { addToClaudeDesktop, canAddToClaudeDesktop } from '../lib/claudeConnection'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { InstallBlock } from './ui/install-block'

export function ClaudeDesktopInstall({ mcpUrl }: { mcpUrl: string }) {
  const [state, setState] = useState<'idle' | 'opening' | 'opened'>('idle')
  const [error, setError] = useState('')

  async function connect() {
    setState('opening')
    setError('')
    try {
      await addToClaudeDesktop(mcpUrl)
      setState('opened')
      posthog.capture('claude_extension_opened')
    } catch (err) {
      setState('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <InstallBlock
      action={
        canAddToClaudeDesktop() ? (
          <Button variant="solid" disabled={state === 'opening'} onClick={() => void connect()}>
            {state === 'opening' ? 'Opening Claude…' : state === 'opened' ? 'Open Claude again' : 'Add to Claude'}
          </Button>
        ) : (
          <p>
            Open this server in an updated Doop desktop app to add Claude directly. In a browser, you can use the manual
            installation below.
          </p>
        )
      }
      status={state === 'opened' && 'Confirm the installation in Claude, then approve the Doop sign-in.'}
      error={error}
      manualLabel="Install manually"
      manual={
        <p>
          <a className="underline underline-offset-2" href="/claude-extension/doop.mcpb" download="doop.mcpb">
            Download extension
          </a>
          , then open it with Claude Desktop. Set <strong>Doop server URL</strong> to{' '}
          <code className="break-all">{mcpUrl}</code>. If the file doesn’t open, use Claude’s{' '}
          <strong>Settings → Extensions → Advanced settings → Install Extension</strong>.
        </p>
      }
    />
  )
}
