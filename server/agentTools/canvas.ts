import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** Canvas tools and lighter responses (duplicating frames, layout, batches). Register new MCP tools here, in this area's branch only. */
export function register(_server: McpServer, _ctx: AgentToolContext): void {}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = []
