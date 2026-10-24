import { navigate } from '../App'
import { ConnectModal } from '../components/ConnectModal'
import { Button } from '../components/ui/button'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { parseCodexSetup } from '../lib/codexConnection'

export function DesktopCodexSetup() {
  const request = parseCodexSetup(location.search, location.origin)
  if (!request) {
    return (
      <AuthScreen>
        <AuthCard title="Open the matching Doop server">
          <AuthCardText>
            This setup link is for a different Doop server or is incomplete. Open Connect AI in the desktop app for that
            server, or use the manual Codex setup in your browser.
          </AuthCardText>
          <Button className="self-start" onClick={() => navigate('/')}>
            Back to Doop
          </Button>
        </AuthCard>
      </AuthScreen>
    )
  }
  return (
    <ConnectModal
      initialAgent="codex"
      showAgentStatus={false}
      canvasId={request.canvasId}
      onClose={() => navigate(request.canvasId ? `/c/${request.canvasId}` : '/')}
    />
  )
}
