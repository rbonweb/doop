import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'
import { measureResidentTools, registerMeasureTools } from './render/measure.ts'
import { registerShotTools, shotResidentTools } from './render/shots.ts'
import { registerSnapshotTools, snapshotResidentTools } from './render/snapshot.ts'

/** Render and vision tools (snapshots, measuring, screenshots with targets). Each family registers from its own file under `render/`. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  registerSnapshotTools(server, ctx)
  registerMeasureTools(server, ctx)
  registerShotTools(server, ctx)
}

/** The same tools for the resident agent, under the same names. */
export const residentTools: ResidentAgentTool[] = [
  ...snapshotResidentTools,
  ...measureResidentTools,
  ...shotResidentTools,
]
