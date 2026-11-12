import type { Actor, Frame } from '../shared/types.ts'

/** Longest a single advisory claim may last. */
export const MAX_CLAIM_MINUTES = 60

/** Longest claim note kept; the note is echoed verbatim into other agents' tool results. */
export const MAX_CLAIM_NOTE = 200

export interface FrameClaim {
  frameId: string
  canvasId: string
  holder: string
  holderKey: string
  note: string
  claimedAt: number
  expiresAt: number
}

type ClaimsListener = (canvasId: string, claims: FrameClaim[]) => void

const claims = new Map<string, FrameClaim>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<ClaimsListener>()

export function holderKey(actor: Actor): string {
  return `${actor.kind}:${actor.userId ?? ''}:${actor.name}`
}

function clearTimer(frameId: string): void {
  const timer = timers.get(frameId)
  if (timer) clearTimeout(timer)
  timers.delete(frameId)
}

function dropClaim(claim: FrameClaim): void {
  clearTimer(claim.frameId)
  if (claims.get(claim.frameId) === claim) claims.delete(claim.frameId)
}

function isExpired(claim: FrameClaim, now: number): boolean {
  return claim.expiresAt <= now
}

/** Current claims on a canvas, dropping expired ones quietly so notification can use it without recursing. */
function liveClaims(canvasId: string, now: number): FrameClaim[] {
  const live: FrameClaim[] = []
  for (const claim of [...claims.values()]) {
    if (claim.canvasId !== canvasId) continue
    if (isExpired(claim, now)) {
      dropClaim(claim)
      continue
    }
    live.push(claim)
  }
  live.sort((a, b) => a.claimedAt - b.claimedAt || a.frameId.localeCompare(b.frameId))
  return live
}

function notify(canvasId: string): void {
  const current = liveClaims(canvasId, Date.now())
  for (const listener of [...listeners]) {
    try {
      listener(canvasId, current)
    } catch {
      // one broken listener must not starve the others
    }
  }
}

function schedule(claim: FrameClaim): void {
  clearTimer(claim.frameId)
  const delay = Math.max(0, claim.expiresAt - Date.now())
  const timer = setTimeout(() => {
    const current = claims.get(claim.frameId)
    if (current !== claim) return
    if (!isExpired(current, Date.now())) return
    dropClaim(current)
    notify(current.canvasId)
  }, delay)
  timer.unref()
  timers.set(claim.frameId, timer)
}

export function claimFrames(
  frames: Pick<Frame, 'id' | 'canvasId'>[],
  actor: Actor,
  minutes: number,
  note: string,
  now = Date.now(),
): { claimed: FrameClaim[]; heldByOthers: FrameClaim[] } {
  const span = Number.isFinite(minutes) ? Math.min(MAX_CLAIM_MINUTES, Math.max(1, Math.round(minutes))) : 1
  const key = holderKey(actor)
  const expiresAt = now + span * 60_000
  const claimed: FrameClaim[] = []
  const heldByOthers: FrameClaim[] = []
  const touched = new Set<string>()

  for (const frame of frames) {
    let stored = claims.get(frame.id)
    if (stored && isExpired(stored, now)) {
      dropClaim(stored)
      touched.add(stored.canvasId)
      stored = undefined
    }
    if (stored && stored.holderKey !== key) {
      heldByOthers.push(stored)
      continue
    }
    const claim: FrameClaim = {
      frameId: frame.id,
      canvasId: frame.canvasId,
      holder: actor.name,
      holderKey: key,
      note: note.slice(0, MAX_CLAIM_NOTE),
      claimedAt: now,
      expiresAt,
    }
    claims.set(frame.id, claim)
    schedule(claim)
    claimed.push(claim)
    touched.add(frame.canvasId)
  }

  for (const canvasId of touched) notify(canvasId)
  return { claimed, heldByOthers }
}

export function releaseFrames(frameIds: string[] | undefined, actor: Actor): string[] {
  const key = holderKey(actor)
  const released: string[] = []
  const touched = new Set<string>()

  if (frameIds === undefined) {
    for (const claim of [...claims.values()]) {
      if (claim.holderKey !== key) continue
      dropClaim(claim)
      released.push(claim.frameId)
      touched.add(claim.canvasId)
    }
  } else {
    for (const frameId of frameIds) {
      const claim = claims.get(frameId)
      if (!claim || claim.holderKey !== key) continue
      dropClaim(claim)
      released.push(frameId)
      touched.add(claim.canvasId)
    }
  }

  for (const canvasId of touched) notify(canvasId)
  return released
}

/** Forgets every claim on these frames whoever holds it (the frames are gone), notifying each canvas once. */
export function dropClaims(frameIds: string[]): void {
  const touched = new Set<string>()
  for (const frameId of frameIds) {
    const claim = claims.get(frameId)
    if (!claim) continue
    dropClaim(claim)
    touched.add(claim.canvasId)
  }
  for (const canvasId of touched) notify(canvasId)
}

export function claimOf(frameId: string, now = Date.now()): FrameClaim | undefined {
  const claim = claims.get(frameId)
  if (!claim) return undefined
  if (isExpired(claim, now)) {
    dropClaim(claim)
    notify(claim.canvasId)
    return undefined
  }
  return claim
}

export function claimsOn(canvasId: string, now = Date.now()): FrameClaim[] {
  return liveClaims(canvasId, now)
}

export function claimWarning(frameIds: string[], actor: Actor, now = Date.now()): string | undefined {
  const key = holderKey(actor)
  const lines: string[] = []
  for (const frameId of frameIds) {
    const claim = claims.get(frameId)
    if (!claim || claim.holderKey === key || isExpired(claim, now)) continue
    lines.push(
      `Frame ${claim.frameId} is claimed by ${claim.holder} until ${new Date(claim.expiresAt).toISOString()}: "${claim.note}". Your write went through (claims are advisory); coordinate with them before changing it again.`,
    )
  }
  return lines.length ? lines.join('\n') : undefined
}

export function onClaimsChange(listener: (canvasId: string, claims: FrameClaim[]) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetClaims(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  claims.clear()
  listeners.clear()
}
