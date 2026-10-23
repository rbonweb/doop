// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { copyFrameImage } from '../src/lib/copyFrameImage'
import { useStore } from '../src/lib/store'

const frame = { id: 'f1', name: 'Landing', width: 1440, height: 900 } as Frame

const write = vi.fn((_items: unknown[]) => Promise.resolve())
const fetchMock = vi.fn((_url: string, _init?: unknown) =>
  Promise.resolve(new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 })),
)

class FakeClipboardItem {
  constructor(public items: Record<string, Promise<Blob>>) {}
}

beforeEach(() => {
  write.mockClear()
  fetchMock.mockClear()
  useStore.setState({ notice: null })
  vi.stubGlobal('ClipboardItem', FakeClipboardItem)
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyFrameImage', () => {
  it('hands the clipboard the pending render, from /i/<id>.png at the asked scale', async () => {
    await copyFrameImage(frame, 4)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/i/f1.png?scale=4')
    const item = write.mock.calls[0]?.[0][0] as FakeClipboardItem
    expect(Object.keys(item.items)).toEqual(['image/png'])
    await expect(item.items['image/png']).resolves.toBeInstanceOf(Blob)
    expect(useStore.getState().notice?.text).toBe('Copied Landing as a 5760×3600 PNG')
  })

  it('reports the scale the server clamped to', async () => {
    await copyFrameImage({ ...frame, width: 1280, height: 8192 } as Frame, 4)
    /* 16384 / 8192 leaves room for 2×, not 4× */
    expect(useStore.getState().notice?.text).toBe('Copied Landing as a 2560×16384 PNG')
  })

  it('explains when the browser cannot copy images, without rendering anything', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    await copyFrameImage(frame, 2)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useStore.getState().notice?.text).toMatch(/can’t copy images/)
  })

  it('says when the server could not render', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    write.mockImplementationOnce(async (items) => {
      await (items[0] as FakeClipboardItem).items['image/png']
    })
    await copyFrameImage(frame, 2)
    expect(useStore.getState().notice?.text).toBe('Couldn’t copy Landing. The server could not render it (500).')
  })

  it('refuses a response that is not an image, such as the app shell served for an unknown path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    write.mockImplementationOnce(async (items) => {
      await (items[0] as FakeClipboardItem).items['image/png']
    })
    await copyFrameImage(frame, 2)
    expect(useStore.getState().notice?.text).toBe('Couldn’t copy Landing. The server did not send an image.')
  })

  it('says when the clipboard refuses', async () => {
    write.mockRejectedValueOnce(new Error('NotAllowedError'))
    await copyFrameImage(frame, 2)
    expect(useStore.getState().notice?.text).toMatch(/clipboard refused/)
  })
})
