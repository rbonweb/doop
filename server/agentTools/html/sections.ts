import type Anthropic from '@anthropic-ai/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Frame } from '../../../shared/types.ts'
import * as actions from '../../actions.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import { frameVersion, versionConflict } from '../../frameVersion.ts'
import { store } from '../../store.ts'
import { applyEdits, checkFragment, editsForOp, type Edit, type OpBody } from '../../sectionEdits.ts'
import {
  describeTarget,
  instanceRefusal,
  parseFrameDocument,
  resolveTarget,
  sectionTargetSchema,
  type FrameDocument,
  type ResolvedTarget,
  type SectionTarget,
} from '../../sectionTargets.ts'
import { assertExpectedVersion, expectedVersionSchema, withClaimWarning, type AgentToolContext } from '../context.ts'
import type { ResidentAgentTool, ResidentToolContext, ResidentToolOutcome } from '../resident.ts'

/** Section reads and edits: get one section by target, replace it whole, or patch many targets in one write. */

const targetField = sectionTargetSchema
const allField = z
  .boolean()
  .optional()
  .describe('With a selector target: apply the op to every match instead of refusing an ambiguous one.')

const setTextOp = z.object({ op: z.literal('set_text'), target: targetField, all: allField, text: z.string() }).strict()
const setAttrOp = z
  .object({
    op: z.literal('set_attr'),
    target: targetField,
    all: allField,
    name: z.string(),
    value: z.string(),
  })
  .strict()
const removeAttrOp = z
  .object({ op: z.literal('remove_attr'), target: targetField, all: allField, name: z.string() })
  .strict()
const setStyleOp = z
  .object({
    op: z.literal('set_style'),
    target: targetField,
    all: allField,
    style: z.record(z.string(), z.string().nullable()),
  })
  .strict()
const insertBeforeOp = z
  .object({ op: z.literal('insert_before'), target: targetField, all: allField, html: z.string() })
  .strict()
const insertAfterOp = z
  .object({ op: z.literal('insert_after'), target: targetField, all: allField, html: z.string() })
  .strict()
const removeOp = z.object({ op: z.literal('remove'), target: targetField, all: allField }).strict()

const patchOpSchema = z.discriminatedUnion('op', [
  setTextOp,
  setAttrOp,
  removeAttrOp,
  setStyleOp,
  insertBeforeOp,
  insertAfterOp,
  removeOp,
])

type PatchOp = z.infer<typeof patchOpSchema>

const patchOpsSchema = z
  .array(patchOpSchema)
  .min(1)
  .max(100)
  .describe('1 to 100 edits applied together in one write, in the order given.')

const getSectionShape = {
  frame_id: z.string(),
  target: targetField,
}

const replaceSectionShape = {
  frame_id: z.string(),
  target: targetField,
  html: z.string().describe('The complete replacement markup for the target element.'),
  expected_version: expectedVersionSchema,
}

const patchFrameShape = {
  frame_id: z.string(),
  ops: patchOpsSchema,
  expected_version: expectedVersionSchema,
}

const getSectionInput = z.object(getSectionShape)
const replaceSectionInput = z.object(replaceSectionShape)
const patchFrameInput = z.object(patchFrameShape)

const CONTENT_OPS = new Set<string>(['set_text', 'set_attr', 'remove_attr', 'set_style'])

function bodyFor(op: PatchOp): OpBody {
  switch (op.op) {
    case 'set_text':
      return { op: 'set_text', text: op.text }
    case 'set_attr':
      return { op: 'set_attr', name: op.name, value: op.value }
    case 'remove_attr':
      return { op: 'remove_attr', name: op.name }
    case 'set_style':
      return { op: 'set_style', style: op.style }
    case 'insert_before':
      return { op: 'insert_before', html: op.html }
    case 'insert_after':
      return { op: 'insert_after', html: op.html }
    case 'remove':
      return { op: 'remove' }
  }
}

/** The resolver's refusal, with its candidates when it listed any. */
function targetFailure(error: string, candidates?: unknown[]): string {
  return candidates?.length ? `${error}\nCandidates: ${JSON.stringify(candidates)}` : error
}

