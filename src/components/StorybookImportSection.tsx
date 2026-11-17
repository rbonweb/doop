import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '@/lib/api'
import {
  groupImportIssues,
  type IssueGroupKey,
  relativeInSeconds,
  streamStorybookImport,
  StorybookRequestError,
  type ImportResult,
  type PlannedComponent,
  type StorybookErrorCode,
  type StorybookEvent,
} from '@/lib/componentImport'
import { useT, type Translate } from '@/lib/i18n'
import { posthog } from '@/lib/posthog'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'
import { Badge } from './ui/badge'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Checkbox } from './ui/checkbox'
import { Disclosure } from './ui/collapsible'
import { Field } from './ui/field'
import { CheckIcon } from './ui/icons'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Progress } from './ui/progress'
import { SearchField } from './ui/search-field'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'

/** Names listed before "+N more", so a 60-component Storybook still fits the modal. */
const NAMES_SHOWN = 8

/** The most components one import takes (the bundle's cap): the checklist stops selecting here. */
const MAX_IMPORT = 60

/** A list this long gets a filter field above it. */
const FILTER_FROM = 12

/** Seconds without a progress line before the card says it is still rendering. */
const STILL_RENDERING_S = 8

/** Skipped components named in the result before "+N more". */
const SKIPPED_SHOWN = 8

export type StorybookPhase =
  | { kind: 'idle'; cancelled?: boolean }
  | { kind: 'reading' }
  | { kind: 'preview'; plan: PlannedComponent[]; result: ImportResult; found?: number }
  | { kind: 'running'; rendered: number; total: number; component: string | null; at?: number }
  | { kind: 'done'; result: ImportResult }
  | {
      kind: 'refused'
      code: StorybookErrorCode | 'generic' | 'rate_limited'
      message: string
      retryAfter?: number | null
    }

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** The address a person typed, made into one the server can open. */
function normalizeUrl(raw: string): string {
  const clean = raw.trim()
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
}

/** The Storybook titles of a plan, one each, or null when a component does not carry one (it cannot be narrowed). */
/** What an import takes when nothing is chosen: the first MAX_IMPORT titles. */
function firstTitles(titles: string[] | null): string[] {
  return (titles ?? []).slice(0, MAX_IMPORT)
}

function planTitles(plan: PlannedComponent[]): string[] | null {
  if (plan.length < 2 || plan.some((c) => !c.group)) return null
  return [...new Set(plan.map((c) => c.group as string))]
}

/** "Component: message", unless the message already begins with the component's name. */
function noteLine(t: Translate, component: string | undefined, message: string): string {
  const text = plain(message)
  if (!component || text.toLowerCase().startsWith(component.toLowerCase())) return text
  return t('componentImport.issueLine', { component, message: text })
}

