/* The presenter window and the presentation share one BroadcastChannel per canvas. The presentation announces where the
   show is; the presenter window reads it, shows notes and the next slide, and may ask for a step. Both ends run
   `reducePresenterView`, so what a window shows is a function of the messages it has seen and nothing else. */

export const presenterChannelName = (canvasId: string) => `doop-present-${canvasId}`

export type PresenterCommand = 'next' | 'prev'

export type PresenterMessage =
  /** a presenter window that has just opened asking for the current state */
  | { type: 'hello' }
  /** the show is on this frame */
  | {
      type: 'state'
      frameId: string
      /** 1-based place in the walk order, and the length of it */
      index: number
      total: number
      /** the slide after this one, when there is one */
      nextId: string | null
      /** wall-clock ms the show began, so every window's timer agrees */
      startedAt: number
    }
  /** the presenter window asking the presentation to step */
  | { type: 'command'; command: PresenterCommand }
  /** the show is over */
  | { type: 'end' }

export interface PresenterView {
  live: boolean
  frameId: string | null
  index: number
  total: number
  nextId: string | null
  startedAt: number | null
}

export const idlePresenterView: PresenterView = {
  live: false,
  frameId: null,
  index: 0,
  total: 0,
  nextId: null,
  startedAt: null,
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** A message off the wire, or null when it is not one of ours (another tab, another version, junk). */
export function parsePresenterMessage(data: unknown): PresenterMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  switch (m.type) {
    case 'hello':
    case 'end':
      return { type: m.type }
    case 'command':
      return m.command === 'next' || m.command === 'prev' ? { type: 'command', command: m.command } : null
    case 'state':
      if (
        typeof m.frameId !== 'string' ||
        !m.frameId ||
        !isCount(m.index) ||
        !isCount(m.total) ||
        !(m.nextId === null || typeof m.nextId === 'string') ||
        typeof m.startedAt !== 'number' ||
        !Number.isFinite(m.startedAt)
      )
        return null
      return {
        type: 'state',
        frameId: m.frameId,
        index: m.index,
        total: m.total,
        nextId: m.nextId,
        startedAt: m.startedAt,
      }
    default:
      return null
  }
}

/** What a window shows after one more message. Only state and end change it; hello and command are for the other end. */
export function reducePresenterView(view: PresenterView, message: PresenterMessage): PresenterView {
  switch (message.type) {
    case 'state':
      return {
        live: true,
        frameId: message.frameId,
        index: message.index,
        total: message.total,
        nextId: message.nextId,
        startedAt: message.startedAt,
      }
    case 'end':
      return idlePresenterView
    default:
      return view
  }
}
