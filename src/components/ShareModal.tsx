import { useEffect, useState } from 'react'
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type AccessRequestInfo,
  type Canvas,
  type CommunityCategory,
  type DomainGrant,
  type LinkAccess,
  type LinkAudience,
  type MemberRole,
} from '../../shared/types'
import { navigate } from '../App'
import type { WorkspaceSummary } from '../../shared/types'
import { api, ApiError, paywalledWorkspace, type CanvasMember } from '../lib/api'
import { UpgradeModal } from './WorkspaceModals'
import { Sel } from './AutomateShell'
import { authClient } from '../lib/auth'
import { useStore } from '../lib/store'
import { posthog } from '../lib/posthog'
import { Avatar } from './ui/avatar'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { BuildingIcon, LockIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Label } from './ui/field'
import { Modal, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'

type ShareableCanvas = Pick<
  Canvas,
  | 'id'
  | 'name'
  | 'ownerId'
  | 'linkAccess'
  | 'linkAudience'
  | 'hasLinkPassword'
  | 'memberIds'
  | 'memberRoles'
  | 'workspaceId'
  | 'publishedAt'
  | 'description'
  | 'category'
>
type SharePatch = Partial<
  Pick<
    ShareableCanvas,
    | 'linkAccess'
    | 'linkAudience'
    | 'hasLinkPassword'
    | 'memberIds'
    | 'memberRoles'
    | 'workspaceId'
    | 'publishedAt'
    | 'description'
    | 'category'
  >
>

const ROLE_LABEL: Record<MemberRole, string> = { view: 'Can view', comment: 'Can comment', edit: 'Can edit' }
const ROLE_OPTIONS: MemberRole[] = ['view', 'comment', 'edit']

const LINK_OPTIONS: { value: LinkAccess; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'view', label: 'Can view' },
  { value: 'comment', label: 'Can comment' },
  { value: 'edit', label: 'Can edit' },
]

const AUDIENCE_OPTIONS: { value: LinkAudience; label: string }[] = [
  { value: 'signed-in', label: 'Anyone signed in to doop' },
  { value: 'anyone', label: 'Anyone with the link, no sign-in' },
  { value: 'password', label: 'Anyone with the password' },
]

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
  className,
}: {
  value: MemberRole
  onChange: (role: MemberRole) => void
  disabled?: boolean
  label: string
  className?: string
}) {
  return (
    <Sel
      className={className ?? 'w-[148px] flex-none'}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as MemberRole)}
    >
      {ROLE_OPTIONS.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role]}
        </option>
      ))}
    </Sel>
  )
}

const caption = 'mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint'

/* One sharing surface for the canvas and dashboard. The caller owns canvas
   state; this component reports optimistic access changes back to it. */
