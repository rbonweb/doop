import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { SyncIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'

/** A frame a change to a component's main has not reached yet: drawn beside its name until the
 *  server has visited it (server/propagation.ts), for everyone in the room. It goes by itself. */
export function FrameCatchingUpBadge({ frameId }: { frameId: string }) {
  const t = useT()
  const waiting = useStore((s) => s.catchingUp[frameId] === true)
  if (!waiting) return null
  return (
    <Tooltip label={t('stage.catchingUpTip')} side="top" align="start">
      <span
        data-frame-catching-up=""
        className="flex shrink-0 items-center gap-1 rounded-pill bg-surface px-1.5 py-px text-micro font-medium text-ink-soft shadow-ring"
      >
        <SyncIcon width={10} height={10} aria-hidden className="shrink-0 animate-spin [animation-duration:2.4s]" />
        {t('stage.catchingUp')}
      </span>
    </Tooltip>
  )
}
