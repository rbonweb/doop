import { useEffect, useMemo, useRef, useState } from 'react'
import type { Frame, FrameVersion, FrameVersionInfo } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { recordUpdate } from '../lib/history'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ClockIcon } from './ui/icons'
import { Panel, PanelBody, PanelClose, PanelHeader } from './ui/panel'
import { Skeleton } from './ui/skeleton'

/* How far the preview may grow: the frame is scaled to fit this box, so a tall
   mobile artboard and a wide desktop one both stay readable in the rail. */
const PREVIEW_MAX_HEIGHT = 230
const FALLBACK_WIDTH = 308
/* a burst of edits lands as one refetch */
const REFRESH_DELAY_MS = 800

const REASONS: Record<FrameVersion['reason'], { label: string; tone: 'default' | 'accent' | 'outline' }> = {
  agent: { label: 'Agent', tone: 'accent' },
  human: { label: 'Edit', tone: 'default' },
  restore: { label: 'Before restore', tone: 'outline' },
}

type ListState = { frameId: string; versions: FrameVersionInfo[] } | { frameId: string; error: string }
function savedAtLabel(savedAt: number): string {
  return new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** The version history rail for one frame: every earlier version doop saved,
 *  a live preview of the selected one, and a restore button. It takes the
 *  Inspector's spot while open. */
export function FrameHistoryPanel({
  frame,
  surface = 'floating',
  className,
  onClose,
}: {
  frame: Frame
  surface?: 'floating' | 'inline'
  className?: string
  onClose: () => void
}) {
  const [list, setList] = useState<ListState | null>(null)
  const [reloads, setReloads] = useState(0)
  const [pickedId, setPickedId] = useState<string | null>(null)
  /* full versions fetched so far, and the ones that failed to load */
  const [loaded, setLoaded] = useState<Record<string, FrameVersion>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const loadedFor = useRef<string | null>(null)

  /* load on open, then again (debounced) whenever the frame changes: doop
     saves a version before every change, so the list grows while we watch */
  useEffect(() => {
    let live = true
    const delay = loadedFor.current === frame.id ? REFRESH_DELAY_MS : 0
    const timer = window.setTimeout(() => {
      api.frameVersions(frame.id).then(
        (versions) => {
          if (!live) return
          loadedFor.current = frame.id
          setList({ frameId: frame.id, versions })
        },
        (err) => {
          if (!live) return
          /* a failed refresh keeps the list already on screen */
          setList((prev) =>
            prev && 'versions' in prev && prev.frameId === frame.id
              ? prev
              : { frameId: frame.id, error: errorMessage(err, 'Couldn’t load the version history') },
          )
        },
      )
    }, delay)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [frame.id, frame.updatedAt, reloads])

  const versions = list && list.frameId === frame.id && 'versions' in list ? list.versions : null
  const listError = list && list.frameId === frame.id && 'error' in list ? list.error : null
  const selected = versions?.find((v) => v.id === pickedId) ?? versions?.[0] ?? null
  const selectedId = selected?.id ?? null

  /* versions never change once saved, so each is fetched once */
  const version = selectedId ? (loaded[selectedId] ?? null) : null
  const detailError = selectedId && !version ? (failed[selectedId] ?? null) : null
  useEffect(() => {
    if (!selectedId || version) return
    let live = true
    api.frameVersion(frame.id, selectedId).then(
      (full) => live && setLoaded((prev) => ({ ...prev, [selectedId]: full })),
      (err) =>
        live && setFailed((prev) => ({ ...prev, [selectedId]: errorMessage(err, 'Couldn’t load this version') })),
    )
    return () => {
      live = false
    }
  }, [frame.id, selectedId, version])

  async function restore() {
    if (!version) return
    setRestoring(true)
    setRestoreError(null)
    const before = { html: frame.html, name: frame.name, width: frame.width, height: frame.height }
    try {
      await api.restoreFrameVersion(frame.id, version.id)
      /* a restore is a frame edit like any other: Undo walks it back */
      recordUpdate(frame.id, before, {
        html: version.html,
        name: version.name,
        width: version.width,
        height: version.height,
      })
      useStore.getState().pushNotice(`Restored “${version.name}” to the version from ${timeAgo(version.savedAt)}`)
      setPickedId(null)
      setReloads((n) => n + 1)
    } catch (err) {
      setRestoreError(errorMessage(err, 'Couldn’t restore this version'))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Panel
      surface={surface}
      className={cn(
        surface === 'floating' && 'right-3 top-3 max-h-[calc(100%-24px)] w-[340px] transition-[right] duration-150',
        className,
      )}
      aria-label={`Version history for ${frame.name}`}
    >
      <PanelHeader>
        <span className="flex min-w-0 items-center gap-2">
          <ClockIcon className="size-[14px] shrink-0" />
          <span className="truncate">Version history</span>
        </span>
        <PanelClose onClick={onClose} />
      </PanelHeader>

      {versions === null && !listError && <HistorySkeleton />}

      {listError && (
        <div className="grid gap-3 px-4 py-8 text-center" role="alert">
          <p className="text-[13px] leading-[1.5] text-accent-ink">{listError}</p>
          <div>
            <Button
              size="sm"
              onClick={() => {
                setList(null)
                setReloads((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )}

      {versions && versions.length === 0 && (
        <div className="grid justify-items-center gap-2 px-6 py-10 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-paper-deep text-ink-faint">
            <ClockIcon className="size-[18px]" />
          </span>
          <p className="max-w-[240px] text-[13px] leading-[1.5] text-ink-soft">
            No earlier versions yet — doop saves one before every change.
          </p>
        </div>
      )}

      {versions && versions.length > 0 && selected && (
        <>
          <Preview frame={frame} version={version} error={detailError} />
          <div className="grid gap-2.5 border-b border-line-soft px-4 py-3">
            <div className="min-w-0 text-[12px] leading-[1.45] text-ink-soft">
              <b className="font-semibold text-ink">{savedAtLabel(selected.savedAt)}</b>
              <span className="text-ink-faint"> · {selected.savedBy}</span>
              <span className="block font-mono text-[11px] text-ink-faint">
                {selected.width}×{selected.height}
                {selected.name !== frame.name ? ` · named “${selected.name}”` : ''}
              </span>
            </div>
            {restoreError && (
              <p role="alert" className="text-[12px] leading-[1.4] text-accent-ink">
                {restoreError}
              </p>
            )}
            <Button variant="primary" block disabled={!version || restoring} onClick={() => setConfirming(true)}>
              {restoring ? 'Restoring…' : 'Restore this version'}
            </Button>
          </div>
          <PanelBody className="p-1.5">
            <ul className="grid gap-px" aria-label="Saved versions">
              {versions.map((v) => (
                <li key={v.id}>
                  <VersionRow info={v} selected={v.id === selectedId} onPick={() => setPickedId(v.id)} />
                </li>
              ))}
            </ul>
          </PanelBody>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Restore this version?"
        description={
          version
            ? `“${frame.name}” goes back to the version from ${savedAtLabel(version.savedAt)}. The current design is saved to the history first, so you can return to it.`
            : undefined
        }
        confirmLabel="Restore version"
        onConfirm={() => void restore()}
      />
    </Panel>
  )
}

function VersionRow({ info, selected, onPick }: { info: FrameVersionInfo; selected: boolean; onPick: () => void }) {
  const reason = REASONS[info.reason]
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={savedAtLabel(info.savedAt)}
      onClick={onPick}
      className={cn(
        'relative flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition-colors',
        'hover:bg-paper-deep focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
        selected && 'bg-paper-deep',
      )}
    >
      {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand" />}
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-[1.3] text-ink">{timeAgo(info.savedAt)}</span>
        <span className="block truncate text-[12px] leading-[1.4] text-ink-soft">{info.savedBy}</span>
      </span>
      <Badge tone={reason.tone} className="shrink-0">
        {reason.label}
      </Badge>
    </button>
  )
}

function HistorySkeleton() {
  return (
    <div className="grid gap-3 p-4" aria-busy="true" aria-label="Loading version history">
      <Skeleton className="h-[170px] w-full" />
      <Skeleton className="h-9 w-full" index={1} />
      {[2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-10 w-full" index={i} />
      ))}
    </div>
  )
}

/** A sandboxed render of one version, scaled to fit the rail. The runtime is
 *  the same one frames and presentations use; the html arrives by message. */
function Preview({ frame, version, error }: { frame: Frame; version: FrameVersion | null; error: string | null }) {
  const [boxRef, boxWidth] = useElementWidth<HTMLDivElement>()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source === iframeRef.current?.contentWindow && ev.data?.type === 'doop:frame-ready') setReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const html = version?.html
  useEffect(() => {
    if (!ready || html === undefined) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [ready, html])

  const width = version?.width ?? frame.width
  const height = version?.height ?? frame.height
  const scale = useMemo(
    () => Math.min((boxWidth || FALLBACK_WIDTH) / width, PREVIEW_MAX_HEIGHT / height, 1),
    [boxWidth, width, height],
  )

  return (
    <div ref={boxRef} className="grid min-h-[120px] place-items-center border-b border-line-soft bg-paper-deep p-4">
      <div
        className="relative overflow-hidden rounded-[6px] border border-line bg-white shadow-card"
        style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
      >
        <iframe
          ref={iframeRef}
          className="block border-none bg-white"
          title={`Preview of the version from ${version ? savedAtLabel(version.savedAt) : 'the selected time'}`}
          data-doop-frame=""
          sandbox="allow-scripts"
          srcDoc={FRAME_BOOTSTRAP}
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
        />
        {!version && !error && <Skeleton className="absolute inset-0 rounded-none" />}
        {error && (
          <p
            role="alert"
            className="absolute inset-0 grid place-items-center bg-surface p-3 text-center text-[12px] text-accent-ink"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