/** A server note as one plain line: no backticks, no run of spaces or line breaks. */
function plain(message: string): string {
  return message.replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

/** One import note group, in plain words with its count. */
function issueSummary(t: Translate, key: IssueGroupKey, count: number): string {
  switch (key) {
    case 'worker':
      return t('componentImport.issueWorker', { count })
    case 'props':
      return t('componentImport.issueProps', { count })
    case 'noProps':
      return t('componentImport.issueNoProps', { count })
    case 'styles':
      return t('componentImport.issueStyles', { count })
    case 'variants':
      return t('componentImport.issueVariants', { count })
    case 'markup':
      return t('componentImport.issueMarkup', { count })
    case 'files':
      return t('componentImport.issueFiles', { count })
    case 'unsafe':
      return t('componentImport.issueUnsafe', { count })
    case 'limits':
      return t('componentImport.issueLimits', { count })
    case 'other':
      return t('componentImport.issueOther', { count })
  }
}

/** The header, the screen's body, then its footer. */
function Screen({ header, footer, children }: { header: ReactNode; footer: ReactNode; children?: ReactNode }) {
  return (
    <div data-slot="import-screen">
      {header}
      {children}
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
    () => new Set(initialPhase.kind === 'preview' ? firstTitles(planTitles(initialPhase.plan)) : []),
  )
  const [filter, setFilter] = useState('')
  const controller = useRef<AbortController | null>(null)

  /* closing the modal mid-import closes the request, which stops the import on the server */
  useEffect(() => () => controller.current?.abort(), [])

  /* one clock while an import runs, so a render that takes tens of seconds still reads as alive */
  const [now, setNow] = useState(() => Date.now())
  const running = phase.kind === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const busy = phase.kind === 'reading' || phase.kind === 'running'
  const ready = url.trim().length > 0

  function refusal(
    code: StorybookErrorCode | 'generic' | 'rate_limited',
    message: string,
    retryAfter?: number | null,
  ): StorybookPhase {
    return { kind: 'refused', code, message, retryAfter }
  }

  async function run(dryRun: boolean, include?: string[]) {
    if (busy || !ready) return
    const abort = new AbortController()
    controller.current = abort
    setPhase(dryRun ? { kind: 'reading' } : { kind: 'running', rendered: 0, total: 0, component: null, at: Date.now() })
    let plan: PlannedComponent[] = []
    let found: number | undefined
    const onEvent = (event: StorybookEvent) => {
      if (event.type === 'plan') {
        plan = event.components
        found = event.total
        if (!dryRun) setPhase({ kind: 'running', rendered: 0, total: event.renders, component: null, at: Date.now() })
      } else if (event.type === 'progress') {
        setPhase({
          kind: 'running',
          rendered: event.rendered,
          total: event.total,
          component: event.component ?? null,
          at: Date.now(),
        })
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
          setPicked(new Set(firstTitles(planTitles(plan))))
          setFilter('')
          setPhase({ kind: 'preview', plan, result: last.result, found })
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
      else if (e instanceof ApiError) {
        const message = String(e.body.error ?? e.body.message ?? '')
        /* a 429 before streaming is the hourly cap, with the server's own words and a wait; "busy" is a real busy code */
        if (e.status === 429)
          setPhase(refusal('rate_limited', message, e instanceof StorybookRequestError ? e.retryAfterSeconds : null))
        else setPhase(refusal('generic', message))
      } else setPhase(refusal('unreachable', ''))
    } finally {
      if (controller.current === abort) controller.current = null
    }
  }

  /* fixed copy where Doop knows the cause; otherwise the server's own words, which are already for people */
  function refusedText(code: StorybookErrorCode | 'generic' | 'rate_limited', message: string) {
    switch (code) {
      case 'rate_limited':
        return message || t('componentImport.rateLimited')
      case 'private':
        return t('componentImport.errPrivate')
      case 'unreachable':
        return t('componentImport.errUnreachable')
      case 'too_many':
        return t('componentImport.errTooMany')
      case 'busy':
        return t('componentImport.errBusy')
      case 'needs_worker':
        return t('componentImport.errNeedsWorker')
      default:
        return message || t('componentImport.errGeneric')
    }
  }
  const refusedHeading = (code: StorybookErrorCode | 'generic' | 'rate_limited') =>
    code === 'invalid' || code === 'generic' || code === 'rate_limited'
      ? t('componentImport.failedHeading')
      : t('componentImport.refusedHeading')

  const header = (
    <ImportStepHeader
      icon={<AppIcon brand="storybook" size={40} />}
      title={t('componentImport.storybookHeading')}
      lede={t('componentImport.storybookLede')}
    />
  )

  if (phase.kind === 'running') {
    const known = phase.total > 0
    /* seconds since the last line from the server (progress or plan) */
    const silent = phase.at ? Math.max(0, Math.floor((now - phase.at) / 1000)) : 0
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
          <Note>
            {silent >= STILL_RENDERING_S
              ? t('componentImport.stillRendering', { seconds: silent })
              : t('componentImport.runningNote')}
          </Note>
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
    /* a component imported under another name is told apart from the other notes, as the preview did */
    const renamed = result.issues.filter((i) => i.code === 'renamed' && (i.detail || i.component))
    const renamedLines = renamed.map((i) =>
      t('componentImport.renamedLine', {
        name: i.detail?.from ?? (i.component as string),
        /* an older server names the new name only in the message */
        to: i.detail?.to ?? /imported as “([^”]+)”/.exec(i.message)?.[1] ?? i.component ?? '',
      }),
    )
    const groups = groupImportIssues(result.issues.filter((i) => i.code !== 'renamed'))
    const summary = groups.map((group) => issueSummary(t, group.key, group.items.length))
    const needsWorker = groups.some((group) => group.key === 'worker')
    const skippedLines = result.skipped.map((c) =>
      t('componentImport.skippedLine', { name: c.name, reason: plain(c.reason) }),
    )
    const details = groups.flatMap((group) => group.items.map((i) => noteLine(t, i.component, i.message)))
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
          {renamedLines.length > 0 && (
            <div className="flex flex-col gap-1.5" data-slot="storybook-renamed">
              <span className="text-label font-medium text-ink-soft">
                {t('componentImport.renamedHeading', { count: renamedLines.length })}
              </span>
              <ul className="flex flex-col gap-1 text-label text-ink-soft">
                {renamedLines.slice(0, SKIPPED_SHOWN).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {renamedLines.length > SKIPPED_SHOWN && (
                <Note>{t('componentImport.moreNames', { count: renamedLines.length - SKIPPED_SHOWN })}</Note>
              )}
            </div>
          )}
          {skippedLines.length > 0 && (
            <div className="flex flex-col gap-1.5" data-slot="storybook-skipped">
              <span className="text-label font-medium text-ink-soft">
                {t('componentImport.skippedHeading', { count: skippedLines.length })}
              </span>
              <ul className="flex flex-col gap-1 text-label text-ink-soft">
                {skippedLines.slice(0, SKIPPED_SHOWN).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {skippedLines.length > SKIPPED_SHOWN && (
                <Disclosure
                  label={
                    <span className="text-label text-ink-faint">
                      {t('componentImport.moreNames', { count: skippedLines.length - SKIPPED_SHOWN })}
                    </span>
                  }
                >
                  <ul className="flex flex-col gap-1 text-label text-ink-soft">
                    {skippedLines.slice(SKIPPED_SHOWN).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </div>
          )}
          {summary.length > 0 && (
            <div className="flex flex-col gap-1.5" data-slot="storybook-issues">
              <span className="text-label font-medium text-ink-soft">{t('componentImport.issuesHeading')}</span>
              <ul className="flex flex-col gap-1 text-label text-ink-soft">
                {summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {needsWorker && (
                <Button size="sm" className="self-start" onClick={onUseCli}>
                  {t('componentImport.useCli')}
                </Button>
              )}
              <Disclosure
                label={<span className="text-label font-medium text-ink-faint">{t('componentImport.details')}</span>}
                contentClassName="mt-1.5"
              >
                <ul className="flex max-h-[168px] flex-col gap-1 overflow-y-auto text-label text-ink-soft">
                  {details.slice(0, 100).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {details.length > 100 && <Note>{t('componentImport.moreNames', { count: details.length - 100 })}</Note>}
              </Disclosure>
            </div>
          )}
        </div>
      </Screen>
    )
  }

  if (phase.kind === 'preview') {
    const { result, plan } = phase
    const titles = planTitles(plan)
    const everything = !titles || (titles.length <= MAX_IMPORT && picked.size === titles.length)
    /* the lists, the counts and the renders follow what is ticked, not the whole plan */
    const chosen = titles ? plan.filter((c) => c.group && picked.has(c.group)) : plan
    const planned = new Set(plan.map((c) => c.name))
    const chosenNames = new Set(chosen.map((c) => c.name))
    const inChoice = (name: string) => !planned.has(name) || chosenNames.has(name)
    const created = result.created.filter((c) => inChoice(c.name))
    const updated = result.updated.filter((c) => inChoice(c.name))
    const skipped = result.skipped.filter((c) => inChoice(c.name))
    const empty = !created.length && !updated.length
    const renders = chosen.reduce((sum, c) => sum + c.renders, 0)
    const nothingPicked = !!titles && picked.size === 0
    const full = !!titles && picked.size >= MAX_IMPORT
    const found = Math.max(phase.found ?? 0, titles?.length ?? 0)
    const needle = filter.trim().toLowerCase()
    const shown = titles ? titles.filter((title) => !needle || title.toLowerCase().includes(needle)) : []
    const toggle = (title: string) =>
      setPicked((current) => {
        const next = new Set(current)
        if (next.has(title)) next.delete(title)
        else if (next.size < MAX_IMPORT) next.add(title)
        return next
      })
    /* Select all takes what the filter shows, in order, up to the cap */
    const selectShown = () =>
      setPicked((current) => {
        const next = new Set(current)
        for (const title of shown) if (next.size < MAX_IMPORT) next.add(title)
        return next
      })
    return (
      <Screen
        header={header}
        footer={
          <ImportStepFooter note={t('componentImport.storybookNote')} onBack={() => setPhase({ kind: 'idle' })}>
            <Button
              variant="primary"
              disabled={empty || nothingPicked}
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
            label={t('componentImport.wouldCreate', { count: created.length })}
            names={created.map((c) => c.name)}
          />
          <NameList
            label={t('componentImport.wouldUpdate', { count: updated.length })}
            names={updated.map((c) => c.name)}
          />
          {skipped.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-ink-soft">
                {t('componentImport.wouldSkip', { count: skipped.length })}
              </span>
              <ul className="flex max-h-[96px] flex-col gap-1 overflow-y-auto text-label text-ink-soft">
                {skipped.map((s) => (
                  <li key={s.name}>{t('componentImport.skippedLine', { name: s.name, reason: s.reason })}</li>
                ))}
              </ul>
            </div>
          )}
          {titles && (
            <div data-slot="storybook-choose">
              {found > MAX_IMPORT && (
                <Note size="sm" className="mb-2 block" data-slot="storybook-found">
                  {t('componentImport.foundPick', { count: found, max: MAX_IMPORT })}
                </Note>
              )}
              {titles.length > FILTER_FROM && (
                <SearchField
                  className="mb-2"
                  aria-label={t('componentImport.chooseFilter')}
                  placeholder={t('componentImport.chooseFilter')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <SelectionBar
                count={picked.size}
                total={titles.length}
                note={full ? ` · ${t('componentImport.chooseFull')}` : undefined}
                actions={
                  <>
                    <SelectionBarAction disabled={full} onClick={selectShown}>
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
                {shown.length === 0 && (
                  <p className="px-3.5 py-2.5 text-label text-ink-faint">{t('componentImport.chooseNone')}</p>
                )}
                {shown.map((title) => {
                  const on = picked.has(title)
                  return (
                    <label
                      key={title}
                      className="relative flex min-h-9 cursor-pointer items-center gap-3 border-b border-line-soft px-3.5 py-1.5 transition-colors last:border-b-0 hover:bg-sub"
                    >
                      <Checkbox checked={on} disabled={!on && full} onChange={() => toggle(title)} />
                      <span className="min-w-0 truncate text-body text-ink">{title}</span>
                    </label>
                  )
                })}
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
          {phase.code === 'rate_limited' && phase.retryAfter ? (
            <span>{t('componentImport.retryIn', { time: relativeInSeconds(phase.retryAfter) })}</span>
          ) : null}
          {(phase.code === 'private' || phase.code === 'too_many' || phase.code === 'needs_worker') && (
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
