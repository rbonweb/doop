import type Anthropic from '@anthropic-ai/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  DEFAULT_ROWS,
  arrangeRows,
  layoutIssues,
  type LayoutItem,
  type NamedBox,
  type RowRule,
} from '../../shared/arrange.ts'
import { noteExcerpt, notePageId } from '../../shared/notes.ts'
import { canvasPages, framePageId } from '../../shared/pages.ts'
import type { Actor, Canvas, Frame } from '../../shared/types.ts'
import * as actions from '../actions.ts'
import { store } from '../store.ts'
import type { AgentToolContext, AgentToolResult } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

const DEFAULT_GAP = 300
const DEFAULT_MIN_GAP = 40
const MAX_REPORTED_ISSUES = 100

const rowShape = z.object({
  min_width: z.number().min(0).optional().describe('Frames at least this wide join the row'),
  max_width: z.number().min(0).optional().describe('Frames at most this wide join the row'),
  name: z.string().max(200).optional().describe('Case-insensitive text the frame name must contain'),
  order: z
    .enum(['x', 'name', 'given'])
    .optional()
    .describe('Left to right by current x (default), by name (numeric aware) or in the order frame_ids lists them'),
})

/** The inputs both tools surfaces share: the MCP schema adds `canvas_id` and `agent_name`, the resident agent has neither. */
const arrangeShape = {
  frame_ids: z.array(z.string()).min(1).max(200).optional().describe('The frames to arrange, all on one page'),
  page_id: z
    .string()
    .optional()
    .describe('Arrange every frame of this page (demo frames excepted) instead of frame_ids'),
  rows: z
    .array(rowShape)
    .min(1)
    .max(10)
    .optional()
    .describe(
      'Rows top to bottom; each frame joins the first row it matches. Default: desktops (900 px and wider), then the rest',
    ),
  gap: z.number().min(0).max(5000).optional().describe(`Space between frames and rows in px (default ${DEFAULT_GAP})`),
  origin: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('Top-left of the first row (default: the top-left of the frames being arranged)'),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'Plan only: list each move as planned (frame_id, from, to) and write nothing, so the layout can be checked first',
    ),
}
const arrangeInput = z.object(arrangeShape)
type ArrangeInput = z.infer<typeof arrangeInput>

const checkShape = {
  page_id: z.string().describe('The page to check (ids from get_canvas)'),
  min_gap: z
    .number()
    .min(0)
    .max(2000)
    .optional()
    .describe(`Frames closer than this many px count as tight (default ${DEFAULT_MIN_GAP})`),
}
const checkInput = z.object(checkShape)
type CheckInput = z.infer<typeof checkInput>

type Outcome = { ok: true; data: Record<string, unknown> | string; changed: boolean } | { ok: false; error: string }

const pageLabel = (canvas: Canvas, pageId: string): string => {
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  return page ? `${page.id} (${JSON.stringify(page.name)})` : pageId
}

const noPageError = (canvas: Canvas, pageId: string): string =>
  `Error: no page ${pageId} on this canvas. Pages: ${canvasPages(canvas)
    .map((p) => `${p.id} (${JSON.stringify(p.name)})`)
    .join(', ')}`

/** The frames an `arrange_frames` call names, or the reason it cannot go ahead. */
function framesToArrange(canvas: Canvas, input: ArrangeInput): { frames: Frame[] } | { error: string } {
  const { frame_ids, page_id } = input
  if (!frame_ids === !page_id) return { error: 'Pass exactly one of frame_ids or page_id.' }
  if (page_id) {
    if (!canvasPages(canvas).some((p) => p.id === page_id)) return { error: noPageError(canvas, page_id) }
    return { frames: canvas.frames.filter((f) => framePageId(canvas, f) === page_id && !f.demo) }
  }
  const ids = [...new Set(frame_ids)]
  const frames: Frame[] = []
  const missing: string[] = []
  for (const id of ids) {
    const frame = canvas.frames.find((f) => f.id === id)
    if (frame) frames.push(frame)
    else missing.push(id)
  }
  if (missing.length) return { error: `These frames are not on this canvas: ${missing.join(', ')}.` }
  const pages = [...new Set(frames.map((f) => framePageId(canvas, f)))]
  if (pages.length > 1) {
    return {
      error: `frame_ids span ${pages.length} pages (${pages.map((p) => pageLabel(canvas, p)).join(', ')}). Arrange one page at a time.`,
    }
  }
  return { frames }
}

