import { describe, expect, it } from 'vitest'
import { shouldSleep, type SleepState } from '../src/lib/frameSleep'

const VIEW = { width: 1000, height: 800 }
const frame = { id: 'f', x: 100, y: 100, width: 400, height: 300 }

/* a resting, unattended frame on a camera that is not moving: awake because it is on screen */
const resting: SleepState = {
  viewport: { x: 0, y: 0, zoom: 1 },
  size: VIEW,
  selected: false,
  editing: false,
  working: false,
  hovered: false,
  cameraMoving: false,
  presenting: false,
  disabled: false,
}

const farAway = { ...frame, x: 9000, y: 9000 }

describe('shouldSleep', () => {
  it('keeps an on-screen frame awake while the camera is still', () => {
    expect(shouldSleep(frame, resting)).toBe(false)
  })

  it('sleeps an on-screen frame while the camera moves', () => {
    expect(shouldSleep(frame, { ...resting, cameraMoving: true })).toBe(true)
  })

  it('sleeps a frame beyond the near margin, and keeps one inside it awake', () => {
    expect(shouldSleep(farAway, resting)).toBe(true)
    /* 1300 is past the 1000px viewport but within half a viewport of it */
    expect(shouldSleep({ ...frame, x: 1300 }, resting)).toBe(false)
    expect(shouldSleep({ ...frame, x: 1600 }, resting)).toBe(true)
  })

  it('follows the viewport and its zoom', () => {
    expect(shouldSleep(farAway, { ...resting, viewport: { x: -8800, y: -8800, zoom: 1 } })).toBe(false)
    expect(shouldSleep(farAway, { ...resting, viewport: { x: 0, y: 0, zoom: 0.05 } })).toBe(false)
  })

  it.each([
    ['selected', { selected: true }],
    ['being edited', { editing: true }],
    ['worked on by an agent', { working: true }],
    ['hovered', { hovered: true }],
  ] as const)('stays awake when %s, even off screen or mid-pan', (_, held) => {
    expect(shouldSleep(frame, { ...resting, ...held, cameraMoving: true })).toBe(false)
    expect(shouldSleep(farAway, { ...resting, ...held })).toBe(false)
  })

  it('never sleeps in present mode', () => {
    expect(shouldSleep(farAway, { ...resting, presenting: true, cameraMoving: true })).toBe(false)
  })

  it('never sleeps with ?awake=1', () => {
    expect(shouldSleep(farAway, { ...resting, disabled: true, cameraMoving: true })).toBe(false)
  })

  it('does not call anything off screen before the stage is measured', () => {
    expect(shouldSleep(farAway, { ...resting, size: { width: 0, height: 0 } })).toBe(false)
  })
})
