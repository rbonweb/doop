import { z } from 'zod'

/** Pure: no node or server imports, since the CLI bundles it. Reads Storybook's story index, whatever a published Storybook (or a hostile server pretending to be one) sends. */

export const MAX_INDEX_ENTRIES = 5000
const MAX_ID = 200
const MAX_TITLE = 300
const MAX_NAME = 200
const MAX_TAGS = 20
const MAX_TAG = 60

export interface StorybookIssue {
  component?: string
  code: string
  message: string
}

export interface StoryEntry {
  id: string
  /** the title path, "Inputs/Button" */
  title: string
  name: string
  type: 'story'
  tags: string[]
}

export interface ParsedIndex {
  entries: StoryEntry[]
  issues: StorybookIssue[]
}

/** A story id goes into a URL and a bundle: lowercase words joined by `-` and `--`, as Storybook makes them, nothing else. */
const STORY_ID = /^[A-Za-z0-9_.-]{1,200}$/

const rawEntry = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  story: z.string().optional(),
  type: z.string().optional(),
  tags: z.unknown().optional(),
  parameters: z.unknown().optional(),
})

const rawIndex = z.object({
  v: z.number().int(),
  entries: z.record(z.string(), z.unknown()).optional(),
  stories: z.record(z.string(), z.unknown()).optional(),
})

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const tags: string[] = []
  for (const tag of raw) {
    if (typeof tag === 'string' && tag.length <= MAX_TAG && tags.length < MAX_TAGS) tags.push(tag)
  }
  return tags
}

function isDocsOnly(parameters: unknown): boolean {
  if (typeof parameters !== 'object' || parameters === null) return false
  return (parameters as { docsOnly?: unknown }).docsOnly === true
}

/** Storybook's `index.json` (v4, v5) and the older `stories.json` (v3) to the stories it lists. Docs entries and malformed entries are skipped and said so; nothing here throws. */
export function parseStorybookIndex(json: unknown): ParsedIndex {
  const issues: StorybookIssue[] = []
  const top = rawIndex.safeParse(json)
  if (!top.success) {
    return {
      entries: [],
      issues: [{ code: 'index_malformed', message: 'The story index is not a Storybook index.json' }],
    }
  }
  const { v } = top.data
  const table = v >= 4 ? top.data.entries : v === 3 ? top.data.stories : undefined
  if (v < 3 || v > 5 || !table) {
    return {
      entries: [],
      issues: [{ code: 'index_version', message: `Storybook index version ${v} is not supported (3, 4 and 5 are)` }],
    }
  }
  const entries: StoryEntry[] = []
  const seen = new Set<string>()
  let docs = 0
  let dropped = 0
  let overflow = 0
  for (const [key, value] of Object.entries(table)) {
    const parsed = rawEntry.safeParse(value)
    if (!parsed.success) {
      dropped++
      continue
    }
    const raw = parsed.data
    if (raw.type === 'docs' || (v === 3 && isDocsOnly(raw.parameters))) {
      docs++
      continue
    }
    if (raw.type !== undefined && raw.type !== 'story') {
      dropped++
      continue
    }
    const id = raw.id ?? key
    const title = (raw.title ?? raw.kind)?.trim()
    const name = (raw.name ?? raw.story)?.trim()
    if (id !== key || !STORY_ID.test(id) || id.length > MAX_ID || !title || !name || seen.has(id)) {
      dropped++
      continue
    }
    if (title.length > MAX_TITLE || name.length > MAX_NAME) {
      dropped++
      continue
    }
    if (entries.length >= MAX_INDEX_ENTRIES) {
      overflow++
      continue
    }
    seen.add(id)
    entries.push({ id, title, name, type: 'story', tags: cleanTags(raw.tags) })
  }
  if (dropped)
    issues.push({ code: 'index_entries_dropped', message: `${dropped} index entries were malformed and skipped` })
  if (overflow) {
    issues.push({
      code: 'index_too_large',
      message: `The index lists more than ${MAX_INDEX_ENTRIES} stories; the first ${MAX_INDEX_ENTRIES} were read`,
    })
  }
  if (docs && !entries.length)
    issues.push({ code: 'index_docs_only', message: 'The index lists documentation pages and no stories' })
  return { entries, issues }
}
