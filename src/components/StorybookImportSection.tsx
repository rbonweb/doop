import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '@/lib/api'
import {
  streamStorybookImport,
  type ImportResult,
  type PlannedComponent,
  type StorybookErrorCode,
  type StorybookEvent,
} from '@/lib/componentImport'
import { useT } from '@/lib/i18n'
import { posthog } from '@/lib/posthog'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'
import { Badge } from './ui/badge'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { CheckIcon } from './ui/icons'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Progress } from './ui/progress'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'

/** Names listed before "+N more", so a 60-component Storybook still fits the modal. */
const NAMES_SHOWN = 8

/** The most titles the server takes in one `include`. */
const MAX_INCLUDE = 50

export type StorybookPhase =
  | { kind: 'idle'; cancelled?: boolean }
  | { kind: 'reading' }
  | { kind: 'preview'; plan: PlannedComponent[]; result: ImportResult }
  | { kind: 'running'; rendered: number; total: number; component: string | null }
  | { kind: 'done'; result: ImportResult }
  | { kind: 'refused'; code: StorybookErrorCode | 'generic'; message: string }

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** The address a person typed, made into one the server can open. */
function normalizeUrl(raw: string): string {
  const clean = raw.trim()
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
}

/** The Storybook titles of a plan, one each, or null when a component does not carry one (it cannot be narrowed). */
function planTitles(plan: PlannedComponent[]): string[] | null {
  if (plan.length < 2 || plan.some((c) => !c.group)) return null
  return [...new Set(plan.map((c) => c.group as string))]
}

/** One height for every state, so the modal does not re-centre as the import moves along. */
function Screen({ header, footer, children }: { header: ReactNode; footer: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-[440px] flex-col" data-slot="import-screen">
      <div className="flex-1">
        {header}
        {children}
      </div>
      {footer}
    </div>
  )
}

function NameList({ names, label }: { names: string[]; label: string }) {
  const t = useT()
  if (!names.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label font-medium text-ink-soft">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {names.slice(0, NAMES_SHOWN).map((name) => (
          <Badge key={name} tone="outline">
            {name}
          </Badge>
        ))}
        {names.length > NAMES_SHOWN && (
          <Note className="self-center">{t('componentImport.moreNames', { count: names.length - NAMES_SHOWN })}</Note>
        )}
      </div>
    </div>
  )
}

/**
 * The picker's Storybook screen: an address (and the package the components come from), a dry run that
 * lists what would be created, updated and skipped (and lets a big plan be narrowed), then the import with
 * its progress, and the result. A Storybook that needs a login is refused, and the refusal offers the
 * command-line card.
 */
