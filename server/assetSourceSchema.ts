import { z } from 'zod'
import { MAX_ASSET_TAG_LENGTH, MAX_ASSET_TAGS } from '../shared/assetSource.ts'

const MAX_TEXT = 500

/** Bounds for one asset's provenance: what a tool accepts before anything touches the database. */
export const assetSourceSchema = z.object({
  kind: z.enum(['frame', 'store', 'url']),
  frame_id: z.string().max(MAX_TEXT).optional(),
  region: z
    .object({
      x: z.number().min(0),
      y: z.number().min(0),
      w: z.number().min(0),
      h: z.number().min(0),
    })
    .optional(),
  element: z.string().max(MAX_TEXT).optional(),
  frame_version: z.number().int().min(0).optional(),
  name: z.string().max(MAX_TEXT).optional(),
  url: z.string().url().max(2000).optional(),
  agent: z.string().max(MAX_TEXT).optional(),
})

export const assetTagsSchema = z.array(z.string().min(1).max(MAX_ASSET_TAG_LENGTH)).max(MAX_ASSET_TAGS)