function writeRefusal(match: ResolvedTarget, write: 'content' | 'structure'): string | undefined {
  const refused = instanceRefusal(match, write)
  if (refused) return refused
  const insideUse = match.path.split(' > ').slice(0, -1).includes('doop-use')
  if (insideUse) {
    return 'The target is inside a component instance; change the component with update_component (or the instance’s props) instead.'
  }
  if (match.tagName === 'doop-use' && write === 'content') {
    return 'set_text/set_attr/set_style on an instance root are reverted by the component; use update_component, or replace/remove the whole instance.'
  }
  return undefined
}

function collectPatchEdits(
  compact: string,
  fd: FrameDocument,
  ops: PatchOp[],
): { ok: true; edits: Edit[] } | { ok: false; error: string } {
  const edits: Edit[] = []
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!
    const resolved = resolveTarget(fd, op.target, { all: op.all === true })
    if (!resolved.ok) {
      return { ok: false, error: `op ${index} (${op.op}): ${targetFailure(resolved.error, resolved.candidates)}` }
    }
    const write = CONTENT_OPS.has(op.op) ? 'content' : 'structure'
    const body = bodyFor(op)
    for (const match of resolved.matches) {
      const refused = writeRefusal(match, write)
      if (refused) return { ok: false, error: `op ${index} (${op.op}): ${refused}` }
      const result = editsForOp(compact, match, body)
      if (!result.ok) return { ok: false, error: `op ${index} (${op.op}): ${result.error}` }
      edits.push(...result.edits)
    }
  }
  return { ok: true, edits }
}

function sectionAnswer(frame: Frame, match: ResolvedTarget, target: SectionTarget, compact: string) {
  return {
    frameId: frame.id,
    version: frameVersion(frame),
    target: describeTarget(target),
    elementId: match.elementId,
    tag: match.tagName,
    label: match.label,
    path: match.path,
    bytes: match.end - match.start,
    html: compact.slice(match.start, match.end),
  }
}

function writeAnswer(
  ctx: AgentToolContext,
  frame: Frame,
  data: Record<string, unknown>,
  actor: ReturnType<AgentToolContext['actorFrom']>,
) {
  const result = ctx.withStatusNudge(
    ctx.withFeedback(ctx.textWithNudge(data, ctx.reviewNudge), frame.canvasId, actor),
    frame.canvasId,
    actor,
  )
  return withClaimWarning(ctx.withPreview(result, frame.canvasId, [frame]), [frame.id], actor)
}

