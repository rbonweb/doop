import { useEffect, useState } from 'react'
import {
  COMMUNITY_CATEGORIES,
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
import { PERSONAL_WORKSPACE, UpgradeModal } from './WorkspaceModals'
import { authClient } from '../lib/auth'
import { useStore } from '../lib/store'
import { posthog } from '../lib/posthog'
import { Avatar } from './ui/avatar'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { IconButton } from './ui/icon-button'
import { BuildingIcon, CopyIcon, LockIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Label } from './ui/field'
import { PersonRow } from './ui/list'
import { Modal, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { useT, type PlainMessageKey } from '@/lib/i18n'

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

const ROLE_LABEL: Record<MemberRole, PlainMessageKey> = {
  view: 'panels.shareRoleView',
  comment: 'panels.shareRoleComment',
  edit: 'panels.shareCanEdit',
}
const ROLE_ORDER: readonly MemberRole[] = ['view', 'comment', 'edit']

/* What each share-link level grants, as the picker and the read-out say it. */
const LINK_ACCESS_LABELS: Record<LinkAccess, PlainMessageKey> = {
  none: 'panels.shareAccessNone',
  view: 'panels.shareAccessView',
  comment: 'panels.shareAccessComment',
  edit: 'panels.shareAccessEdit',
}

const LINK_ACCESS_SUMMARY: Record<LinkAccess, PlainMessageKey> = {
  none: 'panels.shareSummaryNone',
  view: 'panels.shareSummaryView',
  comment: 'panels.shareSummaryComment',
  edit: 'panels.shareSummaryEdit',
}

const LINK_ACCESS_ORDER: readonly LinkAccess[] = ['none', 'view', 'comment', 'edit']

const AUDIENCE_LABELS: Record<LinkAudience, PlainMessageKey> = {
  'signed-in': 'panels.shareAudienceSignedIn',
  anyone: 'panels.shareAudienceAnyone',
  password: 'panels.shareAudiencePassword',
}
const AUDIENCE_ORDER: readonly LinkAudience[] = ['signed-in', 'anyone', 'password']

/* the gallery shelves; the ids are what the server stores */
const CATEGORY_LABELS: Record<CommunityCategory, PlainMessageKey> = {
  website: 'panels.shareCategoryWebsite',
  app: 'panels.shareCategoryApp',
  dashboard: 'panels.shareCategoryDashboard',
  mobile: 'panels.shareCategoryMobile',
  marketing: 'panels.shareCategoryMarketing',
  other: 'panels.shareCategoryOther',
}

/* a ring Select over a short fixed list: roles, link access, who can open it */
function OptionSelect<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
  id,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  disabled?: boolean
  label?: string
  id?: string
  className?: string
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger id={id} size="sm" className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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
  const t = useT()
  return (
    <OptionSelect
      className={className ?? 'w-[132px] flex-none'}
      value={value}
      options={ROLE_ORDER.map((role) => ({ value: role, label: t(ROLE_LABEL[role]) }))}
      disabled={disabled}
      label={label}
      onChange={onChange}
    />
  )
}

const caption = 'mb-2 text-caption font-medium text-ink-faint'

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
  const t = useT()
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
      else fail(caught, t('panels.shareMoveFailed'))
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
      fail(caught, t('panels.shareInviteFailed'))
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
      fail(caught, t('panels.shareRoleChangeFailed'))
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
      fail(caught, t('panels.shareRemoveFailed'))
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
      fail(caught, t('panels.shareAnswerFailed'))
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
      fail(caught, t('panels.shareAccessFailed'))
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
      setError(t('panels.shareCopyFailed'))
    }
  }

  return (
    <Modal size="md" onClose={onClose}>
      <>
        <div className="flex items-start justify-between gap-3">
          <ModalTitle className="min-w-0">{t('panels.shareTitle', { name: canvas.name })}</ModalTitle>
          <IconButton aria-label={t('panels.shareClose')} onClick={onClose}>
            <XIcon />
          </IconButton>
        </div>

        {requests.length > 0 && (
          <section
            aria-label={t('panels.shareRequestsAria')}
            className="mt-4 animate-[chip-in_0.25s_ease] rounded-card bg-brand/5 p-3 ring-1 ring-brand/40"
          >
            <div className={caption}>{t('panels.shareRequests', { count: requests.length })}</div>
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
              variant="well"
              className="flex-1"
              autoFocus
              placeholder={t('panels.shareInvitePlaceholder')}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && invite()}
            />
            <RoleSelect
              value={inviteRole}
              onChange={setInviteRole}
              disabled={busy}
              label={t('panels.shareInviteRoleAria')}
            />
            <Button
              variant="primary"
              className="justify-center"
              disabled={busy || people === null || !email.trim()}
              onClick={invite}
            >
              {t('panels.shareInvite')}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mx-[2px] mt-2 text-label text-accent-ink">
            {error}
          </p>
        )}

        <div className="mt-[14px] mb-1 flex max-h-[34vh] flex-col gap-[2px] overflow-y-auto">
          {(people ?? []).map((person) => (
            <PersonRow
              key={person.userId}
              className="px-[2px] py-1.5"
              avatar={<Avatar name={person.name} image={person.image} size={28} />}
              name={person.userId === meId ? t('panels.shareYou', { name: person.name }) : person.name}
              detail={person.email}
              trailing={
                person.owner ? (
                  <span className="text-label text-ink-faint">{t('panels.shareOwner')}</span>
                ) : (
                  <>
                    {isOwner ? (
                      <RoleSelect
                        value={person.role === 'owner' ? 'edit' : person.role}
                        disabled={busy}
                        label={t('panels.shareRoleFor', { name: person.name })}
                        onChange={(role) => changeRole(person.userId, role)}
                      />
                    ) : (
                      <span className="text-label text-ink-faint">
                        {t(ROLE_LABEL[person.role === 'owner' ? 'edit' : person.role])}
                      </span>
                    )}
                    {(isOwner || person.userId === meId) && (
                      <IconButton
                        variant="danger"
                        size="sm"
                        aria-label={
                          person.userId === meId
                            ? t('panels.shareLeave')
                            : t('panels.shareRemove', { name: person.name })
                        }
                        disabled={busy}
                        onClick={() => remove(person.userId)}
                      >
                        <XIcon width={14} height={14} />
                      </IconButton>
                    )}
                  </>
                )
              }
            />
          ))}
          {people === null && <p className="text-label text-ink-faint">{t('common.loading')}</p>}
          {canvas.workspaceId && (
            <PersonRow
              className="px-[2px] py-1.5"
              avatar={
                <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep text-ink-soft">
                  <BuildingIcon width={14} height={14} aria-hidden />
                </span>
              }
              name={
                workspace ? t('panels.shareEveryoneIn', { name: workspace.name }) : t('panels.shareEveryoneInWorkspace')
              }
              detail={
                workspace
                  ? t('panels.sharePeople', { count: workspace.memberCount })
                  : t('panels.shareWorkspaceMembers')
              }
              trailing={<span className="text-label text-ink-faint">{t('panels.shareCanEdit')}</span>}
            />
          )}
        </div>

        {isOwner && <DomainGrants canvasId={canvas.id} busy={busy} setBusy={setBusy} setError={setError} fail={fail} />}

        {/* filing: a workspace canvas is open to the whole team, so the
            choice sits with the access controls rather than in a menu */}
        {isOwner && workspaces.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2 border-t border-line-soft pt-3.5 sm:flex-row sm:items-center">
            <span className="text-body font-medium text-ink">{t('panels.shareWorkspace')}</span>
            <Select
              value={canvas.workspaceId ?? PERSONAL_WORKSPACE}
              disabled={busy}
              onValueChange={(value) => void move(value === PERSONAL_WORKSPACE ? '' : value)}
            >
              <SelectTrigger className="sm:ml-auto sm:w-[240px]" aria-label={t('panels.shareWorkspaceAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONAL_WORKSPACE}>{t('panels.sharePersonal')}</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                    {w.active ? '' : ` ${t('panels.shareNeedsPlan')}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            reason={t('panels.shareUpgradeReason')}
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
  const t = useT()
  const [role, setRole] = useState<MemberRole>('view')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <PersonRow avatar={<Avatar name={request.name} size={28} />} name={request.name} detail={request.email} />
      </div>
      {request.message && (
        <p className="ml-[38px] rounded-control bg-surface px-2.5 py-1.5 text-body text-ink-soft shadow-ring">
          “{request.message}”
        </p>
      )}
      <div className="ml-[38px] flex flex-wrap items-center gap-2">
        <RoleSelect
          value={role}
          onChange={setRole}
          disabled={busy}
          label={t('panels.shareRoleToGive', { name: request.name })}
        />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onAnswer(role)}>
          {t('panels.shareApprove')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onAnswer(null)}>
          {t('panels.shareDecline')}
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
  const t = useT()
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
    if (password.length < 8) return setProblem(t('panels.sharePasswordShort'))
    setProblem(null)
    if (await save({ linkPassword: password, linkAudience: 'password' })) {
      setPassword('')
      setEditingPassword(false)
    }
  }

  const summary = !open
    ? t('panels.shareLinkClosed')
    : audience === 'anyone'
      ? access === 'edit'
        ? t('panels.shareLinkAnyoneEdit')
        : t('panels.shareLinkAnyone')
      : audience === 'password'
        ? t('panels.shareLinkPassword')
        : t('panels.shareLinkSignedIn')

  return (
    <div className="mt-2.5 border-t border-line-soft pt-3.5">
      <div className={caption}>{t('panels.shareLinkAccess')}</div>
      {isOwner ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Label variant="plain" className="mb-0 sm:w-[96px]" htmlFor="link-access">
              {t('panels.shareAnyoneWithLink')}
            </Label>
            <OptionSelect
              id="link-access"
              className="sm:ml-auto sm:w-[240px]"
              value={access}
              options={LINK_ACCESS_ORDER.map((level) => ({ value: level, label: t(LINK_ACCESS_LABELS[level]) }))}
              disabled={busy}
              onChange={(next) => void save({ linkAccess: next })}
            />
          </div>
          {open && (
            <div className="flex animate-[chip-in_0.2s_ease] flex-col gap-2 sm:flex-row sm:items-center">
              <Label variant="plain" className="mb-0 sm:w-[96px]" htmlFor="link-audience">
                {t('panels.shareWhoCanOpen')}
              </Label>
              <OptionSelect
                id="link-audience"
                className="sm:ml-auto sm:w-[240px]"
                value={needsPassword && !hasPassword ? 'password' : audience}
                options={AUDIENCE_ORDER.map((level) => ({ value: level, label: t(AUDIENCE_LABELS[level]) }))}
                disabled={busy}
                onChange={(next) => void setAudience(next)}
              />
            </div>
          )}
          {open && (audience === 'password' || editingPassword) && (
            <div className="flex animate-[chip-in_0.2s_ease] flex-col gap-2 rounded-pill bg-sub px-3 py-2.5">
              {needsPassword ? (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      variant="well"
                      className="flex-1"
                      placeholder={t('panels.sharePasswordPlaceholder')}
                      aria-label={t('panels.sharePasswordAria')}
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && void savePassword()}
                    />
                    <Button variant="primary" disabled={busy || !password} onClick={() => void savePassword()}>
                      {t('panels.shareSavePassword')}
                    </Button>
                    {editingPassword && (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setEditingPassword(false)
                          setPassword('')
                          setProblem(null)
                        }}
                      >
                        {t('panels.shareCancel')}
                      </Button>
                    )}
                  </div>
                  {problem && <Note tone="error">{problem}</Note>}
                  <Note>{t('panels.sharePasswordNote')}</Note>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <LockIcon width={14} height={14} className="flex-none text-ink-soft" aria-hidden />
                  <span className="flex-1 text-body text-ink-soft">{t('panels.sharePasswordSet')}</span>
                  <Button variant="bare" size="sm" disabled={busy} onClick={() => setEditingPassword(true)}>
                    {t('panels.shareChange')}
                  </Button>
                  <Button
                    variant="bare-danger"
                    size="sm"
                    disabled={busy}
                    title={t('panels.shareRemovePasswordTitle')}
                    onClick={() => void save({ linkPassword: null })}
                  >
                    {t('panels.shareRemovePassword')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <p className="text-label text-ink-faint">{summary}</p>
        </div>
      ) : (
        <p className="text-body text-ink-soft">{t(LINK_ACCESS_SUMMARY[access])}</p>
      )}
      <Button className="mt-3 justify-center gap-2" onClick={copy}>
        <CopyIcon className="size-3.5" />
        {t('panels.shareCopyLink')}
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
  const t = useT()
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
      fail(caught, t('panels.shareDomainSaveFailed'))
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
      fail(caught, t('panels.shareDomainChangeFailed'))
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
      fail(caught, t('panels.shareDomainRemoveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2.5 border-t border-line-soft pt-3.5">
      <div className={caption}>{t('panels.shareDomains')}</div>
      {grants.map((grant) => (
        <div key={grant.domain} className="flex items-center gap-2.5 py-1">
          <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep font-mono text-body text-ink-soft">
            @
          </span>
          <b className="min-w-0 flex-1 truncate text-body font-medium">{grant.domain}</b>
          <RoleSelect
            value={grant.role}
            disabled={busy}
            label={t('panels.shareRoleFor', { name: grant.domain })}
            onChange={(r) => void update(grant, r)}
          />
          <IconButton
            variant="danger"
            size="sm"
            title={t('panels.shareRemoveTitle')}
            aria-label={t('panels.shareRemove', { name: grant.domain })}
            disabled={busy}
            onClick={() => void drop(grant)}
          >
            <XIcon width={14} height={14} />
          </IconButton>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <Input
          variant="well"
          className="flex-1"
          placeholder={t('panels.shareDomainPlaceholder')}
          aria-label={t('panels.shareDomainAria')}
          value={domain}
          disabled={busy}
          onChange={(event) => setDomain(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void add()}
        />
        <RoleSelect value={role} onChange={setRole} disabled={busy} label={t('panels.shareRoleForDomain')} />
        <Button disabled={busy || !domain.trim()} onClick={() => void add()}>
          {t('panels.shareAdd')}
        </Button>
      </div>
      <p className="mt-1.5 text-label text-ink-faint">
        {mailer ? t('panels.shareDomainsVerified') : t('panels.shareDomainsNoMailer')}
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
  const t = useT()

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
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? t('panels.sharePublishFailed'))
          : t('panels.sharePublishFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3.5 border-t border-line-soft pt-3.5">
      <label
        className="flex cursor-pointer items-center gap-2 text-body font-medium text-ink"
        title={t('panels.shareGalleryTitle')}
      >
        <Checkbox checked={published} disabled={busy} onChange={(event) => save(event.target.checked)} />
        {t('panels.shareGallery')}
      </label>
      <p className="mt-1 pl-[26px] text-label leading-snug text-ink-faint">{t('panels.shareGalleryBlurb')}</p>
      {published && (
        <div className="mt-3 flex flex-col gap-2.5 pl-[26px]">
          <Textarea
            rows={2}
            maxLength={280}
            variant="well"
            placeholder={t('panels.shareDescriptionPlaceholder')}
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
          <ToggleChipGroup
            aria-label={t('panels.shareShelf')}
            className="gap-1.5"
            value={category}
            onValueChange={(next) => setCategory(next as CommunityCategory)}
          >
            {COMMUNITY_CATEGORIES.map((value) => (
              <ToggleChipItem key={value} value={value} size="sm" disabled={busy}>
                {t(CATEGORY_LABELS[value])}
              </ToggleChipItem>
            ))}
          </ToggleChipGroup>
          {dirty && (
            <Button size="sm" className="self-start" disabled={busy} onClick={() => save(true)}>
              {t('panels.shareUpdateListing')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
