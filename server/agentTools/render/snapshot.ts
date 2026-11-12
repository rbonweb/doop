import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { env } from '../../env.ts'
import { store } from '../../store.ts'
import { assetTagsSchema } from '../../assetSourceSchema.ts'
import { listCanvasAssets } from '../../assets.ts'
import { frameTargetSchema, regionSchema } from '../../renderTargets.ts'
import type { FrameTarget } from '../../renderTypes.ts'
import { snapshotFrame } from '../../snapshots.ts'
import { limitKey, type AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/** snapshot_frame and list_assets (items 2 and 11). */

const SNAPSHOT_DESCRIPTION =
  'Render a frame, a region of it or one element straight to a permanent /a/ image asset (webp by default) with its provenance, for use in other frames, store listings or reports — one call instead of render, download, crop, convert and upload. Pass region OR target, not both; a target is { element_id } (data-doop-id), { label } (a section label from get_frame mode outline, or a data-doop-label) or { selector }. tags make it findable with list_assets.'

const LIST_DESCRIPTION =
  "List the images an agent can use on a canvas: those uploaded for it plus any asset one of its frames references, newest first, with each one's URL, size, provenance and tags. Narrow by tag, source_kind (frame = a snapshot, store, url) and frame_id. Use it to find a snapshot again instead of rendering it twice."

/** The MCP text answer. ctx.text/ctx.err are typed AgentToolResult, whose content union registerTool cannot accept (reported to the lead); at runtime it is the SDK's text block. */
type ToolAnswer = { content: { type: 'text'; text: string }[]; isError?: boolean }
const asToolAnswer = (result: unknown) => result as ToolAnswer

export function registerSnapshotTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'snapshot_frame',
    {
      title: 'Snapshot a frame, region or element to an image asset',
      description: SNAPSHOT_DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        frame_id: z.string().describe('The frame to snapshot'),
        region: regionSchema.optional().describe('A region in design px of the frame; exclusive with target'),
        target: frameTargetSchema.optional().describe('One element of the frame; exclusive with region'),
        format: z.enum(['webp', 'png', 'jpg']).optional().describe('Default webp'),
        scale: z.number().min(0.25).max(4).optional().describe('Pixel density; default 1'),
        quality: z.number().min(1).max(100).optional().describe('webp/jpg only; default 85 webp, 90 jpg'),
        tags: assetTagsSchema.optional().describe('Tags to find the asset again with list_assets'),
        agent_name: ctx.agentName,
      },
    },
    async ({ frame_id, region, target, format, scale, quality, tags, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'edit')
      if (!frame) return asToolAnswer(ctx.noFrame(frame_id, 'edit'))
      if (!ctx.takeSlot('render', limitKey(ctx, agent_name), env.MCP_RENDERS_PER_MIN)) {
        return asToolAnswer(ctx.err('render rate limit — wait a minute'))
      }
      ctx.arrive(frame.canvasId, agent_name)
      try {
        const result = await snapshotFrame({
          frame,
          ...(region ? { region } : {}),
          ...(target ? { target } : {}),
          ...(format ? { format } : {}),
          ...(scale !== undefined ? { scale } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(tags ? { tags } : {}),
          agentName: agent_name,
          ...(ctx.ownerId ? { ownerId: ctx.ownerId } : {}),
        })
        const shownWidth = result.source.region?.w ?? result.width
        return asToolAnswer(
          ctx.withFeedback(
            ctx.text({
              ok: true,
              ...result,
              html_snippet: `<img src="${result.url}" width="${shownWidth}" alt="">`,
            }),
            frame.canvasId,
            ctx.actorFrom(agent_name),
          ),
        )
      } catch (e) {
        return asToolAnswer(ctx.err(e instanceof Error ? e.message : 'snapshot failed'))
      }
    },
  )

  server.registerTool(
    'list_assets',
    {
      title: 'List images usable on a canvas',
      description: LIST_DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string().describe('The canvas to list images for'),
        tag: z.string().optional().describe('Only assets carrying this tag'),
        source_kind: z.enum(['frame', 'store', 'url']).optional().describe('Only assets with this provenance kind'),
        frame_id: z.string().optional().describe("Only assets one of this frame's HTML references"),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100, max 500'),
        agent_name: ctx.agentName.optional(),
      },
    },
    async ({ canvas_id, tag, source_kind, frame_id, limit, agent_name }) => {
      const canvas = ctx.canvasFor(canvas_id, 'view')
      if (!canvas) return asToolAnswer(ctx.noCanvas(canvas_id, 'view'))
      const assets = await listCanvasAssets(
        canvas_id,
        canvas.frames.map((f) => f.id),
        {
          ...(tag !== undefined ? { tag } : {}),
          ...(source_kind ? { source_kind } : {}),
          ...(frame_id !== undefined ? { frame_id } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      ).then((rows) => rows.map((row) => ({ ...row, url: `${env.BETTER_AUTH_URL}${row.src}` })))
      return asToolAnswer(
        ctx.withFeedbackNotice(
          ctx.text({ count: assets.length, assets }),
          canvas_id,
          agent_name ? ctx.actorFrom(agent_name) : undefined,
        ),
      )
    },
  )
}

