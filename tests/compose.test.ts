import { describe, expect, it } from 'vitest'
import { composeDocument, type ComposeSource } from '../server/compose.ts'

/* The two smoke-script fixtures: a real document carries the head rules, a fragment carries the section. */
const a = `<!doctype html><html><head><link rel="stylesheet" href="https://x/a.css"><style>
:root{--c:red;color:#111}*{box-sizing:border-box}body{margin:0;background:#fff}
@font-face{font-family:Inter;src:url(a.woff2)}@font-face{font-family:Unused;src:url(u.woff2)}
@keyframes pulse{to{opacity:.5}}
.title{color:var(--c);font-family:Inter;animation:pulse 1s}
.a + .b{margin:1px}
body > section:nth-child(3) h2{x:y}
</style></head><body><section class="b"><h2 class="title">A</h2></section></body></html>`
const b = `<html><head><link rel="stylesheet" href="https://x/a.css"><style>body{margin:9px}.title{color:blue}@keyframes pulse{to{opacity:.1}}.title{animation:pulse 2s}</style></head><body><div class="w"><p class="title" style="x:y">B</p></div></body></html>`

const makeSource = (frameId: string, frameName: string, html: string, open: string, close: string): ComposeSource => ({
  frameId,
  frameName,
  html,
  start: html.indexOf(open),
  end: html.indexOf(close) + close.length,
})

const sourceA = makeSource('f1', 'A', a, '<section', '</section>')
const sourceB = makeSource('f2', 'B', b, '<div', '</div>')

/** The contents of one section's style element, without the element itself. */
const sectionCss = (html: string, scope: string) => {
  const marker = `<style data-doop-compose="${scope}">`
  const start = html.indexOf(marker) + marker.length
  return html.slice(start, html.indexOf('</style>', start))
}

describe('composeDocument', () => {
  it('keeps each source .title rule inside its own section scope', () => {
    const result = composeDocument([sourceA, sourceB])
    const first = sectionCss(result.html, 's0-f1')
    const second = sectionCss(result.html, 's1-f2')

    expect(first).toContain('[data-doop-section="s0-f1"]')
    expect(second).toContain('[data-doop-section="s1-f2"]')
    expect(first).toContain('color:var(--c)')
    expect(first).toContain('--c: red')
    expect(second).toContain('color:blue')
    expect(first).not.toContain('blue')
    expect(second).not.toContain('red')
  })

  it('lands a source custom property on that section root only', () => {
    const result = composeDocument([sourceA, sourceB])

    expect(sectionCss(result.html, 's0-f1')).toContain(':where([data-doop-section="s0-f1"]) {--c: red')
    expect(sectionCss(result.html, 's1-f2')).not.toContain('--c')
  })

  it('renames each source own @keyframes per scope', () => {
    const result = composeDocument([sourceA, sourceB])

    expect(result.html).toContain('@keyframes pulse__s0-f1')
    expect(result.html).toContain('@keyframes pulse__s1-f2')
    expect(result.html).toContain('animation:pulse__s0-f1 1s')
    expect(result.html).toContain('animation:pulse__s1-f2 2s')
    expect(result.sections[0]!.keyframes).toEqual(['pulse__s0-f1'])
    expect(result.sections[1]!.keyframes).toEqual(['pulse__s1-f2'])
  })

  it('carries a used @font-face and leaves an unused one out', () => {
    const result = composeDocument([sourceA, sourceB])

    expect(result.sections[0]!.fonts).toEqual(['Inter'])
    expect(result.html).toContain('font-family:Inter;src:url(a.woff2)')
    expect(result.html).not.toContain('Unused')
  })

  it('reports selectors that cannot be carried and drops them from the output', () => {
    const result = composeDocument([sourceA, sourceB])
    const dropped = result.sections[0]!.dropped

    for (const selector of ['body > section:nth-child(3) h2', '.a + .b']) {
      const entry = dropped.find((rule) => rule.selector === selector)
      expect(entry).toBeDefined()
      expect(entry!.reason.length).toBeGreaterThan(0)
      expect(result.html).not.toContain(selector)
    }
  })

  it('deduplicates head tags shared by the sources', () => {
    const result = composeDocument([sourceA, sourceB])
    const link = '<link rel="stylesheet" href="https://x/a.css">'

    expect(result.html.split(link).length - 1).toBe(1)
    expect(result.headTags).toHaveLength(1)
  })

  it('takes document rules from the first source only', () => {
    const result = composeDocument([sourceA, sourceB])
    const start = result.html.indexOf('<style data-doop-compose-base>')
    const base = result.html.slice(start, result.html.indexOf('</style>', start))

    expect(base).toContain('margin:0')
    expect(base).not.toContain('margin:9px')
    expect(result.documentRulesFrom).toBe('f1')
    expect(result.sections[1]!.dropped.some((rule) => rule.selector === 'body')).toBe(true)
  })

  it('leaves section markup byte-identical apart from the inserted attribute', () => {
    const one = `<!doctype html><html><head><style>.card{color:red}.card .label{font-weight:700}</style></head><body><section class="card" data-kind="one" style="padding:2px"><div class="inner" id="wrap"><span class="label" style="color:blue">one</span><em>!</em></div></section></body></html>`
    const two = `<!doctype html><html><head><style>.panel{color:green}</style></head><body><section id="two" class="panel" aria-label="two" style="margin:1px"><ul><li class="label">two</li><li data-z="1">2</li></ul></section></body></html>`
    const sources = [
      makeSource('x1', 'One', one, '<section', '</section>'),
      makeSource('x2', 'Two', two, '<section', '</section>'),
    ]
    const result = composeDocument(sources)

    sources.forEach((source, index) => {
      const scope = result.sections[index]!.scope
      const original = source.html.slice(source.start, source.end)
      const stripped = result.html.replace(` data-doop-section="${scope}"`, '')
      expect(stripped).toContain(original)
    })
  })

  it('writes an escaped title only when asked', () => {
    const withTitle = composeDocument([sourceA, sourceB], { title: 'A & B' })
    const withoutTitle = composeDocument([sourceA, sourceB])

    expect(withTitle.html).toContain('<title>A &amp; B</title>')
    expect(withoutTitle.html).not.toContain('<title>')
  })

  it('rejects a range that is not one element outer HTML', () => {
    const broken: ComposeSource = { ...sourceA, start: sourceA.start + 1 }

    expect(() => composeDocument([broken])).toThrow()
  })
})
