import type { z } from 'zod'
import type { Actor, Canvas, Frame } from '../../shared/types.ts'
import type { CanvasRole } from '../../shared/canvasRole.ts'
import type { CanvasPreview } from '../chatgptApp.ts'
import { claimWarning } from '../frameClaims.ts'
import { versionConflict, type ExpectedVersion } from '../frameVersion.ts'

/** The content a tool answers with: text blocks, images, resources. */
export type AgentToolContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'image'; data: string; mimeType: string; [k: string]: unknown }

export type AgentToolContent = { content: AgentToolContentBlock[] }

/** A tool's answer as the MCP SDK takes it. */
export type AgentToolResult = AgentToolContent & { isError?: boolean }

/** What `mcp.ts` hands the tools of `server/agentTools/`: the per-session helpers the built-in tools close over, so a new tool checks access, attributes, nudges and rate-limits exactly like them. One context per MCP session (`buildMcpServer`). */
export interface AgentToolContext {
  /** the connected user's id: undefined for a session without one */
  ownerId?: string
  /** the connected user's display name, for attribution */
  owner?: string
  /** the zod field every tool takes so presence and edits are attributed: `agent_name: ctx.agentName` (or `.optional()`) */
  agentName: z.ZodString
  /** the actor behind an `agent_name` (the SAME name on every call) */
  actorFrom(agentName?: string): Actor
  /** a read counts as arrival: heartbeats the agent's presence on the canvas */
  arrive(canvasId: string, agentName?: string): void
  /** the canvas when the connected user's role covers `need` (default `view`), else undefined */
  canvasFor(canvasId: string, need?: CanvasRole): Canvas | undefined
  /** the frame when its canvas passes `canvasFor` at `need`, else undefined */
  frameFor(frameId: string, need?: CanvasRole): Frame | undefined
  /** the refusal for a canvas `canvasFor` returned nothing for: names the role the account lacks, or says there is none */
  noCanvas(canvasId: string, need?: CanvasRole): AgentToolResult
  noFrame(frameId: string, need?: CanvasRole): AgentToolResult
  /** `Error: <message>` with `isError` set */
  err(message: string): AgentToolResult
  /** a text block: strings as they are, anything else as pretty JSON */
  text(data: unknown): AgentToolResult
  /** the JSON payload plus a second text block the agent reads at its decision point */
  textWithNudge(data: unknown, nudge: string): AgentToolResult
  /** appends open human feedback to a write's result (editors only) */
  withFeedback<T extends AgentToolContent>(result: T, canvasId: string, actor?: Actor): T
  /** says feedback is waiting without claiming it: for read-only tools */
  withFeedbackNotice<T extends AgentToolContent>(result: T, canvasId: string, actor?: Actor): T
  /** reminds an editor that has not called `set_status` yet */
  withStatusNudge<T extends AgentToolContent>(result: T, canvasId: string, actor?: Actor): T
  /** reminds an agent of the canvas's style guides it has not read */
  withGuidelinesNudge<T extends AgentToolContent>(result: T, canvasId: string, actor?: Actor): T
  /** adds `structuredContent` (the ChatGPT preview card's data, and the whole payload for clients that show it in place of text) */
  withPreview<T extends { content: unknown[] }>(
    result: T,
    canvasId: string,
    frames: Frame[],
  ): T & { structuredContent: CanvasPreview & Record<string, unknown> }
  /** the one-line review reminder frame writes carry */
  readonly reviewNudge: string
  /** a frame as get_canvas lists it */
  frameSummary(frame: Frame): Record<string, unknown>
  /** Takes one slot of a rolling-minute budget per user: false when `limitPerMin` calls were taken in the last 60 s. `bucket` names the budget (one per kind of expensive call), `key` the user (`ownerId ?? agent_name`). */
  takeSlot(bucket: string, key: string, limitPerMin: number): boolean
}

/** The slot a tool of `bucket` takes for the connected user, the way the built-in tools key theirs. */
export const limitKey = (ctx: Pick<AgentToolContext, 'ownerId'>, agentName: string): string => ctx.ownerId ?? agentName

export { expectedVersionSchema } from '../frameVersion.ts'
export type { ExpectedVersion } from '../frameVersion.ts'

/** The refusal for a write whose `expected_version` is stale, else undefined. Call it in the same synchronous tick as the write. */
export function assertExpectedVersion(
  frame: Frame,
  expected: ExpectedVersion | undefined,
): (AgentToolResult & { isError: true; content: { type: 'text'; text: string }[] }) | undefined {
  const conflict = versionConflict(frame, expected)
  return conflict === undefined
    ? undefined
    : { isError: true as const, content: [{ type: 'text' as const, text: `Error: ${conflict}` }] }
}

/** Adds the advisory notice when another agent holds a claim on one of the frames just written. */
export function withClaimWarning<T extends AgentToolContent>(result: T, frameIds: string[], actor: Actor): T {
  const warning = claimWarning(frameIds, actor)
  if (!warning) return result
  return { ...result, content: [...result.content, { type: 'text', text: warning }] }
}