export function StorybookImportSection({
  canvasId,
  onBack,
  onUseCli,
  onOpenPage,
  initialPhase = { kind: 'idle' },
  initialUrl = '',
}: {
  canvasId: string
  onBack: () => void
  /** the refusal's way out: the CLI card */
  onUseCli: () => void
  /** shows the Imported components page (the result's id, when it names one) */
  onOpenPage: (pageId: string | null) => void
  /** the stories open on a state mid-way instead of waiting for a real import */
  initialPhase?: StorybookPhase
  initialUrl?: string
}) {
  const t = useT()
  const [url, setUrl] = useState(initialUrl)
  const [pkg, setPkg] = useState('')
  const [phase, setPhase] = useState<StorybookPhase>(initialPhase)
  /* the Storybook titles ticked in the preview's checklist; all of them until the person narrows it */
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initialPhase.kind === 'preview' ? (planTitles(initialPhase.plan) ?? []) : []),
  )
  const controller = useRef<AbortController | null>(null)

  /* closing the modal mid-import closes the request, which stops the import on the server */
  useEffect(() => () => controller.current?.abort(), [])

  const busy = phase.kind === 'reading' || phase.kind === 'running'
  const ready = url.trim().length > 0

  function refusal(code: StorybookErrorCode | 'generic', message: string): StorybookPhase {
    return { kind: 'refused', code, message }
  }

  async function run(dryRun: boolean, include?: string[]) {
    if (busy || !ready) return
    const abort = new AbortController()
    controller.current = abort
    setPhase(dryRun ? { kind: 'reading' } : { kind: 'running', rendered: 0, total: 0, component: null })
    let plan: PlannedComponent[] = []
    const onEvent = (event: StorybookEvent) => {
      if (event.type === 'plan') {
        plan = event.components
        if (!dryRun) setPhase({ kind: 'running', rendered: 0, total: event.renders, component: null })
      } else if (event.type === 'progress') {
        setPhase({ kind: 'running', rendered: event.rendered, total: event.total, component: event.component ?? null })
      }
    }
    try {
      const last = await streamStorybookImport(
        canvasId,
        { url: normalizeUrl(url), package: pkg.trim(), include, dryRun },
        abort.signal,
        onEvent,
      )
      if (last?.type === 'result') {
        if (dryRun) {
          setPicked(new Set(planTitles(plan) ?? []))
          setPhase({ kind: 'preview', plan, result: last.result })
        } else {
          setPhase({ kind: 'done', result: { ...last.result, issues: last.issues ?? last.result.issues } })
          posthog.capture('storybook_imported', {
            created: last.result.created.length,
            updated: last.result.updated.length,
          })
        }
      } else if (last?.type === 'error') setPhase(refusal(last.code, last.message))
      else setPhase(refusal('generic', ''))
    } catch (e) {
      if (isAbort(e)) setPhase({ kind: 'idle', cancelled: true })
      else if (e instanceof ApiError)
        setPhase(refusal(e.status === 429 ? 'busy' : 'generic', String(e.body.error ?? e.body.message ?? '')))
      else setPhase(refusal('unreachable', ''))
    } finally {
      if (controller.current === abort) controller.current = null
    }
  }

  /* fixed copy where Doop knows the cause; otherwise the server's own words, which are already for people */
  function refusedText(code: StorybookErrorCode | 'generic', message: string) {
    switch (code) {
      case 'private':
        return t('componentImport.errPrivate')
      case 'unreachable':
        return t('componentImport.errUnreachable')
      case 'too_many':
        return t('componentImport.errTooMany')
      case 'busy':
        return t('componentImport.errBusy')
      default:
        return message || t('componentImport.errGeneric')
    }
  }
  const refusedHeading = (code: StorybookErrorCode | 'generic') =>
    code === 'invalid' || code === 'generic' ? t('componentImport.failedHeading') : t('componentImport.refusedHeading')

  const header = (
    <ImportStepHeader
      icon={<AppIcon brand="storybook" size={40} />}
      title={t('componentImport.storybookHeading')}
      lede={t('componentImport.storybookLede')}
    />
  )

  if (phase.kind === 'running') {
    const known = phase.total > 0
    return (
      <Screen
        header={header}
        footer={
          <ImportStepFooter onBack={onBack} backDisabled>
            <Button variant="ghost" onClick={() => controller.current?.abort()}>
              {t('componentImport.cancel')}
            </Button>
          </ImportStepFooter>
        }
      >
        <div className="mt-[22px] flex flex-col gap-3" role="status" aria-live="polite" data-slot="storybook-progress">
          <div className="flex items-baseline justify-between gap-3 text-body">
            <span className="font-medium text-ink">
              {known
                ? t('componentImport.progress', { rendered: phase.rendered, total: phase.total })
                : t('componentImport.starting')}
            </span>
            {phase.component && (
              <span className="min-w-0 truncate text-caption text-ink-faint">
                {t('componentImport.currentComponent', { component: phase.component })}
              </span>
            )}
          </div>
          <Progress
            aria-label={t('componentImport.progressAria')}
            indeterminate={!known}
            value={known ? phase.rendered : 0}
            max={known ? phase.total : 1}
          />
          <Note>{t('componentImport.runningNote')}</Note>
        </div>
      </Screen>
    )
  }

  if (phase.kind === 'done') {
    const { result } = phase
    const counts = [
      result.created.length && t('componentImport.created', { count: result.created.length }),
      result.updated.length && t('componentImport.updated', { count: result.updated.length }),
      result.unchanged.length && t('componentImport.unchanged', { count: result.unchanged.length }),
      result.skipped.length && t('componentImport.skipped', { count: result.skipped.length }),
      result.tokens.created.length && t('componentImport.tokensAdded', { count: result.tokens.created.length }),
    ].filter(Boolean)
    const worth = [
      ...result.skipped.map((s) => t('componentImport.skippedLine', { name: s.name, reason: s.reason })),
      ...result.issues.map((i) =>
        i.component ? t('componentImport.issueLine', { component: i.component, message: i.message }) : i.message,
      ),
    ]
    return (
      <Screen
        header={header}
        footer={
          <ImportStepFooter onBack={onBack}>
            <Button variant="ghost" onClick={() => setPhase({ kind: 'idle' })}>
              {t('componentImport.importAnother')}
            </Button>
            <Button variant="primary" onClick={() => onOpenPage(result.pageId)}>
              {t('componentImport.openPage')}
            </Button>
          </ImportStepFooter>
        }
      >
        <div className="mt-[22px] flex flex-col gap-3.5" data-slot="storybook-done">
          <div className="flex items-center gap-2 text-copy font-medium text-ink">
            <CheckIcon size={16} className="text-success-ink" />
            {t('componentImport.doneHeading')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {counts.map((count) => (
              <Badge key={String(count)} tone="success">
                {count}
              </Badge>
            ))}
          </div>
          {worth.length > 0 && (
            <div className="flex flex-col gap-1.5" data-slot="storybook-issues">
              <span className="text-label font-medium text-ink-soft">{t('componentImport.issuesHeading')}</span>
              <ul className="flex max-h-[132px] flex-col gap-1 overflow-y-auto text-label text-ink-soft">
                {worth.slice(0, 20).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {worth.length > 20 && <Note>{t('componentImport.moreNames', { count: worth.length - 20 })}</Note>}
            </div>
          )}
        </div>
      </Screen>
    )
  }

  if (phase.kind === 'preview') {
    const { result, plan } = phase
    const empty = !result.created.length && !result.updated.length
    const renders = plan.reduce((sum, c) => sum + c.renders, 0)
    const titles = planTitles(plan)
    const everything = !titles || picked.size === titles.length
    const tooMany = !everything && picked.size > MAX_INCLUDE
    const nothingPicked = !!titles && picked.size === 0
    const toggle = (title: string) =>
      setPicked((current) => {
        const next = new Set(current)
        if (next.has(title)) next.delete(title)
        else next.add(title)
        return next
      })
    return (
      <Screen
        header={header}
        footer={
          <ImportStepFooter note={t('componentImport.storybookNote')} onBack={() => setPhase({ kind: 'idle' })}>
            <Button
              variant="primary"
              disabled={empty || nothingPicked || tooMany}
              onClick={() => void run(false, everything ? undefined : [...picked])}
            >
              {t('componentImport.import')}
            </Button>
          </ImportStepFooter>
        }
      >
        <div className="mt-[22px] flex flex-col gap-3.5" data-slot="storybook-preview">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-copy font-medium text-ink">{t('componentImport.previewHeading')}</span>
            {renders > 0 && <Note>{t('componentImport.plannedRenders', { count: renders })}</Note>}
          </div>
          {empty && <Note size="sm">{t('componentImport.previewNothing')}</Note>}
          <NameList
            label={t('componentImport.wouldCreate', { count: result.created.length })}
            names={result.created.map((c) => c.name)}
          />
          <NameList
            label={t('componentImport.wouldUpdate', { count: result.updated.length })}
            names={result.updated.map((c) => c.name)}
          />
          {result.skipped.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-ink-soft">
                {t('componentImport.wouldSkip', { count: result.skipped.length })}
              </span>
              <ul className="flex max-h-[96px] flex-col gap-1 overflow-y-auto text-label text-ink-soft">
                {result.skipped.map((s) => (
                  <li key={s.name}>{t('componentImport.skippedLine', { name: s.name, reason: s.reason })}</li>
                ))}
              </ul>
            </div>
          )}
          {titles && (
            <div data-slot="storybook-choose">
              <SelectionBar
                count={picked.size}
                total={titles.length}
                tone={tooMany ? 'error' : 'default'}
                note={tooMany ? ` ${t('componentImport.chooseAtMost', { count: MAX_INCLUDE })}` : undefined}
                actions={
                  <>
                    <SelectionBarAction onClick={() => setPicked(new Set(titles))}>
                      {t('panels.exportSelectAll')}
                    </SelectionBarAction>
                    <SelectionBarAction onClick={() => setPicked(new Set())}>
                      {t('panels.exportClear')}
                    </SelectionBarAction>
                  </>
                }
              />
              <div
                role="group"
                aria-label={t('componentImport.chooseAria')}
                className="max-h-[168px] overflow-y-auto rounded-panel bg-surface shadow-ring"
              >
                {titles.map((title) => (
                  <label
                    key={title}
                    className="relative flex min-h-9 cursor-pointer items-center gap-3 border-b border-line-soft px-3.5 py-1.5 transition-colors last:border-b-0 hover:bg-sub"
                  >
                    <Checkbox checked={picked.has(title)} onChange={() => toggle(title)} />
                    <span className="min-w-0 truncate text-body text-ink">{title}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </Screen>
    )
  }

  return (
    <Screen
      header={header}
      footer={
        <ImportStepFooter note={t('componentImport.storybookNote')} onBack={onBack} backDisabled={busy}>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void run(true)}>
            {phase.kind === 'reading'
              ? t('componentImport.reading')
              : phase.kind === 'refused'
                ? t('componentImport.tryAgain')
                : t('componentImport.preview')}
          </Button>
        </ImportStepFooter>
      }
    >
      <Field className="mt-[22px]" label={t('componentImport.urlLabel')} labelVariant="form" htmlFor="storybook-url">
        <Input
          id="storybook-url"
          variant="well"
          inputSize="lg"
          className="font-mono"
          autoFocus
          placeholder={t('componentImport.urlPlaceholder')}
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value)
            if (phase.kind !== 'idle') setPhase({ kind: 'idle' })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(true)
          }}
        />
      </Field>
      <Field
        className="mt-3.5"
        label={
          <>
            {t('componentImport.packageLabel')}{' '}
            <em className="ml-[7px] rounded-full bg-paper-deep px-1.5 py-px text-micro font-medium not-italic text-ink-faint">
              {t('componentImport.optional')}
            </em>
          </>
        }
        labelVariant="form"
        htmlFor="storybook-package"
        hint={t('componentImport.packageHint')}
      >
        <Input
          id="storybook-package"
          variant="well"
          inputSize="lg"
          className="font-mono"
          placeholder={t('componentImport.packagePlaceholder')}
          value={pkg}
          disabled={busy}
          onChange={(e) => setPkg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(true)
          }}
        />
      </Field>
      {phase.kind === 'refused' && (
        <Callout tone="error" className="mt-4 flex flex-col items-start gap-2" role="alert">
          <b className="font-medium">{refusedHeading(phase.code)}</b>
          <span>{refusedText(phase.code, phase.message)}</span>
          {(phase.code === 'private' || phase.code === 'too_many') && (
            <Button size="sm" onClick={onUseCli}>
              {t('componentImport.useCli')}
            </Button>
          )}
        </Callout>
      )}
      {phase.kind === 'idle' && phase.cancelled && (
        <Callout className="mt-4" role="status" data-slot="storybook-cancelled">
          {t('componentImport.cancelled')}
        </Callout>
      )}
    </Screen>
  )
}
