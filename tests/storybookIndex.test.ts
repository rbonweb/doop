import { describe, expect, it } from 'vitest'
import { MAX_INDEX_ENTRIES, parseStorybookIndex } from '../shared/storybook/index.ts'

const v5 = {
  v: 5,
  entries: {
    'inputs-button--primary': {
      type: 'story',
      id: 'inputs-button--primary',
      name: 'Primary',
      title: 'Inputs/Button',
      importPath: './b.tsx',
      tags: ['dev', 'autodocs'],
    },
    'inputs-button--secondary': {
      type: 'story',
      id: 'inputs-button--secondary',
      name: 'Secondary',
      title: 'Inputs/Button',
      importPath: './b.tsx',
      tags: ['dev'],
    },
    'inputs-button--docs': {
      type: 'docs',
      id: 'inputs-button--docs',
      name: 'Docs',
      title: 'Inputs/Button',
      importPath: './b.mdx',
      storiesImports: [],
      tags: ['unattached-mdx'],
    },
  },
}

describe('parseStorybookIndex', () => {
  it('reads index.json v5 and skips docs entries', () => {
    const { entries, issues } = parseStorybookIndex(v5)
    expect(entries.map((entry) => entry.id)).toEqual(['inputs-button--primary', 'inputs-button--secondary'])
    expect(entries[0]).toEqual({
      id: 'inputs-button--primary',
      title: 'Inputs/Button',
      name: 'Primary',
      type: 'story',
      tags: ['dev', 'autodocs'],
      importPath: './b.tsx',
    })
    expect(issues).toEqual([])
  })

  it('keeps the story file and the component file as plain bounded text, nothing else', () => {
    const { entries } = parseStorybookIndex({
      v: 5,
      entries: {
        'a--x': {
          id: 'a--x',
          title: 'A',
          name: 'X',
          type: 'story',
          importPath: './a.stories.tsx',
          componentPath: './a.tsx',
        },
        'b--x': {
          id: 'b--x',
          title: 'B',
          name: 'X',
          type: 'story',
          importPath: { evil: 1 },
          componentPath: 'x'.repeat(301),
        },
      },
    })
    expect(entries.map((entry) => [entry.importPath, entry.componentPath])).toEqual([
      ['./a.stories.tsx', './a.tsx'],
      [undefined, undefined],
    ])
  })

  it('reads index.json v4', () => {
    const { entries } = parseStorybookIndex({ ...v5, v: 4 })
    expect(entries).toHaveLength(2)
  })

  it('reads stories.json v3 (kind and story, docsOnly skipped)', () => {
    const { entries, issues } = parseStorybookIndex({
      v: 3,
      stories: {
        'card--basic': { id: 'card--basic', kind: 'Card', story: 'Basic', importPath: './c.tsx' },
        'card--docs': { id: 'card--docs', kind: 'Card', story: 'Docs', parameters: { docsOnly: true } },
      },
    })
    expect(entries).toEqual([
      { id: 'card--basic', title: 'Card', name: 'Basic', type: 'story', tags: [], importPath: './c.tsx' },
    ])
    expect(issues).toEqual([])
  })

  it('says so when only docs are listed', () => {
    const { entries, issues } = parseStorybookIndex({
      v: 5,
      entries: { 'a--docs': { type: 'docs', id: 'a--docs', name: 'Docs', title: 'A' } },
    })
    expect(entries).toEqual([])
    expect(issues[0]?.code).toBe('index_docs_only')
  })

  it.each([
    null,
    'x',
    7,
    [],
    {},
    { v: 'five' },
    { v: 5 },
    { v: 9, entries: {} },
    { v: 2, stories: {} },
    { v: 3, entries: {} },
  ])('never throws and returns nothing for %j', (input) => {
    const { entries, issues } = parseStorybookIndex(input)
    expect(entries).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('drops malformed entries one by one and counts them', () => {
    const { entries, issues } = parseStorybookIndex({
      v: 5,
      entries: {
        ok: { type: 'story', id: 'ok', name: 'Ok', title: 'A' },
        'bad id!': { type: 'story', id: 'bad id!', name: 'Bad', title: 'A' },
        mismatch: { type: 'story', id: 'other', name: 'M', title: 'A' },
        'no-title': { type: 'story', id: 'no-title', name: 'N' },
        'not-object': 'story',
        'weird-type': { type: 'component', id: 'weird-type', name: 'W', title: 'A' },
        'long-title': { type: 'story', id: 'long-title', name: 'L', title: 'x'.repeat(400) },
        numbers: { type: 'story', id: 'numbers', name: 5, title: 'A' },
      },
    })
    expect(entries.map((entry) => entry.id)).toEqual(['ok'])
    expect(issues).toEqual([
      expect.objectContaining({ code: 'index_entries_dropped', message: expect.stringContaining('7 ') }),
    ])
  })

  it('drops a __proto__ entry, and ignores non-array or hostile tags', () => {
    const hostile = JSON.parse(
      '{"v":5,"entries":{"__proto__":{"type":"story","id":"__proto__","name":"P","title":"Proto"},"a--b":{"type":"story","id":"a--b","name":"B","title":"A","tags":"dev"},"c--d":{"type":"story","id":"c--d","name":"D","title":"C","tags":[1,"ok","x",{"a":1}]}}}',
    )
    const { entries } = parseStorybookIndex(hostile)
    expect(entries.map((entry) => [entry.id, entry.tags])).toEqual([
      ['a--b', []],
      ['c--d', ['ok', 'x']],
    ])
    expect(({} as Record<string, unknown>).title).toBeUndefined()
  })

  it('caps the number of stories and says so', () => {
    const entries: Record<string, unknown> = {}
    for (let i = 0; i < MAX_INDEX_ENTRIES + 25; i++)
      entries[`c${i}--s`] = { type: 'story', id: `c${i}--s`, name: 'S', title: `C${i}` }
    const parsed = parseStorybookIndex({ v: 5, entries })
    expect(parsed.entries).toHaveLength(MAX_INDEX_ENTRIES)
    expect(parsed.issues.map((issue) => issue.code)).toContain('index_too_large')
  })

  it('looks at a bounded number of keys before parsing, and says so', () => {
    const entries: Record<string, unknown> = {}
    for (let i = 0; i < MAX_INDEX_ENTRIES * 2 + 500; i++) entries[`junk${i}`] = 'not an entry'
    entries.late = { type: 'story', id: 'late', name: 'L', title: 'T' }
    const parsed = parseStorybookIndex({ v: 5, entries })
    expect(parsed.entries).toEqual([])
    expect(parsed.issues.map((issue) => issue.code)).toContain('index_too_large')
  })

  it('keeps the first of a repeated id', () => {
    const { entries } = parseStorybookIndex({
      v: 5,
      entries: { a: { type: 'story', id: 'a', name: 'One', title: 'T' } },
    })
    expect(entries).toHaveLength(1)
  })
})
