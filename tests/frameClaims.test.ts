import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types.ts'
import {
  MAX_CLAIM_MINUTES,
  claimFrames,
  claimOf,
  claimWarning,
  claimsOn,
  holderKey,
  onClaimsChange,
  releaseFrames,
  resetClaims,
} from '../server/frameClaims.ts'

const A = { name: 'A', kind: 'agent', color: '#000', userId: 'u1' } as Actor
const B = { name: 'B', kind: 'agent', color: '#111', userId: 'u2' } as Actor

const frame = (id: string, canvasId = 'c1') => ({ id, canvasId })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  resetClaims()
})

describe('frameClaims', () => {
  it('claims a frame and reads it back', () => {
    const result = claimFrames([frame('f1')], A, 10, 'building the hero')
    expect(result.claimed).toHaveLength(1)
    expect(result.heldByOthers).toEqual([])
    expect(claimOf('f1')).toMatchObject({
      frameId: 'f1',
      canvasId: 'c1',
      holder: 'A',
      holderKey: holderKey(A),
      note: 'building the hero',
    })
    expect(claimsOn('c1').map((claim) => claim.frameId)).toEqual(['f1'])
  })

  it('clamps the claim span to one minute at the bottom and an hour at the top', () => {
    claimFrames([frame('f1')], A, 0, 'short')
    const short = claimOf('f1')
    expect(short?.expiresAt).toBe((short?.claimedAt ?? 0) + 60_000)

    claimFrames([frame('f2')], A, 500, 'long')
    const long = claimOf('f2')
    expect(long?.expiresAt).toBe((long?.claimedAt ?? 0) + MAX_CLAIM_MINUTES * 60_000)
  })

  it('refuses a frame another holder has and leaves their claim in place', () => {
    claimFrames([frame('f1')], A, 5, 'mine')
    const result = claimFrames([frame('f1')], B, 5, 'theirs')
    expect(result.claimed).toEqual([])
    expect(result.heldByOthers).toHaveLength(1)
    expect(result.heldByOthers[0]?.holder).toBe('A')
    expect(claimOf('f1')?.holder).toBe('A')
  })

  it('renews the holder own claim with a new note and expiry', () => {
    claimFrames([frame('f1')], A, 5, 'first')
    vi.advanceTimersByTime(30_000)
    const result = claimFrames([frame('f1')], A, 10, 'second')
    expect(result.heldByOthers).toEqual([])
    const claim = claimOf('f1')
    expect(claim?.note).toBe('second')
    expect(claim?.expiresAt).toBe((claim?.claimedAt ?? 0) + 10 * 60_000)
  })

  it('releases only the caller own claims, and all of them when ids are undefined', () => {
    claimFrames([frame('f1'), frame('f2')], A, 10, 'a')
    claimFrames([frame('f3')], B, 10, 'b')

    expect(releaseFrames(['f1', 'f3'], A)).toEqual(['f1'])
    expect(claimOf('f3')?.holder).toBe('B')
    expect(releaseFrames(undefined, A)).toEqual(['f2'])
    expect(claimOf('f2')).toBeUndefined()
  })

  it('expires a claim through its timer and notifies listeners', () => {
    const seen: string[][] = []
    onClaimsChange((canvasId, claims) => {
      if (canvasId === 'c1') seen.push(claims.map((claim) => claim.frameId))
    })
    claimFrames([frame('f1')], A, 1, 'ticking')
    vi.advanceTimersByTime(60_000)
    expect(seen.at(-1)).toEqual([])
    expect(claimOf('f1')).toBeUndefined()
  })

  it('warns only about another holder claim', () => {
    expect(claimWarning(['f1'], A)).toBeUndefined()
    claimFrames([frame('f1')], A, 5, 'mid edit')
    expect(claimWarning(['f1'], A)).toBeUndefined()
    const warning = claimWarning(['f1'], B)
    expect(warning).toContain('A')
    expect(warning).toContain(new Date(Date.now() + 5 * 60_000).toISOString())
    expect(warning).toContain('mid edit')
    expect(warning).toContain('advisory')
  })

  it('notifies on claim, renew and release', () => {
    const calls: string[] = []
    onClaimsChange((canvasId, claims) => calls.push(`${canvasId}:${claims.length}`))
    claimFrames([frame('f1')], A, 5, 'one')
    claimFrames([frame('f1')], A, 5, 'two')
    releaseFrames(['f1'], A)
    expect(calls).toEqual(['c1:1', 'c1:1', 'c1:0'])
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const off = onClaimsChange(listener)
    claimFrames([frame('f1')], A, 5, 'one')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    releaseFrames(undefined, A)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps notifying other listeners when one throws', () => {
    const good = vi.fn()
    onClaimsChange(() => {
      throw new Error('boom')
    })
    onClaimsChange(good)
    expect(() => claimFrames([frame('f1')], A, 5, 'one')).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })
})
