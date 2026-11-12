import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { freeSpotBeside } from '../../shared/arrange.ts'
import { canvasPages, framePageId, pageFrames } from '../../shared/pages.ts'
import type { Canvas, Frame } from '../../shared/types.ts'
import * as actions from '../actions.ts'
import { store } from '../store.ts'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** How many frames one call copies. */
export const MAX_DUPLICATES = 50

/** The gap kept between a copy and its neighbours. */
const GAP = 80

const itemShape = {
  frame_id: z.string().describe('The frame to copy (on this canvas)'),
  name: z.string().min(1).max(200).optional().describe('Name of the copy; default "<source name> copy"'),
  page_id: z.string().optional().describe('Page of the copy; default the source frame’s page'),
  x: z.number().optional().describe('Left edge of the copy; default beside the source, clear of other frames'),
  y: z.number().optional().describe('Top edge of the copy; default beside the source, clear of other frames'),
}
const itemSchema = z.object(itemShape)
type DuplicateItem = z.infer<typeof itemSchema>

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const boxOf = (frame: Box): Box => ({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })

/** Whether two boxes overlap or sit closer than `gap`. */
const near = (a: Box, b: Box, gap: number): boolean =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap

/** Every item checked against the canvas, then each copy's name, page and place; the whole call is refused on the first problem. */
export function planDuplicates(
  canvas: Canvas,
  items: readonly DuplicateItem[],
): { ok: true; plan: actions.FrameDuplicate[] } | { ok: false; error: string } {
  const pages = canvasPages(canvas)
  const sources: Frame[] = []
  for (const [index, item] of items.entries()) {
    const source = store.getFrame(item.frame_id)
    if (!source || source.canvasId !== canvas.id) {
      return {
        ok: false,
        error: `items[${index}]: frame ${item.frame_id} is not on canvas ${canvas.id}; duplicate_frames stays on one canvas (move_frame moves a frame to another canvas). Nothing was copied.`,
      }
    }
    if (item.page_id && !pages.some((page) => page.id === item.page_id)) {
      const known = pages.map((page) => `${page.id} (${page.name})`).join(', ')
      return {
        ok: false,
        error: `items[${index}]: page ${item.page_id} is not a page of this canvas; pages: ${known}. Nothing was copied.`,
      }
    }
    sources.push(source)
  }
  const occupied = new Map<string, Box[]>()
  const onPage = (pageId: string): Box[] => {
    const existing = occupied.get(pageId)
    if (existing) return existing
    const boxes = pageFrames(canvas, pageId).map(boxOf)
    occupied.set(pageId, boxes)
    return boxes
  }
  const plan = items.map((item, index): actions.FrameDuplicate => {
    const source = sources[index]!
    const sourcePage = framePageId(canvas, source)
    const pageId = item.page_id ?? sourcePage
    const taken = onPage(pageId)
    const box = boxOf(source)
    const own = pageId !== sourcePage && !taken.some((other) => near(box, other, GAP)) ? box : undefined
    const spot = own ?? freeSpotBeside(box, taken, GAP)
    const x = item.x ?? spot.x
    const y = item.y ?? spot.y
    taken.push({ x, y, width: source.width, height: source.height })
    return { sourceId: source.id, name: item.name ?? `${source.name} copy`, pageId, x, y }
  })
  return { ok: true, plan }
}

/** What the tool answers with: one entry per copy. */
function resultOf(made: ReturnType<typeof actions.duplicateFrames>) {
  return {
    ok: true,
    frames: made.map(({ source, frame, rewritten }) => ({
      source_id: source.id,
      id: frame.id,
      name: frame.name,
      pageId: frame.pageId,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      ...(rewritten ? { rewritten: true } : {}),
    })),
  }
}

const DESCRIPTION =
  'Copy frames on one canvas, as many as you like in one call: each copy is the source’s HTML byte for byte (element ids and prototype attributes kept), with its size, slide flag, speaker notes, hidden, locked and rotation. Approval, comments, versions and sticky notes are not copied. Use it for variants, phone and desktop pairs and any "same design again"; never re-type HTML to copy a frame. Copies land beside their source clear of other frames unless you pass page_id, x or y. Links between frames copied in the same call follow the copies; every other link stays. A frame holding a component main is copied through the normal write path so the canvas never has two mains of one component (the result flags it rewritten).'

/** `duplicate_frames`: copies of frames on the same canvas, HTML byte for byte. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'duplicate_frames',
    {
      title: 'Duplicate frames',
      description: DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string().describe('The canvas the frames are on; copies stay on it'),
        items: z.array(itemSchema).min(1).max(MAX_DUPLICATES).describe(`Up to ${MAX_DUPLICATES} copies to make`),
        agent_name: ctx.agentName,
      },
    },
    async ({ canvas_id, items, agent_name }): Promise<CallToolResult> => {
      const canvas = ctx.canvasFor(canvas_id, 'edit')
      if (!canvas) return ctx.noCanvas(canvas_id, 'edit') as CallToolResult
      const planned = planDuplicates(canvas, items)
      if (!planned.ok) return ctx.err(planned.error) as CallToolResult
      ctx.arrive(canvas_id, agent_name)
      const actor = ctx.actorFrom(agent_name)
      const made = actions.duplicateFrames(canvas_id, planned.plan, actor)
      return ctx.withFeedback(ctx.text(resultOf(made)), canvas_id, actor) as CallToolResult
    },
  )
}

/** The same tool for the resident agent. */
export const residentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'duplicate_frames',
      description: DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_DUPLICATES,
            description: `Up to ${MAX_DUPLICATES} copies to make`,
            items: {
              type: 'object',
              properties: {
                frame_id: { type: 'string', description: 'The frame to copy (on this canvas)' },
                name: { type: 'string', description: 'Name of the copy; default "<source name> copy"' },
                page_id: { type: 'string', description: 'Page of the copy; default the source frame’s page' },
                x: { type: 'number', description: 'Left edge of the copy; default beside the source' },
                y: { type: 'number', description: 'Top edge of the copy; default beside the source' },
              },
              required: ['frame_id'],
            },
          },
        },
        required: ['items'],
      },
    },
    run(input, { canvasId, actor, runState }) {
      const parsed = z.object({ items: z.array(itemSchema).min(1).max(MAX_DUPLICATES) }).safeParse(input)
      if (!parsed.success) return { ok: false, error: `duplicate_frames: items must be 1-${MAX_DUPLICATES} copies` }
      const canvas = store.getCanvas(canvasId)
      if (!canvas) return { ok: false, error: 'canvas not found' }
      const planned = planDuplicates(canvas, parsed.data.items)
      if (!planned.ok) return { ok: false, error: planned.error }
      const made = actions.duplicateFrames(canvasId, planned.plan, actor)
      for (const { frame } of made) {
        runState.mutatedFrames.add(frame.id)
        runState.verifiedFrames.delete(frame.id)
      }
      return { ok: true, content: JSON.stringify(resultOf(made)) }
    },
  },
]
