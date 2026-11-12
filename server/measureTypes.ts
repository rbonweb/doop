import type { FrameTarget } from './renderTypes.ts'

/** A box in design px, relative to the frame's top-left (document coordinates, scroll included). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One block of text: an element with its own visible text. */
export interface TextBlock {
  element_id: string | null
  /** a selector that finds it again: `[data-doop-id="…"]` when it has one, else a positional path */
  selector: string
  tag: string
  /** the first 80 characters of its visible text */
  text: string
  /** rendered lines, from Range.getClientRects grouped by line */
  lines: number
  font_size: number
  line_height: number
  /** text runs past the element's box and stays visible */
  overflow: boolean
  /** text is cut off by its own or an ancestor's overflow */
  clipped: boolean
  /** computed colour, `#rrggbb` (or `#rrggbbaa` when not opaque) */
  color: string
  /** the effective background behind it, `#rrggbb`; null over an image or gradient */
  background: string | null
  /** WCAG 2 contrast ratio of color on background, 2 decimals; null when the background is unknown */
  contrast: number | null
  /** WCAG large text (24px, or 18.66px bold) */
  large: boolean
}

export interface MeasuredSection {
  element_id: string | null
  /** data-doop-label, else the first heading's text */
  label: string | null
  selector: string
  tag: string
  box: Box
  overflow: boolean
  clipped: boolean
  /** every colour used inside it (text, background, border), `#rrggbb`, distinct */
  colors: string[]
  /** at most 60 per section */
  texts: TextBlock[]
}

export interface FrameMeasurement {
  /** viewport width it was measured at */
  width: number
  /** the document's full height at that width */
  height: number
  sections: MeasuredSection[]
  /** every colour in the document, distinct */
  colors: string[]
  /** only when asked (`MeasureOptions.colorSources`): for each colour, the `data-doop-id` of the first element it appears on, else a positional selector */
  color_sources?: Record<string, string>
  /** document.body.innerText, at most 200 000 characters */
  text: string
  /** answers for `MeasureOptions.lineQueries`: every element each selector matches, with its line count */
  queries: Array<{ selector: string; matches: Array<{ element_id: string | null; selector: string; lines: number }> }>
}

export interface MeasureOptions {
  /** viewport width in px; default the frame's width */
  width?: number
  /** the sections to measure; default every top-level section */
  targets?: FrameTarget[]
  /** the name an element id is stamped under when a label resolves to an element without one; absent for a read-only caller */
  stampAs?: string
  /** CSS selectors whose matches get a line count (for lint's max_text_lines) */
  lineQueries?: string[]
  /** CSS selectors: matches and everything inside them contribute no colour, text block or body text; an invalid one throws `InvalidSelectorError` */
  exclude?: string[]
  /** also report where each colour is used (`FrameMeasurement.color_sources`) */
  colorSources?: boolean
}

export interface LintRules {
  max_section_height?: number
  max_heading_lines?: number
  max_text_lines?: Array<{ selector: string; max: number }>
  allowed_colors?: string[]
  banned_words?: string[]
  no_overflow?: boolean
  min_contrast?: number
}

export interface LintResult {
  rule: keyof LintRules
  pass: boolean
  /** data-doop-id (or selector when the element has none) of each offender */
  offenders: string[]
  /** one line per offence, e.g. `#hero is 1180px tall (max 900)` */
  details: string[]
}

export interface LintReport {
  pass: boolean
  results: LintResult[]
}
