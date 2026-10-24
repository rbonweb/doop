import { useEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import {
  downloadFrameExport,
  exportFrames,
  type BatchFailure,
  type BatchProgress,
  type FrameExportFormat,
} from '../lib/frameExport'
import { isDesktopShell } from '../lib/shell'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

/** Export dialog for one frame (renders and closes, the canvas toast reports) or several (downloads one after another, reporting here). */
export function FrameExportModal({ frames, onClose }: { frames: Frame[]; onClose: () => void }) {
  const [only] = frames
  if (frames.length === 1 && only) return <SingleExport frame={only} onClose={onClose} />
  return <BatchExport frames={frames} onClose={onClose} />
}

function SingleExport({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  function download(format: FrameExportFormat) {
    void downloadFrameExport(frame, format)
    onClose()
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">Export “{frame.name}”</ModalTitle>
      <ModalLede>Download this frame as a PNG or JPG image.</ModalLede>
      <div className="mt-5 grid gap-2">
        <Button variant="default" className="justify-start" onClick={() => download('png')}>
          Download PNG
        </Button>
        <Button variant="default" className="justify-start" onClick={() => download('jpg')}>
          Download JPG
        </Button>
      </div>
      <ModalActions>
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
      </ModalActions>
    </Modal>
  )
}

type BatchState =
  | { phase: 'choose' }
  | { phase: 'running'; progress: BatchProgress }
  | { phase: 'done'; saved: number; failures: BatchFailure[] }

function BatchExport({ frames, onClose }: { frames: Frame[]; onClose: () => void }) {
  const [state, setState] = useState<BatchState>({ phase: 'choose' })
  /* closing the dialog ends the run after the image in flight */
  const stopped = useRef(false)
  useEffect(() => {
    stopped.current = false
    return () => {
      stopped.current = true
    }
  }, [])

  async function start(format: FrameExportFormat) {
    const summary = await exportFrames(frames, format, {
      shouldStop: () => stopped.current,
      onProgress: (progress) => {
        if (!stopped.current) setState({ phase: 'running', progress })
      },
    })
    if (!stopped.current) setState({ phase: 'done', saved: summary.saved, failures: summary.failures })
  }

  const running = state.phase === 'running'
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>Export {frames.length} frames</ModalTitle>
      <ModalLede>
        {isDesktopShell()
          ? 'Download each frame as a PNG or JPG image, one after another. You’ll choose where each one is saved.'
          : 'Download each frame as a PNG or JPG image, one after another.'}
      </ModalLede>
      <ul className="mt-4 max-h-28 list-none overflow-y-auto rounded-control bg-sub px-3 py-2 text-copy text-ink-soft shadow-ring">
        {frames.map((f) => (
          <li key={f.id} className="truncate py-0.5">
            {f.name}
          </li>
        ))}
      </ul>
      {state.phase !== 'done' && (
        <div className="mt-5 grid gap-2">
          <Button variant="default" className="justify-start" disabled={running} onClick={() => void start('png')}>
            Download PNG
          </Button>
          <Button variant="default" className="justify-start" disabled={running} onClick={() => void start('jpg')}>
            Download JPG
          </Button>
        </div>
      )}
      <div role="status" aria-live="polite" className="empty:hidden">
        {state.phase === 'running' && (
          <p className="mt-4 text-copy font-medium text-ink">
            Exporting {state.progress.index} of {state.progress.total}…
            <span className="ml-1.5 font-normal text-ink-soft">{state.progress.frame.name}</span>
          </p>
        )}
        {state.phase === 'done' && <BatchResult total={frames.length} saved={state.saved} failures={state.failures} />}
      </div>
      <ModalActions>
        <Button variant={state.phase === 'done' ? 'primary' : 'default'} onClick={onClose}>
          {state.phase === 'done' ? 'Done' : running ? 'Stop' : 'Cancel'}
        </Button>
      </ModalActions>
    </Modal>
  )
}

function BatchResult({ total, saved, failures }: { total: number; saved: number; failures: BatchFailure[] }) {
  const failed = failures.length > 0
  return (
    <div className="mt-5">
      <p className={failed ? 'text-copy font-medium text-accent-ink' : 'text-copy font-medium text-success-ink'}>
        {failed ? `${saved} of ${total} exported — ${failures.length} failed` : `All ${total} frames exported`}
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
