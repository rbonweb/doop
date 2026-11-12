import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import type { Clip, FrameTarget, RenderCrop } from './renderTypes.ts'
import { runPageActions, type ActionsOutcome, type PageAction } from './pageActions.ts'
import { clipForTarget } from './renderTargets.ts'
import { captureFrame } from './screenshot.ts'
import { store } from './store.ts'
import { resolveFrameTargets } from './targetResolution.ts'

/** One screenshot of a frame, of one element or region of it, optionally after page actions (item 6). Shared by `get_frame_screenshot` and `compare_frames`. */

export interface ShotInput {
  target?: FrameTarget
  region?: RenderCrop
  format?: 'png' | 'webp'
  scale?: number
  actions?: PageAction[]
  /** the name an element id is stamped under when a label resolves to an element without one; absent for a read-only caller */
  stampAs?: string
}

export interface ShotResult {
  buf: Buffer
  mime: 'image/png' | 'image/webp'
  width: number
  height: number
  clip: Clip
  actions?: ActionsOutcome
}

function clipOf(region: RenderCrop): Clip {
  return { x: region.x, y: region.y, width: region.w, height: region.h }
}

/**
 * A capture of one region: the element `target` names, the `region` given, or the whole frame. `actions` run in the
 * loaded page first, so interactive states (tabs, toggles, drawers) show in the image. A failed action is reported on
 * the result, not thrown: the state reached so far is still worth seeing.
 */
export async function frameScreenshot(frame: Frame, input: ShotInput): Promise<ShotResult> {
  if (input.target !== undefined && input.region !== undefined) {
    throw new RangeError('pass either target or region, not both')
  }
  const loaded = await store.renderSource(frame)
  const resolved = input.target
    ? await resolveFrameTargets(loaded, [input.target], { stampAs: input.stampAs })
    : undefined
  const source = resolved?.frame ?? loaded
  const target = resolved?.targets[0]
  const format = input.format ?? 'png'
  let actions: ActionsOutcome | undefined
  const prepare =
    input.actions?.length || target
      ? async (page: Page): Promise<Clip | undefined> => {
          if (input.actions?.length) actions = await runPageActions(page, input.actions)
          return target ? clipForTarget(page, target, source) : undefined
        }
      : undefined
  const capture = await captureFrame(source, {
    format,
    scale: input.scale ?? 1,
    ...(format === 'webp' ? { quality: 85 } : {}),
    ...(input.region ? { clip: clipOf(input.region) } : {}),
    ...(prepare ? { prepare } : {}),
  })
  return {
    buf: capture.buf,
    mime: format === 'webp' ? 'image/webp' : 'image/png',
    width: capture.width,
    height: capture.height,
    clip: capture.clip,
    ...(actions ? { actions } : {}),
  }
}
