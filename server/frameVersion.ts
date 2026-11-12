import { z } from 'zod'
import type { Frame } from '../shared/types.ts'

export type ExpectedVersion = string | number

export const expectedVersionSchema = z
  .union([z.string(), z.number()])
  .optional()
  .describe(
    'The frame’s updatedAt from your last read (get_frame / get_canvas / a write’s answer). If the frame changed since, the write is refused and nothing is written.',
  )

export function frameVersion(frame: Pick<Frame, 'updatedAt'>): string {
  return new Date(frame.updatedAt).toISOString()
}

export function parseExpectedVersion(value: ExpectedVersion): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The version the caller sent, as ISO, or the raw value when it cannot be a date. */
function sentVersion(n: number, expected: ExpectedVersion): string {
  try {
    return new Date(n).toISOString()
  } catch {
    return String(expected)
  }
}

export function versionConflict(frame: Frame, expected: ExpectedVersion | undefined): string | undefined {
  if (expected === undefined) return undefined
  const n = parseExpectedVersion(expected)
  if (n === undefined)
    return `expected_version "${expected}" is not a version: pass the frame's updatedAt from your last read`
  if (n === frame.updatedAt) return undefined
  return `frame ${frame.id} changed since your read: current version ${frameVersion(frame)} by ${frame.updatedBy} (${frame.updatedByKind ?? 'unknown'}), you sent ${sentVersion(n, expected)}. Nothing was written. Re-read it (get_frame, or get_section for one part) and apply your change again.`
}

/** Thrown by an action whose own write step found the frame changed since the caller's read. */
export class FrameVersionConflictError extends Error {}
