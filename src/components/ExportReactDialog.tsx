import { useEffect, useRef, useState } from 'react'
import type { ComponentDef } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { useT } from '../lib/i18n'
import {
  downloadReactZip,
  fetchReactFiles,
  ReactExportError,
  type ReactExportBody,
  type ReactExportReport,
  type ReactZipResult,
} from '../lib/reactExport'
import { setReactExportSettings, useReactExportSettings, type ReactStyling } from '../lib/reactExportSettings'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Checkbox } from './ui/checkbox'
import { CheckIcon, ImportIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Progress } from './ui/progress'
import { Segmented, SegmentedItem } from './ui/segmented'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'
import { Switch } from './ui/switch'

export type ReactExportScope = 'frame' | 'page' | 'components'

type Phase =
  | { phase: 'choose' }
  | { phase: 'running' }
  | { phase: 'done'; result: ReactZipResult; body: ReactExportBody }
  | { phase: 'failed'; message: string }

/** The list of what did not carry over, asked for on demand after a zip: loading, shown or failed. */
type Dropped =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'shown'; issues: ReactExportReport['issues'] }
  | { phase: 'failed'; message: string }

/** The scope the dialog opens on: what is selected, else the page, else the components. */
function firstScope(frames: number, pageFrames: number): ReactExportScope {
  if (frames > 0) return 'frame'
  return pageFrames > 0 ? 'page' : 'components'
}

/**
 * Export to React: a zip of typed components and pages from this canvas.
 *
 *  - `frames`: the frames selected on the page; the "this frame" scope exports them as pages.
 *  - `page`: the page in view; its frames are exported as pages.
 *  - `components`: the canvas's active components, ticked one by one; an export carries the ones
 *    the frames use too.
 *
 * Styling and tokens are remembered per browser; the scope is not, since it depends on what is open.
 */
