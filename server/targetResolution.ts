import type { Frame } from '../shared/types.ts'
import { ensureElementId } from './actions.ts'
import { compactFrameHtml } from './componentActions.ts'
import { TargetError } from './renderTargets.ts'
import type { FrameTarget } from './renderTypes.ts'
import { frameOutline, type Outline } from './sectionEdits.ts'
import { parseFrameDocument, resolveTarget } from './sectionTargets.ts'

/**
 * The one rule that turns a `{ label }` target into an element, shared by `measure_frame`, `lint_frame`,
 * `snapshot_frame`, `get_frame_screenshot` and `compare_frames`. A label is what `get_frame` mode "outline" prints
 * for a section (`data-doop-label`, else the first heading, else `aria-label`, else a component's name), so it is
 * looked up in the saved HTML through that same outline first; a label the outline does not list (a nested block,
 * a heading further down) goes through `server/sectionTargets.ts`, the rule `get_section` and `patch_frame` use.
 * The page is then handed a `[data-doop-id]` target (stamped as an annotation when the caller may edit) or, for a
 * read-only caller, a positional selector, never a label it would have to guess at.
 */

export interface ResolvedRenderTargets {
  /** the frame the page must render: the input, or its copy carrying the stamped element ids */
  frame: Frame
  /** the same targets in the same order, each label the saved HTML names rewritten to an element id or a selector */
  targets: FrameTarget[]
}

export interface ResolveTargetOptions {
  /** the name an element id is stamped under; absent for a caller without the edit role, which gets a selector instead */
  stampAs?: string
}

interface Located {
  path: string
  elementId?: string
}

/** The saved HTML, parsed once per call however many labels it names. */
class FrameSource {
  readonly #frame: Frame
  #document: ReturnType<typeof parseFrameDocument> | undefined
  #sections: { labels: Outline['sections']; paths: Outline['sections'] } | undefined

  constructor(frame: Frame) {
    this.#frame = frame
  }

  document() {
    this.#document ??= parseFrameDocument(this.#frame.html)
    return this.#document
  }

  /** The outline's sections: labelled as the agent saw them (short form), addressed in the stored HTML. */
  sections() {
    if (this.#sections) return this.#sections
    const full = frameOutline(this.#frame.html)
    let labels = full.sections
    try {
      const compact = frameOutline(compactFrameHtml(this.#frame))
      if (compact.container === full.container && compact.sections.length === full.sections.length) {
        labels = compact.sections
      }
    } catch {
      /* a frame whose components cannot be compacted is labelled from its stored HTML */
    }
    this.#sections = { labels, paths: full.sections }
    return this.#sections
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function outlineMatches(source: FrameSource, wanted: string): Located[] {
  const { labels, paths } = source.sections()
  const found: Located[] = []
  for (const [index, section] of labels.entries()) {
    const addressed = paths[index]
    if (!addressed || section.label === undefined || normalize(section.label) !== wanted) continue
    found.push({ path: uniquePath(addressed.path), ...(addressed.elementId ? { elementId: addressed.elementId } : {}) })
  }
  return found
}

/** A path as a CSS selector that names exactly one element: the outline leaves `:nth-of-type` off a first child, which as CSS would match every sibling of its type. */
function uniquePath(path: string): string {
  return path
    .split(' > ')
    .map((step) => (step.includes(':nth-of-type(') ? step : `${step}:nth-of-type(1)`))
    .join(' > ')
}

function candidates(found: Located[]): string {
  return found
    .slice(0, 5)
    .map((item) => (item.elementId ? `element_id "${item.elementId}"` : `selector "${item.path}"`))
    .join(', ')
}

/** The elements a label names in the saved HTML: none (left for the page's data-doop-label lookup), or the one it means. */
function locate(source: FrameSource, label: string): Located | undefined {
  const fromOutline = outlineMatches(source, normalize(label))
  if (fromOutline.length > 1) {
    throw new TargetError(
      `label "${label}" matches ${fromOutline.length} sections; name one by ${candidates(fromOutline)}`,
    )
  }
  if (fromOutline[0]) return fromOutline[0]
  const resolved = resolveTarget(source.document(), { label })
  if (resolved.ok) {
    const match = resolved.matches[0]
    return match
      ? { path: uniquePath(match.path), ...(match.elementId ? { elementId: match.elementId } : {}) }
      : undefined
  }
  if (resolved.code === 'ambiguous') {
    const named = (resolved.candidates ?? []).map((c) => ({ path: uniquePath(c.path), elementId: c.elementId }))
    throw new TargetError(`label "${label}" matches several elements; name one by ${candidates(named)}`)
  }
  return undefined
}

/** Resolves every label the saved HTML names. Throws a TargetError for a label that is ambiguous. */
export async function resolveFrameTargets(
  frame: Frame,
  targets: readonly FrameTarget[],
  opts: ResolveTargetOptions = {},
): Promise<ResolvedRenderTargets> {
  if (!targets.some((target) => 'label' in target)) return { frame, targets: [...targets] }
  const source = new FrameSource(frame)
  let current = frame
  const resolved: FrameTarget[] = []
  for (const target of targets) {
    if (!('label' in target)) {
      resolved.push(target)
      continue
    }
    const found = locate(source, target.label)
    if (!found) {
      resolved.push(target)
      continue
    }
    if (found.elementId) {
      resolved.push({ element_id: found.elementId })
      continue
    }
    /* a stamp is a courtesy: when it cannot be written the page still gets a selector */
    const stamped = opts.stampAs
      ? await ensureElementId(frame.id, found.path, opts.stampAs).catch(() => undefined)
      : undefined
    if (stamped) {
      current = stamped.frame
      resolved.push({ element_id: stamped.id })
    } else {
      resolved.push({ selector: found.path })
    }
  }
  return { frame: current, targets: resolved }
}
