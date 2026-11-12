import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* Mock only the leaves (Chromium, byte storage, the render store): previews.ts and thumbs.ts run for real. */
const mocks = vi.hoisted(() => ({
  captureFrame: vi.fn(),
  getStoredRender: vi.fn(),
  putStoredRender: vi.fn(),
  purgeFrameRenders: vi.fn(),
}))

vi.mock('../server/screenshot.ts', () => ({ renderFrame: vi.fn(), captureFrame: mocks.captureFrame }))
vi.mock('../server/storage.ts', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn().mockResolvedValue(null),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../server/renderStore.ts', () => ({
  getStoredRender: mocks.getStoredRender,
  putStoredRender: mocks.putStoredRender,
  purgeFrameRenders: mocks.purgeFrameRenders,
}))

import { getRender, invalidateFrameImages } from '../server/previews.ts'
import { normalizeRenderParams } from '../server/renderParams.ts'
import { store } from '../server/store.ts'

let seq = 0
const frame = (): Frame =>
  ({
    id: `render-f${seq++}`,
    canvasId: 'c',
    name: 'f',
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    html: '',
    updatedAt: 1,
    updatedBy: 't',
  }) as Frame

const req = { ip: 'render-ip', isAuthenticated: () => Promise.resolve(true) }

beforeEach(() => {
  vi.spyOn(store, 'renderSource').mockImplementation(async (f: Frame) => f)
  mocks.captureFrame.mockReset().mockResolvedValue({ buf: Buffer.from('png') })
  mocks.getStoredRender.mockReset().mockResolvedValue(null)
  mocks.putStoredRender.mockReset().mockResolvedValue(undefined)
  mocks.purgeFrameRenders.mockReset().mockResolvedValue(0)
})

describe('getRender persistence', () => {
  it('persists a render that nothing invalidated', async () => {
    const f = frame()
    const params = normalizeRenderParams(f, {})
    await getRender(f, params, req)
    expect(mocks.putStoredRender).toHaveBeenCalledTimes(1)
    expect(mocks.putStoredRender).toHaveBeenCalledWith(f.id, f.updatedAt, expect.any(String), 'png', expect.anything())
  })

  it('does not persist or reuse a render that was invalidated while it ran', async () => {
    const f = frame()
    const params = normalizeRenderParams(f, {})
    mocks.captureFrame.mockImplementationOnce(async () => {
      invalidateFrameImages(f.id)
      return { buf: Buffer.from('drawn with the old stylesheet') }
    })
    await getRender(f, params, req)
    expect(mocks.putStoredRender).not.toHaveBeenCalled()
    await getRender(f, params, req)
    expect(mocks.captureFrame).toHaveBeenCalledTimes(2)
  })
})

describe('invalidateFrameImages', () => {
  it('purges the persisted renders of the frame', () => {
    invalidateFrameImages('purged-frame')
    expect(mocks.purgeFrameRenders).toHaveBeenCalledWith('purged-frame')
  })
})
