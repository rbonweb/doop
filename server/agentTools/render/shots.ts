import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type Anthropic from '@anthropic-ai/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Frame } from '../../../shared/types.ts'
import type { FrameTarget, RenderCrop } from '../../renderTypes.ts'
import { limitKey, type AgentToolContext, type AgentToolResult } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'
import { composeImages } from '../../composite.ts'
import { env } from '../../env.ts'
import { frameScreenshot } from '../../frameShots.ts'
import { describeTarget, frameTargetSchema, regionSchema, TargetError } from '../../renderTargets.ts'
import { store } from '../../store.ts'

/** compare_frames (item 6): several frames or sections joined into one labelled image. The new `get_frame_screenshot` parameters are handled by server/frameShots.ts, called from mcp.ts. */

interface CompareItem {
  frame_id: string
  target?: FrameTarget
  region?: RenderCrop
  label?: string
}

interface CompareOptions {
  layout: 'row' | 'grid'
  format: 'png' | 'webp'
  scale: number
  /** the name an element id is stamped under for one frame's label target; undefined where the caller may not edit */
  stampAs?: (frame: Frame) => string | undefined
}

const itemSchema = z
  .object({
    frame_id: z.string(),
    target: frameTargetSchema.optional(),
    region: regionSchema.optional(),
    label: z.string().max(80).optional().describe('Caption for this cell; defaults to the frame name (+ the target)'),
  })
  .strict()

const compareSchema = z.object({
  items: z
    .array(itemSchema)
    .min(1)
    .max(8)
    .describe('1 to 8 cells: each a frame, optionally one section of it, with a caption'),
  layout: z.enum(['row', 'grid']).optional().describe('row (default) or grid'),
  format: z.enum(['png', 'webp']).optional().describe('webp (default) or png'),
  scale: z.number().min(0.25).max(2).optional().describe('Device scale factor, 0.25 to 2 (default 1)'),
})

const COMPARE_DESCRIPTION =
  'Render several frames or sections and join them side by side with labels — compare concepts, variants or before/after in one image at a readable scale. Each item is a frame, optionally cropped to one element (target) or region.'

/** Runs `run` over the items with at most `limit` in flight, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function defaultLabel(frame: Frame, item: CompareItem): string {
  return item.target ? `${frame.name} · ${describeTarget(item.target)}` : frame.name
}

interface CompareCell {
  label: string
  frame_id: string
  region: string
  width: number
  height: number
}

/** The frames are already access-checked and in item order; renders at most 2 at a time and composes one sheet. */
async function compareShots(
  frames: Frame[],
  items: CompareItem[],
  opts: CompareOptions,
): Promise<{ buf: Buffer; mime: 'image/png' | 'image/webp'; width: number; height: number; cells: CompareCell[] }> {
  const shots = await mapLimit(items, 2, (item, index) =>
    frameScreenshot(frames[index]!, {
      target: item.target,
      region: item.region,
      format: opts.format,
      scale: opts.scale,
      stampAs: opts.stampAs?.(frames[index]!),
    }),
  )
  const labels = items.map((item, index) => item.label ?? defaultLabel(frames[index]!, item))
  const composed = await composeImages(
    shots.map((shot, index) => ({ buf: shot.buf, label: labels[index] })),
    { layout: opts.layout, format: opts.format },
  )
  const cells = shots.map((shot, index) => ({
    label: labels[index]!,
    frame_id: frames[index]!.id,
    region: `${shot.clip.x},${shot.clip.y} ${shot.clip.width}×${shot.clip.height}`,
    width: shot.width,
    height: shot.height,
  }))
  return {
    buf: composed.buf,
    mime: opts.format === 'webp' ? 'image/webp' : 'image/png',
    width: composed.width,
    height: composed.height,
    cells,
  }
}

function optionsOf(input: z.infer<typeof compareSchema>, stampAs?: CompareOptions['stampAs']): CompareOptions {
  return { layout: input.layout ?? 'row', format: input.format ?? 'webp', scale: input.scale ?? 1, stampAs }
}

function shotError(e: unknown, lead: string): string {
  if (e instanceof TargetError || e instanceof RangeError) return e.message
  return `${lead}: ${e instanceof Error ? e.message : String(e)}`
}

type ToolReply = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

/** A ctx result (loose blocks) in the precise shape registerTool takes. */
function reply(result: AgentToolResult): ToolReply {
  return { content: result.content as ToolReply['content'], isError: result.isError }
}

export function registerShotTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'compare_frames',
    {
      title: 'Compare frames side by side',
      description: COMPARE_DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { ...compareSchema.shape, agent_name: ctx.agentName.optional() },
    },
    async ({ items, layout, format, scale, agent_name }) => {
      const frames: Frame[] = []
      for (const item of items) {
        const frame = ctx.frameFor(item.frame_id, 'view')
        if (!frame) return reply(ctx.noFrame(item.frame_id))
        frames.push(frame)
      }
      const key = limitKey(ctx, agent_name ?? '')
      for (let index = 0; index < items.length; index++) {
        if (!ctx.takeSlot('render', key, env.MCP_RENDERS_PER_MIN)) {
          return reply(
            ctx.err(`render budget spent (${env.MCP_RENDERS_PER_MIN} renders per minute): try again in a minute`),
          )
        }
      }
      const canvasId = frames[0]!.canvasId
      ctx.arrive(canvasId, agent_name)
      try {
        const shot = await compareShots(
          frames,
          items,
          optionsOf({ items, layout, format, scale }, (frame) =>
            ctx.frameFor(frame.id, 'edit') ? ctx.actorFrom(agent_name).name : undefined,
          ),
        )
        const result = {
          content: [
            { type: 'image' as const, data: shot.buf.toString('base64'), mimeType: shot.mime },
            {
              type: 'text' as const,
              text: JSON.stringify(
                { image: { width: shot.width, height: shot.height, format: format ?? 'webp' }, cells: shot.cells },
                null,
                2,
              ),
            },
          ],
        }
        return ctx.withFeedbackNotice(result, canvasId, agent_name ? ctx.actorFrom(agent_name) : undefined)
      } catch (e) {
        return reply(ctx.err(shotError(e, 'compare failed')))
      }
    },
  )
}

export const shotResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'compare_frames',
      description: COMPARE_DESCRIPTION,
      input_schema: zodToJsonSchema(compareSchema) as Anthropic.Tool['input_schema'],
    },
    run(input, ctx) {
      const parsed = compareSchema.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') }
      const items = parsed.data.items
      const frames: Frame[] = []
      for (const item of items) {
        const frame = store.getFrame(item.frame_id)
        if (!frame || frame.canvasId !== ctx.canvasId) {
          return { ok: false, error: `no frame ${item.frame_id} on this canvas` }
        }
        frames.push(frame)
      }
      return compareShots(
        frames,
        items,
        optionsOf(parsed.data, () => ctx.actor.name),
      )
        .then((shot) => ({
          ok: true as const,
          content: [
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: shot.mime, data: shot.buf.toString('base64') },
            },
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  image: { width: shot.width, height: shot.height, format: parsed.data.format ?? 'webp' },
                  cells: shot.cells,
                },
                null,
                2,
              ),
            },
          ],
        }))
        .catch((e: unknown) => ({ ok: false as const, error: shotError(e, 'compare failed') }))
    },
  },
]
