import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Actor, Canvas, Frame } from '../../../shared/types.ts'
import { canvasPages, framePageId } from '../../../shared/pages.ts'
import * as actions from '../../actions.ts'
import { compactFrameHtml } from '../../componentActions.ts'
import {
  compileQuery,
  findInHtml,
  findInText,
  imageSources,
  replaceInHtml,
  regexBudget,
  RegexTimeoutError,
  replaceInText,
  snippetAround,
  type Hit,
} from '../../frameSearch.ts'
import { dropClaims } from '../../frameClaims.ts'
import { versionConflict, type ExpectedVersion } from '../../frameVersion.ts'
import { noPageMessage } from '../../pageTools.ts'
import { store } from '../../store.ts'
import { withClaimWarning, type AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/** frame id -> the `updatedAt` the caller last read; a batch write refuses the whole call when any has moved on. */
type ExpectedVersions = Record<string, ExpectedVersion>

const expectedVersionsSchema = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .optional()
  .describe(
    'Frame id -> the updatedAt from your last read of that frame. If any listed frame changed since, the whole call is refused and nothing is written.',
  )

/** One refusal naming every listed frame whose version moved on, or undefined when all match (or none were given). */
function versionConflicts(canvas: Canvas, expected: ExpectedVersions | undefined): string | undefined {
  if (!expected) return undefined
  const conflicts: string[] = []
  for (const [frameId, version] of Object.entries(expected)) {
    const frame = canvas.frames.find((candidate) => candidate.id === frameId)
    const conflict = frame ? versionConflict(frame, version) : undefined
    if (conflict) conflicts.push(conflict)
  }
  return conflicts.length > 0
    ? `${conflicts.length} frame(s) changed since your read; nothing was written.\n${conflicts.join('\n')}`
    : undefined
}

/** The values of an untrusted `expected_versions` object that are strings or numbers. */
function parseExpectedVersions(raw: unknown): ExpectedVersions | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: ExpectedVersions = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}

/** One criterion of `find_frames`; every given criterion must match the same frame. */
interface FindInput {
  page_id?: string
  name?: string
  text?: string
  html?: string
  image_src?: string
  limit?: number
}

interface FindMatch {
  field: 'name' | 'text' | 'html' | 'image_src'
  snippet: string
}

interface FindFrame {
  frameId: string
  name: string
  pageId: string
  locked?: boolean
  matches: FindMatch[]
}

const MAX_FRAMES = 200
const MAX_MATCHES = 3

/** The frames `find_frames` may see: the canvas's own work, in canvas order, on the requested page. */
function searchableFrames(canvas: Canvas, pageId?: string): Frame[] {
  return canvas.frames.filter((frame) => !frame.demo && (!pageId || framePageId(canvas, frame) === pageId))
}

function nameHit(name: string, needle: string): FindMatch | undefined {
  const at = name.toLowerCase().indexOf(needle)
  return at === -1 ? undefined : { field: 'name', snippet: snippetAround(name, at, at + needle.length) }
}

function imageHit(frame: Frame, needle: string): FindMatch | undefined {
  const source = imageSources(frame.html).find((url) => url.toLowerCase().includes(needle))
  if (!source) return undefined
  const at = source.toLowerCase().indexOf(needle)
  return { field: 'image_src', snippet: snippetAround(source, at, at + needle.length) }
}

function matchHits(field: 'text' | 'html', hits: Hit[]): FindMatch[] {
  return hits.map((hit) => ({ field, snippet: hit.snippet }))
}

/** The matches of one frame, at most three, or undefined when a criterion does not match. */
function frameMatches(frame: Frame, input: FindInput): FindMatch[] | undefined {
  const matches: FindMatch[] = []
  if (input.name !== undefined) {
    const hit = nameHit(frame.name, input.name.toLowerCase())
    if (!hit) return undefined
    matches.push(hit)
  }
  if (input.text !== undefined) {
    const query = compileQuery(input.text, { caseSensitive: false })
    if (!query.ok) return undefined
    const hits = findInText(frame.html, query.re, MAX_MATCHES)
    if (hits.length === 0) return undefined
    matches.push(...matchHits('text', hits))
  }
  if (input.html !== undefined) {
    const query = compileQuery(input.html, { caseSensitive: false })
    if (!query.ok) return undefined
    const hits = findInHtml(frame.html, query.re, MAX_MATCHES)
    if (hits.length === 0) return undefined
    matches.push(...matchHits('html', hits))
  }
  if (input.image_src !== undefined) {
    const hit = imageHit(frame, input.image_src.toLowerCase())
    if (!hit) return undefined
    matches.push(hit)
  }
  return matches.slice(0, MAX_MATCHES)
}

