import { cursorMcpInstallUrl } from '../lib/cursorConnection'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { InstallBlock } from './ui/install-block'

export function CursorInstall({ mcpUrl }: { mcpUrl: string }) {
  return (
    <InstallBlock
      action={
        <Button asChild variant="solid">
          <a href={cursorMcpInstallUrl(mcpUrl)}>Add to Cursor</a>
        </Button>
      }
      manualLabel="Connection help"
      manual={
        <>
          <p>
            If Cursor does not open, open its <strong>Customize</strong> panel and add a custom MCP server. Merge this{' '}
            <code>doop</code> entry into your MCP configuration, keeping any existing servers. If Doop is already
            connected through a plugin, use that connection.
          </p>
          <CodeBlock text={JSON.stringify({ mcpServers: { doop: { url: mcpUrl } } }, null, 2)} className="mt-2.5" />
        </>
      }
    />
  )
}
