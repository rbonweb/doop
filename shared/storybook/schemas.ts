import { isFollowableAttribute } from './bindings.ts'
import { z } from 'zod'
import { STYLE_PROPERTIES } from './capture.ts'

/** Pure: no node or server imports, since the CLI bundles it. What a story page hands back is whatever its own JavaScript says: it shares the page's world with the capture function, so the capture's caps are not a boundary. These schemas are, applied to every result right after it arrives. */

const MAX_HTML = 2_000_000
const MAX_CSS = 2_000_000
const MAX_RULE = 20_000
const MAX_CELL = 500
const MAX_ELEMENTS = 300

const issue = z.object({ code: z.string().max(60), message: z.string().max(500) })

export const capturedStorySchema = z
  .object({
    ok: z.literal(true),
    html: z.string().max(MAX_HTML),
    css: z.string().max(MAX_CSS),
    sharedRules: z.array(z.string().max(MAX_RULE)).max(500),
    shape: z.string().max(20_000),
    paths: z.array(z.string().max(MAX_CELL)).max(MAX_ELEMENTS),
    styles: z
      .array(z.array(z.string().max(MAX_CELL)).length(STYLE_PROPERTIES.length))
      .max(MAX_ELEMENTS)
      .nullable(),
    marker: z.string().max(100).optional(),
    attrs: z
      .array(
        z.record(
          z.string().refine(isFollowableAttribute, 'not an attribute a prop may follow'),
          z.string().max(MAX_CELL),
        ),
      )
      .max(MAX_ELEMENTS)
      .nullable()
      .optional(),
    texts: z.array(z.string().max(MAX_CELL)).max(MAX_ELEMENTS).nullable().optional(),
    srcs: z.array(z.string().max(MAX_CELL)).max(MAX_ELEMENTS).nullable().optional(),
    issues: z.array(issue).max(20),
  })
  .refine((captured) => captured.styles === null || captured.styles.length === captured.paths.length, {
    message: 'styles and paths do not line up',
  })

/** what `captureStory` answers when it will not hand the story over: small by construction */
export const captureRefusalSchema = z.object({
  ok: z.literal(false),
  reason: z.string().max(300),
  bytes: z.number().int().nonnegative().optional(),
})

export const storyCaptureSchema = z.union([capturedStorySchema, captureRefusalSchema])

/** Whether `value` is plain JSON of bounded size, depth and string length, checked without recursion. */
export function isBoundedJson(value: unknown, limits = { nodes: 20_000, depth: 6, string: 400 }): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const { value: current, depth } = stack.pop()!
    if (++nodes > limits.nodes || depth > limits.depth) return false
    if (current === null || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
    } else if (typeof current === 'string') {
      if (current.length > limits.string) return false
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: depth + 1 })
    } else if (typeof current === 'object') {
      for (const key of Object.keys(current)) {
        if (key.length > limits.string) return false
        stack.push({ value: (current as Record<string, unknown>)[key], depth: depth + 1 })
      }
    } else return false
  }
  return true
}

const boundedJson = z.unknown().refine((value) => isBoundedJson(value), { message: 'not bounded JSON' })

export const storyMetaSchema = z.object({
  argTypes: boundedJson,
  initialArgs: boundedJson,
  displayName: z.string().max(100).optional(),
})
