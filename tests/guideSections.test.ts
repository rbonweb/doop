import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { DOOP_GUIDE } from '../server/guide.ts'
import { findGuideSection, guideIndex, guideSections, slugify } from '../server/guideSections.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

const FIXTURE = `Intro before any heading.

## Frames and HTML

Frames are self-contained HTML documents.

\`\`\`html
## not a heading inside a fence
<p>hello</p>
\`\`\`

## Review checkpoints

Review what you design.

### A sub-heading stays in its section

## Pages

Pages group frames.
`

async function guideClient() {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'guide-section-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content
  return (content ?? []).map((block) => block.text ?? '').join('')
}

describe('guideSections', () => {
  it('splits on ## headings and ignores a ## line inside a fence', () => {
    const sections = guideSections(FIXTURE)
    expect(sections.map((section) => section.title)).toEqual(['Frames and HTML', 'Review checkpoints', 'Pages'])
    expect(sections[0]!.body).toContain('<p>hello</p>')
    expect(sections[1]!.body).toContain('### A sub-heading stays in its section')
    expect(sections.some((section) => section.title === 'not a heading inside a fence')).toBe(false)
  })

  it('drops the text before the first heading', () => {
    expect(guideSections(FIXTURE).some((section) => section.body.includes('Intro before any heading'))).toBe(false)
  })

  it('slugifies titles', () => {
    expect(slugify('Frames and HTML')).toBe('frames-and-html')
    expect(slugify('  Review checkpoints — MANDATORY ')).toBe('review-checkpoints-mandatory')
  })

  it('finds a section by slug, exact title and title prefix', () => {
    expect(findGuideSection(FIXTURE, 'frames-and-html')?.title).toBe('Frames and HTML')
    expect(findGuideSection(FIXTURE, 'Frames and HTML')?.title).toBe('Frames and HTML')
    expect(findGuideSection(FIXTURE, 'review')?.title).toBe('Review checkpoints')
  })

  it('returns undefined for an unknown section', () => {
    expect(findGuideSection(FIXTURE, 'nope')).toBeUndefined()
  })

  it('returns undefined for a blank section instead of prefix-matching the first', () => {
    expect(findGuideSection(FIXTURE, '')).toBeUndefined()
    expect(findGuideSection(FIXTURE, '   ')).toBeUndefined()
  })

  it('lists every section with its slug, title and size', () => {
    const index = guideIndex(FIXTURE)
    expect(index.split('\n')).toEqual([
      'Sections of the Doop guide (pass one as section):',
      '- frames-and-html: Frames and HTML (0.1 KB)',
      '- review-checkpoints: Review checkpoints (0.1 KB)',
      '- pages: Pages (0.0 KB)',
    ])
  })
})

describe('the real guide', () => {
  it('has at least 20 sections with unique slugs', () => {
    const sections = guideSections(DOOP_GUIDE)
    expect(sections.length).toBeGreaterThanOrEqual(20)
    const slugs = sections.map((section) => section.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('invents nothing: the bodies plus the preamble are no longer than the guide', () => {
    const sections = guideSections(DOOP_GUIDE)
    const firstHeading = DOOP_GUIDE.indexOf('\n## ')
    const preamble = firstHeading === -1 ? '' : DOOP_GUIDE.slice(0, firstHeading + 1)
    expect(preamble.length + sections.map((section) => section.body).join('\n').length).toBeLessThanOrEqual(
      DOOP_GUIDE.length,
    )
  })
})

describe('get_guide sections over MCP', () => {
  it('returns the whole guide when no section is given', async () => {
    const client = await guideClient()
    try {
      const result = await client.callTool({ name: 'get_guide', arguments: { topic: 'doop-instructions' } })
      expect(textOf(result)).toBe(DOOP_GUIDE)
    } finally {
      await client.close()
    }
  })

  it('returns the index for section "index"', async () => {
    const client = await guideClient()
    try {
      const result = await client.callTool({
        name: 'get_guide',
        arguments: { topic: 'doop-instructions', section: 'index' },
      })
      expect(textOf(result)).toBe(guideIndex(DOOP_GUIDE))
      expect(textOf(result)).toContain('Sections of the Doop guide (pass one as section):')
    } finally {
      await client.close()
    }
  })

  it('returns one section by slug', async () => {
    const client = await guideClient()
    try {
      const section = guideSections(DOOP_GUIDE)[0]!
      const result = await client.callTool({
        name: 'get_guide',
        arguments: { topic: 'doop-instructions', section: section.slug },
      })
      expect(textOf(result)).toBe(section.body)
    } finally {
      await client.close()
    }
  })

  it('names the sections when the section is unknown', async () => {
    const client = await guideClient()
    try {
      const result = await client.callTool({
        name: 'get_guide',
        arguments: { topic: 'doop-instructions', section: 'no-such-section' },
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('no guide section "no-such-section"')
      expect(textOf(result)).toContain(guideSections(DOOP_GUIDE)[0]!.slug)
    } finally {
      await client.close()
    }
  })

  it('refuses a blank section instead of returning the first one', async () => {
    const client = await guideClient()
    try {
      const result = await client.callTool({
        name: 'get_guide',
        arguments: { topic: 'doop-instructions', section: '   ' },
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('no guide section "   "')
    } finally {
      await client.close()
    }
  })
})
