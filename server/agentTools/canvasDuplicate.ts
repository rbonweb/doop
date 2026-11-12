import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** `duplicate_frames`: copies of frames on the same canvas, HTML byte for byte. */
export function register(_server: McpServer, _ctx: AgentToolContext): void {}

/** The same tool for the resident agent. */
export const residentTools: ResidentAgentTool[] = []
