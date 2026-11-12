import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodRawShape } from 'zod'
import type { AgentToolContext, AgentToolResult } from './context.ts'
import type { ResidentAgentTool } from './resident.ts'
import { registeredTool } from '../toolLoads.ts'

const TOOL_NAME = 'run_batch'
const MAX_OPS = 50

type Block = AgentToolResult['content'][number]
type OpStatus = 'ok' | 'error' | 'skipped'

interface OpOutcome {
  index: number
  tool: string
  status: OpStatus
  error?: string
  content?: Block[]
}

/** The first text block of a result: what an op's error says. */
function firstText(content: Block[]): string {
  const block = content.find((b) => b.type === 'text' && typeof b.text === 'string')
  return typeof block?.text === 'string' ? block.text : 'the tool reported an error'
}

/** Parses `args` the way the SDK does before it calls a tool, with the same message on a refusal, so an op takes and refuses exactly the arguments a direct call does. */
async function parseArgs(name: string, shape: ZodRawShape | undefined, args: unknown): Promise<unknown> {
  if (!shape) return undefined
  const schema = normalizeObjectSchema(shape) ?? (Object.keys(shape).length === 0 ? z.object({}) : undefined)
  if (!schema) return args
  const parsed = await safeParseAsync(schema, args)
  if (parsed.success) return parsed.data
  const error = 'error' in parsed ? parsed.error : 'Unknown error'
  throw new McpError(
    ErrorCode.InvalidParams,
    `Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(error)}`,
  )
}

/** Runs one op through the handler its tool was registered with: its own access checks, rate limits, canvas loads and version checks all run, exactly as for a direct call. */
async function runOp(
  server: McpServer,
  index: number,
  op: { tool: string; args?: Record<string, unknown> },
  extra: unknown,
) {
  const base = { index, tool: op.tool }
  if (op.tool === TOOL_NAME)
    return { ...base, status: 'error', error: 'run_batch cannot be nested in a batch' } as OpOutcome
  const handler = registeredTool(server, op.tool)
  if (!handler) return { ...base, status: 'error', error: `Tool ${op.tool} not found` } as OpOutcome
  try {
    const args = await parseArgs(op.tool, handler.inputSchema, op.args ?? {})
    const result = (await (handler.inputSchema ? handler.run(args, extra) : handler.run(extra))) as AgentToolResult
    const content = Array.isArray(result?.content) ? result.content : []
    if (result?.isError) return { ...base, status: 'error', error: firstText(content), content } as OpOutcome
    return { ...base, status: 'ok', content } as OpOutcome
  } catch (error) {
    return { ...base, status: 'error', error: error instanceof Error ? error.message : String(error) } as OpOutcome
  }
}

/** `run_batch`: several tool calls in one round trip, each through its own registered handler. */
export function register(server: McpServer, ctx: AgentToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Run several Doop tool calls in one round trip',
      description:
        'Run up to 50 Doop tool calls in order in a single call. Each op is { tool, args } and is checked, rate-limited and run exactly as if you had called that tool alone (every op still needs its own agent_name and ids). An unknown tool, run_batch itself or arguments the tool would refuse fail that op only. With stop_on_error (default true) the ops after the first failure are skipped. The answer starts with a JSON summary { ok, results: [{ index, tool, status }] }, then each op\'s own output under "--- op <index> <tool> ---". Use it for many small independent edits or reads when each round trip is slow.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        ops: z
          .array(
            z.object({
              tool: z.string().describe('The tool to call, e.g. "update_frame"'),
              args: z
                .record(z.unknown())
                .optional()
                .describe("That tool's arguments, exactly as a direct call takes them"),
            }),
          )
          .min(1)
          .max(MAX_OPS)
          .describe('The calls to run, in order'),
        stop_on_error: z.boolean().optional().describe('Skip the remaining ops after the first failure (default true)'),
      },
    },
    async ({ ops, stop_on_error }, extra) => {
      const stop = stop_on_error ?? true
      const outcomes: OpOutcome[] = []
      let failed = false
      for (const [index, op] of ops.entries()) {
        if (failed && stop) {
          outcomes.push({ index, tool: op.tool, status: 'skipped' })
          continue
        }
        const outcome = await runOp(server, index, op, extra)
        if (outcome.status === 'error') failed = true
        outcomes.push(outcome)
      }
      const summary = {
        ok: outcomes.every((o) => o.status === 'ok'),
        results: outcomes.map(({ index, tool, status, error }) => ({
          index,
          tool,
          status,
          ...(error ? { error } : {}),
        })),
      }
      const content: Block[] = ctx.text(summary).content
      for (const o of outcomes) {
        if (!o.content) continue
        content.push({ type: 'text', text: `--- op ${o.index} ${o.tool} ---` }, ...o.content)
      }
      return { content } as unknown as CallToolResult
    },
  )
}

/** The resident agent already runs several tool calls per turn, so it has no batch tool. */
export const residentTools: ResidentAgentTool[] = []
