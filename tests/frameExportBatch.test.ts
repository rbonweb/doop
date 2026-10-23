import { expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import {
  exportFrames,
  type BatchProgress,
  type FrameExportFormat,
  type FrameExportResult,
} from '../src/lib/frameExport'

function frameNamed(name: string): Frame {
  return {
    id: name.toLowerCase(),
    canvasId: 'canvas',
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '',
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
  }
}

const frames = ['One', 'Two', 'Three'].map(frameNamed)
const saved = (frame: Frame): FrameExportResult => ({ ok: true, fileName: `${frame.name}.png` })

it('exports frames strictly one after another, pausing between downloads and reporting 1-based progress', async () => {
  const events: string[] = []
  const progress: BatchProgress[] = []
  const summary = await exportFrames(frames, 'png', {
    onProgress: (p) => progress.push(p),
    exportOne: async (frame) => {
      events.push(`start ${frame.name}`)
      await Promise.resolve()
      events.push(`end ${frame.name}`)
      return saved(frame)
    },
    wait: async (ms) => {
      events.push(`wait ${ms}`)
    },
    pauseMs: 250,
  })

  expect(events).toEqual([
    'start One',
    'end One',
    'wait 250',
    'start Two',
    'end Two',
    'wait 250',
    'start Three',
    'end Three',
  ])
  expect(progress.map((p) => [p.index, p.total, p.frame.name])).toEqual([
    [1, 3, 'One'],
    [2, 3, 'Two'],
    [3, 3, 'Three'],
  ])
  expect(summary).toEqual({ saved: 3, failures: [], stopped: false })
})

it('passes the chosen format through to every frame', async () => {
  const exportOne = vi.fn(async (frame: Frame, _format: FrameExportFormat) => saved(frame))
  await exportFrames(frames, 'jpg', { exportOne, wait: async () => {} })
  expect(exportOne.mock.calls.map(([frame, format]) => [frame.name, format])).toEqual([
    ['One', 'jpg'],
    ['Two', 'jpg'],
    ['Three', 'jpg'],
  ])
})

it('records a failed frame with its error and carries on with the rest', async () => {
  const summary = await exportFrames(frames, 'png', {
    wait: async () => {},
    exportOne: async (frame) => (frame.name === 'Two' ? { ok: false, error: 'Renderer is busy' } : saved(frame)),
  })

  expect(summary.saved).toBe(2)
  expect(summary.stopped).toBe(false)
  expect(summary.failures).toEqual([{ frame: frames[1], error: 'Renderer is busy' }])
})

it('stops before the next frame once asked to, and does not pause or render after that', async () => {
  let stop = false
  const exportOne = vi.fn(async (frame: Frame) => {
    stop = true
    return saved(frame)
  })
  const summary = await exportFrames(frames, 'png', { exportOne, shouldStop: () => stop, wait: async () => {} })

  expect(exportOne).toHaveBeenCalledTimes(1)
  expect(summary).toEqual({ saved: 1, failures: [], stopped: true })
})

it('does nothing for an empty selection', async () => {
  const exportOne = vi.fn()
  expect(await exportFrames([], 'png', { exportOne })).toEqual({ saved: 0, failures: [], stopped: false })
  expect(exportOne).not.toHaveBeenCalled()
})