function findFrames(
  canvas: Canvas,
  input: FindInput,
): { error: string } | { payload: { canvasId: string; total: number; frames: FindFrame[]; truncated: number } } {
  if (input.page_id && !canvasPages(canvas).some((page) => page.id === input.page_id)) {
    return { error: noPageMessage(canvas, input.page_id) }
  }
  const found: FindFrame[] = []
  for (const frame of searchableFrames(canvas, input.page_id)) {
    const matches = frameMatches(frame, input)
    if (!matches) continue
    found.push({
      frameId: frame.id,
      name: frame.name,
      pageId: framePageId(canvas, frame),
      ...(frame.locked ? { locked: true } : {}),
      matches,
    })
  }
  const limit = Math.min(MAX_FRAMES, Math.max(1, input.limit ?? 50))
  const frames = found.slice(0, limit)
  return { payload: { canvasId: canvas.id, total: found.length, frames, truncated: found.length - frames.length } }
}

interface DeleteFramesResult {
  deleted: { frameId: string; name: string }[]
  locked: { frameId: string; name: string }[]
  missing: string[]
}

interface DeleteOutcome {
  payload:
    | DeleteFramesResult
    | { wouldDelete: { frameId: string; name: string }[]; locked: DeleteFramesResult['locked']; missing: string[] }
  deletedIds: string[]
}

function deleteFrames(
  canvas: Canvas,
  frameIds: string[],
  dryRun: boolean,
  actor: Actor,
  expectedVersions?: ExpectedVersions,
): { error: string } | DeleteOutcome {
  const seen = new Set<string>()
  const missing: string[] = []
  const locked: { frameId: string; name: string }[] = []
  const targets: Frame[] = []
  for (const id of frameIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const frame = canvas.frames.find((candidate) => candidate.id === id)
    if (!frame) missing.push(id)
    else if (frame.locked) locked.push({ frameId: frame.id, name: frame.name })
    else targets.push(frame)
  }
  if (dryRun) {
    return {
      payload: {
        wouldDelete: targets.map((frame) => ({ frameId: frame.id, name: frame.name })),
        locked,
        missing,
      },
      deletedIds: [] as string[],
    }
  }
  /* the check and the deletes share this synchronous tick, so no write can land between them */
  const refused = versionConflicts(canvas, expectedVersions)
  if (refused) return { error: refused }
  const deleted: { frameId: string; name: string }[] = []
  for (const target of targets) {
    const frame = actions.deleteFrame(target.id, actor)
    if (frame) deleted.push({ frameId: frame.id, name: frame.name })
  }
  dropClaims(deleted.map((entry) => entry.frameId))
  return {
    payload: { deleted, locked, missing } satisfies DeleteFramesResult,
    deletedIds: deleted.map((f) => f.frameId),
  }
}

interface ReplaceInput {
  find: string
  replace: string
  regex?: boolean
  case_sensitive?: boolean
  scope: 'text' | 'html'
  frame_ids?: string[]
  page_id?: string
  dry_run?: boolean
  expected_versions?: ExpectedVersions
}

interface ReplaceFrame {
  frameId: string
  name: string
  count: number
}

