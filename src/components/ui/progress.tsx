import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils'

/** A meter with a value a screen reader can read — the free-task allowance
 *  was a bare div whose only signal was its inline width. */
function Progress({
  className,
  value = 0,
  max = 100,
  indeterminate = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  /** work of unknown length: a short bar that pulses instead of a fill that reads 0% */
  indeterminate?: boolean
}) {
  const pct = max ? Math.max(0, Math.min(100, ((value ?? 0) / max) * 100)) : 0
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={indeterminate ? null : value}
      max={max}
      className={cn('h-[5px] w-full flex-none overflow-hidden rounded-full bg-paper-deep', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full rounded-full bg-brand transition-[width] duration-300',
          indeterminate && 'animate-[skeleton-pulse_1.4s_ease-in-out_infinite]',
        )}
        style={{ width: `${indeterminate ? 40 : pct}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
