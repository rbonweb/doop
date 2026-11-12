import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'

/** Render and vision tools (snapshots, measuring, screenshots with targets). Register new MCP tools here, in this area's branch only. */
export function register(_server: McpServer, _ctx: AgentToolContext): void {}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = []
