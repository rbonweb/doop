import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Frame } from '../../../shared/types.ts'
import { MAX_CLAIM_MINUTES, claimFrames, releaseFrames, type FrameClaim } from '../../frameClaims.ts'
import { store } from '../../store.ts'
import type { AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

const MAX_CLAIM_FRAMES = 50
const MAX_NOTE_CHARS = 200
const DEFAULT_MINUTES = 15
const ADVISORY =
  'Claims are advisory: another agent can still write to these frames, and its answer names you. A claim lapses on its own after the minutes you asked for; call release_frames when you are done.'

const iso = (ms: number): string => new Date(ms).toISOString()

/** What a claim call answers: the frames now held, and the frames someone else already holds. */
function claimAnswer(result: { claimed: FrameClaim[]; heldByOthers: FrameClaim[] }) {
  return {
    claimed: result.claimed.map((c) => ({ frameId: c.frameId, expiresAt: iso(c.expiresAt) })),
    heldByOthers: result.heldByOthers.map((c) => ({
      frameId: c.frameId,
      holder: c.holder,
      note: c.note,
      expiresAt: iso(c.expiresAt),
    })),
  }
}

const unique = (ids: string[]): string[] => [...new Set(ids)]

export function registerClaimTools(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    'claim_frames',
    {
      title: 'Claim frames you are about to work on',
      description:
        'Tell everyone on the canvas which frames you are working on, for a while. People see a badge with your name on each frame; other agents get your note in the answer to any write on it. Claims are advisory and never block a write. Frames someone else already holds come back under heldByOthers (not claimed): pick other work or coordinate. Release with release_frames when done, or let the claim lapse.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_ids: z.array(z.string()).min(1).max(MAX_CLAIM_FRAMES),
        minutes: z.number().int().min(1).max(MAX_CLAIM_MINUTES).default(DEFAULT_MINUTES),
        note: z.string().min(1).max(MAX_NOTE_CHARS).describe('What you are doing, in a line others can read'),
        agent_name: ctx.agentName,
      },
    },
    async ({ frame_ids, minutes, note, agent_name }) => {
      const frames: Frame[] = []
      for (const id of unique(frame_ids)) {
        const frame = ctx.frameFor(id, 'edit')
        if (!frame) return ctx.noFrame(id, 'edit') as CallToolResult
        frames.push(frame)
      }
      const actor = ctx.actorFrom(agent_name)
      for (const canvasId of unique(frames.map((f) => f.canvasId))) ctx.arrive(canvasId, agent_name)
      const result = claimFrames(frames, actor, minutes, note)
      return ctx.textWithNudge(claimAnswer(result), ADVISORY) as CallToolResult
    },
  )

  server.registerTool(
    'release_frames',
    {
      title: 'Release your frame claims',
      description:
        'Release the claims you hold: the frames in frame_ids, or all of your claims when frame_ids is left out. Claims held by others are never touched.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_ids: z.array(z.string()).max(MAX_CLAIM_FRAMES).optional(),
        agent_name: ctx.agentName,
      },
    },
    async ({ frame_ids, agent_name }) => {
      const released = releaseFrames(frame_ids === undefined ? undefined : unique(frame_ids), ctx.actorFrom(agent_name))
      return ctx.text({ released }) as CallToolResult
    },
  )
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string')
}

/** The frames of a resident run's canvas named by `ids`, or the refusal for the first that is not on it. */
function runFrames(ids: string[], canvasId: string): { frames: Frame[] } | { error: string } {
  const frames: Frame[] = []
  for (const id of unique(ids)) {
    const frame = store.getFrame(id)
    if (!frame || frame.canvasId !== canvasId) return { error: `frame ${id} not found on this canvas` }
    frames.push(frame)
  }
  return { frames }
}

export const claimResidentTools: ResidentAgentTool[] = [
  {
    definition: {
      name: 'claim_frames',
      description:
        'Tell everyone on the canvas which frames you are working on, for a while. People see a badge on each frame. Claims are advisory and never block a write; frames someone else already holds come back under heldByOthers. Release with release_frames when done, or let the claim lapse.',
      input_schema: {
        type: 'object',
        properties: {
          frame_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CLAIM_FRAMES },
          minutes: { type: 'integer', minimum: 1, maximum: MAX_CLAIM_MINUTES, default: DEFAULT_MINUTES },
          note: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS },
        },
        required: ['frame_ids', 'note'],
      },
    },
    run(input, { canvasId, actor }) {
      const ids = stringList(input.frame_ids)
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      if (!ids?.length || ids.length > MAX_CLAIM_FRAMES)
        return { ok: false, error: `frame_ids takes 1 to ${MAX_CLAIM_FRAMES} ids` }
      if (!note || note.length > MAX_NOTE_CHARS)
        return { ok: false, error: `note takes 1 to ${MAX_NOTE_CHARS} characters` }
      const minutes =
        typeof input.minutes === 'number'
          ? Math.min(MAX_CLAIM_MINUTES, Math.max(1, Math.round(input.minutes)))
          : DEFAULT_MINUTES
      const found = runFrames(ids, canvasId)
      if ('error' in found) return { ok: false, error: found.error }
      const answer = claimAnswer(claimFrames(found.frames, actor, minutes, note))
      return { ok: true, content: `${JSON.stringify(answer, null, 2)}\n${ADVISORY}` }
    },
  },
  {
    definition: {
      name: 'release_frames',
      description:
        'Release the claims you hold: the frames in frame_ids, or all of your claims when frame_ids is left out. Claims held by others are never touched.',
      input_schema: {
        type: 'object',
        properties: { frame_ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_CLAIM_FRAMES } },
      },
    },
    run(input, { actor }) {
      const ids = input.frame_ids === undefined ? undefined : stringList(input.frame_ids)
      if (input.frame_ids !== undefined && !ids) return { ok: false, error: 'frame_ids must be a list of ids' }
      return { ok: true, content: JSON.stringify({ released: releaseFrames(ids && unique(ids), actor) }, null, 2) }
    },
  },
]
