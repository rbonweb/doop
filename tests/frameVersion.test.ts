import { describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types.ts'
import { frameVersion, parseExpectedVersion, versionConflict } from '../server/frameVersion.ts'

const frame = { id: 'f1', updatedAt: 1700000000123, updatedBy: 'Ann', updatedByKind: 'agent' } as Frame

describe('frameVersion', () => {
  it('round trips updatedAt through ISO', () => {
    const iso = frameVersion({ updatedAt: 1700000000123 })
    expect(iso).toBe(new Date(1700000000123).toISOString())
    expect(Date.parse(iso)).toBe(1700000000123)
  })
})

describe('parseExpectedVersion', () => {
  it('parses an ISO string', () => {
    expect(parseExpectedVersion(new Date(1700000000123).toISOString())).toBe(1700000000123)
  })

  it('passes a finite number through', () => {
    expect(parseExpectedVersion(1700000000123)).toBe(1700000000123)
    expect(parseExpectedVersion(Number.NaN)).toBeUndefined()
    expect(parseExpectedVersion(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('parses a numeric string', () => {
    expect(parseExpectedVersion('1700000000123')).toBe(1700000000123)
    expect(parseExpectedVersion(' 1700000000123 ')).toBe(1700000000123)
  })

  it('returns undefined for garbage', () => {
    expect(parseExpectedVersion('not a version')).toBeUndefined()
    expect(parseExpectedVersion('')).toBeUndefined()
  })
})

describe('versionConflict', () => {
  it('accepts an undefined expectation', () => {
    expect(versionConflict(frame, undefined)).toBeUndefined()
  })

  it('accepts the current version as ISO or as a number', () => {
    expect(versionConflict(frame, frameVersion(frame))).toBeUndefined()
    expect(versionConflict(frame, frame.updatedAt)).toBeUndefined()
  })

  it('explains a stale version', () => {
    const message = versionConflict(frame, '2023-11-14T22:13:20.000Z')
    expect(message).toContain('f1')
    expect(message).toContain(frameVersion(frame))
    expect(message).toContain('Ann')
    expect(message).toContain('agent')
    expect(message).toContain('Nothing was written')
  })

  it('prints unknown when the kind is missing', () => {
    const legacy = { ...frame, updatedByKind: undefined } as Frame
    expect(versionConflict(legacy, 1)).toContain('(unknown)')
  })

  it('explains an unreadable version', () => {
    expect(versionConflict(frame, 'nope')).toBe(
      'expected_version "nope" is not a version: pass the frame\'s updatedAt from your last read',
    )
  })
})
