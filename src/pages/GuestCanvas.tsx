import { useEffect, useState } from 'react'
import { api, type PublicGate } from '../lib/api'
import { AuthPage } from './AuthPage'
import { CanvasPage } from './CanvasPage'
import { PresenterWindow } from '../components/PresenterView'
import { PasswordGate } from '../components/AccessScreens'
import { AuthScreen } from '../components/ui/screen'

/**
 * What a signed-out visitor sees at /c/<id>. The server says whether the share
 * link admits guests (the canvas opens, as a commenter at most), asks for the
 * link password first, or has nothing public here — in which case the page is
 * the sign-in form, exactly as for a private canvas. Missing and private
 * canvases look the same on purpose.
 */
export function GuestCanvas({ canvasId }: { canvasId: string }) {
  const [mode, setMode] = useState<PublicGate['mode'] | null>(null)
  const [signIn, setSignIn] = useState(() => new URLSearchParams(location.search).has('signin'))
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    api
      .publicGate(canvasId)
      .then((gate) => live && setMode(gate.mode))
      .catch(() => live && setMode('signin'))
    return () => {
      live = false
    }
  }, [canvasId, attempt])

  if (signIn || mode === 'signin') return <AuthPage />
  if (mode === null) return <AuthScreen />
  if (mode === 'password') {
    return (
      <PasswordGate canvasId={canvasId} onUnlocked={() => setAttempt((n) => n + 1)} onSignIn={() => setSignIn(true)} />
    )
  }
  /* the presenter's own window (opened from a presentation) is open to guests as well, once the gate has let them in */
  if (new URLSearchParams(location.search).has('presenter')) return <PresenterWindow canvasId={canvasId} />
  return <CanvasPage canvasId={canvasId} guestEntry />
}