function replaceFrames(
  canvas: Canvas,
  input: ReplaceInput,
  actor: Actor,
):
  | { error: string }
  | {
      payload: {
        dryRun: boolean
        changed?: ReplaceFrame[]
        frames?: (ReplaceFrame & { snippets: string[] })[]
        locked: ReplaceFrame[]
        totalReplacements: number
      }
      changedIds: string[]
    } {
  if (input.frame_ids && input.page_id) return { error: 'frame_ids and page_id are exclusive; pass one or neither' }
  if (input.page_id && !canvasPages(canvas).some((page) => page.id === input.page_id)) {
    return { error: noPageMessage(canvas, input.page_id) }
  }
  const query = compileQuery(input.find, { regex: input.regex, caseSensitive: input.case_sensitive })
  if (!query.ok) return { error: query.error }
  let selected = searchableFrames(canvas, input.page_id)
  if (input.frame_ids) {
    const ids = new Set(input.frame_ids)
    const unknown = input.frame_ids.filter((id) => !canvas.frames.some((frame) => frame.id === id))
    if (unknown.length > 0) return { error: `no frame with id ${unknown.join(', ')} on this canvas` }
    selected = selected.filter((frame) => ids.has(frame.id))
  }
  if (selected.length > MAX_FRAMES) {
    return {
      error: `replace_in_frames handles at most ${MAX_FRAMES} frames per call; narrow with frame_ids or page_id`,
    }
  }
  const dryRun = input.dry_run === true
  if (!dryRun) {
    const refused = versionConflicts(canvas, input.expected_versions)
    if (refused) return { error: refused }
  }
  /* matching runs first, for every frame, under a time budget: a pattern that is too slow refuses the call before anything is written */
  const budget = query.literal ? undefined : regexBudget()
  const locked: ReplaceFrame[] = []
  const previews: (ReplaceFrame & { snippets: string[] })[] = []
  const writes: { frame: Frame; html: string; count: number }[] = []
  let totalReplacements = 0
  const options = { literal: query.literal, budget }
  for (const frame of selected) {
    try {
      const compact = compactFrameHtml(frame)
      const hits =
        input.scope === 'text'
          ? findInText(compact, query.re, MAX_MATCHES, budget)
          : findInHtml(compact, query.re, MAX_MATCHES, budget)
      let result: { html: string; count: number; lockedSkipped: number }
      if (input.scope === 'text') {
        result = replaceInText(compact, query.re, input.replace, options)
      } else {
        const replaced = replaceInHtml(compact, query.re, input.replace, options)
        result = { html: replaced.html, count: replaced.count, lockedSkipped: 0 }
      }
      if (frame.locked) {
        const count = result.count + result.lockedSkipped
        if (count > 0) locked.push({ frameId: frame.id, name: frame.name, count })
        continue
      }
      if (result.count === 0) continue
      if (dryRun) {
        previews.push({
          frameId: frame.id,
          name: frame.name,
          count: result.count,
          snippets: hits.map((hit) => hit.snippet),
        })
      } else {
        writes.push({ frame, html: result.html, count: result.count })
      }
      totalReplacements += result.count
    } catch (error) {
      if (error instanceof RegexTimeoutError) return { error: slowPatternMessage(frame) }
      throw error
    }
  }
  /* no await since the version check above: the writes below land on exactly the versions that were checked */
  const changed: ReplaceFrame[] = []
  for (const write of writes) {
    actions.updateFrame(write.frame.id, { html: write.html }, actor, { replace: true })
    changed.push({ frameId: write.frame.id, name: write.frame.name, count: write.count })
  }
  return {
    payload: dryRun
      ? { dryRun: true, frames: previews, locked, totalReplacements }
      : { dryRun: false, changed, locked, totalReplacements },
    changedIds: changed.map((frame) => frame.frameId),
  }
}

function slowPatternMessage(frame: Frame): string {
  return `the pattern is too slow on frame ${frame.id} ("${frame.name}") and was stopped; nothing was written. Simplify the regex (no nested repeats like (a+)+) or search plain text instead.`
}

const findSchema = {
  page_id: z.string().optional().describe('Only frames on this page (a page id from get_canvas)'),
  name: z.string().optional().describe('Case-insensitive substring of the frame name'),
  text: z.string().optional().describe('Case-insensitive text the rendered frame shows (style and script excluded)'),
  html: z.string().optional().describe('Case-insensitive substring of the frame HTML source, markup included'),
  image_src: z.string().optional().describe('Case-insensitive substring of any image URL the frame references'),
  limit: z.number().int().min(1).max(MAX_FRAMES).optional().describe('Maximum frames to return; defaults to 50'),
}

