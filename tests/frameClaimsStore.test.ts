import { beforeEach, expect, it } from 'vitest'
import type { FrameClaimView } from '../shared/types.ts'
import { claimUntilLabel, liveClaims } from '../src/lib/frameClaims'
import { useStore } from '../src/lib/store'

const claim = (frameId: string, expiresAt: string): FrameClaimView => ({
  frameId,
  holder: 'Ada',
  note: '',
  expiresAt,
})

beforeEach(() => {
  useStore.getState().setClaims([])
})

it('liveClaims drops an expired claim and keeps a live one', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  const result = liveClaims([claim('expired', '2026-01-01T12:00:00Z'), claim('live', '2026-01-01T12:10:00Z')], now)
  expect(Object.keys(result)).toEqual(['live'])
  expect(result.expired).toBeUndefined()
  expect(result.live?.frameId).toBe('live')
})

it('liveClaims of an empty list is {}', () => {
  expect(liveClaims([], Date.now())).toEqual({})
})

it('setClaims keeps only live claims', () => {
  useStore
    .getState()
    .setClaims([
      claim('live', new Date(Date.now() + 600000).toISOString()),
      claim('expired', new Date(Date.now() - 1000).toISOString()),
    ])
  expect(Object.keys(useStore.getState().claims)).toEqual(['live'])
  useStore.getState().setClaims([])
  expect(useStore.getState().claims).toEqual({})
})

it('setClaims replaces rather than merges', () => {
  useStore.getState().setClaims([claim('a', new Date(Date.now() + 600000).toISOString())])
  useStore.getState().setClaims([claim('b', new Date(Date.now() + 600000).toISOString())])
  expect(Object.keys(useStore.getState().claims)).toEqual(['b'])
})

it('claimUntilLabel returns a non-empty string for an ISO date', () => {
  const label = claimUntilLabel('2026-01-01T14:05:00Z')
  expect(typeof label).toBe('string')
  expect(label.length).toBeGreaterThan(0)
})
