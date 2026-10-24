import { useEffect, useState } from 'react'
import { adminApi, ApiError, type AdminInvite } from '../lib/api'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { CardBody, CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Input } from './ui/input'

function errorText(e: unknown, fallback: string): string {
  return e instanceof ApiError && typeof e.body.error === 'string' ? e.body.error : fallback
}

/** Copies, or selects the text for a manual copy where the clipboard is closed. */
async function copy(text: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    field?.select()
    return false
  }
}

/**
 * Accounts on an invite-only instance come from here: an admin makes a link
 * for one address and sends it however they like (there may be no mail
 * server). The link opens the sign-up form for that address only, works
 * once, and lapses after a week.
 */
export function InvitesCard() {
  const [invites, setInvites] = useState<AdminInvite[] | null>(null)
  const [email, setEmail] = useState('')
  const [made, setMade] = useState<AdminInvite | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<AdminInvite | null>(null)

  useEffect(() => {
    adminApi.invites().then(setInvites, () => setInvites([]))
  }, [])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const invite = await adminApi.invite(email)
      setMade(invite)
      setEmail('')
      setInvites((list) => [invite, ...(list ?? []).filter((i) => i.email !== invite.email)])
    } catch (err) {
      setError(errorText(err, 'The invite could not be made.'))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(invite: AdminInvite) {
    try {
      await adminApi.revokeInvite(invite.email)
      setInvites((list) => (list ?? []).filter((i) => i.email !== invite.email))
      if (made?.email === invite.email) setMade(null)
    } catch (err) {
      setError(errorText(err, 'The invite could not be cancelled.'))
    }
  }

  async function copyLink(invite: AdminInvite, field: HTMLInputElement | null) {
    if (await copy(invite.link, field)) setCopied(invite.email)
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>
          Nobody can sign up here on their own. Make a link for their email and send it to them: it opens the sign-up
          form for that address, works once, and expires in 7 days.
        </CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={create}>
          <Input
            variant="well"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            aria-label="Email to invite"
            className="sm:flex-1"
          />
          <Button variant="primary" size="md" type="submit" disabled={busy}>
            {busy ? '…' : 'Make invite link'}
          </Button>
        </form>
        {error && <Callout tone="error">{error}</Callout>}
        {made && (
          <Callout tone="success">
            Send this link to {made.email}:
            <InviteLinkRow invite={made} copied={copied === made.email} onCopy={copyLink} />
          </Callout>
        )}
      </CardBody>
      {invites && invites.length > 0 && (
        <div className="border-t border-line-soft">
          <div className="px-4 pb-1 pt-3 text-label font-medium text-ink-soft sm:px-[22px]">Waiting to sign up</div>
          {invites.map((invite) => (
            <CardRow
              key={invite.email}
              action={
                <>
                  <Button variant="ghost" size="sm" onClick={() => void copyLink(invite, null)}>
                    {copied === invite.email ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setRevoking(invite)}>
                    Cancel
                  </Button>
                </>
              }
            >
              <div className="min-w-0 flex-1 text-copy">
                <span className="font-medium">{invite.email}</span>
                <span className="text-ink-faint">
                  {' '}
                  · expires{' '}
                  {new Date(invite.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · by{' '}
                  {invite.invitedBy}
                </span>
              </div>
            </CardRow>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
        title={`Cancel the invite for ${revoking?.email ?? ''}?`}
        description="Its link stops working."
        confirmLabel="Cancel invite"
        cancelLabel="Keep invite"
        destructive
        onConfirm={() => {
          if (revoking) void revoke(revoking)
        }}
      />
    </SettingsCard>
  )
}

function InviteLinkRow({
  invite,
  copied,
  onCopy,
}: {
  invite: AdminInvite
  copied: boolean
  onCopy: (invite: AdminInvite, field: HTMLInputElement | null) => Promise<void>
}) {
  const [field, setField] = useState<HTMLInputElement | null>(null)
  return (
    <div className="mt-1.5 flex gap-2">
      <Input
        ref={setField}
        variant="well"
        readOnly
        value={invite.link}
        aria-label={`Invite link for ${invite.email}`}
        onFocus={(e) => e.currentTarget.select()}
        className="flex-1 font-mono"
      />
      <Button variant="default" size="md" onClick={() => void onCopy(invite, field)}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
