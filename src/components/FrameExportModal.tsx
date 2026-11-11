import { useEffect, useRef, useState } from 'react'
import { readingOrder } from '../../shared/frameOrder'
import { MAX_PDF_FRAMES } from '../../shared/pdfLimits'
import type { Frame } from '../../shared/types'
import {
  downloadElementExport,
  downloadFrameExport,
  downloadFramesPdf,
  exportFrames,
  type BatchFailure,
  type BatchProgress,
  type ElementTarget,
  type FrameExportFormat,
} from '../lib/frameExport'
import { setExportSettings, useExportSettings } from '../lib/exportSettings'
import { isDesktopShell } from '../lib/shell'
import { ExportOptions } from './ExportOptions'
import { FrameThumb } from './FramePreview'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { ImportIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'
import { useT } from '@/lib/i18n'

type BatchState =
  | { phase: 'choose' }
  | { phase: 'running'; progress: BatchProgress }
  | { phase: 'done'; saved: number; failures: BatchFailure[] }

/** Export a frame, a selection of frames, a page's frames or one element: the
 *  scale to render at, then the formats as a list.
 *
 *  - `frame` alone: that frame; a row downloads it and the canvas toast reports.
 *  - `groupFrames`: the selection the menu acts on. A row exports every one,
 *    one after another with progress here; the PDF binds all of it, a page per
 *    frame in reading order.
 *  - `pageFrames`: the frames of the current page as a checklist, `groupFrames`
 *    (the selection) pre-checked, or all of them when none is given. The top
 *    bar's Export and the frame title bar's Export open it this way.
 *  - `element`: one element of the frame instead of the whole of it, no PDF. */
export function FrameExportModal({
  frame,
  groupFrames = [frame],
  pageFrames,
  element,
  onClose,
}: {
  frame: Frame
  groupFrames?: Frame[]
  pageFrames?: Frame[]
  element?: ElementTarget
  onClose: () => void
}) {
  const t = useT()
  const settings = useExportSettings()
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set((groupFrames.length ? groupFrames : (pageFrames ?? [frame])).map((f) => f.id)),
  )
  const [state, setState] = useState<BatchState>({ phase: 'choose' })
  /* closing the dialog ends a batch after the image in flight */
  const stopped = useRef(false)
  useEffect(() => {
    stopped.current = false
    return () => {
      stopped.current = true
    }
  }, [])

  /* the checklist keeps the page's reading order (re-sorting only the checked
     rows could regroup them) */
  const listed = pageFrames ? readingOrder(pageFrames) : []
  const targets = pageFrames ? listed.filter((f) => checked.has(f.id)) : groupFrames
  const pdfFrames = pageFrames ? targets : readingOrder(targets)
  const [first] = targets
  const running = state.phase === 'running'
  const overPdfLimit = pdfFrames.length > MAX_PDF_FRAMES
  const many = !element && (pageFrames !== undefined || targets.length > 1)

  function toggle(frameId: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(frameId)) next.delete(frameId)
      else next.add(frameId)
      return next
    })
  }

  /* the row picked is remembered as the format, so the Inspector's Export
     starts from it too */
  function download(format: FrameExportFormat) {
    setExportSettings({ format })
    if (element) {
      void downloadElementExport(frame, element, format, settings.scale)
      onClose()
    } else if (targets.length === 1 && first) {
      void downloadFrameExport(first, format, settings.scale)
      onClose()
    } else {
      void startBatch(format)
    }
  }

  async function startBatch(format: FrameExportFormat) {
    const summary = await exportFrames(targets, format, {
      scale: settings.scale,
      shouldStop: () => stopped.current,
      onProgress: (progress) => {
        if (!stopped.current) setState({ phase: 'running', progress })
      },
    })
    if (!stopped.current) setState({ phase: 'done', saved: summary.saved, failures: summary.failures })
  }

  function downloadPdf() {
    if (overPdfLimit || !first) return
    void downloadFramesPdf(first.canvasId, pdfFrames)
    onClose()
  }

  const downloadMark = <ImportIcon size="rail" />
  const none = !element && targets.length === 0
  const disabled = running || none
  const title = element
    ? t('panels.frameExportTitle', { name: element.name })
    : targets.length === 1 && first
      ? t('panels.frameExportTitle', { name: first.name })
      : t('panels.frameExportBatchTitle', { count: targets.length })
  const lede = element
    ? t('panels.elementExportLede')
    : many
      ? t(isDesktopShell() ? 'panels.frameExportBatchLedeDesktop' : 'panels.frameExportBatchLede')
      : t('panels.frameExportLede')
  const pdfTitle =
    pdfFrames.length > 1 ? t('panels.frameExportPdfGroup', { count: pdfFrames.length }) : t('panels.exportDownloadPdf')
  const pdfHint = overPdfLimit
    ? `${t('panels.exportPdfMax', { count: MAX_PDF_FRAMES })} ${t('panels.exportUncheck', { count: pdfFrames.length - MAX_PDF_FRAMES })}`
    : pdfFrames.length > 1
      ? t('panels.frameExportPdfGroupHint')
      : t('panels.frameExportPdfHint')

  return (
    <Modal size={pageFrames ? 'lg' : 'sm'} onClose={onClose}>
      <ModalTitle className="break-words">{title}</ModalTitle>
      <ModalLede>{lede}</ModalLede>
      {pageFrames ? (
        <>
          <SelectionBar
            className="mt-5"
            count={targets.length}
            total={pageFrames.length}
            actions={
              <>
                <SelectionBarAction onClick={() => setChecked(new Set(pageFrames.map((f) => f.id)))}>
                  {t('panels.exportSelectAll')}
                </SelectionBarAction>
                <SelectionBarAction onClick={() => setChecked(new Set())}>{t('panels.exportClear')}</SelectionBarAction>
              </>
            }
          />
          <div
            className="max-h-[calc(100dvh-460px)] overflow-y-auto rounded-panel bg-surface shadow-ring sm:max-h-[min(280px,calc(100vh-460px))]"
            role="group"
            aria-label={t('panels.exportFramesAria')}
          >
            {listed.map((f) => (
              <label
                key={f.id}
                className="relative grid min-h-[60px] cursor-pointer grid-cols-[20px_64px_minmax(0,1fr)] items-center gap-3 border-b border-line-soft px-4 py-2.5 transition-colors last:border-b-0 hover:bg-sub"
              >
                <Checkbox checked={checked.has(f.id)} disabled={running} onChange={() => toggle(f.id)} />
                <FrameThumb frameId={f.id} />
                <span className="min-w-0">
                  <span className="block truncate text-copy font-medium text-ink">
                    {f.name || t('panels.exportUntitled')}
                  </span>
                  <span className="block font-mono text-caption text-ink-faint">
                    {Math.round(f.width)} × {Math.round(f.height)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </>
      ) : (
        many && (
          <ul className="mt-4 max-h-28 list-none overflow-y-auto rounded-control bg-sub px-3 py-2 text-copy text-ink-soft shadow-ring">
            {targets.map((f) => (
              <li key={f.id} className="truncate py-0.5">
                {f.name}
              </li>
            ))}
          </ul>
        )
      )}
      {state.phase !== 'done' && (
        <>
          <div className="mt-5">
            <ExportOptions value={settings} onChange={setExportSettings} withFormat={false} />
          </div>
          <ChoiceList className="mt-3">
            <ChoiceRow
              icon={<AppIcon brand="png" />}
              title={t('panels.frameExportPng')}
              description={t('panels.frameExportPngHint')}
              trailing={downloadMark}
              disabled={disabled}
              onClick={() => download('png')}
            />
            <ChoiceRow
              icon={<AppIcon brand="jpg" />}
              title={t('panels.frameExportJpg')}
              description={t('panels.frameExportJpgHint')}
              trailing={downloadMark}
              disabled={disabled}
              onClick={() => download('jpg')}
            />
            <ChoiceRow
              icon={<AppIcon brand="svg" />}
              title={t('panels.frameExportSvg')}
              description={t('panels.frameExportSvgHint')}
              trailing={downloadMark}
              disabled={disabled}
              onClick={() => download('svg')}
            />
            {!element && (
              <ChoiceRow
                icon={<AppIcon brand="pdf" />}
                title={pdfTitle}
                description={pdfHint}
                trailing={downloadMark}
                disabled={disabled || overPdfLimit}
                onClick={downloadPdf}
              />
            )}
          </ChoiceList>
        </>
      )}
      <div role="status" aria-live="polite" className="empty:hidden">
        {state.phase === 'running' && (
          <p className="mt-4 text-copy font-medium text-ink">
            {t('panels.frameExportBatchProgress', { index: state.progress.index, total: state.progress.total })}
            <span className="ml-1.5 font-normal text-ink-soft">{state.progress.frame.name}</span>
          </p>
        )}
        {state.phase === 'done' && <BatchResult total={targets.length} saved={state.saved} failures={state.failures} />}
      </div>
      <ModalActions>
        <Button variant={state.phase === 'done' ? 'primary' : 'ghost'} onClick={onClose}>
          {state.phase === 'done'
            ? t('panels.frameExportBatchDone')
            : running
              ? t('panels.frameExportBatchStop')
              : t('common.cancel')}
        </Button>
      </ModalActions>
    </Modal>
  )
}

function BatchResult({ total, saved, failures }: { total: number; saved: number; failures: BatchFailure[] }) {
  const t = useT()
  const failed = failures.length > 0
  return (
    <div className="mt-5">
      <p className={failed ? 'text-copy font-medium text-accent-ink' : 'text-copy font-medium text-success-ink'}>
        {failed
          ? t('panels.frameExportBatchSome', { saved, total, failed: failures.length })
          : t('panels.frameExportBatchAll', { count: total })}
      </p>
      {failed && (
        <ul className="mt-2 list-none space-y-1 text-body text-ink-soft">
          {failures.map(({ frame, error }) => (
            <li key={frame.id}>
              <b className="font-medium text-ink">{frame.name}</b> — {error}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
