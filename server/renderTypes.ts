/** Shared types of the render area (agent-speed items 1, 2, 5, 6): image parameters, regions and element targets. Implementations live in renderParams.ts, screenshot.ts (captureFrame), renderTargets.ts and renderStore.ts. */

/** An output format of a frame image. `jpg` is encoded as JPEG. */
export type RenderFormat = 'png' | 'jpg' | 'webp'

/** A rectangle in design px of the frame (CSS px at 1x), origin at the frame's top-left. */
export interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/** A crop as the `/i/` query and the tools spell it. */
export interface RenderCrop {
  x: number
  y: number
  w: number
  h: number
}

/** Normalized parameters of one frame image: what the render store keys on. */
export interface RenderParams {
  format: RenderFormat
  /** device scale factor, already fitted to the render limits and lowered by `width` */
  scale: number
  /** 1-100 for jpg and webp; always 0 for png */
  quality: number
  /** clamped to the frame, integers; absent for the whole frame */
  crop?: RenderCrop
}

/** One element of a frame, as every render tool names it. `element_id` is a `data-doop-id`, `label` a `data-doop-label` (else a top-level section whose first heading reads it), `selector` any CSS selector. */
export type FrameTarget = { element_id: string } | { label: string } | { selector: string }

/** What `captureFrame` takes. `clip` and `prepare` are exclusive ways to pick the region; neither means the whole frame. */
export interface CaptureRequest {
  format: RenderFormat
  scale: number
  quality?: number
  clip?: Clip
  /** runs in the loaded, settled page before the capture (actions, target lookup); may return the region to capture */
  prepare?: (page: import('puppeteer-core').Page) => Promise<Clip | void>
}

export interface CaptureResult {
  buf: Buffer
  /** the region captured, in design px */
  clip: Clip
  /** output pixel size */
  width: number
  height: number
}
