import type { Frame } from '../../../shared/types.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import { frameVersion } from '../../frameVersion.ts'
import { measureFrame } from '../../measure.ts'
import { frameOutline } from '../../sectionEdits.ts'
import { store } from '../../store.ts'

interface OutlineOptions {
  /** add each section's rendered box and height: one render */
  measure?: boolean
  /** spends one unit of the caller's render budget; false when it is used up */
  mayRender?: () => boolean
}

/** The section outline of a frame, with the version a writer must send back, and with `measure` its rendered heights. */
export async function frameOutlineFor(frame: Frame, opts: OutlineOptions): Promise<unknown> {
  const outline = { ...frameOutline(compactFrameHtml(frame)), version: frameVersion(frame) }
  if (!opts.measure) return outline
  if (opts.mayRender && !opts.mayRender()) return { ...outline, measure: 'render rate limit — wait a minute' }
  const measured = await measureFrame(await store.renderSource(frame))
  return {
    ...outline,
    measure: {
      width: measured.width,
      height: measured.height,
      sections: measured.sections.map((s) => ({ element_id: s.element_id, label: s.label, box: s.box })),
    },
  }
}
