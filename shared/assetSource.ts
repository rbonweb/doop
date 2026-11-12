/** Where an asset came from, kept on `assets.source` (jsonb) and written by whatever made the asset: a snapshot of a frame, an upload from a store, a fetched URL. Existing assets have none. */
export interface AssetSource {
  kind: 'frame' | 'store' | 'url'
  /** the frame a snapshot was taken from */
  frame_id?: string
  /** the region of that frame, in design px */
  region?: { x: number; y: number; w: number; h: number }
  /** the `data-doop-id` of the element a snapshot was cut to */
  element?: string
  /** the frame's `updatedAt` when the snapshot was taken */
  frame_version?: number
  /** the store or site the picture came from, by name */
  name?: string
  url?: string
  /** the agent that made or fetched it */
  agent?: string
}

/** Tags an agent put on an asset to find it again. */
export type AssetTags = string[]

export const MAX_ASSET_TAGS = 20
export const MAX_ASSET_TAG_LENGTH = 40

/** trims, lowercases, drops empties and duplicates, cuts each to MAX_ASSET_TAG_LENGTH and the list to MAX_ASSET_TAGS */
export function normalizeAssetTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, MAX_ASSET_TAG_LENGTH).trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length === MAX_ASSET_TAGS) break
  }
  return out.length ? out : undefined
}
