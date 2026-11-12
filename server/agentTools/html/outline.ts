import type { Frame } from '../../../shared/types.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import { frameVersion } from '../../frameVersion.ts'
import { frameOutline } from '../../sectionEdits.ts'

/** The section outline of a frame, with the version a writer must send back. `measure` is a get_frame mode that waits on the measuring slice. */
export async function frameOutlineFor(frame: Frame, opts: { measure?: boolean }): Promise<unknown> {
  const outline = { ...frameOutline(compactFrameHtml(frame)), version: frameVersion(frame) }
  if (!opts.measure) return outline
  return { ...outline, measure: 'unavailable: measure_frame has not landed in this build yet' }
}