export function registerSectionTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'get_section',
    {
      title: 'Get one frame section',
      description:
        "Read one part of a frame instead of the whole document: resolve a section by element id (data-doop-id), label (data-doop-label or its heading text) or CSS selector, and get its exact source, size and path. Use this after get_frame's outline when a targeted edit only needs one section; use get_frame when you need the whole document. Example: { frame_id: 'f1', target: { label: 'Pricing' } }.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { ...getSectionShape, agent_name: ctx.agentName.optional() },
    },
    async ({ frame_id, target, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'view')
      if (!frame) return ctx.noFrame(frame_id)
      ctx.arrive(frame.canvasId, agent_name)
      const compact = compactFrameHtml(frame)
      const resolved = resolveTarget(compact, target)
      if (!resolved.ok) return ctx.err(targetFailure(resolved.error, resolved.candidates))
      const match = resolved.matches[0]!
      const result = ctx.text(sectionAnswer(frame, match, target, compact))
      return ctx.withFeedbackNotice(result, frame.canvasId, agent_name ? ctx.actorFrom(agent_name) : undefined)
    },
  )

  server.registerTool(
    'replace_section',
    {
      title: 'Replace one frame section',
      description:
        'Replace one element and everything inside it with new markup, without resending or re-reading the whole frame. Resolve the section by element id, label or selector (get_frame with mode: "outline" first), then pass its complete replacement markup; the fragment is parsed before anything is written. For small text or attribute changes inside one element use patch_frame, and for many scattered exact-string changes use edit_frame_html. Example: { frame_id: "f1", target: { element_id: "hero" }, html: "<section data-doop-id=\\"hero\\">…</section>" }.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        ...replaceSectionShape,
        agent_name: ctx.agentName,
      },
    },
    async ({ frame_id, target, html, expected_version, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'edit')
      if (!frame) return ctx.noFrame(frame_id, 'edit')
      const compact = compactFrameHtml(frame)
      const resolved = resolveTarget(compact, target)
      if (!resolved.ok) return ctx.err(targetFailure(resolved.error, resolved.candidates))
      const match = resolved.matches[0]!
      const refused = writeRefusal(match, 'structure')
      if (refused) return ctx.err(refused)
      const check = checkFragment(html)
      if (!check.ok) return ctx.err(check.error)
      const edits = editsForOp(compact, match, { op: 'replace', html })
      if (!edits.ok) return ctx.err(edits.error)
      const applied = applyEdits(compact, edits.edits)
      if (!applied.ok) return ctx.err(applied.error)
      const stale = assertExpectedVersion(frame, expected_version)
      if (stale) return stale
      const actor = ctx.actorFrom(agent_name)
      const written = actions.updateFrame(frame_id, { html: applied.html }, actor, { replace: true })
      if (!written) return ctx.noFrame(frame_id, 'edit')
      return writeAnswer(
        ctx,
        written,
        {
          ok: true,
          frame: ctx.frameSummary(written),
          replaced: { path: match.path, bytesBefore: match.end - match.start, bytesAfter: html.length },
        },
        actor,
      )
    },
  )

  server.registerTool(
    'patch_frame',
    {
      title: 'Patch several frame targets in one write',
      description:
        'Make several small edits across a frame in one atomic write: set an element\'s text, attributes or styles, insert or remove elements, each resolved by element id, label or selector. All targets are resolved against one parse first; any bad target, protected attribute or invalid fragment refuses the whole patch and nothing is written. Use this over edit_frame_html when you know the elements rather than the exact strings, and over set_frame_html when the change is local. Example: { frame_id: "f1", ops: [{ op: "set_text", target: { selector: "#cta" }, text: "Start free" }, { op: "set_attr", target: { label: "Pricing" }, name: "data-state", value: "open" }] }.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        ...patchFrameShape,
        agent_name: ctx.agentName,
      },
    },
    async ({ frame_id, ops, expected_version, agent_name }) => {
      const frame = ctx.frameFor(frame_id, 'edit')
      if (!frame) return ctx.noFrame(frame_id, 'edit')
      const compact = compactFrameHtml(frame)
      const fd = parseFrameDocument(compact)
      const collected = collectPatchEdits(compact, fd, ops)
      if (!collected.ok) return ctx.err(collected.error)
      if (collected.edits.length === 0) return ctx.text({ ok: true, unchanged: true })
      const applied = applyEdits(compact, collected.edits)
      if (!applied.ok) return ctx.err(applied.error)
      const stale = assertExpectedVersion(frame, expected_version)
      if (stale) return stale
      const actor = ctx.actorFrom(agent_name)
      const written = actions.updateFrame(frame_id, { html: applied.html }, actor, { replace: true })
      if (!written) return ctx.noFrame(frame_id, 'edit')
      return writeAnswer(
        ctx,
        written,
        { ok: true, frame: ctx.frameSummary(written), applied: ops.length, edits: collected.edits.length },
        actor,
      )
    },
  )
}

function residentFrame(ctx: ResidentToolContext, frameId: string): Frame | undefined {
  const frame = store.getFrame(frameId)
  return frame && frame.canvasId === ctx.canvasId ? frame : undefined
}

function residentWrite(ctx: ResidentToolContext, frame: Frame, html: string): ResidentToolOutcome {
  const written = actions.updateFrame(frame.id, { html }, ctx.actor, { replace: true }) ?? frame
  ctx.runState.mutatedFrames.add(written.id)
  ctx.runState.verifiedFrames.delete(written.id)
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      frame: { id: written.id, name: written.name, version: frameVersion(written) },
    }),
  }
}

const residentTargetSchema = {
  type: 'object',
  description: 'Exactly one of element_id, label or selector.',
  properties: {
    element_id: { type: 'string', description: 'The element’s data-doop-id.' },
    label: { type: 'string', description: 'The element’s data-doop-label or heading text.' },
    selector: { type: 'string', description: 'A CSS selector.' },
  },
}

