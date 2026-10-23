import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { navigate } from '../App'
import { api, ApiError } from '../lib/api'
import { chooseGuestName, getIdentity } from '../lib/identity'
import { Button } from './ui/button'
import { CheckIcon, LockIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { AuthScreen } from './ui/screen'
import { Textarea } from './ui/textarea'
import { Wordmark } from './ui/wordmark'

/* The screens a visitor meets before a canvas opens: the password gate, the
   no-access page with its request form, and the one-time "who are you" prompt
   a guest answers before commenting. They share the canvas-not-found card. */

function GateCard({ children }: { children: ReactNode }) {
  return (
    <AuthScreen>
      <div className="flex w-[min(420px,100%)] animate-[modal-in_0.28s_cubic-bezier(0.2,0.9,0.3,1.1)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] text-center shadow-pop sm:p-9 sm:pb-8">
        <Wordmark className="mb-1.5 self-center" />
        {children}
      </div>
    </AuthScreen>
  )
}

function Seal({ children }: { children: ReactNode }) {
  return (
    <span className="mx-auto grid size-11 place-items-center rounded-full bg-paper-deep text-ink-soft">{children}</span>
  )
}

const heading = 'font-serif text-[27px] font-normal leading-[1.08] tracking-[-0.015em]'
const lede = 'text-[14px] leading-[1.5] text-ink-soft'

/** Ask for the link password. `onUnlocked` runs once the server has set the cookie. */
export function PasswordForm({
  canvasId,
  onUnlocked,
  autoFocus = true,
}: {
  canvasId: string
  onUnlocked: () => void
  autoFocus?: boolean
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(0)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.unlockCanvas(canvasId, password)
      onUnlocked()
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'Could not unlock this canvas.')
          : 'Could not unlock this canvas.',
      )
      setShake((n) => n + 1)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 text-left">
      <div key={shake} className={shake ? 'animate-[gate-shake_0.32s_ease]' : undefined}>
        <Input
          type="password"
          autoComplete="off"
          autoFocus={autoFocus}
          inputSize="lg"
          placeholder="Password"
          aria-label="Link password"
          aria-invalid={!!error}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {error && (
        <Note tone="error" size="sm" role="alert">
          {error}
        </Note>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={!password || busy}>
        {busy ? 'Opening…' : 'Open canvas'}
      </Button>
    </form>
  )
}

/** A signed-out visitor at a password-protected link. */
export function PasswordGate({
  canvasId,
  onUnlocked,
  onSignIn,
}: {
  canvasId: string
  onUnlocked: () => void
  onSignIn: () => void
}) {
  return (
    <GateCard>
      <Seal>
        <LockIcon width={20} height={20} aria-hidden />
      </Seal>
      <h1 className={heading}>This canvas is password protected</h1>
      <p className={lede}>Enter the password the owner shared with you to open it.</p>
      <PasswordForm canvasId={canvasId} onUnlocked={onUnlocked} />
      <Button variant="link" size="sm" className="self-center text-ink-soft" onClick={onSignIn}>
        Have an account? Sign in
      </Button>
    </GateCard>
  )
}

/** A signed-in person the server turned away: unlock with the password if the
 *  link offers one, or ask the owner. Checks back for an answer while it is open. */
export function NoAccess({ canvasId }: { canvasId: string }) {
  const [gate, setGate] = useState<{ passwordRequired: boolean; requested: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const look = () =>
      api
        .accessGate(canvasId)
        .then((g) => {
          if (!live) return
          if (g.access) return location.reload()
          setGate({ passwordRequired: !!g.passwordRequired, requested: !!g.requested })
        })
        .catch(() => {})
    void look()
    /* an owner who approves while this page is open lets the person straight in */
    const timer = window.setInterval(look, 5000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [canvasId])

  const requested = sent || gate?.requested

  async function request(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.requestAccess(canvasId, message.trim())
      setSent(true)
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'Could not send the request.')
          : 'Could not send the request.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <GateCard>
      <Seal>
        {requested ? <CheckIcon width={20} height={20} aria-hidden /> : <LockIcon width={20} height={20} aria-hidden />}
      </Seal>
      <h1 className={heading}>{requested ? 'Request sent' : 'You don’t have access to this canvas'}</h1>
      {requested ? (
        <p className={lede}>
          The owner has been told. This page opens the canvas as soon as they say yes, and we will email you too.
        </p>
      ) : (
        <>
          <p className={lede}>Ask the owner to let you in. Add a note so they know who you are.</p>
          <form onSubmit={request} className="flex flex-col gap-2.5 text-left">
            <Textarea
              rows={3}
              maxLength={500}
              placeholder="Optional message, e.g. “Hi, I’m on the checkout team.”"
              aria-label="Message to the owner"
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
            />
            {error && (
              <Note tone="error" size="sm" role="alert">
                {error}
              </Note>
            )}
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? 'Sending…' : 'Request access'}
            </Button>
          </form>
        </>
      )}
      {gate?.passwordRequired && !requested && (
        <div className="mt-1 flex flex-col gap-2 border-t border-line-soft pt-4 text-left">
          <p className="text-[12.5px] font-medium text-ink-soft">Have the link password?</p>
          <PasswordForm canvasId={canvasId} autoFocus={false} onUnlocked={() => location.reload()} />
        </div>
      )}
      <Button variant="link" size="sm" className="self-center text-ink-soft" onClick={() => navigate('/')}>
        Back to your canvases
      </Button>
    </GateCard>
  )
}

/** Asks a guest for the name their comments carry, once. */
export function GuestNamePrompt({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  function submit(event: FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) return
    chooseGuestName(clean)
    onDone(clean)
  }
  return (
    <Modal size="sm" onClose={onCancel}>
      <form onSubmit={submit}>
        <ModalTitle>Who’s commenting?</ModalTitle>
        <ModalLede>
          Your name is shown next to your comments, marked as a guest. You will only be asked once on this browser.
        </ModalLede>
        <Input
          ref={ref}
          className="mt-4"
          inputSize="lg"
          maxLength={40}
          placeholder={getIdentity().name}
          aria-label="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Continue
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
