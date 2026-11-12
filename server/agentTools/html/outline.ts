import type { Frame } from '../../../shared/types.ts'
import * as actions from '../../actions.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import { frameVersion } from '../../frameVersion.ts'
import { measureFrame } from '../../measure.ts'
import { frameOutline, type Outline, type OutlineSection } from '../../sectionEdits.ts'
import { resolveTarget } from '../../sectionTargets.ts'
import { store } from '../../store.ts'

interface OutlineOptions {
  /** add each section's rendered box and height: one render */
  measure?: boolean
  /** spends one unit of the caller's render budget; false when it is used up */
  mayRender?: () => boolean
  /** the caller may edit the frame: sections without a data-doop-id get one, in one annotation write, by this name */
  stamp?: { by: string }
}

type SectionRow = OutlineSection & {
  element_id: string | null
  /** the section as it is stored, when components make that differ from the `<doop-use>` form agents read */
  compactBytes?: number
  /** a positional CSS selector, for a section that has no id (a caller who may not edit) */
  selector?: string
}

type OutlineView = Omit<Outline, 'sections'> & { sections: SectionRow[]; storedBytes?: number }

/** The stored span of a component instance, found by the id its root wears (the `<doop-use>`'s own `id`). */
function instanceSpan(frame: Frame, useId: string): number | undefined {
  const found = resolveTarget(frame.html, { element_id: useId })
  return found.ok && found.matches.length === 1 ? found.matches[0]!.end - found.matches[0]!.start : undefined
}

/** Sections as agents read them (components as `<doop-use>`) lined up with the stored markup, since only the stored one holds the ids and the true sizes. */
function read(frame: Frame): { view: OutlineView; missing: string[] } {
  const compact = compactFrameHtml(frame)
  const seen = frameOutline(compact)
  const stored = compact === frame.html ? seen : frameOutline(frame.html)
  /* the stored outline may descend into an instance's root (a lone instance whose root wraps one chain), so a row lines up only where the stored element is the very root the `<doop-use>` stands for */
  const aligned =
    stored.sections.length === seen.sections.length &&
    seen.sections.every((s, i) => {
      const real = stored.sections[i]!
      return s.tag === 'doop-use' ? s.useId !== undefined && real.elementId === s.useId : real.tag === s.tag
    })
  const missing: string[] = []
  const sections = seen.sections.map((section, index): SectionRow => {
    const real = aligned ? stored.sections[index]! : undefined
    const { elementId: _own, useId, ...rest } = section
    const elementId = real?.elementId ?? section.elementId ?? useId
    if (real && !elementId) missing.push(real.path)
    const bytes = real ? real.bytes : useId ? instanceSpan(frame, useId) : undefined
    return {
      ...rest,
      ...(elementId ? { elementId } : {}),
      element_id: elementId ?? null,
      ...(bytes !== undefined ? { bytes, ...(bytes !== section.bytes ? { compactBytes: section.bytes } : {}) } : {}),
      ...(elementId ? {} : { selector: section.path }),
    }
  })
  const view: OutlineView = { ...seen, sections, ...(stored.bytes !== seen.bytes ? { storedBytes: stored.bytes } : {}) }
  return { view, missing }
}

/** The section outline of a frame, with the version a writer must send back, and with `measure` its rendered heights. */
export async function frameOutlineFor(frame: Frame, opts: OutlineOptions): Promise<unknown> {
  let current = frame
  let { view, missing } = read(current)
  if (missing.length && opts.stamp) {
    const stamped = await actions.ensureElementIds(current.id, missing, opts.stamp.by)
    if (stamped) {
      current = store.getFrame(current.id) ?? stamped.frame
      ;({ view, missing } = read(current))
    }
  }
  const outline = { ...view, version: frameVersion(current) }
  if (!opts.measure) return outline
  if (opts.mayRender && !opts.mayRender()) return { ...outline, measure: 'render rate limit — wait a minute' }
  const measured = await measureFrame(await store.renderSource(current))
  return {
    ...outline,
    measure: {
      width: measured.width,
      height: measured.height,
      sections: measured.sections.map((s) => ({ element_id: s.element_id, label: s.label, box: s.box })),
    },
  }
}
