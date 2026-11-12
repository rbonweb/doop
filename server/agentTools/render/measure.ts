import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Frame } from '../../../shared/types.ts'
import { env } from '../../env.ts'
import { lintMeasurement } from '../../lint.ts'
import { InvalidSelectorError, measureFrame } from '../../measure.ts'
import type { FrameMeasurement, LintResult, LintRules } from '../../measureTypes.ts'
import { frameTargetSchema } from '../../renderTargets.ts'
import type { FrameTarget } from '../../renderTypes.ts'
import { store } from '../../store.ts'
import { limitKey, type AgentToolContext, type AgentToolResult } from '../context.ts'
import type { ResidentAgentTool, ResidentToolContext, ResidentToolOutcome } from '../resident.ts'

/** The answer of a measurement that had to be cut down to fit the context. */
type MeasureAnswer = FrameMeasurement | (Omit<FrameMeasurement, 'text'> & { truncated: true })

const MAX_MEASURE_CHARS = 60_000

/** measure_frame's payload: the whole measurement while it fits, else no full text and the 15 longest-line blocks per section. */
function measured(measurement: FrameMeasurement): MeasureAnswer {
  if (JSON.stringify(measurement).length <= MAX_MEASURE_CHARS) return measurement
  return {
    width: measurement.width,
    height: measurement.height,
    sections: measurement.sections.map((section) => ({
      ...section,
      texts: [...section.texts].sort((a, b) => b.lines - a.lines).slice(0, 15),
    })),
    colors: measurement.colors,
    queries: measurement.queries,
    truncated: true,
  }
}

const lintRulesSchema = z
  .object({
    max_section_height: z.number().int().positive().optional(),
    max_heading_lines: z.number().int().positive().optional(),
    max_text_lines: z
      .array(z.object({ selector: z.string().min(1).max(500), max: z.number().int().positive() }).strict())
      .max(20)
      .optional(),
    allowed_colors: z.array(z.string()).max(64).optional(),
    banned_words: z.array(z.string()).max(100).optional(),
    no_overflow: z.boolean().optional(),
    min_contrast: z.number().min(1).max(21).optional(),
  })
  .strict()
  .refine((rules) => Object.values(rules).some((value) => value !== undefined), {
    message: 'give at least one rule',
  })

const MEASURE_DESCRIPTION =
  'Measure the rendered frame at a width: each section’s box and height, every text block’s line count, overflow and clipping, the colours in use and each text’s WCAG contrast. Read-only; use it to check fit and readability without cutting screenshots up.'

const LINT_DESCRIPTION =
  'Check a rendered frame against rules — section height, heading and text line counts, palette, banned words, overflow, contrast — and list the element ids that offend. allowed_colors also accepts tints, shades and alpha versions of an allowed colour; exclude skips CSS-selector subtrees (screenshots, third-party widgets) for colour, contrast and banned-word rules.'

/* The context hands results back with a content type wider than the SDK's CallToolResult; the seam's built-in tools infer the narrow shape, an area file has to say so. */
function asToolResult(result: AgentToolResult): CallToolResult {
  return result as unknown as CallToolResult
}

const measureShape = (ctx: AgentToolContext) => ({
  frame_id: z.string(),
  width: z.number().int().min(1).max(4000).optional().describe('Viewport width in px; defaults to the frame’s width'),
  targets: z
    .array(frameTargetSchema)
    .max(50)
    .optional()
    .describe('The sections to measure; defaults to every top-level section'),
  agent_name: ctx.agentName.optional(),
})

const EXCLUDE_DESCRIPTION =
  'CSS selectors: matching elements and everything inside them are skipped by the colour, contrast and banned-word rules (for example a store screenshot mock-up). An invalid selector is refused by name'

/** The tool error for a measurement the page refused, or undefined when the failure is not the caller's. */
function selectorRefusal(error: unknown): string | undefined {
  return error instanceof InvalidSelectorError ? error.message : undefined
}

/** measure_frame and lint_frame (item 5). */
export function registerMeasureTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'measure_frame',
    {
      title: 'Measure a frame',
      description: MEASURE_DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: measureShape(ctx),
    },
    async ({ frame_id, width, targets, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'view')
      if (!frame) return asToolResult(ctx.noFrame(frame_id))
      if (!ctx.takeSlot('render', limitKey(ctx, agent_name ?? 'agent'), env.MCP_RENDERS_PER_MIN))
        return asToolResult(ctx.err('render rate limit — wait a minute'))
      ctx.arrive(frame.canvasId, agent_name)
      const measurement = await measureFrame(await store.renderSource(frame), { width, targets })
      return asToolResult(
        ctx.withFeedbackNotice(ctx.text(measured(measurement)), frame.canvasId, ctx.actorFrom(agent_name)),
      )
    },
  )

  server.registerTool(
    'lint_frame',
    {
      title: 'Lint a frame',
      description: LINT_DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        ...measureShape(ctx),
        rules: lintRulesSchema.describe(
          'At least one rule: section height, heading/text lines, palette, words, overflow, contrast',
        ),
        exclude: z.array(z.string().min(1).max(500)).max(50).optional().describe(EXCLUDE_DESCRIPTION),
      },
    },
    async ({ frame_id, rules, exclude, width, targets, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'view')
      if (!frame) return asToolResult(ctx.noFrame(frame_id))
      if (!ctx.takeSlot('render', limitKey(ctx, agent_name ?? 'agent'), env.MCP_RENDERS_PER_MIN))
        return asToolResult(ctx.err('render rate limit — wait a minute'))
      ctx.arrive(frame.canvasId, agent_name)
      let measurement: FrameMeasurement
      try {
        measurement = await measureFrame(await store.renderSource(frame), {
          width,
          targets,
          lineQueries: rules.max_text_lines?.map((rule) => rule.selector),
          exclude,
          colorSources: true,
        })
      } catch (error) {
        const refusal = selectorRefusal(error)
        if (refusal) return asToolResult(ctx.err(refusal))
        throw error
      }
      const report = lintMeasurement(measurement, rules)
      const passed = report.results.filter((result) => result.pass).length
      const answer = {
        pass: report.pass,
        summary: `${passed} of ${report.results.length} rules pass`,
        results: report.results,
      }
      return asToolResult(ctx.withFeedbackNotice(ctx.text(answer), frame.canvasId, ctx.actorFrom(agent_name)))
    },
  )
}

