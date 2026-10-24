import { useEffect, useMemo, useState } from 'react'
import { authClient } from '../lib/auth'
import { desktopAuthDeepLink, parseDesktopHandoffQuery } from '../lib/desktopAuth'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'

/* Step 2 of the desktop sign-in (src/lib/desktopAuth.ts): the system browser
   lands here signed in, after the identity provider. Mint a one-time token
   from this session and hand it to the app over the doop:// scheme. The
   token is single-use and expires within minutes, so the link is safe to
   leave in the browser's history. The challenge travels along unchanged: the
   app only redeems a link that answers the sign-in it started. */
export function DesktopHandoff() {
  const request = useMemo(() => parseDesktopHandoffQuery(location.search), [])
  const [link, setLink] = useState<string | null>(null)
  const [mintFailed, setMintFailed] = useState(false)
  const failed = mintFailed || request === null

  useEffect(() => {
    if (!request) return
    authClient.oneTimeToken
      .generate()
      .then((res) => {
        const token = res.data?.token
        if (!token) {
          setMintFailed(true)
          return
        }
        const url = desktopAuthDeepLink(token, request.challenge, request.to)
        setLink(url)
        location.assign(url)
      })
      .catch(() => setMintFailed(true))
  }, [request])

  return (
    <AuthScreen>
      <AuthCard title={failed ? 'Something went wrong.' : "You're signed in."}>
        {failed ? (
          <Callout tone="error">
            Could not hand the sign-in over to the doop app. Go back to the app and try again.
          </Callout>
        ) : (
          <>
            <AuthCardText>Sending you back to the doop app… You can close this tab afterwards.</AuthCardText>
            {link && (
              <Button asChild className="mt-1">
                <a href={link}>Open doop</a>
              </Button>
            )}
          </>
        )}
      </AuthCard>
    </AuthScreen>
  )
}
