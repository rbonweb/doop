import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { create } from 'zustand'
import { isNearViewport, type FrameBox, type Size, type Viewport } from './frameMounting'
import { useStore } from './store'

/**
 * Frames at rest. A mounted frame keeps its document alive, and every CSS animation, Web Animation and playing video in it keeps the main thread busy even when nobody can see it. A sleeping frame has all of those paused (the runtime half is `doop:sleep` in lib/frameRuntime.ts) and wakes the moment it matters again.
 */

/* on-screen frames wake this long after the camera stops, so a flick of the wheel does not make every animation stutter back to life between ticks */
const WAKE_MS = 300

export interface SleepState {
  viewport: Viewport
  size: Size
  selected: boolean
  /** someone is editing the frame: the local text edit, or a peer on it */
  editing: boolean
  /** an agent is designing the frame, or working a comment pinned on it */
  working: boolean
  /** the pointer is over the frame */
  hovered: boolean
  cameraMoving: boolean
  presenting: boolean
  /** `?awake=1`: sleeping is off, for comparison and debugging */
  disabled: boolean
}

/** Whether a frame's animations should be paused right now. */
export function shouldSleep(frame: FrameBox, state: SleepState): boolean {
  if (state.disabled || state.presenting) return false
  if (state.selected || state.editing || state.working || state.hovered) return false
  /* the stage has not been measured yet, so nothing can be called off screen */
  if (state.size.width === 0 || state.size.height === 0) return false
  return state.cameraMoving || !isNearViewport(frame, state.viewport, state.size)
}

/** `?awake=1` in the URL turns sleeping off. */
export function sleepDisabled(): boolean {
  return new URLSearchParams(location.search).get('awake') === '1'
}

interface CameraActivity {
  /** the camera moved within the last `WAKE_MS` */
  moving: boolean
  /** the Stage's size in screen px, which the viewport is measured against */
  size: Size
}

const useCameraActivity = create<CameraActivity>(() => ({ moving: false, size: { width: 0, height: 0 } }))

let wakeTimer = 0

/** The Stage calls this on every camera move; frames sleep at once and wake `WAKE_MS` after the last one. */
export function noteCameraMove() {
  window.clearTimeout(wakeTimer)
  wakeTimer = window.setTimeout(() => useCameraActivity.setState({ moving: false }), WAKE_MS)
  if (!useCameraActivity.getState().moving) useCameraActivity.setState({ moving: true })
}

export function setStageSize(width: number, height: number) {
  const { size } = useCameraActivity.getState()
  if (size.width !== width || size.height !== height) useCameraActivity.setState({ size: { width, height } })
}

/** Test seam: forget the camera. */
export function resetCameraActivity() {
  window.clearTimeout(wakeTimer)
  useCameraActivity.setState({ moving: false, size: { width: 0, height: 0 } })
}

interface SleepInputs {
  frame: FrameBox
  /** the frame's document answered, so it can take messages */
  ready: boolean
  editing: boolean
  working: boolean
}

/**
 * Keeps one frame's iframe asleep or awake. It listens to the stores directly and posts `doop:sleep` only when the answer changes, so a camera tick never renders React and never sends a message. Returns the handler for the pointer entering or leaving the frame.
 */
export function useFrameSleep(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  { frame, ready, editing, working }: SleepInputs,
): (hovered: boolean) => void {
  const { id, x, y, width, height } = frame
  const hovered = useRef(false)
  /* what the document was last told; a freshly loaded document is awake */
  const asleep = useRef(false)
  const evaluate = useRef<() => void>(() => {})

  useEffect(() => {
    if (!ready) return
    const box = { id, x, y, width, height }
    const disabled = sleepDisabled()
    evaluate.current = () => {
      const s = useStore.getState()
      const camera = useCameraActivity.getState()
      const next = shouldSleep(box, {
        viewport: s.viewport,
        size: camera.size,
        selected: s.selectedIds.includes(id),
        editing,
        working: working || !!s.streams[id],
        hovered: hovered.current,
        cameraMoving: camera.moving,
        presenting: s.presenting,
        disabled,
      })
      if (next === asleep.current) return
      asleep.current = next
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:sleep', on: next }, '*')
    }
    evaluate.current()
    /* the viewport is left out on purpose: every camera move also raises the camera flag, which is what re-evaluates */
    const unsubscribeStore = useStore.subscribe((s, prev) => {
      if (s.selectedIds !== prev.selectedIds || s.streams !== prev.streams || s.presenting !== prev.presenting) {
        evaluate.current()
      }
    })
    const unsubscribeCamera = useCameraActivity.subscribe(() => evaluate.current())
    return () => {
      unsubscribeStore()
      unsubscribeCamera()
      evaluate.current = () => {}
    }
  }, [iframeRef, ready, id, x, y, width, height, editing, working])

  return useCallback((next: boolean) => {
    hovered.current = next
    evaluate.current()
  }, [])
}
