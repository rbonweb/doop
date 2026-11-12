import { claimUntilLabel } from '../lib/frameClaims'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { LockIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'

/** Who is working on a frame, drawn beside its name for everyone in the room. Advisory: it blocks nothing. */
export function FrameClaimBadge({ frameId }: { frameId: string }) {
  const t = useT()
  const claim = useStore((s) => s.claims[frameId])
  if (!claim) return null
  const until = claimUntilLabel(claim.expiresAt)
  const label = claim.note
    ? t('stage.claimTip', { name: claim.holder, time: until, note: claim.note })
    : t('stage.claimTipNoNote', { name: claim.holder, time: until })
  return (
    <Tooltip label={label} side="top" align="start">
      <span
        data-frame-claim=""
        className="flex min-w-0 max-w-[140px] shrink items-center gap-1 rounded-pill bg-surface px-1.5 py-px text-micro font-medium text-ink-soft shadow-ring"
      >
        <LockIcon width={10} height={10} aria-hidden className="shrink-0" />
        <span className="min-w-0 overflow-hidden text-ellipsis">{claim.holder}</span>
      </span>
    </Tooltip>
  )
}
