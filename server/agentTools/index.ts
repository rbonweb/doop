import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentToolContext } from './context.ts'
import { register as registerCanvas } from './canvas.ts'
import { register as registerHtml } from './html.ts'
import { register as registerRender } from './render.ts'

/** The agent speed tools: one file per area (`render.ts`, `html.ts`, `canvas.ts`), registered from one call in `server/mcp.ts` so each passes through the same `loadToolTargets` wrapping (canvas loading) as every built-in tool. The resident agent's copies are in `resident.ts`, the guide sections in `guide/`. */
export function registerAgentSpeedTools(server: McpServer, ctx: AgentToolContext): void {
  registerRender(server, ctx)
  registerHtml(server, ctx)
  registerCanvas(server, ctx)
}
