import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceRole, WorkspaceSummary } from '../../shared/types'
import { formatUsd, STATUS_LABELS, TEAM_SEAT_PRICE } from '../../shared/billing'
import { navigate } from '../App'
import { api, errorMessage, paywalledWorkspace } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { AppRail, railLayout } from '../components/AppRail'
import { UpgradeModal } from '../components/WorkspaceModals'
import { Avatar } from '../components/ui/avatar'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { CardBody, CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from '../components/ui/card'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { PersonRow } from '../components/ui/list'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import { ChevronRightIcon, CreditCardIcon, GearIcon, UsersIcon } from '../components/ui/icons'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'
import { timeAgo } from '../lib/time'

type Pane = 'members' | 'billing' | 'general'

/**
 * One workspace's settings, in the dashboard shell: who is in it, what it
 * costs, and the name. Stripe's hosted pages do the money — this page only
 * opens them and mirrors what they did. It is also where Checkout lands
 * back (?checkout=success), so the plan takes effect on the screen they see.
 */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const { data: session } = authClient.useSession()
  const meId = session?.user.id
  const [ws, setWs] = useState<WorkspaceDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [upgrade, setUpgrade] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /* the checkout round-trip lands here with its outcome in the query; read
     once, then clean the URL in the effect below */
  const [landing] = useState(() => {
    const q = new URLSearchParams(location.search)
    return { checkout: q.get('checkout'), sessionId: q.get('session_id') ?? undefined }
  })
  const [pane, setPane] = useState<Pane>(landing.checkout ? 'billing' : 'members')

  /* the rail's workspace list, reloaded with the workspace so a rename or a
     new plan shows in its row too */
  const [spaces, setSpaces] = useState<WorkspaceSummary[] | undefined>(undefined)

  const reload = useCallback(() => {
    api
      .getWorkspace(workspaceId)
      .then(setWs)
      .catch(() => setMissing(true))
    api
      .listWorkspaces()
      .then((w) => setSpaces(w.workspaces))
      .catch(console.error)
  }, [workspaceId])

  useEffect(() => {
    if (landing.checkout) history.replaceState(null, '', location.pathname)
    if (landing.checkout === 'success') {
      /* pull the subscription now rather than wait for the webhook */
      api
        .syncWorkspaceBilling(workspaceId, landing.sessionId)
        .then((summary) => {
          if (summary.active && summary.plan) {
            posthog.capture('workspace_plan_activated', { workspaceId, interval: summary.interval })
            showToast('Team plan is active — welcome aboard')
          }
        })
        .catch(console.error)
        .finally(reload)
    } else {
      if (landing.checkout === 'canceled') showToast('Checkout canceled — nothing was charged')
      reload()
    }
  }, [landing, workspaceId, reload])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }

  /** every 402 on this page means the same thing */
  function handle(caught: unknown, fallback: string) {
    const walled = paywalledWorkspace(caught)
    if (walled) setUpgrade(`"${ws?.name ?? 'This workspace'}" needs a plan first.`)
    else showToast(errorMessage(caught, fallback))
  }

  const admin = ws ? ws.role !== 'member' : false
  const isOwner = ws?.role === 'owner'

  if (missing) {
    return (
      <DashLayout className={railLayout}>
        <AppRail active={null} />
        <DashMain className="[background:var(--paper)]">
          <DashHeader variant="bare" />
          <DashContent>
            <DashTitle>Workspace not found</DashTitle>
            <DashSubtitle>It may have been deleted, or you are no longer a member.</DashSubtitle>
            <Button className="mt-5" onClick={() => navigate('/')}>
              Back to canvases
            </Button>
          </DashContent>
        </DashMain>
      </DashLayout>
    )
  }

  return (
    <DashLayout className={railLayout}>
      {/* the app rail, lit on this workspace, with its panes as the page's group */}
      <AppRail active={`ws:${workspaceId}`} workspaces={spaces}>
        <DashSectionLabel density="rail">{ws?.name ?? 'Workspace'}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<UsersIcon size="rail" />}
            active={pane === 'members'}
            onClick={() => setPane('members')}
          >
            People
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<CreditCardIcon size="rail" />}
            active={pane === 'billing'}
            onClick={() => setPane('billing')}
          >
            Plan &amp; billing
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<GearIcon size="rail" />}
            active={pane === 'general'}
            onClick={() => setPane('general')}
          >
            General
          </DashNavItem>
        </nav>
      </AppRail>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <nav className="flex items-center gap-2 text-body text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-body font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <ChevronRightIcon size={12} />
            <b className="truncate font-semibold text-ink">{ws?.name ?? '…'}</b>
          </nav>
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div className="min-w-0">
              <DashTitle className="truncate">{ws?.name ?? '…'}</DashTitle>
              <DashSubtitle>
                {ws
                  ? `${ws.memberCount} ${ws.memberCount === 1 ? 'person' : 'people'} · ${ws.canvasCount} ${
                      ws.canvasCount === 1 ? 'canvas' : 'canvases'
                    } · ${ws.billing.enabled ? STATUS_LABELS[ws.status] : 'Self-hosted, included'}`
                  : '…'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList variant="card">
              <TabsTrigger value="members">People</TabsTrigger>
              <TabsTrigger value="billing">Billing</TabsTrigger>
              <TabsTrigger value="general">General</TabsTrigger>
            </TabsList>
          </Tabs>

          {ws && ws.billing.enabled && !ws.active && (
            <Callout className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="flex-1">
                <b>No plan yet.</b> Inviting people and adding canvases waits until this workspace is on Team.
                {ws.status === 'canceled' ? ' Your existing canvases stay open to everyone in it.' : ''}
              </span>
              {isOwner && (
                <Button variant="primary" size="sm" onClick={() => setUpgrade('')}>
                  {ws.status === 'canceled' ? 'Reactivate' : 'Choose a plan'}
                </Button>
              )}
            </Callout>
          )}
          {ws && ws.status === 'past_due' && (
            <Callout tone="error" className="mt-4">
              <b>The last payment failed.</b> Stripe is retrying; update the card in the billing portal to keep the
              plan.
            </Callout>
          )}

          {!ws ? (
            <Skeleton shape="card" className="mt-5 max-w-[1000px]" />
          ) : pane === 'members' ? (
            <MembersPane ws={ws} meId={meId} admin={admin} onChange={reload} onError={handle} onToast={showToast} />
          ) : pane === 'billing' ? (
            <BillingPane
              ws={ws}
              isOwner={isOwner}
              onUpgrade={() => setUpgrade('')}
              onSynced={reload}
              onToast={showToast}
            />
          ) : (
            <GeneralPane ws={ws} admin={admin} isOwner={isOwner} onChange={reload} onToast={showToast} />
          )}
        </DashContent>
      </DashMain>

      {upgrade !== null && (
        <UpgradeModal
          workspaceId={workspaceId}
          reason={upgrade || undefined}
          onClose={() => {
            setUpgrade(null)
            reload()
          }}
        />
      )}
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

/* ---- people ---- */

function MembersPane({
  ws,
  meId,
  admin,
  onChange,
  onError,
  onToast,
}: {
  ws: WorkspaceDetail
  meId?: string
  admin: boolean
  onChange: () => void
  onError: (caught: unknown, fallback: string) => void
  onToast: (message: string) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null)

  async function invite() {
    const clean = email.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const result = await api.inviteToWorkspace(ws.id, clean, role)
      posthog.capture('workspace_member_invited', { pending: 'invite' in result })
      if ('member' in result) onToast(`${result.member.name} is in`)
      else onToast(result.emailed ? `Invite emailed to ${clean}` : `${clean} joins when they sign up with that email`)
      setEmail('')
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t invite')
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(userId: string, next: WorkspaceRole) {
    try {
      await api.setWorkspaceRole(ws.id, userId, next)
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t change the role')
    }
  }

  async function remove(userId: string) {
    try {
      await api.removeWorkspaceMember(ws.id, userId)
      if (userId === meId) navigate('/')
      else onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t remove')
    }
  }

  async function revoke(inviteId: string) {
    try {
      await api.revokeWorkspaceInvite(ws.id, inviteId)
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t revoke the invite')
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          Everyone here opens every canvas in the workspace. Admins invite and remove people; the owner holds the
          billing.
          {ws.billing.enabled ? ' Each person is one seat.' : ''}
        </CardDescription>
        {admin && (
          <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
            <Input
              variant="well"
              className="flex-1"
              placeholder="Invite by email"
              type="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && invite()}
              aria-label="Email to invite"
            />
            <Select value={role} disabled={busy} onValueChange={(value) => setRole(value as WorkspaceRole)}>
              <SelectTrigger aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <RoleOptions />
            </Select>
            <Button variant="primary" className="justify-center" disabled={busy || !email.trim()} onClick={invite}>
              {busy ? 'Inviting…' : 'Invite'}
            </Button>
          </div>
        )}
      </CardHeader>
      <div>
        {ws.members.map((m) => {
          const self = m.userId === meId
          const isOwnerRow = m.role === 'owner'
          return (
            <CardRow
              key={m.userId}
              className="py-3"
              action={
                isOwnerRow ? (
                  <Badge tone="accent">owner</Badge>
                ) : admin ? (
                  <>
                    <Select value={m.role} onValueChange={(value) => changeRole(m.userId, value as WorkspaceRole)}>
                      <SelectTrigger size="sm" aria-label={`Role of ${m.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <RoleOptions />
                    </Select>
                    <Button
                      variant="bare-danger"
                      size="sm"
                      onClick={() => setRemoving({ userId: m.userId, name: self ? 'yourself' : m.name })}
                    >
                      {self ? 'Leave' : 'Remove'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Badge>{m.role}</Badge>
                    {self && (
                      <Button
                        variant="bare-danger"
                        size="sm"
                        onClick={() => setRemoving({ userId: m.userId, name: 'yourself' })}
                      >
                        Leave
                      </Button>
                    )}
                  </>
                )
              }
            >
              <PersonRow
                className="flex-1"
                avatar={<Avatar name={m.name} size={32} />}
                name={`${m.name}${self ? ' (you)' : ''}`}
                detail={`${m.email} · joined ${timeAgo(m.addedAt)}`}
              />
            </CardRow>
          )
        })}
        {ws.invites.length > 0 && (
          <CardBody className="border-t border-line-soft bg-paper/60">
            <span className="text-caption text-ink-faint">Waiting to sign up</span>
            {ws.invites.map((inv) => (
              <div key={inv.id} className="mt-2 flex items-center gap-3 text-body">
                <span className="min-w-0 flex-1 truncate">
                  {inv.email}{' '}
                  <span className="text-ink-faint">
                    · {inv.role} · invited by {inv.invitedByName}
                  </span>
                </span>
                <Button variant="bare" size="sm" onClick={() => revoke(inv.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </CardBody>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.userId === meId ? `Leave “${ws.name}”?` : `Remove ${removing?.name ?? ''}?`}
        description={
          removing?.userId === meId
            ? 'You lose access to every canvas in this workspace except the ones you own.'
            : 'They lose access to every canvas in this workspace except the ones they own. Their seat is released.'
        }
        confirmLabel={removing?.userId === meId ? 'Leave workspace' : 'Remove'}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing.userId)
          setRemoving(null)
        }}
      />
    </SettingsCard>
  )
}

/* ---- plan & billing ---- */

function BillingPane({
  ws,
  isOwner,
  onUpgrade,
  onSynced,
  onToast,
}: {
  ws: WorkspaceDetail
  isOwner: boolean
  onUpgrade: () => void
  onSynced: () => void
  onToast: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const perSeat = ws.interval ? TEAM_SEAT_PRICE[ws.interval] : TEAM_SEAT_PRICE.month
  const paid = ws.plan === 'team' && ws.status !== 'inactive'

  async function portal() {
    if (busy) return
    setBusy(true)
    try {
      posthog.capture('workspace_portal_opened')
      const { url } = await api.workspacePortal(ws.id)
      location.assign(url)
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t open the billing portal'))
      setBusy(false)
    }
  }

  async function sync() {
    if (busy) return
    setBusy(true)
    try {
      await api.syncWorkspaceBilling(ws.id)
      onSynced()
      onToast('Up to date with Stripe')
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t refresh'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>Plan &amp; billing</CardTitle>
        <CardDescription>
          {ws.billing.enabled
            ? 'Team is billed per seat: every person in the workspace, monthly or yearly. Seats follow the people list — add someone and the next invoice grows, remove them and it shrinks.'
            : 'Billing isn’t configured on this server. Workspaces are included on self-hosted doop; there is nothing to pay for here.'}
        </CardDescription>
      </CardHeader>
      <CardRow label="Plan">
        <b className="text-copy">{paid ? 'Team' : ws.billing.enabled ? 'Personal' : 'Self-hosted'}</b>
        {ws.billing.enabled && (
          <Badge
            tone={
              ws.status === 'active' || ws.status === 'trialing'
                ? 'accent'
                : ws.status === 'past_due'
                  ? 'banned'
                  : 'default'
            }
          >
            {STATUS_LABELS[ws.status]}
          </Badge>
        )}
        {ws.cancelAtPeriodEnd && ws.currentPeriodEnd && (
          <span className="text-label text-ink-faint">ends {new Date(ws.currentPeriodEnd).toLocaleDateString()}</span>
        )}
      </CardRow>
      {paid && (
        <>
          <CardRow label="Seats">
            <span className="text-copy">
              {ws.seats} × {formatUsd(perSeat)} = <b>{formatUsd(ws.seats * perSeat)}</b> per {ws.interval ?? 'month'}
            </span>
            {ws.seats !== ws.memberCount && (
              <span className="text-label text-ink-faint">
                ({ws.memberCount} {ws.memberCount === 1 ? 'person' : 'people'} now — Stripe catches up on the next
                invoice)
              </span>
            )}
          </CardRow>
          {ws.currentPeriodEnd && (
            <CardRow label={ws.cancelAtPeriodEnd ? 'Ends' : 'Renews'}>
              <span className="text-copy">{new Date(ws.currentPeriodEnd).toLocaleDateString()}</span>
            </CardRow>
          )}
        </>
      )}
      {ws.billing.enabled && (
        <CardRow label="Manage">
          {isOwner ? (
            <>
              {!ws.active || !paid ? (
                <Button variant="primary" onClick={onUpgrade}>
                  {ws.status === 'canceled' ? 'Reactivate on Team' : 'Choose a plan'}
                </Button>
              ) : null}
              {ws.billing.portal && (
                <Button onClick={portal} disabled={busy}>
                  {busy ? 'Opening…' : 'Manage billing on Stripe'}
                </Button>
              )}
              {ws.billing.portal && (
                <Button variant="ghost" onClick={sync} disabled={busy}>
                  Refresh
                </Button>
              )}
              <span className="text-label text-ink-faint">Cards, invoices, cancelling — all on Stripe’s portal.</span>
            </>
          ) : (
            <span className="text-body text-ink-soft">The owner holds the billing; only they can change the plan.</span>
          )}
        </CardRow>
      )}
    </SettingsCard>
  )
}

/* ---- general ---- */

function GeneralPane({
  ws,
  admin,
  isOwner,
  onChange,
  onToast,
}: {
  ws: WorkspaceDetail
  admin: boolean
  isOwner: boolean
  onChange: () => void
  onToast: (message: string) => void
}) {
  const [name, setName] = useState(ws.name)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function rename() {
    const clean = name.trim()
    if (!clean || clean === ws.name || busy) return
    setBusy(true)
    try {
      await api.renameWorkspace(ws.id, clean)
      onChange()
      onToast('Renamed')
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t rename'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteWorkspace(ws.id)
      posthog.capture('workspace_deleted')
      navigate('/')
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t delete the workspace'))
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>The name everyone sees in their sidebar and on canvases filed here.</CardDescription>
        </CardHeader>
        <CardRow
          label="Name"
          action={
            admin ? (
              <Button size="sm" disabled={busy || !name.trim() || name.trim() === ws.name} onClick={rename}>
                Save
              </Button>
            ) : undefined
          }
        >
          <Input
            variant="well"
            className="max-w-[360px]"
            value={name}
            maxLength={80}
            disabled={!admin || busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && rename()}
            aria-label="Workspace name"
          />
        </CardRow>
        <CardRow label="Created">
          <span className="text-body text-ink-soft">{timeAgo(ws.createdAt)}</span>
        </CardRow>
      </SettingsCard>
      {isOwner && (
        <SettingsCard tone="flat" className="border-accent-ink/30">
          <CardHeader>
            <CardTitle className="text-accent-ink">Delete workspace</CardTitle>
            <CardDescription>
              Every canvas goes back to the personal space of whoever owns it — nothing is deleted. People lose access
              to canvases that aren’t theirs.
              {ws.billing.enabled && ws.plan ? ' The Team subscription is canceled immediately.' : ''}
            </CardDescription>
          </CardHeader>
          <CardBody>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete “{ws.name}”
            </Button>
          </CardBody>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${ws.name}”?`}
        description="Canvases return to their owners and the subscription ends now. This can’t be undone."
        confirmLabel="Delete workspace"
        destructive
        onConfirm={() => {
          setConfirmDelete(false)
          void remove()
        }}
      />
    </>
  )
}

/** The roles an admin can hand out; the owner is not one of them. */
function RoleOptions() {
  return (
    <SelectContent>
      <SelectItem value="member">Member</SelectItem>
      <SelectItem value="admin">Admin</SelectItem>
    </SelectContent>
  )
}
