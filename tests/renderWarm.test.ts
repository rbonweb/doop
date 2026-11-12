import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The warm-up renders through an injected stub (no Chromium) into a render store backed by memory, and persistence is stubbed, so these tests only look at when a render happens and where it lands. */
const objects = new Map<string, Buffer>()
vi.mock('../server/storage.ts', () => ({
  getObject: async (key: string) => objects.get(key) ?? null,
  putObject: async (key: string, body: Buffer) => void objects.set(key, body),
  deleteObject: async (key: string) => void objects.delete(key),
  listObjects: async (prefix: string) =>
    [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1, modified: 0 })),
}))
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveCanvas: () => {},
  deleteFrame: () => {},
  deleteCanvas: () => {},
}))

const { store } = await import('../server/store.ts')
const { getRender } = await import('../server/previews.ts')
const { renderExt, renderParamsHash } = await import('../server/renderParams.ts')
const { getStoredRender } = await import('../server/renderStore.ts')
const { startRenderWarm, stopRenderWarm, warmParams, renderWarmStats } = await import('../server/renderWarm.ts')

const html = (n: number) => `<!doctype html><html><body><p>${n}</p></body></html>`
const png = Buffer.from('rendered-png')

const newFrame = (n = 0) => {
  const canvas = store.createCanvas('Warm', 'owner')
  const frame = store.createFrame(canvas.id, { name: 'Hero', width: 600, height: 400, html: html(n) }, 'tester')!
  return { canvas, frame }
}

const stored = (frameId: string, version: number) => {
  const params = warmParams({ width: 600, height: 400 })
  return getStoredRender(frameId, version, renderParamsHash(params), renderExt(params.format))
}

const DEBOUNCE = 20

let render: ReturnType<typeof vi.fn<(frame: { id: string }) => Promise<Buffer>>>

beforeEach(() => {
  objects.clear()
  render = vi.fn(async () => png)
  startRenderWarm({ debounceMs: DEBOUNCE, render })
})

afterEach(() => stopRenderWarm())

describe('render warm-up after a save', () => {
  it('stores the default render so the first /i/ request is a hit with no new render', async () => {
    const { frame } = newFrame()
    await vi.waitFor(async () => expect(await stored(frame.id, frame.updatedAt)).not.toBeNull())
    expect(render).toHaveBeenCalledTimes(1)

    const result = await getRender(frame, warmParams(frame), { ip: '203.0.113.7', isAuthenticated: async () => false })
    expect(result.status).toBe('ok')
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('renders a burst of edits once, at the last version', async () => {
    const { frame } = newFrame()
    const first = frame.updatedAt
    let last = frame
    for (let n = 1; n <= 5; n++) last = store.updateFrame(frame.id, { html: html(n) }, 'tester')!
    await vi.waitFor(async () => expect(await stored(frame.id, last.updatedAt)).not.toBeNull())
    expect(render).toHaveBeenCalledTimes(1)
    expect(await stored(frame.id, first)).toBeNull()
  })

  it('warms again after a resize but not after a move or a rename', async () => {
    const { frame } = newFrame()
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    store.updateFrame(frame.id, { x: 50, name: 'Renamed' }, 'tester')
    expect(renderWarmStats().armed).toBe(0)
    store.updateFrame(frame.id, { width: 700 }, 'tester')
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
  })

  it('skips a frame whose canvas was deleted', async () => {
    const gone = newFrame(1)
    store.deleteCanvas(gone.canvas.id)
    const kept = newFrame(2)
    await vi.waitFor(async () => expect(await stored(kept.frame.id, kept.frame.updatedAt)).not.toBeNull())
    expect(render).toHaveBeenCalledTimes(1)
    expect(await stored(gone.frame.id, gone.frame.updatedAt)).toBeNull()
  })

  it('does not store a render of a version that was superseded while it ran', async () => {
    let release: (buf: Buffer) => void = () => {}
    render.mockImplementationOnce(() => new Promise<Buffer>((resolve) => (release = resolve)))
    const { frame } = newFrame()
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    const first = frame.updatedAt
    const newer = store.updateFrame(frame.id, { html: html(9) }, 'tester')!
    release(png)
    await vi.waitFor(async () => expect(await stored(frame.id, newer.updatedAt)).not.toBeNull())
    expect(await stored(frame.id, first)).toBeNull()
  })

  it('waits while a stream still writes the frame', async () => {
    let busy = true
    stopRenderWarm()
    startRenderWarm({ debounceMs: DEBOUNCE, render, isBusy: () => busy })
    const { frame } = newFrame()
    await vi.waitFor(() => expect(renderWarmStats().armed).toBe(1))
    expect(render).not.toHaveBeenCalled()
    busy = false
    await vi.waitFor(async () => expect(await stored(frame.id, frame.updatedAt)).not.toBeNull())
  })

  it('never renders when it was not started', async () => {
    stopRenderWarm()
    const { frame } = newFrame()
    store.updateFrame(frame.id, { html: html(3) }, 'tester')
    expect(renderWarmStats().armed).toBe(0)
    expect(render).not.toHaveBeenCalled()
  })
})
