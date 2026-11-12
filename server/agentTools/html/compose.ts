import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Frame } from '../../../shared/types.ts'
import { canvasPages } from '../../../shared/pages.ts'
import * as actions from '../../actions.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import { composeDocument, type ComposeResult, type ComposeSource } from '../../compose.ts'
import { noPageMessage } from '../../pageTools.ts'
import { resolveTarget, sectionTargetSchema, type SectionTarget } from '../../sectionTargets.ts'
import { store } from '../../store.ts'
import type { AgentToolContext, AgentToolResult } from '../context.ts'
import { withClaimWarning } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/**
 * `compose_frame`: a new page built from labelled sections of frames already on the canvas. Each section keeps
 * its CSS scoped to a `data-doop-section` attribute; rules that depend on the source page's structure are
 * listed under `dropped` instead of being guessed.
 */

const COMPOSE_NUDGE =
  'You have not seen this composed page yet. Call get_frame_screenshot on the new frame, check the sections in order and their spacing, then call update_frame with the full height so nothing is cut off.'

const COMPOSE_DESCRIPTION =
  'Build a final page from labelled sections of other frames on this canvas, in order. Each section keeps its CSS scoped to itself, so two sources may both style `.title` without colliding; rules that depend on the source page\'s structure (siblings, nth-child, body/html context) are listed under `dropped`, never guessed. Every source frame must be on this canvas because components belong to the canvas. Example: compose_frame({ canvas_id: "…", name: "Landing page", width: 1280, sections: [{ frame_id: "…", target: { label: "Hero" } }, { frame_id: "…", target: { element_id: "features" } }], agent_name: "Claude" }).'

interface ComposeRequest {
  canvasId: string
  name: string
  width: number
  height: number
  x?: number
  y?: number
  sections: { frame_id: string; target: SectionTarget }[]
}

type Composed = { ok: true; result: ComposeResult } | { ok: false; error: string }

/** Resolve every section and compose the document. Pure reads: the caller creates the frame. */
function composeSections(request: ComposeRequest, frameOf: (id: string) => Frame | undefined): Composed {
  const sources: ComposeSource[] = []
  for (const [index, section] of request.sections.entries()) {
    const frame = frameOf(section.frame_id)
    if (!frame)
      return {
        ok: false,
        error: `section ${index}: no frame with id "${section.frame_id}" on this canvas (components belong to the canvas, so a section must come from it).`,
      }
    if (frame.canvasId !== request.canvasId)
      return {
        ok: false,
        error: `section ${index}: frame "${section.frame_id}" is on another canvas; components belong to the canvas, so a cross-canvas section could not resolve its <doop-use>.`,
      }
    const html = compactFrameHtml(frame)
    const resolved = resolveTarget(html, section.target)
    if (!resolved.ok) {
      const candidates = resolved.candidates?.length ? ` Candidates: ${JSON.stringify(resolved.candidates)}` : ''
      return { ok: false, error: `section ${index} (frame "${section.frame_id}"): ${resolved.error}${candidates}` }
    }
    const match = resolved.matches[0]!
    sources.push({ frameId: frame.id, frameName: frame.name, html, start: match.start, end: match.end })
  }
  try {
    return { ok: true, result: composeDocument(sources, { title: request.name }) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `the sections could not be composed (${reason}); nothing was written` }
  }
}

/** The ctx helpers type their content blocks loosely; the SDK wants its own CallToolResult shape. */
const reply = (result: AgentToolResult): CallToolResult => result as unknown as CallToolResult

function answer(result: ComposeResult, frame: Frame, frameSummary: (frame: Frame) => Record<string, unknown>) {
  return {
    ok: true,
    frame: frameSummary(frame),
    sections: result.sections,
    headTags: result.headTags.length,
    ...(result.documentRulesFrom ? { documentRulesFrom: result.documentRulesFrom } : {}),
  }
}

export function registerComposeTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'compose_frame',
    {
      title: 'Compose a frame from sections',
      description: COMPOSE_DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().trim().min(1).describe('Frame title for the composed page'),
        page_id: z.string().optional().describe('Target page ID from get_canvas; defaults to the first page'),
        width: z.number().min(1).max(10000).describe('Frame width in px (1..10000)'),
        height: z.number().min(1).max(10000).default(1200).describe('Frame height in px; default 1200'),
        x: z.number().optional(),
        y: z.number().optional(),
        sections: z
          .array(z.object({ frame_id: z.string(), target: sectionTargetSchema }))
          .min(1)
          .max(30)
          .describe('Sections in order: a source frame on this canvas and the target inside it'),
        agent_name: ctx.agentName,
      },
    },
    async ({ canvas_id, name, page_id, width, height, x, y, sections, agent_name }) => {
      const canvas = ctx.canvasFor(canvas_id, 'edit')
      if (!canvas) return reply(ctx.noCanvas(canvas_id, 'edit'))
      if (page_id && !canvasPages(canvas).some((page) => page.id === page_id))
        return reply(ctx.err(noPageMessage(canvas, page_id)))
      const composed = composeSections({ canvasId: canvas_id, name, width, height, x, y, sections }, (id) =>
        ctx.frameFor(id, 'view'),
      )
      if (!composed.ok) return reply(ctx.err(composed.error))
      const actor = ctx.actorFrom(agent_name)
      const frame = actions.createFrame(
        canvas_id,
        { name, pageId: page_id, x, y, width, height, html: composed.result.html },
        actor,
      )
      if (!frame) return reply(ctx.noCanvas(canvas_id, 'edit'))
      const result = ctx.textWithNudge(answer(composed.result, frame, ctx.frameSummary), COMPOSE_NUDGE)
      return reply(
        withClaimWarning(
          ctx.withGuidelinesNudge(
            ctx.withStatusNudge(ctx.withFeedback(result, canvas_id, actor), canvas_id, actor),
            canvas_id,
            actor,
          ),
          [frame.id],
          actor,
        ),
      )
    },
  )
}