/* The resident twins share the MCP per-user budget: one rolling minute of hits per actor. */
const residentHits = new Map<string, number[]>()

function residentMayRender(key: string): boolean {
  const now = Date.now()
  const hits = (residentHits.get(key) ?? []).filter((at) => now - at < 60_000)
  if (hits.length >= env.MCP_RENDERS_PER_MIN) {
    residentHits.set(key, hits)
    return false
  }
  hits.push(now)
  residentHits.set(key, hits)
  return true
}

/** The frame a resident run may measure: its own canvas only. */
function residentFrame(input: Record<string, unknown>, ctx: ResidentToolContext): Frame | string {
  const id = String(input.frame_id ?? '')
  const frame = store.getFrame(id)
  if (!frame || frame.canvasId !== ctx.canvasId) return 'frame not found on this canvas'
  return frame
}

function residentWidth(input: Record<string, unknown>): number | undefined {
  const width = input.width
  return typeof width === 'number' && Number.isFinite(width)
    ? Math.min(4000, Math.max(1, Math.round(width)))
    : undefined
}

function residentExclude(input: Record<string, unknown>): string[] | undefined {
  return Array.isArray(input.exclude)
    ? input.exclude.filter((entry): entry is string => typeof entry === 'string')
    : undefined
}

function residentTargets(input: Record<string, unknown>): FrameTarget[] | undefined {
  return Array.isArray(input.targets) ? (input.targets as FrameTarget[]) : undefined
}

const ok = (value: unknown): ResidentToolOutcome => ({ ok: true, content: JSON.stringify(value) })

const fail = (error: string): ResidentToolOutcome => ({ ok: false, error })

const jsonSchema = (extra: Record<string, unknown>) => ({
  type: 'object' as const,
  properties: {
    frame_id: { type: 'string', description: 'The frame to measure' },
    width: { type: 'number', description: 'Viewport width in px; defaults to the frame’s width' },
    targets: {
      type: 'array',
      description: 'The sections to measure; defaults to every top-level section',
      items: { type: 'object', description: '{ element_id }, { label } or { selector }' },
    },
    ...extra,
  },
  required: ['frame_id'],
})

/** The same measure tools for the resident agent, scoped to the run’s canvas. */
export const measureResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'measure_frame',
      description: MEASURE_DESCRIPTION,
      input_schema: jsonSchema({}),
    },
    async run(input, ctx) {
      const frame = residentFrame(input, ctx)
      if (typeof frame === 'string') return fail(frame)
      if (!residentMayRender(ctx.actor.name)) return fail('render rate limit — wait a minute')
      const measurement = await measureFrame(await store.renderSource(frame), {
        width: residentWidth(input),
        targets: residentTargets(input),
      })
      return ok(measured(measurement))
    },
  },
  {
    definition: {
      name: 'lint_frame',
      description: LINT_DESCRIPTION,
      input_schema: jsonSchema({
        rules: {
          type: 'object',
          description: 'At least one rule: section height, heading/text lines, palette, words, overflow, contrast',
        },
        exclude: { type: 'array', items: { type: 'string' }, description: EXCLUDE_DESCRIPTION },
      }),
    },
    async run(input, ctx) {
      const frame = residentFrame(input, ctx)
      if (typeof frame === 'string') return fail(frame)
      const rules = input.rules
      if (typeof rules !== 'object' || rules === null || Object.values(rules).every((value) => value === undefined))
        return fail('give at least one rule')
      if (!residentMayRender(ctx.actor.name)) return fail('render rate limit — wait a minute')
      const lintRules = rules as LintRules
      let measurement: FrameMeasurement
      try {
        measurement = await measureFrame(await store.renderSource(frame), {
          width: residentWidth(input),
          targets: residentTargets(input),
          lineQueries: lintRules.max_text_lines?.map((rule) => rule.selector),
          exclude: residentExclude(input),
          colorSources: true,
        })
      } catch (error) {
        const refusal = selectorRefusal(error)
        if (refusal) return fail(refusal)
        throw error
      }
      const report = lintMeasurement(measurement, lintRules)
      const passed = report.results.filter((result: LintResult) => result.pass).length
      return ok({
        pass: report.pass,
        summary: `${passed} of ${report.results.length} rules pass`,
        results: report.results,
      })
    },
  },
]
