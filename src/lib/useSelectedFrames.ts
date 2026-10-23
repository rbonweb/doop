import { useMemo } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from './store'

/** The selected frames, in selection order. */
export function useSelectedFrames(): Frame[] {
  const canvas = useStore((s) => s.canvas)
  const selectedIds = useStore((s) => s.selectedIds)
  return useMemo(
    () => selectedIds.flatMap((id) => canvas?.frames.find((f) => f.id === id) ?? []),
    [canvas, selectedIds],
  )
}
