import { describe, expect, it } from 'vitest'
import {
  UNLOCK_TTL_MS,
  hashLinkPassword,
  hasUnlock,
  passwordProblem,
  readCookie,
  signUnlockToken,
  unlockCookieName,
  verifyLinkPassword,
  verifyUnlockToken,
} from '../server/linkAccess.ts'
import { createRateLimiter } from '../server/rateLimit.ts'

describe('link password hashing', () => {
  it('stores scrypt$N$salt$hash with a random 16-byte salt', async () => {
    const [a, b] = await Promise.all([hashLinkPassword('correct horse'), hashLinkPassword('correct horse')])
    const parts = a.split('$')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('scrypt')
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16_384)
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(16)
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b) // fresh salt each time
    expect(a).not.toContain('correct horse')
  })

  it('accepts the right password and refuses everything else', async () => {
    const stored = await hashLinkPassword('correct horse')
    expect(await verifyLinkPassword('correct horse', stored)).toBe(true)
    expect(await verifyLinkPassword('correct horse ', stored)).toBe(false)
    expect(await verifyLinkPassword('', stored)).toBe(false)
  })

  it('treats a malformed stored hash as a mismatch, never an error', async () => {
    for (const bad of ['', 'plain', 'scrypt$x$y$z', 'scrypt$16384$AAAA$AAAA', 'bcrypt$16384$AAAA$AAAA']) {
      expect(await verifyLinkPassword('anything', bad)).toBe(false)
    }
  })

  it('enforces the length rules the owner sees', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/)
    expect(passwordProblem('x'.repeat(201))).toMatch(/at most 200/)
    expect(passwordProblem(12345678)).toBeDefined()
    expect(passwordProblem('long enough')).toBeUndefined()
  })
})

describe('unlock cookie', () => {
  const hash = 'scrypt$16384$salt$hash'

  it('verifies for the canvas and password hash it was signed for', () => {
    const token = signUnlockToken('canvas1', hash)
    expect(verifyUnlockToken('canvas1', hash, token)).toBe(true)
  })

  it('is scoped to one canvas', () => {
    expect(verifyUnlockToken('canvas2', hash, signUnlockToken('canvas1', hash))).toBe(false)
  })

  it('stops working when the password changes or is removed', () => {
    const token = signUnlockToken('canvas1', hash)
    expect(verifyUnlockToken('canvas1', 'scrypt$16384$salt$other', token)).toBe(false)
    expect(hasUnlock('canvas1', undefined, `${unlockCookieName('canvas1')}=${token}`)).toBe(false)
  })

  it('expires after 30 days', () => {
    const now = 1_000_000
    const token = signUnlockToken('canvas1', hash, now)
    expect(verifyUnlockToken('canvas1', hash, token, now + UNLOCK_TTL_MS - 1)).toBe(true)
    expect(verifyUnlockToken('canvas1', hash, token, now + UNLOCK_TTL_MS + 1)).toBe(false)
  })

  it('rejects a tampered expiry or signature', () => {
    const now = Date.now()
    const [expires, sig] = signUnlockToken('canvas1', hash, now).split('.')
    expect(verifyUnlockToken('canvas1', hash, `${Number(expires) + 86_400_000}.${sig}`, now)).toBe(false)
    expect(verifyUnlockToken('canvas1', hash, `${expires}.${sig!.slice(0, -2)}xx`, now)).toBe(false)
    expect(verifyUnlockToken('canvas1', hash, 'garbage', now)).toBe(false)
    expect(verifyUnlockToken('canvas1', hash, `${now + 5}.`, now)).toBe(false)
  })

  it('reads the canvas cookie out of a Cookie header', () => {
    const token = signUnlockToken('canvas1', hash)
    const header = `a=1; ${unlockCookieName('canvas1')}=${encodeURIComponent(token)}; b=2`
    expect(readCookie(header, unlockCookieName('canvas1'))).toBe(token)
    expect(hasUnlock('canvas1', hash, header)).toBe(true)
    expect(hasUnlock('canvas2', hash, header)).toBe(false)
    expect(hasUnlock('canvas1', hash, undefined)).toBe(false)
  })

  it('names the cookie per canvas using only token characters', () => {
    expect(unlockCookieName('abc_DEF-123')).toBe('doop_lp_abc_DEF-123')
    expect(unlockCookieName('a b;c=d')).toBe('doop_lp_a_b_c_d')
  })
})

describe('rate limiter', () => {
  it('lets a key through up to its budget, then refuses until the window passes', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 })
    expect([1, 2, 3, 4].map(() => limiter.take('ip', 0))).toEqual([true, true, true, false])
    expect(limiter.retryAfter('ip', 400)).toBe(1)
    expect(limiter.take('ip', 999)).toBe(false)
    expect(limiter.take('ip', 1001)).toBe(true)
  })

  it('counts keys separately and can forget one', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 })
    expect(limiter.take('a', 0)).toBe(true)
    expect(limiter.take('b', 0)).toBe(true)
    expect(limiter.take('a', 1)).toBe(false)
    limiter.reset('a')
    expect(limiter.take('a', 2)).toBe(true)
  })
})
