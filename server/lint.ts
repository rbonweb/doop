/* Design lint: rule engine over a FrameMeasurement, pure so it is cheap to test. */

import { normalizeColor } from './colorMath.ts'
import type { FrameMeasurement, LintReport, LintResult, LintRules, MeasuredSection, TextBlock } from './measureTypes.ts'

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const idOf = (item: { element_id: string | null; selector: string }) => item.element_id ?? item.selector

const firstChars = (text: string) => text.slice(0, 40)

/** Collects offenders, keeping one entry per id, plus details that do not name an offender. */
function collector() {
  const offenders: string[] = []
  const details: string[] = []
  const seen = new Set<string>()
  let failed = false
  return {
    add(id: string, detail: string) {
      if (seen.has(id)) return
      seen.add(id)
      offenders.push(id)
      details.push(detail)
    },
    note(detail: string) {
      details.push(detail)
    },
    fail() {
      failed = true
    },
    result(rule: keyof LintRules): LintResult {
      return { rule, pass: !failed && offenders.length === 0, offenders, details }
    },
  }
}

function checkSectionHeights(m: FrameMeasurement, max: number): LintResult {
  const c = collector()
  for (const section of m.sections) {
    if (section.box.height > max) {
      const id = idOf(section)
      c.add(id, `${id} is ${Math.round(section.box.height)}px tall (max ${max})`)
    }
  }
  return c.result('max_section_height')
}

function checkHeadingLines(m: FrameMeasurement, max: number): LintResult {
  const c = collector()
  for (const section of m.sections) {
    for (const block of section.texts) {
      if (!HEADING_TAGS.has(block.tag.toLowerCase()) || block.lines <= max) continue
      const id = idOf(block)
      c.add(id, `${id} "${firstChars(block.text)}" runs ${block.lines} lines (max ${max})`)
    }
  }
  return c.result('max_heading_lines')
}

function checkTextLines(m: FrameMeasurement, rules: NonNullable<LintRules['max_text_lines']>): LintResult {
  const c = collector()
  for (const rule of rules) {
    const query = m.queries.find((entry) => entry.selector === rule.selector)
    if (!query || query.matches.length === 0) {
      c.note(`${rule.selector} matches nothing`)
      c.fail()
      continue
    }
    for (const match of query.matches) {
      if (match.lines <= rule.max) continue
      const id = idOf(match)
      c.add(id, `${id} runs ${match.lines} lines (max ${rule.max})`)
    }
  }
  return c.result('max_text_lines')
}

const baseHex = (color: string) => normalizeColor(color)?.slice(0, 7) ?? color.toLowerCase()

function checkPalette(m: FrameMeasurement, values: string[]): LintResult {
  const c = collector()
  const allowed = new Set<string>()
  for (const value of values) {
    const hex = normalizeColor(value)
    if (!hex) {
      c.note(`unreadable colour ${value}`)
      continue
    }
    allowed.add(hex.slice(0, 7))
  }
  const usedBy = new Map<string, string[]>()
  for (const section of m.sections) {
    for (const color of section.colors) {
      const hex = baseHex(color)
      const ids = usedBy.get(hex) ?? []
      const id = idOf(section)
      if (!ids.includes(id)) ids.push(id)
      usedBy.set(hex, ids)
    }
  }
  for (const color of m.colors) {
    const hex = baseHex(color)
    if (allowed.has(hex)) continue
    const ids = (usedBy.get(hex) ?? []).slice(0, 5)
    const where = ids.length > 0 ? ` (used in ${ids.join(', ')})` : ''
    c.add(hex, `${hex} is not in the palette${where}`)
  }
  return c.result('allowed_colors')
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function checkBannedWords(m: FrameMeasurement, words: string[]): LintResult {
  const c = collector()
  for (const word of words) {
    const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi')
    const count = m.text.match(pattern)?.length ?? 0
    if (count > 0) c.add(word, `"${word}" appears ${count} times`)
  }
  return c.result('banned_words')
}

function checkOverflow(m: FrameMeasurement): LintResult {
  const c = collector()
  const visit = (item: MeasuredSection | TextBlock) => {
    if (!item.overflow && !item.clipped) return
    const id = idOf(item)
    c.add(id, `${id} ${item.overflow ? 'overflows' : 'is clipped'}`)
  }
  for (const section of m.sections) {
    visit(section)
    for (const block of section.texts) visit(block)
  }
  return c.result('no_overflow')
}

function checkContrast(m: FrameMeasurement, min: number): LintResult {
  const c = collector()
  let unchecked = 0
  for (const section of m.sections) {
    for (const block of section.texts) {
      if (block.contrast === null) {
        unchecked += 1
        continue
      }
      const floor = block.large && min === 4.5 ? Math.min(min, 3) : min
      if (block.contrast >= floor) continue
      const id = idOf(block)
      c.add(id, `${id} "${firstChars(block.text)}" contrast ${block.contrast}:1 (min ${floor})`)
    }
  }
  if (unchecked > 0) c.note(`${unchecked} text blocks sit on images or gradients and were not checked`)
  return c.result('min_contrast')
}

/** Runs every rule present in `rules` (fixed order) and passes only when all of them pass. */
export function lintMeasurement(m: FrameMeasurement, rules: LintRules): LintReport {
  const results: LintResult[] = []
  if (rules.max_section_height !== undefined) results.push(checkSectionHeights(m, rules.max_section_height))
  if (rules.max_heading_lines !== undefined) results.push(checkHeadingLines(m, rules.max_heading_lines))
  if (rules.max_text_lines !== undefined) results.push(checkTextLines(m, rules.max_text_lines))
  if (rules.allowed_colors !== undefined) results.push(checkPalette(m, rules.allowed_colors))
  if (rules.banned_words !== undefined) results.push(checkBannedWords(m, rules.banned_words))
  if (rules.no_overflow === true) results.push(checkOverflow(m))
  if (rules.min_contrast !== undefined) results.push(checkContrast(m, rules.min_contrast))
  return { pass: results.every((result) => result.pass), results }
}