export function ShareModal({
  canvas,
  onChange,
  onClose,
  onCopied,
}: {
  canvas: ShareableCanvas
  onChange: (patch: SharePatch) => void
  onClose: () => void
  onCopied: () => void
}) {
  const { data: session } = authClient.useSession()
  const meId = session?.user?.id
  const isOwner = !!canvas.ownerId && canvas.ownerId === meId
  const linkAccess = canvas.linkAccess ?? 'none'
  const linkAudience = canvas.linkAudience ?? 'signed-in'
  const [people, setPeople] = useState<CanvasMember[] | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [upgrade, setUpgrade] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<MemberRole>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requests, setRequests] = useState<AccessRequestInfo[]>([])
  /* bumped by the room when someone asks while this dialog is open */
  const requestTick = useStore((s) => s.accessRequestTick)

  useEffect(() => {
    let active = true
    api
      .listMembers(canvas.id)
      .then((members) => active && setPeople(members))
      .catch(() => active && setPeople([]))
    api
      .listWorkspaces()
      .then((res) => active && setWorkspaces(res.workspaces))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [canvas.id])

  const workspace = canvas.workspaceId ? workspaces.find((w) => w.id === canvas.workspaceId) : undefined
  /* the owner, and the owner/admins of the canvas's workspace, answer requests */
  const canAnswer = isOwner || workspace?.role === 'owner' || workspace?.role === 'admin'

  useEffect(() => {
    if (!canAnswer) return
    let active = true
    api
      .listAccessRequests(canvas.id)
      .then((list) => active && setRequests(list))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [canvas.id, canAnswer, requestTick])

  function fail(caught: unknown, fallback: string) {
    setError(caught instanceof ApiError ? String(caught.body.error ?? fallback) : fallback)
  }

  async function move(target: string) {
    if (busy) return
    const workspaceId = target || null
    setBusy(true)
    setError(null)
    try {
      await api.moveCanvas(canvas.id, workspaceId)
      posthog.capture('canvas_moved', { into: !!workspaceId })
      onChange({ workspaceId: workspaceId ?? undefined })
    } catch (caught) {
      const walled = paywalledWorkspace(caught)
      if (walled) setUpgrade(walled)
      else fail(caught, 'move failed')
    } finally {
      setBusy(false)
    }
  }

  async function invite() {
    const clean = email.trim()
    if (!clean || busy || people === null) return
    setBusy(true)
    setError(null)
    try {
      const member = await api.inviteMember(canvas.id, clean, inviteRole)
      setPeople((current) => [...(current ?? []).filter((person) => person.userId !== member.userId), member])
      onChange({
        memberIds: canvas.memberIds?.includes(member.userId)
          ? canvas.memberIds
          : [...(canvas.memberIds ?? []), member.userId],
        memberRoles: withRole(canvas.memberRoles, member.userId, member.role === 'owner' ? 'edit' : member.role),
      })
      setRequests((current) => current.filter((r) => r.userId !== member.userId))
      setEmail('')
    } catch (caught) {
      fail(caught, 'invite failed')
    }
    setBusy(false)
  }

  async function changeRole(userId: string, role: MemberRole) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setMemberRole(canvas.id, userId, role)
      setPeople((current) => current?.map((p) => (p.userId === userId ? { ...p, role } : p)) ?? null)
      onChange({ memberRoles: withRole(canvas.memberRoles, userId, role) })
    } catch (caught) {
      fail(caught, 'role change failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(userId: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.removeMember(canvas.id, userId)
      setPeople((current) => current?.filter((person) => person.userId !== userId) ?? null)
      onChange({ memberIds: canvas.memberIds?.filter((id) => id !== userId) })
      if (userId === meId && !isOwner) navigate('/')
    } catch (caught) {
      fail(caught, 'removal failed')
    } finally {
      setBusy(false)
    }
  }

  async function answer(request: AccessRequestInfo, role: MemberRole | null) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (role) {
        await api.approveAccessRequest(canvas.id, request.userId, role)
        posthog.capture('access_request_approved', { role })
        const members = await api.listMembers(canvas.id)
        setPeople(members)
        onChange({
          memberIds: members.filter((m) => !m.owner).map((m) => m.userId),
          memberRoles: withRole(canvas.memberRoles, request.userId, role),
        })
      } else {
        await api.declineAccessRequest(canvas.id, request.userId)
        posthog.capture('access_request_declined')
      }
      setRequests((current) => current.filter((r) => r.userId !== request.userId))
    } catch (caught) {
      fail(caught, 'could not answer that request')
    } finally {
      setBusy(false)
    }
  }

  async function saveLink(patch: {
    linkAccess?: LinkAccess
    linkAudience?: LinkAudience
    linkPassword?: string | null
  }) {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      const state = await api.setLinkSettings(canvas.id, patch)
      onChange({
        linkAccess: state.linkAccess === 'none' ? undefined : state.linkAccess,
        linkAudience: state.linkAudience === 'signed-in' ? undefined : state.linkAudience,
        hasLinkPassword: state.hasLinkPassword || undefined,
      })
      return true
    } catch (caught) {
      fail(caught, 'access update failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(`${location.origin}/c/${canvas.id}`)
      posthog.capture('canvas_link_shared')
      onCopied()
    } catch {
      setError('Couldn’t copy the link. Copy the URL from your browser instead.')
    }
  }

  return (
    <Modal size="md" onClose={onClose}>
      <>
        <div className="flex items-start justify-between gap-3">
          <ModalTitle className="min-w-0">Share “{canvas.name}”</ModalTitle>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Close sharing" onClick={onClose}>
            <XIcon />
          </Button>
        </div>

        {requests.length > 0 && (
          <section
            aria-label="Access requests"
            className="mt-4 animate-[chip-in_0.25s_ease] rounded-[12px] border border-brand/40 bg-brand/[0.05] p-3"
          >
            <div className={caption}>
              {requests.length === 1
                ? '1 person is asking to get in'
                : `${requests.length} people are asking to get in`}
            </div>
            <div className="flex flex-col gap-2.5">
              {requests.map((request) => (
                <RequestRow
                  key={request.userId}
                  request={request}
                  busy={busy}
                  onAnswer={(role) => answer(request, role)}
                />
              ))}
            </div>
          </section>
        )}

        {isOwner && (
          <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
            <Input
              className="flex-1 rounded-[10px] bg-paper focus:ring-0"
              autoFocus
              placeholder="Invite by email (doop account)"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && invite()}
            />
            <RoleSelect
              value={inviteRole}
              onChange={setInviteRole}
              disabled={busy}
              label="Role for the invited person"
            />
            <Button
              variant="primary"
              className="justify-center"
              disabled={busy || people === null || !email.trim()}
              onClick={invite}
            >
              Invite
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mx-[2px] mt-2 text-[12px] text-accent-ink">
            {error}
          </p>
        )}

        <div className="mt-[14px] mb-1 flex max-h-[34vh] flex-col gap-[2px] overflow-y-auto">
          {(people ?? []).map((person) => (
            <div key={person.userId} className="flex items-center gap-2.5 px-[2px] py-1.5">
              <Avatar name={person.name} className="size-7 flex-none border-0 text-xs" />
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <b className="overflow-hidden whitespace-nowrap text-ellipsis text-[13px] font-semibold">
                  {person.name}
                  {person.userId === meId ? ' (you)' : ''}
                </b>
                {person.email && (
                  <span className="overflow-hidden whitespace-nowrap text-ellipsis text-[12px] text-ink-faint">
                    {person.email}
                  </span>
                )}
              </span>
              {person.owner ? (
                <span className="flex-none text-[12px] text-ink-faint">Owner</span>
              ) : (
                <>
                  {isOwner ? (
                    <RoleSelect
                      value={person.role === 'owner' ? 'edit' : person.role}
                      disabled={busy}
                      label={`Role for ${person.name}`}
                      onChange={(role) => changeRole(person.userId, role)}
                    />
                  ) : (
                    <span className="flex-none text-[12px] text-ink-faint">
                      {ROLE_LABEL[person.role === 'owner' ? 'edit' : person.role]}
                    </span>
                  )}
                  {(isOwner || person.userId === meId) && (
                    <Button
                      variant="bare"
                      size="icon-sm"
                      className="flex-none text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
                      title={person.userId === meId ? 'Leave this canvas' : 'Remove'}
                      disabled={busy}
                      onClick={() => remove(person.userId)}
                    >
                      ✕
                    </Button>
                  )}
                </>
              )}
            </div>
          ))}
          {people === null && <p className="text-[12px] text-ink-faint">Loading…</p>}
          {canvas.workspaceId && (
            <div className="flex items-center gap-2.5 px-[2px] py-1.5">
              <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep text-ink-soft">
                <BuildingIcon width={14} height={14} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <b className="truncate text-[13px] font-semibold">Everyone in {workspace?.name ?? 'the workspace'}</b>
                <span className="truncate text-[12px] text-ink-faint">
                  {workspace
                    ? `${workspace.memberCount} ${workspace.memberCount === 1 ? 'person' : 'people'}`
                    : 'workspace members'}
                </span>
              </span>
              <span className="flex-none text-[12px] text-ink-faint">Can edit</span>
            </div>
          )}
        </div>

        {isOwner && <DomainGrants canvasId={canvas.id} busy={busy} setBusy={setBusy} setError={setError} fail={fail} />}

        {/* filing: a workspace canvas is open to the whole team, so the
            choice sits with the access controls rather than in a menu */}
        {isOwner && workspaces.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2 border-t border-line-soft pt-3.5 sm:flex-row sm:items-center">
            <span className="text-[13px] font-medium text-ink">Workspace</span>
            <Sel
              className="sm:ml-auto sm:w-[240px]"
              value={canvas.workspaceId ?? ''}
              disabled={busy}
              onChange={(event) => move(event.target.value)}
              aria-label="Workspace this canvas lives in"
            >
              <option value="">Personal — invite-only</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.active ? '' : ' (needs a plan)'}
                </option>
              ))}
            </Sel>
          </div>
        )}

        <LinkAccessSection
          isOwner={isOwner}
          access={linkAccess}
          audience={linkAudience}
          hasPassword={!!canvas.hasLinkPassword}
          busy={busy}
          save={saveLink}
          copy={copy}
        />

        {isOwner && (
          <CommunityListing canvas={canvas} busy={busy} setBusy={setBusy} setError={setError} onChange={onChange} />
        )}
        {upgrade && (
          <UpgradeModal
            workspaceId={upgrade}
            reason="Moving a canvas into a workspace needs a Team plan."
            onClose={() => setUpgrade(null)}
          />
        )}
      </>
    </Modal>
  )
}