export function ExportReactDialog({
  canvasId,
  frames,
  page,
  components,
  initialComponentIds,
  initialScope,
  onClose,
}: {
  canvasId: string
  frames: Frame[]
  page: { id: string; name: string; frameCount: number } | null
  components: ComponentDef[]
  /** the components ticked on opening; every one when not given */
  initialComponentIds?: string[]
  /** the scope it opens on; the selection, else the page, else the components when not given */
  initialScope?: ReactExportScope
  onClose: () => void
}) {
  const t = useT()
  const settings = useReactExportSettings()
  const [scope, setScope] = useState<ReactExportScope>(
    () => initialScope ?? firstScope(frames.length, page?.frameCount ?? 0),
  )
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(initialComponentIds ?? components.map((component) => component.id)),
  )
  const [state, setState] = useState<Phase>({ phase: 'choose' })
  const [dropped, setDropped] = useState<Dropped>({ phase: 'closed' })
  /* the download carries on if the dialog is closed; only the dialog stops listening */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const pageFrameCount = page?.frameCount ?? 0
  const picked = components.filter((component) => checked.has(component.id))
  const running = state.phase === 'running'
  const available: Record<ReactExportScope, boolean> = {
    frame: frames.length > 0,
    page: pageFrameCount > 0,
    components: components.length > 0,
  }
  const ready = scope === 'frame' ? frames.length > 0 : scope === 'page' ? pageFrameCount > 0 : picked.length > 0

  function body(): ReactExportBody {
    const shared = { styling: settings.styling, tokens: settings.tokens }
    if (scope === 'frame') return { ...shared, frameIds: frames.map((frame) => frame.id) }
    if (scope === 'page' && page) return { ...shared, pageId: page.id }
    return { ...shared, componentIds: picked.map((component) => component.id) }
  }

  async function download() {
    if (!ready || running) return
    setState({ phase: 'running' })
    setDropped({ phase: 'closed' })
    const sent = body()
    try {
      const result = await downloadReactZip(canvasId, sent)
      if (mounted.current) setState({ phase: 'done', result, body: sent })
    } catch (err) {
      const message = err instanceof ReactExportError ? err.message : t('reactExport.failed')
      if (mounted.current) setState({ phase: 'failed', message })
    }
  }

  /* the same scope again as data, for the report's list (the zip answer carries only the count) */
  async function showDropped(sent: ReactExportBody) {
    if (dropped.phase === 'shown') return setDropped({ phase: 'closed' })
    setDropped({ phase: 'loading' })
    try {
      const { report } = await fetchReactFiles(canvasId, sent)
      if (mounted.current) setDropped({ phase: 'shown', issues: report.issues })
    } catch (err) {
      const message = err instanceof ReactExportError ? err.message : t('reactExport.failed')
      if (mounted.current) setDropped({ phase: 'failed', message })
    }
  }

  function toggle(componentId: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(componentId)) next.delete(componentId)
      else next.add(componentId)
      return next
    })
  }

  const [firstFrame] = frames

  return (
    <Modal size="md" onClose={onClose}>
      <ModalTitle>{t('reactExport.title')}</ModalTitle>
      <ModalLede>{t('reactExport.lede')}</ModalLede>
      {state.phase === 'done' ? (
        <div role="status" aria-live="polite" className="mt-5">
          <Callout tone="success" className="flex items-start gap-2.5">
            <CheckIcon size="rail" className="mt-0.5 flex-none" />
            <span className="min-w-0">
              <span className="block font-medium break-words">
                {t('reactExport.doneTitle', { fileName: state.result.fileName })}
              </span>
              <span className="block">
                {state.result.issueCount === null
                  ? t('reactExport.doneUnknown')
                  : state.result.issueCount === 0
                    ? t('reactExport.doneClean')
                    : t('reactExport.doneIssues', { count: state.result.issueCount })}
              </span>
            </span>
          </Callout>
          {(state.result.issueCount ?? 0) > 0 && (
            <div className="mt-3">
              <Button
                variant="link"
                size="inline"
                disabled={dropped.phase === 'loading'}
                onClick={() => void showDropped(state.body)}
              >
                {dropped.phase === 'loading'
                  ? t('reactExport.issuesLoading')
                  : dropped.phase === 'shown'
                    ? t('reactExport.issuesHide')
                    : t('reactExport.issuesSee')}
              </Button>
              {dropped.phase === 'shown' &&
                (dropped.issues.length === 0 ? (
                  <p className="mt-2 text-body text-ink-soft">{t('reactExport.issuesNone')}</p>
                ) : (
                  <ul
                    aria-label={t('reactExport.issuesAria')}
                    className="mt-2 max-h-48 list-none space-y-1.5 overflow-y-auto rounded-control bg-sub px-3 py-2 text-body text-ink-soft shadow-ring"
                  >
                    {dropped.issues.map((issue, index) => (
                      <li key={index} className="break-words">
                        <span className="text-ink">{issue.detail}</span>
                        <span className="block font-mono text-caption text-ink-faint">{issue.file}</span>
                      </li>
                    ))}
                  </ul>
                ))}
              {dropped.phase === 'failed' && (
                <p role="alert" className="mt-2 text-body text-accent-ink">
                  {dropped.message}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-2">
            <span id="react-export-scope" className="text-label font-medium text-ink-soft">
              {t('reactExport.scopeLabel')}
            </span>
            <Segmented
              value={scope}
              onValueChange={(next) => setScope(next as ReactExportScope)}
              aria-labelledby="react-export-scope"
              disabled={running}
            >
              <SegmentedItem value="frame" disabled={!available.frame}>
                {t('reactExport.scopeFrame', { count: Math.max(frames.length, 1) })}
              </SegmentedItem>
              <SegmentedItem value="page" disabled={!available.page}>
                {t('reactExport.scopePage')}
              </SegmentedItem>
              <SegmentedItem value="components" disabled={!available.components}>
                {t('reactExport.scopeComponents')}
              </SegmentedItem>
            </Segmented>
            {scope === 'components' ? (
              <div>
                <SelectionBar
                  className="pt-1"
                  count={picked.length}
                  total={components.length}
                  actions={
                    <>
                      <SelectionBarAction
                        disabled={running}
                        onClick={() => setChecked(new Set(components.map((component) => component.id)))}
                      >
                        {t('panels.exportSelectAll')}
                      </SelectionBarAction>
                      <SelectionBarAction disabled={running} onClick={() => setChecked(new Set())}>
                        {t('panels.exportClear')}
                      </SelectionBarAction>
                    </>
                  }
                />
                <div
                  role="group"
                  aria-label={t('reactExport.componentsAria')}
                  className="max-h-[min(220px,calc(100vh-520px))] overflow-y-auto rounded-panel bg-surface shadow-ring"
                >
                  {components.map((component) => (
                    <label
                      key={component.id}
                      className="relative flex min-h-11 cursor-pointer items-center gap-3 border-b border-line-soft px-4 py-2 transition-colors last:border-b-0 hover:bg-sub"
                    >
                      <Checkbox
                        checked={checked.has(component.id)}
                        disabled={running}
                        onChange={() => toggle(component.id)}
                      />
                      <span className="min-w-0 truncate text-copy font-medium text-ink">{component.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-copy text-ink-soft">
                {scope === 'frame'
                  ? firstFrame
                    ? t('reactExport.summaryFrame', {
                        count: frames.length,
                        name: firstFrame.name || t('reactExport.untitled'),
                      })
                    : t('reactExport.noFrameSelected')
                  : page && pageFrameCount > 0
                    ? t('reactExport.summaryPage', { count: pageFrameCount, name: page.name })
                    : t('reactExport.emptyPage')}
              </p>
            )}
          </div>

          <div className="mt-5 grid gap-2">
            <span id="react-export-styling" className="text-label font-medium text-ink-soft">
              {t('reactExport.stylingLabel')}
            </span>
            <Segmented
              value={settings.styling}
              onValueChange={(next) => setReactExportSettings({ styling: next as ReactStyling })}
              aria-labelledby="react-export-styling"
              disabled={running}
            >
              <SegmentedItem value="modules">{t('reactExport.stylingModules')}</SegmentedItem>
              <SegmentedItem value="tailwind">{t('reactExport.stylingTailwind')}</SegmentedItem>
            </Segmented>
            <p className="text-caption text-ink-faint">
              {t(settings.styling === 'modules' ? 'reactExport.stylingModulesHint' : 'reactExport.stylingTailwindHint')}
            </p>
          </div>

          <label className="mt-5 flex cursor-pointer items-center justify-between gap-4" htmlFor="react-export-tokens">
            <span className="min-w-0">
              <span className="block text-copy font-medium text-ink">{t('reactExport.tokensLabel')}</span>
              <span className="block text-caption text-ink-faint">{t('reactExport.tokensHint')}</span>
            </span>
            <Switch
              id="react-export-tokens"
              checked={settings.tokens}
              disabled={running}
              onCheckedChange={(tokens) => setReactExportSettings({ tokens })}
            />
          </label>
        </>
      )}

      <div role="status" aria-live="polite" className="empty:hidden">
        {running && (
          <div className="mt-5 grid gap-2">
            <Progress value={100} aria-label={t('reactExport.preparing')} className="motion-safe:animate-pulse" />
            <p className="text-caption text-ink-soft">{t('reactExport.preparing')}</p>
          </div>
        )}
      </div>
      {state.phase === 'failed' && (
        <Callout tone="error" role="alert" className="mt-5">
          {state.message}
        </Callout>
      )}

      <ModalActions>
        {state.phase === 'done' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setState({ phase: 'choose' })
                setDropped({ phase: 'closed' })
              }}
            >
              {t('reactExport.again')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t('reactExport.close')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!ready || running} onClick={() => void download()}>
              {!running && <ImportIcon size="button" />}
              {running ? t('reactExport.preparing') : t('reactExport.download')}
            </Button>
          </>
        )}
      </ModalActions>
    </Modal>
  )
}
