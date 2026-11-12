import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/** snapshot_frame and list_assets (items 2 and 11). */
export function registerSnapshotTools(_server: McpServer, _ctx: AgentToolContext): void {}

export const snapshotResidentTools: ResidentAgentTool[] = []