/** Arranges frames in rows. Only the frames that actually move are written, each through `actions.updateFrame`, which carries attached notes along. */
function arrangeFrames(canvas: Canvas, input: ArrangeInput, actor: Actor): Outcome {
  const picked = framesToArrange(canvas, input)
  if ('error' in picked) return { ok: false, error: picked.error }
  const skippedLocked = picked.frames.filter((f) => f.locked).map((f) => f.id)
  const frames = picked.frames.filter((f) => !f.locked)
  if (!frames.length) {
    return {
      ok: true,
      changed: false,
      data: {
        ok: true,
        ...(input.dry_run ? { dry_run: true, planned: [] } : { moved: [] }),
        unchanged: 0,
        skipped_locked: skippedLocked,
        unmatched: [],
      },
    }
  }
  const boxes: NamedBox[] = frames.map((f) => ({
    id: f.id,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
  }))
  const origin = input.origin ?? {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
  }
  const rules: RowRule[] = input.rows
    ? input.rows.map((r) => ({ minWidth: r.min_width, maxWidth: r.max_width, name: r.name, order: r.order }))
    : [...DEFAULT_ROWS]
  const { placed, unmatched } = arrangeRows(boxes, rules, { gap: input.gap ?? DEFAULT_GAP, origin })

  const moved: { id: string; name: string; x: number; y: number }[] = []
  const planned: { frame_id: string; name: string; from: { x: number; y: number }; to: { x: number; y: number } }[] = []
  let unchanged = 0
  for (const frame of frames) {
    const spot = placed.get(frame.id)
    if (!spot) continue
    const x = Math.round(spot.x)
    const y = Math.round(spot.y)
    if (Math.abs(x - frame.x) < 0.5 && Math.abs(y - frame.y) < 0.5) {
      unchanged += 1
      continue
    }
    if (input.dry_run) {
      planned.push({ frame_id: frame.id, name: frame.name, from: { x: frame.x, y: frame.y }, to: { x, y } })
      continue
    }
    const updated = actions.updateFrame(frame.id, { x, y }, actor)
    if (updated) moved.push({ id: frame.id, name: updated.name, x: updated.x, y: updated.y })
  }
  if (input.dry_run) {
    return {
      ok: true,
      changed: false,
      data: { ok: true, dry_run: true, planned, unchanged, skipped_locked: skippedLocked, unmatched },
    }
  }
  return {
    ok: true,
    changed: moved.length > 0,
    data: { ok: true, moved, unchanged, skipped_locked: skippedLocked, unmatched },
  }
}

/** Overlaps and tight gaps between the frames and sticky notes of one page. */
function checkLayout(canvas: Canvas, input: CheckInput): Outcome {
  if (!canvasPages(canvas).some((p) => p.id === input.page_id))
    return { ok: false, error: noPageError(canvas, input.page_id) }
  const minGap = input.min_gap ?? DEFAULT_MIN_GAP
  const items: LayoutItem[] = []
  const names = new Map<string, { id: string; kind: 'frame' | 'note'; name: string }>()
  for (const frame of canvas.frames) {
    if (frame.demo || frame.hidden || framePageId(canvas, frame) !== input.page_id) continue
    items.push({ id: frame.id, kind: 'frame', x: frame.x, y: frame.y, width: frame.width, height: frame.height })
    names.set(frame.id, { id: frame.id, kind: 'frame', name: frame.name })
  }
  /* a note's x and y are canvas coordinates, attached or free: an attached note moves with its frame by the same delta */
  for (const note of store.getNotes(canvas.id)) {
    if (notePageId(canvas, note) !== input.page_id) continue
    items.push({
      id: note.id,
      kind: 'note',
      ...(note.frameId ? { attachedTo: note.frameId } : {}),
      x: note.x,
      y: note.y,
      width: note.width,
      height: note.height,
    })
    names.set(note.id, { id: note.id, kind: 'note', name: noteExcerpt(note.markdown, 40) })
  }
  const found = layoutIssues(items, minGap)
  const describe = (id: string) => names.get(id) ?? { id, kind: 'frame' as const, name: '' }
  if (!found.length) {
    return {
      ok: true,
      changed: false,
      data: `Checked ${items.length} items on ${pageLabel(canvas, input.page_id)}: no overlaps and nothing closer than ${minGap} px.`,
    }
  }
  const shown = found.slice(0, MAX_REPORTED_ISSUES)
  return {
    ok: true,
    changed: false,
    data: {
      checked: items.length,
      issues: shown.map((i) => ({ kind: i.kind, gap: Math.round(i.gap), a: describe(i.a), b: describe(i.b) })),
      ...(found.length > shown.length ? { more_issues: found.length - shown.length } : {}),
    },
  }
}

