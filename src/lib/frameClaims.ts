import type { FrameClaimView } from '../../shared/types'

/** The claims still running at `now`, keyed by frame id: an expired claim is dropped, whatever the server last said. */
export function liveClaims(claims: readonly FrameClaimView[], now: number): Record<string, FrameClaimView> {
  const live: Record<string, FrameClaimView> = {}
  for (const claim of claims) {
    if (Date.parse(claim.expiresAt) > now) live[claim.frameId] = claim
  }
  return live
}

/** The clock time a claim lapses at, in the viewer's locale and zone. */
export function claimUntilLabel(expiresAt: string): string {
  return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
