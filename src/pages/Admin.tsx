import { useEffect, useState } from 'react'
import { adminApi, type AdminCanvas, type AdminUser } from '../lib/api'
import { navigate } from '../App'
import { timeAgo } from '../lib/time'
import { AccountMenu, ConnectCard, IconBack, IconChevron, IconGear, IconGrid, IconShare } from '../components/DashShell'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Wordmark } from '../components/ui/wordmark'
import { cardVariants } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { VersionCard } from '../components/VersionCard'
import { InvitesCard } from '../components/InvitesCard'
import { ModelsCard } from '../components/ModelsCard'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

type Tab = 'canvases' | 'users' | 'settings'

/* rows and tiles share the Card surface */
const cardShell = cn(cardVariants(), 'overflow-hidden text-left transition-[transform,box-shadow,border-color]')

/**
 * The instance index: every canvas, every account. Read-only — the way to
 * look inside someone's canvas is "view as", which hands you a real (but
 * read-only, 15-minute) session as its owner rather than granting admins a
 * privileged read path through the canvas gate.
 *
 * Same shell as home and settings; the rail's middle carries the two indexes.
 */
export function Admin() {
  const [data, setData] = useState<{ total: number; canvases: AdminCanvas[] } | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [stats, setStats] = useState<{ users: number; canvases: number; frames: number } | null>(null)
  const [tab, setTab] = useState<Tab>('canvases')
  const [q, setQ] = useState('')
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    adminApi
      .canvases()
      .then(setData)
      .catch(() => setDenied(true))
    adminApi
      .stats()
      .then(setStats)
      .catch(() => {})
    adminApi
      .users()
      .then(setUsers)
      .catch(() => {})
  }, [])

  async function viewAs(userId: string) {
    await adminApi.impersonate(userId)
    /* the session cookie has been replaced — every piece of client state now
       belongs to the wrong person. Reload rather than reconcile. */
    location.assign('/')
  }

  async function setBanned(u: AdminUser, banned: boolean) {
    const ok = window.confirm(
      banned
        ? `Ban ${u.name} (${u.email})? They are signed out everywhere and cannot sign in or use MCP until unbanned.`
        : `Unban ${u.name} (${u.email})?`,
    )
    if (!ok) return
    try {
      if (banned) await adminApi.ban(u.id)
      else await adminApi.unban(u.id)
      setUsers((list) => (list ? list.map((x) => (x.id === u.id ? { ...x, banned } : x)) : list))
    } catch (e) {
      console.error(e)
    }
  }

  if (denied) {
    return (
      <div className="h-full overflow-y-auto [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/26px_26px,var(--paper)]">
        <div className="mx-auto max-w-[1060px] px-10 pt-[72px] pb-[120px]">
          <h1 className="mt-16 font-serif text-[clamp(38px,4.8vw,60px)] font-normal leading-none tracking-[-0.02em]">
            Not found
          </h1>
          <p className="mt-3.5 max-w-[44em] text-[15px] leading-[1.6] text-ink-soft">
            This page does not exist for this account.
          </p>
          <Button variant="ghost" className="mt-5" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </div>
    )
  }

  const needle = q.trim().toLowerCase()
  const canvases = (data?.canvases ?? []).filter(
    (c) =>
      !needle ||
      c.name.toLowerCase().includes(needle) ||
      c.owner?.name.toLowerCase().includes(needle) ||
      c.owner?.email.toLowerCase().includes(needle),
  )
  const shownUsers = (users ?? []).filter(
    (u) => !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
  )

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]">
          Doop <Badge tone="admin">admin</Badge>
        </Wordmark>

        <Button
          variant="ghost"
          className="w-full justify-start gap-[9px] rounded-[9px] px-2.5 py-2 text-[13px] text-ink-soft hover:bg-paper hover:text-ink"
          onClick={() => navigate('/')}
        >
          <IconBack /> Back to my canvases
        </Button>

        <DashSectionLabel>Instance</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            icon={<IconGrid />}
            count={stats?.canvases ?? ''}
            active={tab === 'canvases'}
            onClick={() => setTab('canvases')}
          >
            Canvases
          </DashNavItem>
          <DashNavItem
            icon={<IconShare />}
            count={stats?.users ?? ''}
            active={tab === 'users'}
            onClick={() => setTab('users')}
          >
            Accounts
          </DashNavItem>
          <DashNavItem icon={<IconGear />} active={tab === 'settings'} onClick={() => setTab('settings')}>
            Settings
          </DashNavItem>
        </nav>

        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader className="max-md:min-h-[104px]">
          <nav className="flex items-center gap-2 text-[13px] text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-[13px] font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <IconChevron />
            <b className="font-semibold text-ink">Admin</b>
          </nav>
          {tab !== 'settings' && (
            <label className="order-2 flex h-10 max-w-none flex-1 basis-full items-center gap-[9px] rounded-[10px] border border-line bg-surface px-[11px] text-ink-faint focus-within:border-ink-faint md:order-none md:h-[34px] md:max-w-[400px] md:basis-auto">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
              <Input
                variant="bare"
                inputSize="auto"
                className="flex-1 md:text-[13px]"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tab === 'canvases' ? 'Search canvases or owners…' : 'Search accounts…'}
                aria-label={tab === 'canvases' ? 'Search canvases or owners' : 'Search accounts'}
              />
            </label>
          )}
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>
                Everything on this instance<em className="not-italic text-brand">.</em>
              </DashTitle>
              <DashSubtitle>
                {stats
                  ? `${stats.users} ${stats.users === 1 ? 'account' : 'accounts'} · ${stats.canvases} ${
                      stats.canvases === 1 ? 'canvas' : 'canvases'
                    } · ${stats.frames} ${stats.frames === 1 ? 'frame' : 'frames'}`
                  : '…'}
              </DashSubtitle>
            </div>
          </div>

          <VersionCard />

          <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)} className="mt-4 flex md:hidden">
            <TabsList className="h-10 w-full border border-line bg-surface p-1 shadow-card">
              <TabsTrigger value="canvases">
                <IconGrid /> Canvases · {stats?.canvases ?? '…'}
              </TabsTrigger>
              <TabsTrigger value="users">
                <IconShare /> Accounts · {stats?.users ?? '…'}
              </TabsTrigger>
              <TabsTrigger value="settings">
                <IconGear /> Settings
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === 'canvases' ? (
            <>
              {data && data.total > data.canvases.length && (
                <div className="mt-[18px] flex flex-wrap items-center gap-2.5 text-xs text-ink-faint">
                  <span>
                    Showing the {data.canvases.length} most recently updated of {data.total}
                  </span>
                </div>
              )}
              <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3.5 xs:grid-cols-[repeat(auto-fill,minmax(214px,1fr))] md:gap-4">
                {data === null &&
                  [0, 1, 2, 3].map((i) => <Skeleton key={i} index={i} className={cn(cardShell, 'min-h-[230px]')} />)}
                {canvases.map((c) => (
                  <div key={c.id} className={cn(cardShell, 'flex flex-col')}>
                    <div className="relative grid aspect-[4/3] place-items-center overflow-hidden border-b border-line-soft [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/18px_18px,var(--paper-deep)]">
                      <CanvasPreview frameId={c.previewFrameId} />
                    </div>
                    <div className="flex flex-1 flex-col px-3 pt-2.5 pb-3">
                      <div className="truncate font-display text-[13.5px] font-semibold">{c.name}</div>
                      <div className="mt-[5px] flex min-h-0 flex-wrap content-start items-center gap-1.5 text-[11.5px] text-ink-faint xs:min-h-[30px]">
                        <span>{c.owner ? c.owner.name : 'unclaimed'}</span>
                        <span className="opacity-60">·</span>
                        <span>
                          {c.frameCount} frame{c.frameCount === 1 ? '' : 's'}
                        </span>
                        <span className="opacity-60">·</span>
                        <span>{timeAgo(c.updatedAt)}</span>
                        {c.linkAccess === 'edit' && (
                          <Badge
                            className="px-[5px] py-px text-[10px]"
                            title="Anyone with the link can edit this canvas"
                          >
                            link on
                          </Badge>
                        )}
                        {c.memberCount > 0 && (
                          <>
                            <span className="opacity-60">·</span>
                            <span>{c.memberCount} invited</span>
                          </>
                        )}
                      </div>
                      {c.owner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-auto self-start"
                          onClick={() => viewAs(c.owner!.id)}
                        >
                          View as {c.owner.name.split(' ')[0]}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : tab === 'settings' ? (
            <ModelsCard />
          ) : (
            <>
              <InvitesCard />
              <div className="mt-4 overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
                {users === null && <p className="mt-7 text-[13.5px] text-ink-soft">…</p>}
                {shownUsers.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-col items-stretch justify-between gap-2.5 border-b border-line-soft p-3.5 last:border-b-0 md:flex-row md:items-center md:gap-4 md:px-[18px] md:py-[13px]"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2 font-display text-[14.5px] font-semibold">
                        {u.name}
                        {u.role === 'admin' && <Badge tone="admin">admin</Badge>}
                        {u.banned && <Badge tone="banned">banned</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-faint">
                        <span>{u.email}</span>
                        <span>·</span>
                        <span>
                          {u.canvasCount} {u.canvasCount === 1 ? 'canvas' : 'canvases'}
                        </span>
                        <span>·</span>
                        <span>joined {timeAgo(u.createdAt)}</span>
                      </div>
                    </div>
                    {u.role !== 'admin' && (
                      <div className="flex flex-wrap items-center gap-2">
                        {!u.banned && (
                          <Button variant="ghost" size="sm" onClick={() => viewAs(u.id)}>
                            View as
                          </Button>
                        )}
                        <Button
                          variant={u.banned ? 'ghost' : 'danger'}
                          size="sm"
                          onClick={() => setBanned(u, !u.banned)}
                        >
                          {u.banned ? 'Unban' : 'Ban'}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}

/** Same contract as the Home dashboard's Preview: a failed render must look
 *  different from an empty canvas, and cards request the cheap ?preview
 *  render rather than the full-size og:image one. */
function CanvasPreview({ frameId }: { frameId?: string }) {
  /* which frame failed, not whether — a new previewFrameId must retry
     rather than inherit the old frame's failure */
  const [failedId, setFailedId] = useState<string | null>(null)
  if (!frameId) return <span className="text-[12px] text-ink-faint">empty canvas</span>
  if (failedId === frameId) return <span className="text-[12px] text-ink-faint">preview unavailable</span>
  return (
    <img
      className="h-full w-full object-cover object-top"
      src={`/i/${frameId}.jpg?preview`}
      alt=""
      loading="lazy"
      onError={() => setFailedId(frameId)}
    />
  )
}
