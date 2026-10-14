import { useEffect, type RefObject } from 'react'
import { create } from 'zustand'
import type { Frame } from '../../shared/types'
import { useStore } from './store'

/**
 * Which frames have their iframe mounted. Every frame iframe is a full document laid out, styled and painted on the app's own main thread (sandboxed srcdoc frames share its process), so mounting all of a 77-frame canvas at once froze the page for about 7 seconds. Frames are mounted one at a time instead, nearest the view first and only near the viewport, yielding to the browser between them so the canvas stays responsive while it fills in. A mounted frame stays mounted: unmounting would throw away its document and repeat the cost when the user pans back.
 */

/* how far past each viewport edge a frame still counts as near, as a share of the viewport */
const NEAR_MARGIN = 0.5
/* re-evaluate at most this often while the viewport moves */
const REFRESH_MS = 120

interface Viewport {
  x: number
  y: number
  zoom: number
}

interface Size {
  width: number
  height: number
}

type FrameBox = Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height'>

/** Frames near the viewport that are not mounted yet, nearest the centre of the view first. */
export function framesToMount(
  frames: FrameBox[],
  viewport: Viewport,
  size: Size,
  mounted: ReadonlySet<string>,
): string[] {
  const zoom = viewport.zoom || 1
  const marginX = (size.width * NEAR_MARGIN) / zoom
  const marginY = (size.height * NEAR_MARGIN) / zoom
  const left = -viewport.x / zoom
  const top = -viewport.y / zoom
  const right = left + size.width / zoom
  const bottom = top + size.height / zoom
  const centreX = (left + right) / 2
  const centreY = (top + bottom) / 2
  return frames
    .filter(
      (f) =>
        !mounted.has(f.id) &&
        f.x < right + marginX &&
        f.x + f.width > left - marginX &&
        f.y < bottom + marginY &&
        f.y + f.height > top - marginY,
    )
    .map((f) => ({ id: f.id, distance: Math.hypot(f.x + f.width / 2 - centreX, f.y + f.height / 2 - centreY) }))
    .sort((a, b) => a.distance - b.distance)
    .map((f) => f.id)
}

interface MountState {
  canvasId: string | null
  mounted: ReadonlySet<string>
}

const useMounts = create<MountState>(() => ({ canvasId: null, mounted: new Set<string>() }))

/** Whether this frame's iframe may be mounted. */
export function useFrameMounted(frameId: string): boolean {
  return useMounts((s) => s.mounted.has(frameId))
}

function mountFrame(canvasId: string, frameId: string) {
  useMounts.setState((s) => {
    if (s.canvasId !== canvasId) return { canvasId, mounted: new Set([frameId]) }
    if (s.mounted.has(frameId)) return s
    return { mounted: new Set(s.mounted).add(frameId) }
  })
}

/** Test seam: forget every mount. */
export function resetFrameMounts() {
  useMounts.setState({ canvasId: null, mounted: new Set<string>() })
}

/**
 * Drives mounting for the Stage: on every settled viewport or frame-list change it recomputes the frames near the view, then mounts them one per step, each step after the browser has painted the last. A long task in a frame's document delays the next animation frame, so the pace follows the main thread.
 */
export function useFrameMountScheduler(stageRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let queue: string[] = []
    let raf = 0
    let timer = 0
    let refreshTimer = 0
    let lastRefresh = 0

    function refresh() {
      refreshTimer = 0
      lastRefresh = Date.now()
      const { canvas, viewport } = useStore.getState()
      const stage = stageRef.current
      if (!canvas || !stage) return
      const { canvasId, mounted } = useMounts.getState()
      const already = canvasId === canvas.id ? mounted : new Set<string>()
      queue = framesToMount(canvas.frames, viewport, { width: stage.clientWidth, height: stage.clientHeight }, already)
      if (!raf && !timer) step()
    }

    function scheduleRefresh() {
      if (refreshTimer) return
      refreshTimer = window.setTimeout(refresh, Math.max(0, lastRefresh + REFRESH_MS - Date.now()))
    }

    function step() {
      raf = 0
      timer = 0
      const canvas = useStore.getState().canvas
      const next = queue.shift()
      if (!canvas || !next) return
      mountFrame(canvas.id, next)
      raf = requestAnimationFrame(() => {
        raf = 0
        timer = window.setTimeout(step, 0)
      })
    }

    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.canvas !== prev.canvas || s.viewport !== prev.viewport) scheduleRefresh()
    })
    refresh()
    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.clearTimeout(refreshTimer)
    }
  }, [stageRef])
}