export const composeResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'compose_frame',
      description: COMPOSE_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Frame title for the composed page' },
          page_id: { type: 'string', description: 'Target page id; defaults to the first page' },
          width: { type: 'number', description: 'Frame width in px (1..10000)' },
          height: { type: 'number', description: 'Frame height in px; default 1200' },
          x: { type: 'number' },
          y: { type: 'number' },
          sections: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            description: 'Sections in order: a source frame on this canvas and the target inside it',
            items: {
              type: 'object',
              properties: {
                frame_id: { type: 'string' },
                target: {
                  type: 'object',
                  description:
                    'Exactly one of element_id (its data-doop-id), label (its data-doop-label or heading text) or selector (a CSS selector)',
                  properties: {
                    element_id: { type: 'string' },
                    label: { type: 'string' },
                    selector: { type: 'string' },
                  },
                },
              },
              required: ['frame_id', 'target'],
            },
          },
        },
        required: ['name', 'width', 'sections'],
      },
    },
    run(input, ctx) {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (!name) return { ok: false, error: 'name must be a non-empty frame title' }
      const width = input.width
      if (typeof width !== 'number' || width < 1 || width > 10000)
        return { ok: false, error: 'width must be a number between 1 and 10000' }
      const height = input.height === undefined ? 1200 : input.height
      if (typeof height !== 'number' || height < 1 || height > 10000)
        return { ok: false, error: 'height must be a number between 1 and 10000' }
      const rawSections = input.sections
      if (!Array.isArray(rawSections) || rawSections.length < 1 || rawSections.length > 30)
        return { ok: false, error: 'sections must be a list of 1 to 30 { frame_id, target } entries' }
      const sections: { frame_id: string; target: SectionTarget }[] = []
      for (const raw of rawSections) {
        const entry = raw as { frame_id?: unknown; target?: unknown } | null
        if (!entry || typeof entry !== 'object')
          return { ok: false, error: 'each section must be a { frame_id, target } object' }
        if (typeof entry.frame_id !== 'string' || !entry.frame_id)
          return { ok: false, error: 'each section needs a frame_id' }
        if (!entry.target || typeof entry.target !== 'object')
          return { ok: false, error: 'each section needs a target object' }
        sections.push({ frame_id: entry.frame_id, target: entry.target as SectionTarget })
      }
      const canvas = store.getCanvas(ctx.canvasId)
      if (!canvas) return { ok: false, error: 'canvas not found' }
      const pageId = typeof input.page_id === 'string' && input.page_id ? input.page_id : undefined
      if (pageId && !canvasPages(canvas).some((page) => page.id === pageId))
        return { ok: false, error: noPageMessage(canvas, pageId) }
      const composed = composeSections(
        {
          canvasId: ctx.canvasId,
          name,
          width,
          height,
          x: typeof input.x === 'number' ? input.x : undefined,
          y: typeof input.y === 'number' ? input.y : undefined,
          sections,
        },
        (id) => store.getFrame(id),
      )
      if (!composed.ok) return { ok: false, error: composed.error }
      const frame = actions.createFrame(
        ctx.canvasId,
        {
          name,
          pageId,
          x: typeof input.x === 'number' ? input.x : undefined,
          y: typeof input.y === 'number' ? input.y : undefined,
          width,
          height,
          html: composed.result.html,
        },
        ctx.actor,
      )
      if (!frame) return { ok: false, error: 'could not create the composed frame' }
      ctx.runState.mutatedFrames.add(frame.id)
      ctx.runState.verifiedFrames.delete(frame.id)
      return {
        ok: true,
        content: `${JSON.stringify(
          {
            ok: true,
            frame: {
              id: frame.id,
              name: frame.name,
              pageId: frame.pageId,
              width: frame.width,
              height: frame.height,
              htmlBytes: frame.html.length,
            },
            sections: composed.result.sections,
            headTags: composed.result.headTags.length,
            ...(composed.result.documentRulesFrom ? { documentRulesFrom: composed.result.documentRulesFrom } : {}),
          },
          null,
          2,
        )}\n${COMPOSE_NUDGE}`,
      }
    },
  },
]