const replaceSchema = {
  find: z.string().describe('Text or pattern to replace'),
  replace: z.string().describe('Replacement text ($1 references work with regex)'),
  regex: z.boolean().optional().describe('Treat find as a regular expression; defaults to false'),
  case_sensitive: z.boolean().optional().describe('Match case exactly; defaults to false'),
  scope: z.enum(['text', 'html']).describe('text: rendered text only; html: the raw source, markup included'),
  frame_ids: z
    .array(z.string())
    .min(1)
    .max(MAX_FRAMES)
    .optional()
    .describe('Only these frames; exclusive with page_id'),
  page_id: z.string().optional().describe('Only frames on this page; exclusive with frame_ids'),
  dry_run: z.boolean().optional().describe('Report what would change without writing; run it first'),
  expected_versions: expectedVersionsSchema,
}

function pageError(ctx: AgentToolContext, canvas: Canvas, pageId: string | undefined) {
  return pageId && !canvasPages(canvas).some((page) => page.id === pageId)
    ? ctx.err(noPageMessage(canvas, pageId))
    : undefined
}

export function registerSearchTools(server: McpServer, ctx: AgentToolContext): void {
  /* the context's result type is wider than the SDK's content union; the cast keeps the callbacks checked against it */
  type ToolCallback = Parameters<McpServer['registerTool']>[2]
  server.registerTool(
    'find_frames',
    {
      title: 'Find frames on a canvas',
      description:
        'Search a canvas\'s frames without reading each one: match the frame name, the text it renders, its HTML source or an image URL, and get the matching frames with short snippets. Every criterion you pass must match (AND). Use it to locate the frame that mentions a headline, colour, component or image before editing. Example: find_frames({ canvas_id, text: "pricing" }).',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), ...findSchema, agent_name: ctx.agentName.optional() },
    },
    (async ({ canvas_id, agent_name, ...input }: { canvas_id: string; agent_name?: string } & FindInput) => {
      const canvas = ctx.canvasFor(canvas_id, 'view')
      if (!canvas) return ctx.noCanvas(canvas_id)
      if (!input.name && !input.text && !input.html && !input.image_src) {
        return ctx.err('give at least one of name, text, html or image_src')
      }
      const refused = pageError(ctx, canvas, input.page_id)
      if (refused) return refused
      ctx.arrive(canvas_id, agent_name)
      const found = findFrames(canvas, input)
      return 'error' in found ? ctx.err(found.error) : ctx.text(found.payload)
    }) as unknown as ToolCallback,
  )

  server.registerTool(
    'delete_frames',
    {
      title: 'Delete several frames',
      description:
        'Delete a list of frames from one canvas in a single call, reporting ids that are not frames of this canvas and frames that are locked. Pass dry_run: true first to see what would be deleted. Example: delete_frames({ canvas_id, frame_ids: ["a", "b"], dry_run: true }).',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_ids: z.array(z.string()).min(1).max(MAX_FRAMES).describe('Frame ids on this canvas'),
        dry_run: z.boolean().optional().describe('Report what would be deleted without deleting'),
        expected_versions: expectedVersionsSchema,
        agent_name: ctx.agentName,
      },
    },
    (async ({
      canvas_id,
      frame_ids,
      dry_run,
      expected_versions,
      agent_name,
    }: {
      canvas_id: string
      frame_ids: string[]
      dry_run?: boolean
      expected_versions?: ExpectedVersions
      agent_name: string
    }) => {
      const canvas = ctx.canvasFor(canvas_id, 'edit')
      if (!canvas) return ctx.noCanvas(canvas_id, 'edit')
      const actor = ctx.actorFrom(agent_name)
      const result = deleteFrames(canvas, frame_ids, dry_run === true, actor, expected_versions)
      if ('error' in result) return ctx.err(result.error)
      return withClaimWarning(ctx.text(result.payload), result.deletedIds, actor)
    }) as unknown as ToolCallback,
  )

  server.registerTool(
    'replace_in_frames',
    {
      title: 'Replace across a canvas’s frames',
      description:
        'Find and replace text or markup in several frames at once, in the compact HTML agents read (component instances stay <doop-use>). Run it with dry_run: true first: it reports each frame\'s match count and snippets without writing, so you can check the blast radius. Locked frames and data-doop-locked layers are left alone. Each changed frame becomes one version and one undo step. Example: replace_in_frames({ canvas_id, find: "Learn more", replace: "Get started", scope: "text", dry_run: true }).',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        ...replaceSchema,
        agent_name: ctx.agentName,
      },
    },
    (async ({ canvas_id, agent_name, ...input }: { canvas_id: string; agent_name: string } & ReplaceInput) => {
      const canvas = ctx.canvasFor(canvas_id, 'edit')
      if (!canvas) return ctx.noCanvas(canvas_id, 'edit')
      const actor = ctx.actorFrom(agent_name)
      const result = replaceFrames(canvas, input, actor)
      if ('error' in result) return ctx.err(result.error)
      const base = ctx.textWithNudge(result.payload, ctx.reviewNudge)
      return withClaimWarning(
        ctx.withStatusNudge(ctx.withFeedback(base, canvas_id, actor), canvas_id, actor),
        result.changedIds,
        actor,
      )
    }) as unknown as ToolCallback,
  )
}