export const sectionResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'get_section',
      description:
        "Read one part of a frame instead of the whole document: resolve a section by element id, label or CSS selector and get its exact source, size and path. Example: { frame_id: 'f1', target: { label: 'Pricing' } }.",
      input_schema: {
        type: 'object',
        properties: {
          frame_id: { type: 'string' },
          target: residentTargetSchema,
        },
        required: ['frame_id', 'target'],
      },
    },
    run(input, ctx) {
      const parsed = getSectionInput.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.message }
      const frame = residentFrame(ctx, parsed.data.frame_id)
      if (!frame) return { ok: false, error: 'frame not found on this canvas' }
      const compact = compactFrameHtml(frame)
      const resolved = resolveTarget(compact, parsed.data.target)
      if (!resolved.ok) return { ok: false, error: targetFailure(resolved.error, resolved.candidates) }
      const match = resolved.matches[0]!
      return { ok: true, content: JSON.stringify(sectionAnswer(frame, match, parsed.data.target, compact)) }
    },
  },
  {
    definition: {
      name: 'replace_section',
      description:
        'Replace one element and everything inside it with new markup, without resending the whole frame. Resolve it by element id, label or selector; the replacement must parse. Example: { frame_id: "f1", target: { element_id: "hero" }, html: "<section data-doop-id=\\"hero\\">…</section>" }.',
      input_schema: {
        type: 'object',
        properties: {
          frame_id: { type: 'string' },
          target: residentTargetSchema,
          html: { type: 'string', description: 'The complete replacement markup for the target element.' },
        },
        required: ['frame_id', 'target', 'html'],
      },
    },
    run(input, ctx) {
      const parsed = replaceSectionInput.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.message }
      const { frame_id, target, html } = parsed.data
      const frame = residentFrame(ctx, frame_id)
      if (!frame) return { ok: false, error: 'frame not found on this canvas' }
      const conflict = versionConflict(frame, parsed.data.expected_version)
      if (conflict) return { ok: false, error: conflict }
      const compact = compactFrameHtml(frame)
      const resolved = resolveTarget(compact, target)
      if (!resolved.ok) return { ok: false, error: targetFailure(resolved.error, resolved.candidates) }
      const match = resolved.matches[0]!
      const refused = writeRefusal(match, 'structure')
      if (refused) return { ok: false, error: refused }
      const edited = editsForOp(compact, match, { op: 'replace', html })
      if (!edited.ok) return { ok: false, error: edited.error }
      const applied = applyEdits(compact, edited.edits)
      if (!applied.ok) return { ok: false, error: applied.error }
      return residentWrite(ctx, frame, applied.html)
    },
  },
  {
    definition: {
      name: 'patch_frame',
      description:
        'Make several small edits across a frame in one atomic write: set text, attributes or styles, insert or remove elements, each resolved by element id, label or selector. Any bad target refuses the whole patch. Example: { frame_id: "f1", ops: [{ op: "set_text", target: { selector: "#cta" }, text: "Start free" }] }.',
      input_schema: zodToJsonSchema(
        z.object({
          frame_id: z.string(),
          ops: patchOpsSchema,
        }),
      ) as Anthropic.Tool['input_schema'],
    },
    run(input, ctx) {
      const parsed = patchFrameInput.safeParse(input)
      if (!parsed.success) return { ok: false, error: parsed.error.message }
      const frame = residentFrame(ctx, parsed.data.frame_id)
      if (!frame) return { ok: false, error: 'frame not found on this canvas' }
      const conflict = versionConflict(frame, parsed.data.expected_version)
      if (conflict) return { ok: false, error: conflict }
      const compact = compactFrameHtml(frame)
      const collected = collectPatchEdits(compact, parseFrameDocument(compact), parsed.data.ops)
      if (!collected.ok) return { ok: false, error: collected.error }
      if (collected.edits.length === 0) return { ok: true, content: JSON.stringify({ ok: true, unchanged: true }) }
      const applied = applyEdits(compact, collected.edits)
      if (!applied.ok) return { ok: false, error: applied.error }
      return residentWrite(ctx, frame, applied.html)
    },
  },
]
