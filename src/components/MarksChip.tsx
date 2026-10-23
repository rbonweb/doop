import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { authClient } from '../lib/auth'
import { bindMarks, markAllSeen, reviewNext, useMarks } from '../lib/marks'
import { cn } from '@/lib/utils'
import { XIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'
import { MarkDot } from './MarkDot'

/** Keeps the review marks of the open canvas up to date. Renders nothing; a guest gets no marks. */
export function MarksController({ canvasId }: { canvasId: string }) {
  const user = authClient.useSession().data?.user
  const userId = user?.id
  const name = user?.name
  useEffect(() => (userId ? bindMarks(canvasId, { userId, name }) : undefined), [canvasId, userId, name])
  return null
}

/**
 * "3 need you · 5 new" in the top bar: what is waiting for you on this canvas. The label jumps to the next one (the U
 * key); the × beside it marks every new frame as seen, and is gone once only needs-you marks are left, since those clear
 * when you reply.
 */
export function MarksChip() {
  const [ask, fresh] = useMarks(
    useShallow((s) => {
      const marks = Object.values(s.marks)
      return [marks.filter((m) => m === 'ask').length, marks.filter((m) => m === 'new').length] as const
    }),
  )
  if (ask + fresh === 0) return null
  return (
    <div className="flex h-8 animate-[chip-in_0.25s_ease] items-center rounded-full border border-line bg-surface text-[12.5px] font-medium text-ink-soft transition-colors hover:border-ink-faint">
      <Tooltip label="Jump to the next one (U)" side="bottom">
        <button
          type="button"
          onClick={reviewNext}
          className={cn(
            'flex h-full items-center gap-2 rounded-full pl-3 transition-colors hover:bg-paper-deep hover:text-ink',
            fresh > 0 ? 'rounded-r-none pr-2' : 'pr-3',
          )}
        >
          {ask > 0 && (
            <span className="flex items-center gap-1.5">
              <MarkDot mark="ask" />
              {ask} {ask === 1 ? 'needs' : 'need'} you
            </span>
          )}
          {ask > 0 && fresh > 0 && (
            <span aria-hidden className="text-ink-faint">
              ·
            </span>
          )}
          {fresh > 0 && (
            <span className="flex items-center gap-1.5">
              <MarkDot mark="new" />
              {fresh} new
            </span>
          )}
        </button>
      </Tooltip>
      {fresh > 0 && (
        <Tooltip label="Mark all as seen" side="bottom">
          <button
            type="button"
            aria-label="Mark all as seen"
            onClick={() => markAllSeen()}
            className="grid h-full w-7 shrink-0 place-items-center rounded-r-full text-ink-faint transition-colors hover:bg-paper-deep hover:text-ink"
          >
            <XIcon className="size-3" strokeWidth={2.4} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