/* ---------------------------------------------------------------- resident */

function residentCanvas(canvasId: string): Canvas | undefined {
  return store.getCanvas(canvasId)
}

function residentFrame(canvas: Canvas, frameId: unknown): Frame | undefined {
  if (typeof frameId !== 'string') return undefined
  const frame = canvas.frames.find((candidate) => candidate.id === frameId)
  return frame && frame.canvasId === canvas.id ? frame : undefined
}

function residentFindInput(raw: Record<string, unknown>): FindInput {
  return {
    ...(typeof raw.page_id === 'string' ? { page_id: raw.page_id } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(typeof raw.html === 'string' ? { html: raw.html } : {}),
    ...(typeof raw.image_src === 'string' ? { image_src: raw.image_src } : {}),
    ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
  }
}

const findFramesTool: ResidentAgentTool = {
  definition: {
    name: 'find_frames',
    description:
      "Search this canvas's frames by name, rendered text, HTML source or image URL; every criterion must match. Returns matching frames with short snippets.",
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Only frames on this page' },
        name: { type: 'string', description: 'Case-insensitive substring of the frame name' },
        text: { type: 'string', description: 'Case-insensitive text the rendered frame shows' },
        html: { type: 'string', description: 'Case-insensitive substring of the HTML source' },
        image_src: { type: 'string', description: 'Case-insensitive substring of an image URL' },
        limit: { type: 'number', description: 'Maximum frames to return; defaults to 50' },
      },
    },
  },
  run(input, ctx) {
    const canvas = residentCanvas(ctx.canvasId)
    if (!canvas) return { ok: false, error: 'canvas not found' }
    const search = residentFindInput(input)
    if (!search.name && !search.text && !search.html && !search.image_src) {
      return { ok: false, error: 'give at least one of name, text, html or image_src' }
    }
    if (search.page_id && !canvasPages(canvas).some((page) => page.id === search.page_id)) {
      return { ok: false, error: noPageMessage(canvas, search.page_id) }
    }
    const found = findFrames(canvas, search)
    return 'error' in found ? { ok: false, error: found.error } : { ok: true, content: JSON.stringify(found.payload) }
  },
}

const deleteFramesTool: ResidentAgentTool = {
  definition: {
    name: 'delete_frames',
    description: 'Delete several frames from this canvas at once, reporting missing and locked frames.',
    input_schema: {
      type: 'object',
      properties: {
        frame_ids: { type: 'array', items: { type: 'string' }, description: 'Frame ids on this canvas' },
        dry_run: { type: 'boolean', description: 'Report what would be deleted without deleting' },
        expected_versions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Frame id -> updatedAt from your last read; if any changed, nothing is deleted',
        },
      },
      required: ['frame_ids'],
    },
  },
  run(input, ctx) {
    const canvas = residentCanvas(ctx.canvasId)
    if (!canvas) return { ok: false, error: 'canvas not found' }
    if (!Array.isArray(input.frame_ids)) return { ok: false, error: 'frame_ids must be a list of frame ids' }
    const ids = input.frame_ids.filter((id): id is string => typeof id === 'string')
    if (ids.length === 0) return { ok: false, error: 'frame_ids must hold at least one frame id' }
    if (ids.length > MAX_FRAMES) return { ok: false, error: `at most ${MAX_FRAMES} frames per call` }
    const result = deleteFrames(
      canvas,
      ids,
      input.dry_run === true,
      ctx.actor,
      parseExpectedVersions(input.expected_versions),
    )
    if ('error' in result) return { ok: false, error: result.error }
    for (const id of result.deletedIds) {
      ctx.runState.mutatedFrames.delete(id)
      ctx.runState.verificationFrames.delete(id)
      ctx.runState.verifiedFrames.delete(id)
    }
    return { ok: true, content: JSON.stringify(result.payload) }
  },
}

