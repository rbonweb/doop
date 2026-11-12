import type Anthropic from '@anthropic-ai/sdk'
import type { Actor } from '../../shared/types.ts'
import type { RunState } from '../resident.ts'
import { residentTools as canvasTools } from './canvas.ts'
import { residentTools as htmlTools } from './html.ts'
import { residentTools as renderTools } from './render.ts'

/** What a resident tool runs with: the canvas of the run, its actor and the run's bookkeeping (frames mutated, verified, vision). */
export interface ResidentToolContext {
  canvasId: string
  actor: Actor
  runState: RunState
}

/** A tool's answer: the content for the model, or an error it reads. */
export type ResidentToolOutcome =
  { ok: true; content: Anthropic.ToolResultBlockParam['content'] } | { ok: false; error: string }

/** A resident-agent tool of one area: its definition (the name matches the MCP tool, `tests/agentToolParity.test.ts`) and what it does. */
export interface ResidentAgentTool {
  definition: Anthropic.Tool
  run(input: Record<string, unknown>, ctx: ResidentToolContext): Promise<ResidentToolOutcome> | ResidentToolOutcome
}

/** Every area's resident tools, in the fixed order of the areas: render, html, canvas. `server/resident.ts` adds the definitions to its tool list and runs a call by name. */
export const RESIDENT_AGENT_TOOLS: ResidentAgentTool[] = [...renderTools, ...htmlTools, ...canvasTools]

export function residentAgentTool(name: string): ResidentAgentTool | undefined {
  return RESIDENT_AGENT_TOOLS.find((tool) => tool.definition.name === name)
}
