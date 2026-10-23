import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { authClient } from '../lib/auth'
import { bindMarks, reviewNext, useMarks } from '../lib/marks'
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

/** "3 need you · 5 new" in the top bar: what is waiting for you on this canvas. Click it, or press U, to go to the next. */
export function MarksChip() {
  const [ask, fresh] = useMarks(
    useShallow((s) => {
      const marks = Object.values(s.marks)
      return [marks.filter((m) => m === 'ask').length, marks.filter((m) => m === 'new').length] as const
    }),
  )
  if (ask + fresh === 0) return null
  return (
    <Tooltip label="Jump to the next one (U)" side="bottom">
      <button
        type="button"
        onClick={reviewNext}
        className="flex h-8 animate-[chip-in_0.25s_ease] items-center gap-2 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-ink-faint hover:bg-paper-deep hover:text-ink"
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
  )
}