/* a member's role in the sparse map: edit is the default and is not stored */
function withRole(map: Record<string, MemberRole> | undefined, userId: string, role: MemberRole) {
  const next = { ...map }
  if (role === 'edit') delete next[userId]
  else next[userId] = role
  return Object.keys(next).length ? next : undefined
}

function RequestRow({
  request,
  busy,
  onAnswer,
}: {
  request: AccessRequestInfo
  busy: boolean
  onAnswer: (role: MemberRole | null) => void
}) {
  const [role, setRole] = useState<MemberRole>('view')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Avatar name={request.name} className="size-7 flex-none border-0 text-xs" />
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <b className="truncate text-[13px] font-semibold">{request.name}</b>
          <span className="truncate text-[12px] text-ink-faint">{request.email}</span>
        </span>
      </div>
      {request.message && (
        <p className="ml-[38px] rounded-[8px] bg-surface px-2.5 py-1.5 text-[12.5px] leading-snug text-ink-soft">
          “{request.message}”
        </p>
      )}
      <div className="ml-[38px] flex flex-wrap items-center gap-2">
        <RoleSelect value={role} onChange={setRole} disabled={busy} label={`Role to give ${request.name}`} />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onAnswer(role)}>
          Approve
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(null)}>
          Decline
        </Button>
      </div>
    </div>
  )
}

