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
