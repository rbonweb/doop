import type { Frame } from '../shared/types.ts'
import type { AssetSource } from '../shared/assetSource.ts'
import { captureFrame } from './screenshot.ts'
import { TargetError, clipForTarget, describeTarget, noMatchError, resolveTargets } from './renderTargets.ts'
import { resolveFrameTargets } from './targetResolution.ts'
import { normalizeRenderParams } from './renderParams.ts'
import type { FrameTarget, RenderCrop, RenderFormat } from './renderTypes.ts'
import { MAX_ASSET_BYTES, createAsset } from './assets.ts'
import { store } from './store.ts'
import { env } from './env.ts'

/** A snapshot: one frame, region or element rendered straight to a permanent /a/ image asset, with the provenance of where it was cut. */

export interface SnapshotInput {
  frame: Frame
  /** a region in design px; exclusive with `target` */
  region?: RenderCrop
  /** one element of the frame; exclusive with `region` */
  target?: FrameTarget
  format?: RenderFormat
  scale?: number
  quality?: number
  tags?: string[]
  agentName: string
  ownerId?: string
}

export interface SnapshotResult {
  url: string
  asset_id: string
  format: RenderFormat
  width: number
  height: number
  bytes: number
  source: AssetSource
  tags: string[]
}

/** What a webp snapshot starts at when the caller names no quality; jpg keeps the render default. */
const SNAPSHOT_QUALITY = { webp: 85, jpg: 90, png: 0 } as const

/** Render a frame, a region of it or one element of it to an image asset. The region of the capture, the element it resolved to and the frame's version ride along as provenance. */
export async function snapshotFrame(input: SnapshotInput): Promise<SnapshotResult> {
  if (input.region && input.target) throw new RangeError('pass region or target, not both')
  const format = input.format ?? 'webp'
  const params = normalizeRenderParams(input.frame, {
    format,
    scale: input.scale ?? 1,
    quality: input.quality ?? SNAPSHOT_QUALITY[format],
    ...(input.region ? { crop: input.region } : {}),
  })
  const loaded = await store.renderSource(input.frame)
  const resolved = input.target
    ? await resolveFrameTargets(loaded, [input.target], { stampAs: input.agentName })
    : undefined
  const sourceFrame = resolved?.frame ?? loaded
  let element: string | undefined
  let clip: { x: number; y: number; width: number; height: number } | undefined
  if (params.crop) clip = { x: params.crop.x, y: params.crop.y, width: params.crop.w, height: params.crop.h }
  const target = resolved?.targets[0]
  const prepare = target
    ? async (page: import('puppeteer-core').Page): Promise<{ x: number; y: number; width: number; height: number }> => {
        const matches = await resolveTargets(page, target)
        if (matches.length === 0) throw noMatchError(target)
        if (matches.length > 1) {
          throw new TargetError(`${matches.length} elements match ${describeTarget(target)}; name one by element_id`)
        }
        element = matches[0]?.elementId ?? undefined
        return clipForTarget(page, target, input.frame)
      }
    : undefined
  const captured = await captureFrame(sourceFrame, {
    format: params.format,
    scale: params.scale,
    quality: params.quality,
    ...(clip ? { clip } : {}),
    ...(prepare ? { prepare } : {}),
  })
  if (captured.buf.length > MAX_ASSET_BYTES) {
    const mb = (captured.buf.length / 1024 / 1024).toFixed(1)
    throw new Error(`snapshot is ${mb} MB; use webp, a lower scale or a smaller region`)
  }
  const source: AssetSource = {
    kind: 'frame',
    frame_id: input.frame.id,
    region: { x: captured.clip.x, y: captured.clip.y, w: captured.clip.width, h: captured.clip.height },
    ...(element ? { element } : {}),
    frame_version: sourceFrame.updatedAt,
    agent: input.agentName,
  }
  const asset = await createAsset(captured.buf, {
    canvasId: input.frame.canvasId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    uploadedBy: input.agentName,
    source,
    ...(input.tags ? { tags: input.tags } : {}),
  })
  return {
    url: `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`,
    asset_id: asset.id,
    format: params.format,
    width: captured.width,
    height: captured.height,
    bytes: captured.buf.length,
    source,
    tags: asset.tags ?? [],
  }
}
