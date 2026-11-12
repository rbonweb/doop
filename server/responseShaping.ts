import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { REVIEW_NUDGE } from './reviewNudge.ts'

/** Clients that read `structuredContent` and show it in place of the text blocks, so the JSON text is dead weight for them. Lower-case. */
export const STRUCTURED_CONTENT_CLIENTS: ReadonlySet<string> = new Set(['claude-code'])

const MAX_SESSIONS = 2_000
const MAX_FRAMES_PER_SESSION = 500
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000
const STREAM_REMINDER = `Stream complete. ${REVIEW_NUDGE}`

interface ReminderRecord {
  frames: Set<string>
  touchedAt: number
}

/** sessionKey -> frames already reminded, least recently used first */
const reminded = new Map<string, ReminderRecord>()

/** True the first time `frameId` is seen in `sessionKey` (and records it), false after. */
function firstReminder(sessionKey: string, frameId: string, now = Date.now()): boolean {
  for (const [key, record] of reminded) {
    if (now - record.touchedAt <= SESSION_IDLE_MS) break
    reminded.delete(key)
  }
  const record = reminded.get(sessionKey) ?? { frames: new Set<string>(), touchedAt: now }
  reminded.delete(sessionKey)
  record.touchedAt = now
  reminded.set(sessionKey, record)
  if (reminded.size > MAX_SESSIONS) {
    const oldest = reminded.keys().next().value
    if (oldest !== undefined) reminded.delete(oldest)
  }
  if (record.frames.has(frameId)) return false
  record.frames.add(frameId)
  if (record.frames.size > MAX_FRAMES_PER_SESSION) {
    const oldest = record.frames.values().next().value
    if (oldest !== undefined) record.frames.delete(oldest)
  }
  return true
}

/** Forgets every recorded reminder (tests). */
export function resetReminders(): void {
  reminded.clear()
}

type Block = { type?: unknown; text?: unknown; [key: string]: unknown }
interface ToolResult {
  content?: Block[]
  structuredContent?: unknown
  [key: string]: unknown
}

const isTextBlock = (block: Block): block is Block & { text: string } =>
  block.type === 'text' && typeof block.text === 'string'

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The frame a result is about: the call's `frame_id`, else the `frame.id` of the JSON payload in the first text block. */
function frameOf(args: unknown, content: Block[]): string | undefined {
  if (args && typeof args === 'object') {
    const { frame_id } = args as Record<string, unknown>
    if (typeof frame_id === 'string' && frame_id) return frame_id
  }
  const first = content.find(isTextBlock)
  const frame = first ? parseObject(first.text)?.frame : undefined
  if (frame && typeof frame === 'object') {
    const { id } = frame as Record<string, unknown>
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

/** Drops the review reminder from a result that already gave it to this session for this frame. */
function thinReminders(result: ToolResult, args: unknown, sessionKey: string): ToolResult {
  const content = result.content
  if (!content?.some((block) => isTextBlock(block) && (block.text === REVIEW_NUDGE || block.text === STREAM_REMINDER)))
    return result
  const frameId = frameOf(args, content)
  if (!frameId || firstReminder(sessionKey, frameId)) return result
  const kept: Block[] = []
  for (const block of content) {
    if (!isTextBlock(block)) kept.push(block)
    else if (block.text === STREAM_REMINDER) kept.push({ ...block, text: 'Stream complete.' })
    else if (block.text !== REVIEW_NUDGE) kept.push(block)
  }
  return { ...result, content: kept }
}

/** One line naming the tool, the object and the size of each list in a JSON payload. */
function summaryLine(tool: string, payload: Record<string, unknown>): string {
  const { id, name } = payload
  const subject = [typeof name === 'string' && name ? `"${name}"` : '', typeof id === 'string' && id ? `(${id})` : '']
    .filter(Boolean)
    .join(' ')
  const counts = Object.entries(payload)
    .flatMap(([key, value]) => (Array.isArray(value) ? [`${value.length} ${key}`] : []))
    .join(', ')
  const head = [tool, subject].filter(Boolean).join(' ')
  return `${head}${counts ? `: ${counts}` : ''}. Full data in structuredContent.`
}

/** Replaces the JSON payload text block of a read with one line; the other blocks stay. */
function summariseRead(tool: string, result: ToolResult): ToolResult {
  const content = result.content
  if (!content || result.structuredContent === undefined) return result
  const index = content.findIndex(isTextBlock)
  const first = content[index]
  if (!first || !isTextBlock(first)) return result
  const payload = parseObject(first.text)
  if (!payload) return result
  const next = [...content]
  next[index] = { ...first, text: summaryLine(tool, payload) }
  return { ...result, content: next }
}

/**
 * Every tool registered on `server` from here on has its result shaped for the client that called it: the review reminder goes out once per frame per session (`sessionKey`), and a read-only tool's JSON text becomes one line for clients that read `structuredContent` (`STRUCTURED_CONTENT_CLIENTS`). Any other or unknown client keeps the full text.
 * `clientName` is asked only when a read with `structuredContent` is about to be summarised.
 */
export function shapeResponses(
  server: McpServer,
  opts: { sessionKey: string | undefined; clientName: () => Promise<string | undefined> },
): void {
  type Register = typeof server.registerTool
  type Callback = Parameters<Register>[2]
  const register: Register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: Parameters<Register>[1], callback: Callback) => {
    const readOnly = (config as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true
    return register(name, config, (async (...params: unknown[]) => {
      const raw: unknown = await (callback as (...forwarded: unknown[]) => unknown)(...params)
      if (!raw || typeof raw !== 'object') return raw
      let result = raw as ToolResult
      const args = params.length > 1 ? params[0] : undefined
      if (opts.sessionKey) result = thinReminders(result, args, opts.sessionKey)
      if (readOnly && result.structuredContent !== undefined) {
        const client = (await opts.clientName())?.toLowerCase()
        if (client && STRUCTURED_CONTENT_CLIENTS.has(client)) result = summariseRead(name, result)
      }
      return result
    }) as unknown as Callback)
  }) as Register
}
