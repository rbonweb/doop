import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'
import { registerSearchTools, searchResidentTools } from './html/search.ts'

/** HTML editing tools (sections, patches, search, claims, composing). Register new MCP tools here, in this area's branch only. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  registerSearchTools(server, ctx)
}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = [...searchResidentTools]
