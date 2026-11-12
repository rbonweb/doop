import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from '../context.ts'
import type { ResidentAgentTool } from '../resident.ts'

/** compare_frames (item 6). The new get_frame_screenshot parameters are handled by server/frameShots.ts, called from mcp.ts. */
export function registerShotTools(_server: McpServer, _ctx: AgentToolContext): void {}

export const shotResidentTools: ResidentAgentTool[] = []
