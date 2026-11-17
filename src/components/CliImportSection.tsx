import { useEffect, useMemo, useState } from 'react'
import { ApiError, errorMessage } from '@/lib/api'
import { createImportTicket, forgetImportTicket, relativeIn, type ImportTicket } from '@/lib/componentImport'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { CodeBlock } from './ui/code-block'
import { CheckIcon, BotIcon } from './ui/icons'
import { Note } from './ui/note'
import { Skeleton } from './ui/skeleton'

type Minted =
  { kind: 'loading' } | { kind: 'ready'; ticket: ImportTicket; expiresAt: number } | { kind: 'failed'; message: string }

const MINUTE = 60_000

/** The components on the open canvas by id and revision: what a command's arrivals are measured against. */
function snapshot(canvasId: string): Map<string, number> | null {
  const open = useStore.getState().canvas
  return open?.id === canvasId ? new Map((open.components ?? []).map((c) => [c.id, c.rev])) : null
}

async function mintTicket(canvasId: string, fallback: string, fresh: boolean): Promise<Minted> {
  try {
    const ticket = await createImportTicket(canvasId, { fresh })
    return { kind: 'ready', ticket, expiresAt: Date.parse(ticket.expires_at) }
  } catch (e) {
    return { kind: 'failed', message: e instanceof ApiError ? errorMessage(e, fallback) : fallback }
  }
}

/**
 * The picker's command-line screen: it mints an upload ticket when it opens, shows the one command that
 * uses it (copyable), says when the ticket lapses and offers a new one, and watches the room for the
 * components the command sends, so the person sees them land without leaving the modal.
 */
export function CliImportSection({
  canvasId,
  onBack,
  onOpenPage,
}: {
  canvasId: string
  onBack: () => void
  /** shows the Imported components page */
  onOpenPage: (pageId: string | null) => void
}) {
  const t = useT()
  const [minted, setMinted] = useState<Minted>({ kind: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  /* each "New command" bumps this, which mints again */
  const [attempt, setAttempt] = useState(0)
  const failedText = t('componentImport.ticketFailed')

  /* the ticket is minted when the screen opens; a result that lands after the screen closed is dropped */
  useEffect(() => {
    let live = true
    void mintTicket(canvasId, failedText, attempt > 0).then((result) => {
      if (!live) return
      setNow(Date.now())
      setMinted(result)
    })
    return () => {
      live = false
    }
  }, [canvasId, failedText, attempt])

  function renew() {
    /* a new command starts a new count of what arrives */
    setBaseline(snapshot(canvasId))
    setMinted({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  /* the command flips to expired the moment it lapses, wherever the label's own tick is */
  const expiresAt = minted.kind === 'ready' ? minted.expiresAt : null
  useEffect(() => {
    if (expiresAt === null || Date.now() >= expiresAt) return
    const timer = window.setTimeout(() => setNow(Date.now()), expiresAt - Date.now() + 20)
    return () => window.clearTimeout(timer)
  }, [expiresAt])

  /* the relative time moves on each minute boundary until then */
  useEffect(() => {
    if (expiresAt === null || now >= expiresAt) return
    const timer = window.setTimeout(() => setNow(Date.now()), ((expiresAt - now) % MINUTE) + 20)
    return () => window.clearTimeout(timer)
  }, [expiresAt, now])

  /* what was on the canvas when this screen opened: anything new or revised after it is what the command sent */
  const components = useStore((s) => (s.canvas?.id === canvasId ? s.canvas.components : undefined))
  const [baseline, setBaseline] = useState(() => snapshot(canvasId))
  const landed = useMemo(() => {
    if (!baseline || !components) return 0
    return components.filter(
      (c) => !c.deletedAt && c.code?.origin?.kind === 'cli' && (baseline.get(c.id) ?? -1) < c.rev,
    ).length
  }, [baseline, components])

  /* the command was used: its ticket is spent, so the next opening mints a new one */
  useEffect(() => {
    if (landed > 0) forgetImportTicket(canvasId)
  }, [canvasId, landed])

  const expired = minted.kind === 'ready' && now >= minted.expiresAt
  /* a lapsed or a used command no longer works; the card shows it dimmed and offers another */
  const used = landed > 0
  const spent = expired || used

  return (
    <div data-slot="import-screen">
      <div>
        <ImportStepHeader
          icon={<AppIcon brand="cli" size={40} />}
          title={t('componentImport.cliHeading')}
          lede={t('componentImport.cliLede')}
        />
        <div className="mt-[22px] flex flex-col gap-2.5" data-slot="cli-import">
          <span className="text-label font-medium text-ink-soft">{t('componentImport.commandLabel')}</span>
          {minted.kind === 'loading' && (
            <div role="status" aria-label={t('componentImport.preparing')}>
              <Skeleton className="h-[52px] w-full rounded-card" />
            </div>
          )}
          {minted.kind === 'failed' && (
            <Callout tone="error" className="flex flex-wrap items-center justify-between gap-2" role="alert">
              <span>{minted.message}</span>
              <Button size="sm" onClick={renew}>
                {t('componentImport.newCommand')}
              </Button>
            </Callout>
          )}
          {minted.kind === 'ready' && (
            <>
              {spent ? (
                <div
                  aria-disabled
                  data-slot="cli-command-spent"
                  className="select-none break-all rounded-card bg-code px-3.5 py-3 font-mono text-label text-code-ink opacity-45"
                >
                  {minted.ticket.command}
                </div>
              ) : (
                <CodeBlock text={minted.ticket.command} />
              )}
              <div className="flex items-center justify-between gap-3">
                <Note data-slot="cli-expiry" tone={spent ? 'error' : 'muted'}>
                  {used
                    ? t('componentImport.used')
                    : expired
                      ? t('componentImport.expired')
                      : t('componentImport.expiresIn', { time: relativeIn(minted.expiresAt, now) })}
                </Note>
                <Button size={spent ? 'md' : 'sm'} variant={spent ? 'primary' : 'ghost'} onClick={renew}>
                  {t('componentImport.newCommand')}
                </Button>
              </div>
            </>
          )}
          <Note size="sm">{t('componentImport.commandNote')}</Note>
          <div className="flex items-start gap-2 rounded-row bg-sub px-3 py-2.5 text-body text-ink-soft">
            <BotIcon size="rail" className="mt-0.5 flex-none text-ink-faint" aria-hidden />
            <span>{t('componentImport.agentLine')}</span>
          </div>
          {landed > 0 && (
            <Callout tone="success" className="flex flex-wrap items-center justify-between gap-2" role="status">
              <span className="flex items-center gap-2">
                <CheckIcon size={16} />
                <span>
                  <b className="font-medium">{t('componentImport.landedHeading', { count: landed })}</b>{' '}
                  {t('componentImport.landedBody')}
                </span>
              </span>
              <Button size="sm" variant="primary" onClick={() => onOpenPage(null)}>
                {t('componentImport.openPage')}
              </Button>
            </Callout>
          )}
        </div>
      </div>
      <ImportStepFooter note={t('componentImport.cliNote')} onBack={onBack} />
    </div>
  )
}
