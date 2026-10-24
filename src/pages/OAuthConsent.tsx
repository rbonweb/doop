import { useEffect, useState } from 'react'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'

export function OAuthConsent({ email }: { email: string }) {
  const code = new URLSearchParams(location.search).get('consent_code') ?? ''
  const [client, setClient] = useState<{ name: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const endpoint = `/api/mcp-consent/${encodeURIComponent(code)}`

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('This connection request has expired. Start again from your agent.')
        return res.json() as Promise<{ name: string }>
      })
      .then(setClient)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the connection.')
      })
    return () => controller.abort()
  }, [endpoint])

  async function respond(accept: boolean) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept }),
      })
      if (!res.ok) throw new Error('Could not finish connecting. Start again from your agent.')
      const result = (await res.json()) as { redirectURI: string }
      location.assign(result.redirectURI)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish connecting.')
      setBusy(false)
    }
  }

  return (
    <AuthScreen>
      <AuthCard title={client ? `Connect ${client.name}?` : 'Connect your agent'}>
        <AuthCardText className="break-all">Signed in as {email}</AuthCardText>
        <AuthCardText>
          This agent will be able to read your profile and read, create, edit and delete designs on the canvases you can
          access. Its changes will be attributed to your account.
        </AuthCardText>
        {error && <Callout tone="error">{error}</Callout>}
        <div className="flex justify-end gap-2">
          <Button disabled={!client || busy} onClick={() => void respond(false)}>
            Cancel
          </Button>
          <Button variant="solid" disabled={!client || busy} onClick={() => void respond(true)}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </AuthCard>
    </AuthScreen>
  )
}
