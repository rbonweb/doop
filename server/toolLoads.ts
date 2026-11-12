import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'
import { store } from './store.ts'

/** The canvases a tool call names: `canvas_id`, and the canvases of
 *  `frame_id` / `frame_ids` and of each `items[].frame_id` (compare_frames). */
function argsCanvases(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const { canvas_id, frame_id, frame_ids, items } = args as Record<string, unknown>
  const ids = new Set<string>()
  if (typeof canvas_id === 'string') ids.add(canvas_id)
  const itemFrames = (Array.isArray(items) ? items : []).map((item: unknown) =>
    item && typeof item === 'object' ? (item as Record<string, unknown>).frame_id : undefined,
  )
  for (const id of [frame_id, ...(Array.isArray(frame_ids) ? frame_ids : []), ...itemFrames]) {
    const canvasId = typeof id === 'string' ? store.getFrame(id)?.canvasId : undefined
    if (canvasId) ids.add(canvasId)
  }
  return [...ids]
}

/** Load the canvases a tool call names and hold them while `run` works, so
 *  tools keep reading the store synchronously and a slow one (an import
 *  waiting on another service) keeps its canvas (store.load, store.hold). */
export async function withArgsCanvases<T>(args: unknown, run: () => T | Promise<T>): Promise<T> {
  const canvasIds = argsCanvases(args)
  await Promise.all(canvasIds.map((id) => store.load(id)))
  const releases = canvasIds.map((id) => store.hold(id))
  try {
    return await run()
  } finally {
    for (const release of releases) release()
  }
}

/** A registered tool as a batch calls it: `run` is the very callback the SDK is given (the one that loads and holds the canvases), so a batched call passes through everything a direct call does. */
export interface RegisteredHandler {
  inputSchema?: ZodRawShape
  annotations?: ToolAnnotations
  run: (...params: unknown[]) => Promise<unknown>
}

/** Per server, never global: each `buildMcpServer` closes over its own account, role checks and rate-limit state, so two accounts' handlers must never mix. */
const registries = new WeakMap<McpServer, Map<string, RegisteredHandler>>()

/** The handler `name` was registered with on `server`, if any. */
export function registeredTool(server: McpServer, name: string): RegisteredHandler | undefined {
  return registries.get(server)?.get(name)
}

/** Every tool registered on `server` from here on loads and holds its
 *  canvases. A tool with an input schema is called with (args, extra), one
 *  without with (extra) alone. */
export function loadToolTargets(server: McpServer): void {
  type Register = typeof server.registerTool
  type Callback = Parameters<Register>[2]
  const register: Register = server.registerTool.bind(server)
  const registry = new Map<string, RegisteredHandler>()
  registries.set(server, registry)
  server.registerTool = ((name: string, config: Parameters<Register>[1], callback: Callback) => {
    const run = async (...params: unknown[]) => {
      const forward = () => (callback as (...forwarded: unknown[]) => unknown)(...params)
      return params.length > 1 ? withArgsCanvases(params[0], forward) : forward()
    }
    const registered = register(name, config, run as unknown as Callback)
    const { inputSchema, annotations } = config as { inputSchema?: ZodRawShape; annotations?: ToolAnnotations }
    registry.set(name, { inputSchema, annotations, run })
    return registered
  }) as Register
}
