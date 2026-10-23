import type { Mark } from '../../shared/marks'
import { cn } from '@/lib/utils'

export const MARK_LABEL: Record<Mark, string> = { new: 'New changes', ask: 'Needs you' }

/** The review dot: blue for a frame that changed since you looked, orange for a thread waiting on you. */
export function MarkDot({ mark, className }: { mark: Mark | undefined; className?: string }) {
  if (!mark) return null
  return (
    <span
      role="img"
      aria-label={MARK_LABEL[mark]}
      title={MARK_LABEL[mark]}
      data-mark={mark}
      className={cn(
        'inline-block size-[7px] shrink-0 animate-[chip-in_0.25s_ease] rounded-full',
        mark === 'ask' ? 'bg-mark-ask' : 'bg-mark-new',
        className,
      )}
    />
  )
}
