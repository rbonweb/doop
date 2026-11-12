import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** `run_batch`: several tool calls in one round trip, each through its own registered handler. */
export function register(_server: McpServer, _ctx: AgentToolContext): void {}

/** The resident agent already runs several tool calls per turn, so it has no batch tool. */
export const residentTools: ResidentAgentTool[] = []