function LinkAccessSection({
  isOwner,
  access,
  audience,
  hasPassword,
  busy,
  save,
  copy,
}: {
  isOwner: boolean
  access: LinkAccess
  audience: LinkAudience
  hasPassword: boolean
  busy: boolean
  save: (patch: {
    linkAccess?: LinkAccess
    linkAudience?: LinkAudience
    linkPassword?: string | null
  }) => Promise<boolean>
  copy: () => void
}) {
  const [password, setPassword] = useState('')
  const [editingPassword, setEditingPassword] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const open = access !== 'none'
  const needsPassword = editingPassword || (audience === 'password' && !hasPassword)

  async function setAudience(next: LinkAudience) {
    setProblem(null)
    if (next === 'password' && !hasPassword) {
      /* the password goes in first; the audience is saved with it */
      setEditingPassword(true)
      return
    }
    await save({ linkAudience: next })
  }

  async function savePassword() {
    if (password.length < 8) return setProblem('The password needs at least 8 characters.')
    setProblem(null)
    if (await save({ linkPassword: password, linkAudience: 'password' })) {
      setPassword('')
      setEditingPassword(false)
    }
  }

  const summary = !open
    ? 'Only you and the people above can open this canvas.'
    : audience === 'anyone'
      ? access === 'edit'
        ? 'Anyone with the link can open it. People who are not signed in can only comment, never edit.'
        : 'Anyone with the link can open it without signing in.'
      : audience === 'password'
        ? 'Anyone with the link and the password can open it, signed in or not.'
        : 'Anyone signed in to doop with the link can open it.'

  return (
    <div className="mt-2.5 border-t border-line-soft pt-3.5">
      <div className={caption}>Link access</div>
      {isOwner ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Label variant="plain" className="mb-0 sm:w-[96px]" htmlFor="link-access">
              Anyone with the link
            </Label>
            <Sel
              id="link-access"
              className="sm:ml-auto sm:w-[240px]"
              value={access}
              disabled={busy}
              onChange={(event) => void save({ linkAccess: event.target.value as LinkAccess })}
            >
              {LINK_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Sel>
          </div>
          {open && (
            <div className="flex animate-[chip-in_0.2s_ease] flex-col gap-2 sm:flex-row sm:items-center">
              <Label variant="plain" className="mb-0 sm:w-[96px]" htmlFor="link-audience">
                Who can open it
              </Label>
              <Sel
                id="link-audience"
                className="sm:ml-auto sm:w-[240px]"
                value={needsPassword && !hasPassword ? 'password' : audience}
                disabled={busy}
                onChange={(event) => void setAudience(event.target.value as LinkAudience)}
              >
                {AUDIENCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Sel>
            </div>
          )}
          {open && (audience === 'password' || editingPassword) && (
            <div className="flex animate-[chip-in_0.2s_ease] flex-col gap-2 rounded-[10px] bg-paper px-3 py-2.5">
              {needsPassword ? (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      className="flex-1 bg-surface"
                      placeholder="Link password (8 characters or more)"
                      aria-label="Link password"
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && void savePassword()}
                    />
                    <Button variant="primary" disabled={busy || !password} onClick={() => void savePassword()}>
                      Save password
                    </Button>
                    {editingPassword && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setEditingPassword(false)
                          setPassword('')
                          setProblem(null)
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  {problem && <Note tone="error">{problem}</Note>}
                  <Note>Changing the password signs everyone who entered the old one out of this canvas.</Note>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <LockIcon width={14} height={14} className="flex-none text-ink-soft" aria-hidden />
                  <span className="flex-1 text-[12.5px] text-ink-soft">Password set</span>
                  <Button variant="bare" size="sm" disabled={busy} onClick={() => setEditingPassword(true)}>
                    Change
                  </Button>
                  <Button
                    variant="bare-danger"
                    size="sm"
                    disabled={busy}
                    title="Removing the password also opens the link to signed-in people only"
                    onClick={() => void save({ linkPassword: null })}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          )}
          <p className="text-[12px] leading-snug text-ink-faint">{summary}</p>
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-soft">
          {open
            ? `${LINK_OPTIONS.find((o) => o.value === access)?.label} for anyone with the link.`
            : 'Invite-only canvas.'}
        </p>
      )}
      <Button className="mt-3 justify-center" onClick={copy}>
        ⧉ Copy link
      </Button>
    </div>
  )
}

/* Everyone with a verified address on a domain gets a role. The server only
   honours verified addresses, so the section says so. */
function DomainGrants({
  canvasId,
  busy,
  setBusy,
  setError,
  fail,
}: {
  canvasId: string
  busy: boolean
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  fail: (caught: unknown, fallback: string) => void
}) {
  const [grants, setGrants] = useState<DomainGrant[]>([])
  const [mailer, setMailer] = useState(true)
  const [domain, setDomain] = useState('')
  const [role, setRole] = useState<MemberRole>('view')

  useEffect(() => {
    let active = true
    api
      .listDomains(canvasId)
      .then((res) => {
        if (!active) return
        setGrants(res.grants)
        setMailer(res.mailer)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [canvasId])

  async function add() {
    const clean = domain.trim().replace(/^@/, '')
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const grant = await api.setDomain(canvasId, clean, role)
      setGrants((current) => [...current.filter((g) => g.domain !== grant.domain), grant])
      setDomain('')
    } catch (caught) {
      fail(caught, 'could not save that domain')
    } finally {
      setBusy(false)
    }
  }

  async function update(grant: DomainGrant, next: MemberRole) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await api.setDomain(canvasId, grant.domain, next)
      setGrants((current) => current.map((g) => (g.domain === saved.domain ? saved : g)))
    } catch (caught) {
      fail(caught, 'could not change that domain')
    } finally {
      setBusy(false)
    }
  }

  async function drop(grant: DomainGrant) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.removeDomain(canvasId, grant.domain)
      setGrants((current) => current.filter((g) => g.domain !== grant.domain))
    } catch (caught) {
      fail(caught, 'could not remove that domain')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2.5 border-t border-line-soft pt-3.5">
      <div className={caption}>Email domains</div>
      {grants.map((grant) => (
        <div key={grant.domain} className="flex items-center gap-2.5 py-1">
          <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep font-mono text-[13px] text-ink-soft">
            @
          </span>
          <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">{grant.domain}</b>
          <RoleSelect
            value={grant.role}
            disabled={busy}
            label={`Role for ${grant.domain}`}
            onChange={(r) => void update(grant, r)}
          />
          <Button
            variant="bare"
            size="icon-sm"
            className="flex-none text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
            title="Remove"
            aria-label={`Remove ${grant.domain}`}
            disabled={busy}
            onClick={() => void drop(grant)}
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <Input
          className="flex-1 rounded-[10px] bg-paper focus:ring-0"
          placeholder="Share with everyone at… acme.com"
          aria-label="Email domain"
          value={domain}
          disabled={busy}
          onChange={(event) => setDomain(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void add()}
        />
        <RoleSelect value={role} onChange={setRole} disabled={busy} label="Role for the domain" />
        <Button disabled={busy || !domain.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-faint">
        {mailer
          ? 'Only people who have verified their email address get access.'
          : 'This server cannot send email, so no address is ever verified and domain sharing stays inactive.'}
      </p>
    </div>
  )
}

/* The gallery is opt-in and owner-only. Listing hands out previews and
   copies, never access — so it sits apart from the access controls above,
   with its own switch and its own blurb. */
function CommunityListing({
  canvas,
  busy,
  setBusy,
  setError,
  onChange,
}: {
  canvas: ShareableCanvas
  busy: boolean
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  onChange: (patch: SharePatch) => void
}) {
  const published = canvas.publishedAt !== undefined
  const [description, setDescription] = useState(canvas.description ?? '')
  const [category, setCategory] = useState<CommunityCategory>(canvas.category ?? 'website')
  const dirty = published && (description.trim() !== (canvas.description ?? '') || category !== canvas.category)

  async function save(next: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (next) {
        const listing = await api.publishCanvas(canvas.id, { description: description.trim(), category })
        if (!published) posthog.capture('canvas_published')
        onChange(listing)
      } else {
        await api.unpublishCanvas(canvas.id)
        posthog.capture('canvas_unpublished')
        onChange({ publishedAt: undefined, description: undefined, category: undefined })
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'publish failed') : 'publish failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3.5 border-t border-line-soft pt-3.5">
      <label
        className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink"
        title="Anyone on doop can preview and copy a listed canvas. The canvas itself stays private."
      >
        <Checkbox checked={published} disabled={busy} onChange={(event) => save(event.target.checked)} />
        Show in the community gallery
      </label>
      <p className="mt-1 pl-[26px] text-[12px] leading-snug text-ink-faint">
        People can preview it and copy it into their own account. Your canvas stays private.
      </p>
      {published && (
        <div className="mt-3 flex flex-col gap-2.5 pl-[26px]">
          <Textarea
            rows={2}
            maxLength={280}
            className="rounded-[10px] bg-paper text-[13px] focus:ring-0"
            placeholder="What is this design? One or two lines helps people find it."
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
          <ToggleChipGroup
            aria-label="Gallery shelf"
            className="gap-1.5"
            value={category}
            onValueChange={(next) => setCategory(next as CommunityCategory)}
          >
            {COMMUNITY_CATEGORIES.map((value) => (
              <ToggleChipItem key={value} value={value} className="px-2.5 py-1 text-[12px]" disabled={busy}>
                {COMMUNITY_CATEGORY_LABELS[value]}
              </ToggleChipItem>
            ))}
          </ToggleChipGroup>
          {dirty && (
            <Button size="sm" className="self-start" disabled={busy} onClick={() => save(true)}>
              Update listing
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
