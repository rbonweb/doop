import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateInfo } from '../../shared/selfUpdate'
import { adminApi, ApiError } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { cardVariants } from './ui/card'

const POLL_MS = 3000

/**
 * The Admin page's version line: what this server runs, whether a newer
 * release exists, and Update now when the host can install it itself (see
 * server/selfUpdate.ts). An update restarts the server, so polling shrugs
 * off failed requests, and the page reloads once a new version answers,
 * because the client bundle it holds belongs to the old one.
 */
export function VersionCard() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loadedVersion = useRef<string | null>(null)

  const show = useCallback((next: UpdateInfo) => {
    if (loadedVersion.current === null) loadedVersion.current = next.current
    else if (next.current !== loadedVersion.current) return location.reload()
    setInfo(next)
  }, [])

  /* a failed read is the server restarting mid-update; the next poll reaches it */
  const load = useCallback((fresh = false) => adminApi.update(fresh).then(show, () => {}), [show])

  useEffect(() => {
    adminApi.update().then(show, () => {})
  }, [show])

  const inFlight = info?.status.state === 'requested' || info?.status.state === 'running'
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, load])

  async function install(tag: string) {
    const ok = window.confirm(
      `Install ${tag}? The database is backed up first, then Doop restarts: everyone is disconnected for about a minute.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      setInfo(await adminApi.installUpdate(tag))
    } catch (e) {
      setError(e instanceof ApiError && typeof e.body.error === 'string' ? e.body.error : 'The update could not start.')
    } finally {
      setBusy(false)
    }
  }

  if (!info) return null
  const { latest } = info

  return (
    <div className={cn(cardVariants(), 'mt-5 flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:gap-4')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-display text-[14.5px] font-semibold">
          Doop {info.current}
          {latest && !info.updateAvailable && <Badge tone="outline">up to date</Badge>}
          {latest && info.updateAvailable && <Badge tone="accent">{latest.tag} available</Badge>}
        </div>
        <p className="mt-1 text-[12.5px] text-ink-faint" role="status">
          {error ?? describe(info)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {latest && (
          <Button variant="ghost" size="sm" asChild>
            <a href={latest.url} target="_blank" rel="noreferrer">
              Release notes
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={inFlight} onClick={() => void load(true)}>
          Check again
        </Button>
        {info.enabled && latest && info.updateAvailable && (
          <Button variant="primary" size="sm" disabled={busy || inFlight} onClick={() => void install(latest.tag)}>
            {inFlight ? 'Updating…' : 'Update now'}
          </Button>
        )}
      </div>
    </div>
  )
}

function describe(info: UpdateInfo): string {
  const { latest, status } = info
  if (status.state === 'requested') return `Waiting for the server to start installing ${status.tag ?? 'the update'}…`
  if (status.state === 'running') {
    return `Installing ${status.tag ?? 'the update'}. Doop restarts, and this page reloads when it is back.`
  }
  if (status.state === 'failed') {
    return `Installing ${status.tag ?? 'the update'} failed, so ${info.current} is still running.${
      status.message ? ` ${status.message}` : ''
    }`
  }
  if (info.error) return `Could not check for releases: ${info.error}`
  if (!latest) return 'No release has been published yet.'
  const released = latest.publishedAt ? ` was released ${timeAgo(Date.parse(latest.publishedAt))}` : ' is out'
  if (info.updateAvailable && !info.enabled)
    return `${latest.tag}${released}. Install it on the server: deploy/doop.sh update`
  if (info.updateAvailable) return `${latest.tag}${released}.`
  if (status.state === 'succeeded' && status.at) return `Updated to ${status.tag} ${timeAgo(status.at)}.`
  return `This is the latest release.`
}