function residentReplaceInput(raw: Record<string, unknown>): ReplaceInput | string {
  if (typeof raw.find !== 'string') return 'find must be a string'
  if (typeof raw.replace !== 'string') return 'replace must be a string'
  if (raw.scope !== 'text' && raw.scope !== 'html') return 'scope must be "text" or "html"'
  if (Array.isArray(raw.frame_ids) && typeof raw.page_id === 'string') {
    return 'frame_ids and page_id are exclusive; pass one or neither'
  }
  const frameIds = Array.isArray(raw.frame_ids)
    ? raw.frame_ids.filter((id): id is string => typeof id === 'string')
    : undefined
  if (frameIds && frameIds.length === 0) return 'frame_ids must hold at least one frame id'
  return {
    find: raw.find,
    replace: raw.replace,
    ...(typeof raw.regex === 'boolean' ? { regex: raw.regex } : {}),
    ...(typeof raw.case_sensitive === 'boolean' ? { case_sensitive: raw.case_sensitive } : {}),
    scope: raw.scope,
    ...(frameIds ? { frame_ids: frameIds } : {}),
    ...(typeof raw.page_id === 'string' ? { page_id: raw.page_id } : {}),
    ...(typeof raw.dry_run === 'boolean' ? { dry_run: raw.dry_run } : {}),
    ...(parseExpectedVersions(raw.expected_versions)
      ? { expected_versions: parseExpectedVersions(raw.expected_versions) }
      : {}),
  }
}

const replaceInFramesTool: ResidentAgentTool = {
  definition: {
    name: 'replace_in_frames',
    description:
      "Find and replace text or markup across this canvas's frames in one call. Run with dry_run: true first to see match counts and snippets. Locked frames and locked layers are left alone; each changed frame becomes one version.",
    input_schema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'Text or pattern to replace' },
        replace: { type: 'string', description: 'Replacement text' },
        regex: { type: 'boolean', description: 'Treat find as a regular expression' },
        case_sensitive: { type: 'boolean', description: 'Match case exactly' },
        scope: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'text: rendered text only; html: the raw source',
        },
        frame_ids: { type: 'array', items: { type: 'string' }, description: 'Only these frames' },
        page_id: { type: 'string', description: 'Only frames on this page' },
        dry_run: { type: 'boolean', description: 'Report what would change without writing' },
        expected_versions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Frame id -> updatedAt from your last read; if any changed, nothing is written',
        },
      },
      required: ['find', 'replace', 'scope'],
    },
  },
  run(input, ctx) {
    const canvas = residentCanvas(ctx.canvasId)
    if (!canvas) return { ok: false, error: 'canvas not found' }
    const replace = residentReplaceInput(input)
    if (typeof replace === 'string') return { ok: false, error: replace }
    for (const id of replace.frame_ids ?? []) {
      if (!residentFrame(canvas, id)) return { ok: false, error: `frame not found on this canvas: ${id}` }
    }
    const result = replaceFrames(canvas, replace, ctx.actor)
    if ('error' in result) return { ok: false, error: result.error }
    for (const id of result.changedIds) {
      ctx.runState.mutatedFrames.add(id)
      ctx.runState.verifiedFrames.delete(id)
    }
    return { ok: true, content: JSON.stringify(result.payload) }
  },
}

export const searchResidentTools: ResidentAgentTool[] = [findFramesTool, deleteFramesTool, replaceInFramesTool]
