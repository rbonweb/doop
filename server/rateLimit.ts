import type { Request } from 'express'

/**
 * A small in-memory sliding-window limiter, for the few public endpoints a
 * signed-out visitor can reach (guest comments, link-password attempts).
 * Counts are per process and reset on restart, which is fine for abuse
 * brakes: the point is to make a flood expensive, not to meter anyone.
 */
export interface RateLimiter {
  /** Records a hit for `key`; false means the key is over its budget. */
  take(key: string, now?: number): boolean
  /** Seconds until `key` has budget again (0 when it already does). */
  retryAfter(key: string, now?: number): number
  /** Forgets `key`, e.g. after a successful password attempt. */
  reset(key: string): void
}

export function createRateLimiter(options: { max: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>()
  let lastSweep = 0

  function live(key: string, now: number): number[] {
    const kept = (hits.get(key) ?? []).filter((at) => now - at < options.windowMs)
    if (kept.length) hits.set(key, kept)
    else hits.delete(key)
    return kept
  }

  /* drop idle keys now and then so a scan of many addresses cannot grow the map without bound */
  function sweep(now: number) {
    if (now - lastSweep < options.windowMs) return
    lastSweep = now
    for (const key of [...hits.keys()]) live(key, now)
  }

  return {
    take(key, now = Date.now()) {
      sweep(now)
      const kept = live(key, now)
      if (kept.length >= options.max) return false
      kept.push(now)
      hits.set(key, kept)
      return true
    },
    retryAfter(key, now = Date.now()) {
      const kept = live(key, now)
      if (kept.length < options.max) return 0
      return Math.max(1, Math.ceil(((kept[0] ?? now) + options.windowMs - now) / 1000))
    },
    reset(key) {
      hits.delete(key)
    },
  }
}

/** The caller's address for rate limiting. Behind a proxy `trust proxy` makes
 *  req.ip the client; the fallback keeps unit tests and odd sockets working. */
export function clientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown'
}
