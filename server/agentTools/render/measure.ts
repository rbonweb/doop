import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/** measure_frame and lint_frame (item 5). */
export function registerMeasureTools(_server: McpServer, _ctx: AgentToolContext): void {}

export const measureResidentTools: ResidentAgentTool[] = []
