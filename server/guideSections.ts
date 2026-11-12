export interface GuideSection {
  title: string
  slug: string
  body: string
}

interface Heading {
  index: number
  title: string
}

/** The guide's `## ` sections in order (a `## ` line inside a ``` fence is not a heading); body runs from its heading line up to the next heading, trimmed. Text before the first heading is not a section. */
export function guideSections(markdown: string): GuideSection[] {
  const lines = markdown.split('\n')
  const headings: Heading[] = []
  let inFence = false
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.startsWith('## ')) continue
    headings.push({ index, title: line.slice(3).trim() })
  }
  return headings.map((heading, position) => {
    const next = headings[position + 1]
    const body = lines
      .slice(heading.index, next ? next.index : lines.length)
      .join('\n')
      .trim()
    return { title: heading.title, slug: slugify(heading.title), body }
  })
}

/** slug: lower case, every run of characters other than a-z and 0-9 becomes one '-', trimmed of '-' */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The section whose slug equals slugify(wanted), else whose title equals wanted ignoring case, else the first whose title starts with wanted ignoring case; undefined when none. */
export function findGuideSection(markdown: string, wanted: string): GuideSection | undefined {
  const sections = guideSections(markdown)
  const wantedSlug = slugify(wanted)
  const wantedTitle = wanted.trim().toLowerCase()
  const bySlug = sections.find((section) => section.slug === wantedSlug)
  if (bySlug) return bySlug
  const byTitle = sections.find((section) => section.title.toLowerCase() === wantedTitle)
  if (byTitle) return byTitle
  return sections.find((section) => section.title.toLowerCase().startsWith(wantedTitle))
}

/** One line per section: `- <slug>: <title> (<n> KB)` with KB rounded to one decimal, preceded by the line `Sections of the Doop guide (pass one as section):`. */
export function guideIndex(markdown: string): string {
  const lines = guideSections(markdown).map((section) => {
    const kb = Math.round((Buffer.byteLength(section.body, 'utf8') / 1024) * 10) / 10
    return `- ${section.slug}: ${section.title} (${kb.toFixed(1)} KB)`
  })
  return ['Sections of the Doop guide (pass one as section):', ...lines].join('\n')
}
