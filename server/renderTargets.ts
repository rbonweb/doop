import { z } from 'zod'
import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import type { Clip, FrameTarget } from './renderTypes.ts'

/** Resolves the way every render tool names one element to its region in the loaded frame. */

export const frameTargetSchema = z
  .union([
    z.object({ element_id: z.string().min(1) }).strict(),
    z.object({ label: z.string().min(1) }).strict(),
    z.object({ selector: z.string().min(1).max(500) }).strict(),
  ])
  .describe(
    'One element: { element_id } (its data-doop-id), { label } (a section label from get_frame mode: "outline", or a data-doop-label) or { selector } (CSS)',
  ) as z.ZodType<FrameTarget>

export const regionSchema = z
  .object({ x: z.number().min(0), y: z.number().min(0), w: z.number().positive(), h: z.number().positive() })
  .describe('A region in design px of the frame')

/** A target that cannot be resolved; the message is what the agent reads. */
export class TargetError extends Error {}

/** The refusal for a target that names nothing: never dropped silently, always named. */
export function noMatchError(t: FrameTarget): TargetError {
  const hint = 'label' in t ? "; call get_frame with mode: 'outline' to see the frame's section labels" : ''
  return new TargetError(`no element matches ${describeTarget(t)}${hint}`)
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The CSS selector a target names, or null when it needs the heading fallback (labels never do). */
export function targetSelector(t: FrameTarget): string | null {
  if ('element_id' in t) return `[data-doop-id="${escapeAttr(t.element_id)}"]`
  if ('label' in t) return `[data-doop-label="${escapeAttr(t.label)}"]`
  return t.selector
}

export function describeTarget(t: FrameTarget): string {
  if ('element_id' in t) return `element_id "${t.element_id}"`
  if ('label' in t) return `label "${t.label}"`
  return `selector "${t.selector}"`
}

interface Match {
  elementId: string | null
  rect: Clip
}

type Resolution = { matches: Match[] } | { invalidSelector: string }

/**
 * Every element the target names, in document coordinates (design px). Throws TargetError for a bad selector.
 * A `label` here is only the `data-doop-label` lookup: outline and heading labels are resolved on the server first
 * (`resolveFrameTargets` in `targetResolution.ts`), which is the one label rule every render tool shares.
 */
export async function resolveTargets(page: Page, t: FrameTarget): Promise<Match[]> {
  /* tsx annotates nested functions with __name, which the page does not have; see inspectFrame */
  await page.evaluate('globalThis.__name = (target) => target')
  const resolved = await page.evaluate((target: FrameTarget): Resolution => {
    const escapeAttrInPage = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    let selector: string
    if ('selector' in target) selector = target.selector
    else if ('element_id' in target) selector = `[data-doop-id="${escapeAttrInPage(target.element_id)}"]`
    else selector = `[data-doop-label="${escapeAttrInPage(target.label)}"]`
    const matches: Array<{ elementId: string | null; rect: { x: number; y: number; width: number; height: number } }> =
      []
    const collect = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      matches.push({
        elementId: el.getAttribute('data-doop-id'),
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
      })
    }
    try {
      document.querySelectorAll(selector).forEach(collect)
    } catch (error) {
      return { invalidSelector: error instanceof Error ? error.message : String(error) }
    }
    return { matches }
  }, t)
  if ('invalidSelector' in resolved) throw new TargetError(`invalid selector: ${resolved.invalidSelector}`)
  return resolved.matches
}

/** The region a target names, padded and clamped to the frame. With `all`, several matches union into one box. */
export async function clipForTarget(
  page: Page,
  t: FrameTarget,
  frame: Pick<Frame, 'width' | 'height'>,
  opts: { pad?: number; all?: boolean } = {},
): Promise<Clip> {
  const matches = await resolveTargets(page, t)
  if (matches.length === 0) throw noMatchError(t)
  if (matches.length > 1 && !opts.all) {
    throw new TargetError(`${matches.length} elements match ${describeTarget(t)}; name one by element_id`)
  }
  const pad = opts.pad ?? 0
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { rect } of opts.all ? matches : matches.slice(0, 1)) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  const x = Math.floor(Math.max(0, left - pad))
  const y = Math.floor(Math.max(0, top - pad))
  const clippedRight = Math.min(Math.ceil(frame.width), Math.ceil(right + pad))
  const clippedBottom = Math.min(Math.ceil(frame.height), Math.ceil(bottom + pad))
  return {
    x,
    y,
    width: Math.max(0, clippedRight - x),
    height: Math.max(0, clippedBottom - y),
  }
}

/**
 * Refuses every target the loaded page has no element for (a hidden or zero-size element still counts as found).
 * `measure_frame` and `lint_frame` call it so an unmatched target is an error, not a section that quietly goes missing.
 */
export async function assertTargetsMatch(page: Page, targets: readonly FrameTarget[]): Promise<void> {
  if (targets.length === 0) return
  await page.evaluate('globalThis.__name = (target) => target')
  const selectors = targets.map((t) => targetSelector(t) ?? '')
  const results = await page.evaluate((list: string[]): Array<boolean | string> => {
    return list.map((selector) => {
      try {
        return document.querySelector(selector) !== null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
  }, selectors)
  for (const [index, result] of results.entries()) {
    if (typeof result === 'string') throw new TargetError(`invalid selector: ${result}`)
    if (!result) throw noMatchError(targets[index]!)
  }
}
