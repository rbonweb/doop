import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import { claimResidentTools, registerClaimTools } from './html/claims.ts'
import { composeResidentTools, registerComposeTools } from './html/compose.ts'
import { registerSearchTools, searchResidentTools } from './html/search.ts'
import { registerSectionTools, sectionResidentTools } from './html/sections.ts'
import type { ResidentAgentTool } from './resident.ts'

/** HTML editing tools (sections, patches, search, claims, composing). Register new MCP tools here, in this area's branch only. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  registerSectionTools(server, ctx)
  registerSearchTools(server, ctx)
  registerClaimTools(server, ctx)
  registerComposeTools(server, ctx)
}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = [
  ...sectionResidentTools,
  ...searchResidentTools,
  ...claimResidentTools,
  ...composeResidentTools,
]
