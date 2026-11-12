import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
import { frameScreenshot } from '../server/frameShots.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/**
 * frameScreenshot: one capture of a target, a region, a format or an interactive state. The frame renders in real
 * Chromium, so the pixel checks below read the image the tool hands an agent.
 */

const fixture = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box }
  body { background: #ffffff }
  #hero { position: absolute; left: 40px; top: 60px; width: 320px; height: 200px; background: #e6194b }
  #tab { position: absolute; left: 0; top: 0; width: 120px; height: 40px }
  #panel { position: absolute; left: 0; top: 300px; width: 200px; height: 100px; background: #3cb44b; display: none }
  #panel.open { display: block }
</style></head><body>
  <div id="hero" data-doop-id="hero"></div>
  <button id="tab" onclick="document.getElementById('panel').classList.add('open')">tab</button>
  <div id="panel"></div>
</body></html>`

function useFrame(html: string): Frame {
  const frame: Frame = {
    id: 'shot-frame',
    canvasId: 'shot-canvas',
    name: 'Shots',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'test',
  }
  const canvas: Canvas = {
    id: 'shot-canvas',
    ownerId: 'test-owner',
    name: 'Shots',
    frames: [frame],
    createdAt: 0,
    updatedAt: 0,
  }
  store.init([canvas])
  return frame
}

/** The rgb of one pixel of a captured image. */
async function pixel(buf: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (Math.round(y) * info.width + Math.round(x)) * 3
  return Array.from(data.subarray(at, at + 3))
}

describe.skipIf(!findBrowserPath())('frameScreenshot', { timeout: 30_000 }, () => {
  beforeEach(() => {
    useFrame(fixture)
  })

  it('captures the element a target names, at its own size', async () => {
    const shot = await frameScreenshot(store.getFrame('shot-frame')!, { target: { element_id: 'hero' } })
    expect(shot.mime).toBe('image/png')
    expect(shot.clip).toEqual({ x: 40, y: 60, width: 320, height: 200 })
    expect([shot.width, shot.height]).toEqual([320, 200])
    expect(await pixel(shot.buf, 160, 100)).toEqual([230, 25, 75])
  })

  it('captures a region of the frame', async () => {
    const shot = await frameScreenshot(store.getFrame('shot-frame')!, { region: { x: 40, y: 60, w: 100, h: 50 } })
    expect(shot.clip).toEqual({ x: 40, y: 60, width: 100, height: 50 })
    expect([shot.width, shot.height]).toEqual([100, 50])
    expect(await pixel(shot.buf, 50, 25)).toEqual([230, 25, 75])
  })

  it('encodes webp', async () => {
    const shot = await frameScreenshot(store.getFrame('shot-frame')!, { format: 'webp' })
    expect(shot.mime).toBe('image/webp')
    expect(shot.buf.subarray(0, 4).toString()).toBe('RIFF')
    expect(shot.buf.subarray(8, 12).toString()).toBe('WEBP')
  })

  it('shows the state its actions reach', async () => {
    const shot = await frameScreenshot(store.getFrame('shot-frame')!, { actions: [{ click: '#tab' }] })
    expect(shot.actions).toEqual({ ok: true, done: 1 })
    expect(await pixel(shot.buf, 100, 350)).toEqual([60, 180, 75])
  })

  it('reports a failed action and still returns the capture', async () => {
    const shot = await frameScreenshot(store.getFrame('shot-frame')!, { actions: [{ click: '#missing' }] })
    expect(shot.actions?.ok).toBe(false)
    expect(shot.actions?.done).toBe(0)
    expect(shot.actions?.error).toContain('step 1')
    expect(shot.buf.length).toBeGreaterThan(0)
    expect([shot.width, shot.height]).toEqual([800, 600])
  })

  it('refuses a target and a region together', async () => {
    await expect(
      frameScreenshot(store.getFrame('shot-frame')!, {
        target: { element_id: 'hero' },
        region: { x: 0, y: 0, w: 10, h: 10 },
      }),
    ).rejects.toThrow(RangeError)
  })
})
