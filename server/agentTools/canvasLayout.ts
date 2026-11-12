import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** `arrange_frames` and `check_layout`: frames in rows, and overlaps or tight gaps between frames and notes. */
export function register(_server: McpServer, _ctx: AgentToolContext): void {}

/** The same tools for the resident agent. */
export const residentTools: ResidentAgentTool[] = []
