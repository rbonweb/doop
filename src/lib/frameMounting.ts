import { useEffect, type RefObject } from 'react'
import { create } from 'zustand'
import type { Frame } from '../../shared/types'
import { useStore } from './store'

/**
 * Which frames have their iframe mounted. Every frame iframe is a full document laid out, styled and painted on the app's own main thread (sandboxed srcdoc frames share its process), so mounting all of a 77-frame canvas at once froze the page for about 7 seconds. Frames are mounted one at a time instead, nearest the view first and only near the viewport, yielding to the browser between them so the canvas stays responsive while it fills in. A mounted frame stays mounted: unmounting would throw away its document and repeat the cost when the user pans back.
 */

/* how far past each viewport edge a frame still counts as near, as a share of the viewport */
const NEAR_MARGIN = 0.5
/* a changed frame list is re-evaluated at most this often */
const REFRESH_MS = 120
/* a moving viewport is not re-evaluated at all until it has been still this long: frames mounted mid-gesture start as blank documents that fill in later, which reads as flicker, so the whole set is settled once on idle instead */
const VIEWPORT_IDLE_MS = 150

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Size {
  width: number
  height: number
}

export type FrameBox = Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height'>

/** Whether a frame is on screen or within `NEAR_MARGIN` of it. */
export function isNearViewport(frame: FrameBox, viewport: Viewport, size: Size): boolean {
  const zoom = viewport.zoom || 1
  const marginX = (size.width * NEAR_MARGIN) / zoom
  const marginY = (size.height * NEAR_MARGIN) / zoom
  const left = -viewport.x / zoom
  const top = -viewport.y / zoom
  const right = left + size.width / zoom
  const bottom = top + size.height / zoom
  return (
    frame.x < right + marginX &&
    frame.x + frame.width > left - marginX &&
    frame.y < bottom + marginY &&
    frame.y + frame.height > top - marginY
  )
}

/** Frames near the viewport that are not mounted yet, nearest the centre of the view first. */
export function framesToMount(
  frames: FrameBox[],
  viewport: Viewport,
  size: Size,
  mounted: ReadonlySet<string>,
): string[] {
  const zoom = viewport.zoom || 1
  const centreX = (-viewport.x + size.width / 2) / zoom
  const centreY = (-viewport.y + size.height / 2) / zoom
  return frames
    .filter((f) => !mounted.has(f.id) && isNearViewport(f, viewport, size))
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
 * Drives mounting for the Stage: on every frame-list change, and once the viewport has stopped moving, it recomputes the frames near the view, then mounts them one per step, each step after the browser has painted the last. A long task in a frame's document delays the next animation frame, so the pace follows the main thread.
 */
export function useFrameMountScheduler(stageRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let queue: string[] = []
    let raf = 0
    let timer = 0
    let refreshTimer = 0
    let idleTimer = 0
    let lastRefresh = 0

    function refresh() {
      refreshTimer = 0
      window.clearTimeout(idleTimer)
      idleTimer = 0
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

    /* the camera moved: hold off until it stops, then evaluate once */
    function refreshWhenIdle() {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idleTimer = 0
        if (!refreshTimer) scheduleRefresh()
      }, VIEWPORT_IDLE_MS)
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
      if (s.canvas !== prev.canvas) scheduleRefresh()
      else if (s.viewport !== prev.viewport) refreshWhenIdle()
    })
    refresh()
    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.clearTimeout(refreshTimer)
      window.clearTimeout(idleTimer)
    }
  }, [stageRef])
}
