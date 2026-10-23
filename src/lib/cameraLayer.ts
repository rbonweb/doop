/**
 * Compositor hint for the canvas world layer. While the camera moves the world is promoted (`will-change: transform`) so a pan or zoom is a pure GPU transform of a bitmap; once the camera rests the browser may re-rasterize it crisp at the final scale.
 *
 * Promoting and demoting a layer this size allocates and frees its tiles, and every demote re-rasterizes all frame iframes. A pan never changes the scale, so the bitmap it moves is already crisp: the layer is only demoted when the zoom drifted from the scale it was rasterized at. That halves the churn on a large canvas, and a plain pan stops allocating tiles at all after its first frame.
 */

/** zoom differences below this are the same raster scale */
const SAME_SCALE = 0.001

/** Whether a layer rasterized at `rasterZoom` is blurry (or oversized) when shown at `zoom`. */
export function needsReraster(rasterZoom: number, zoom: number): boolean {
  return Math.abs(zoom - rasterZoom) > SAME_SCALE
}

export interface WorldLayer {
  /** The camera moved to `zoom`: keep the layer promoted until it rests. */
  moved(zoom: number): void
  dispose(): void
}

export function createWorldLayer(world: { style: { willChange: string } }, idleMs: number): WorldLayer {
  /* the zoom the promoted layer was rasterized at; null while it is not promoted */
  let rasterZoom: number | null = null
  let latest = 1
  let timer = 0

  function settle() {
    timer = 0
    if (rasterZoom === null || !needsReraster(rasterZoom, latest)) return
    world.style.willChange = ''
    rasterZoom = null
  }

  return {
    moved(zoom) {
      latest = zoom
      if (rasterZoom === null) {
        world.style.willChange = 'transform'
        rasterZoom = zoom
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(settle, idleMs)
    },
    dispose() {
      window.clearTimeout(timer)
    },
  }
}