const ARRANGE_DESCRIPTION =
  'Lay frames out in tidy rows on one page, in a single call, instead of moving them one by one with update_frame. By default desktops (900 px and wider) go in the first row and everything narrower in the second, left to right by their current x, 300 px apart, from the top-left of the frames being arranged. Pass frame_ids (all on one page) or page_id (every frame of the page except demo content), and rows to group differently: each row has min_width, max_width, name (a substring) and order (x, name, given); a frame joins the first row it matches and frames no row matches stay put and are listed in unmatched. Locked frames never move (skipped_locked); a rotated frame is arranged by its unrotated box; sticky notes attached to a moved frame go with it; frames already in place are not written. Pass dry_run: true to get the planned moves (frame_id, from, to) without writing anything.'

const CHECK_DESCRIPTION =
  'Read-only layout check for one page: lists pairs of frames and sticky notes that overlap, or that face each other closer than min_gap (default 40 px), so you can fix them before handing the page back. A note and the frame it is attached to are never reported; hidden and demo frames are left out. Fix with arrange_frames or update_frame.'

/** The tool result the SDK's callback type takes: the context's text blocks already have its shape. */
const reply = (result: AgentToolResult): CallToolResult => result as unknown as CallToolResult

/** `arrange_frames` and `check_layout`: frames in rows, and overlaps or tight gaps between frames and notes. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  const { text, err, withFeedback, withFeedbackNotice, canvasFor, noCanvas, actorFrom, arrive } = ctx

  server.registerTool(
    'arrange_frames',
    {
      title: 'Arrange frames in rows',
      description: ARRANGE_DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), ...arrangeShape, agent_name: ctx.agentName },
    },
    ({ canvas_id, agent_name, ...input }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return reply(noCanvas(canvas_id, 'edit'))
      const actor = actorFrom(agent_name)
      const outcome = arrangeFrames(canvas, input, actor)
      if (!outcome.ok) return reply(err(outcome.error))
      return reply(withFeedback(text(outcome.data), canvas_id, actor))
    },
  )

  server.registerTool(
    'check_layout',
    {
      title: 'Check a page for overlaps and tight gaps',
      description: CHECK_DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), ...checkShape, agent_name: ctx.agentName.optional() },
    },
    ({ canvas_id, agent_name, ...input }) => {
      const canvas = canvasFor(canvas_id, 'view')
      if (!canvas) return reply(noCanvas(canvas_id, 'view'))
      arrive(canvas_id, agent_name)
      const outcome = checkLayout(canvas, input)
      if (!outcome.ok) return reply(err(outcome.error))
      return reply(withFeedbackNotice(text(outcome.data), canvas_id, agent_name ? actorFrom(agent_name) : undefined))
    },
  )
}

const rowSchema = {
  type: 'object',
  properties: {
    min_width: { type: 'number' },
    max_width: { type: 'number' },
    name: { type: 'string', description: 'Case-insensitive text the frame name must contain' },
    order: { type: 'string', enum: ['x', 'name', 'given'] },
  },
} as const

const arrangeDefinition: Anthropic.Tool = {
  name: 'arrange_frames',
  description: ARRANGE_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      frame_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
      page_id: { type: 'string' },
      rows: { type: 'array', items: rowSchema, minItems: 1, maxItems: 10 },
      gap: { type: 'number', minimum: 0, maximum: 5000 },
      origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      dry_run: { type: 'boolean', description: 'Plan only: list the planned moves and write nothing' },
    },
  },
}

const checkDefinition: Anthropic.Tool = {
  name: 'check_layout',
  description: CHECK_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      page_id: { type: 'string' },
      min_gap: { type: 'number', minimum: 0, maximum: 2000 },
    },
    required: ['page_id'],
  },
}

const asContent = (data: Record<string, unknown> | string) => (typeof data === 'string' ? data : JSON.stringify(data))

/** The same tools for the resident agent. */
export const residentTools: ResidentAgentTool[] = [
  {
    definition: arrangeDefinition,
    run(input, { canvasId, actor, runState }) {
      const parsed = arrangeInput.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }
      const canvas = store.getCanvas(canvasId)
      if (!canvas) return { ok: false, error: 'canvas not found' }
      const outcome = arrangeFrames(canvas, parsed.data, actor)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      /* a run whose only work was arranging counts as delivered */
      if (outcome.changed) runState.arrangeWrites += 1
      return { ok: true, content: asContent(outcome.data) }
    },
  },
  {
    definition: checkDefinition,
    run(input, { canvasId }) {
      const parsed = checkInput.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }
      const canvas = store.getCanvas(canvasId)
      if (!canvas) return { ok: false, error: 'canvas not found' }
      const outcome = checkLayout(canvas, parsed.data)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      return { ok: true, content: asContent(outcome.data) }
    },
  },
]
