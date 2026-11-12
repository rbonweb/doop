import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'
import * as batch from './canvasBatch.ts'
import * as duplicate from './canvasDuplicate.ts'
import * as layout from './canvasLayout.ts'

/** Canvas tools and lighter responses: duplicating frames (`canvasDuplicate.ts`), layout (`canvasLayout.ts`) and batches (`canvasBatch.ts`), one module per tool family. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  duplicate.register(server, ctx)
  layout.register(server, ctx)
  batch.register(server, ctx)
}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = [
  ...duplicate.residentTools,
  ...layout.residentTools,
  ...batch.residentTools,
]