/* The resident twins take the same inputs minus agent_name and stay on the run's canvas. */

const regionJson = {
  type: 'object',
  description: 'A region in design px of the frame; exclusive with target',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
} as const

const targetJson = {
  anyOf: [
    {
      type: 'object',
      properties: { element_id: { type: 'string', description: 'A data-doop-id' } },
      required: ['element_id'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A section label from get_frame mode outline, or a data-doop-label' },
      },
      required: ['label'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Any CSS selector' } },
      required: ['selector'],
      additionalProperties: false,
    },
  ],
  description: 'One element of the frame; exclusive with region',
} as const

export const snapshotResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'snapshot_frame',
      description: SNAPSHOT_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          frame_id: { type: 'string', description: 'The frame on this canvas to snapshot' },
          region: regionJson,
          target: targetJson,
          format: { type: 'string', enum: ['webp', 'png', 'jpg'], description: 'Default webp' },
          scale: { type: 'number', description: 'Pixel density 0.25-4; default 1' },
          quality: { type: 'number', description: 'webp/jpg only; default 85 webp, 90 jpg' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to find it again with list_assets' },
        },
        required: ['frame_id'],
      },
    },
    async run(input, ctx) {
      const frameId = String(input.frame_id ?? '')
      const region = input.region as { x: number; y: number; w: number; h: number } | undefined
      const rawTarget = input.target as { element_id?: unknown; label?: unknown; selector?: unknown } | undefined
      const target: FrameTarget | undefined =
        rawTarget && typeof rawTarget === 'object'
          ? typeof rawTarget.element_id === 'string'
            ? { element_id: rawTarget.element_id }
            : typeof rawTarget.label === 'string'
              ? { label: rawTarget.label }
              : typeof rawTarget.selector === 'string'
                ? { selector: rawTarget.selector }
                : undefined
          : undefined
      const frame = store.getFrame(frameId)
      if (!frame || frame.canvasId !== ctx.canvasId) return { ok: false, error: 'frame not found on this canvas' }
      const canvas = store.getCanvas(ctx.canvasId)
      try {
        const result = await snapshotFrame({
          frame,
          ...(region ? { region } : {}),
          ...(target ? { target } : {}),
          ...(input.format === 'png' || input.format === 'jpg' || input.format === 'webp'
            ? { format: input.format }
            : {}),
          ...(typeof input.scale === 'number' ? { scale: input.scale } : {}),
          ...(typeof input.quality === 'number' ? { quality: input.quality } : {}),
          ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
          agentName: ctx.actor.name,
          ...(canvas?.ownerId ? { ownerId: canvas.ownerId } : {}),
        })
        const shownWidth = result.source.region?.w ?? result.width
        return {
          ok: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                ...result,
                html_snippet: `<img src="${result.url}" width="${shownWidth}" alt="">`,
              }),
            },
          ],
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'snapshot failed' }
      }
    },
  } satisfies ResidentAgentTool,
  {
    definition: {
      name: 'list_assets',
      description: LIST_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Only assets carrying this tag' },
          source_kind: {
            type: 'string',
            enum: ['frame', 'store', 'url'],
            description: 'Only assets with this provenance kind',
          },
          frame_id: { type: 'string', description: "Only assets one of this frame's HTML references" },
          limit: { type: 'number', description: 'Default 100, max 500' },
        },
      },
    },
    async run(input, ctx) {
      const canvas = store.getCanvas(ctx.canvasId)
      if (!canvas) return { ok: false, error: 'canvas not found' }
      const tag = typeof input.tag === 'string' ? input.tag : undefined
      const kind =
        input.source_kind === 'frame' || input.source_kind === 'store' || input.source_kind === 'url'
          ? input.source_kind
          : undefined
      const frameId = typeof input.frame_id === 'string' ? input.frame_id : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      const assets = await listCanvasAssets(
        ctx.canvasId,
        canvas.frames.map((f) => f.id),
        {
          ...(tag !== undefined ? { tag } : {}),
          ...(kind ? { source_kind: kind } : {}),
          ...(frameId !== undefined ? { frame_id: frameId } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      ).then((rows) => rows.map((row) => ({ ...row, url: `${env.BETTER_AUTH_URL}${row.src}` })))
      return { ok: true, content: [{ type: 'text', text: JSON.stringify({ count: assets.length, assets }) }] }
    },
  } satisfies ResidentAgentTool,
]
