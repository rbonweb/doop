import { isTag, type Element } from 'domhandler'
import { describe, expect, it } from 'vitest'
import { applyEdits, editsForOp, frameOutline } from '../server/sectionEdits.ts'
import type { FrameDocument } from '../server/sectionTargets.ts'
import {
  describeTarget,
  instanceRefusal,
  parseFrameDocument,
  resolveTarget,
  sectionLabel,
  sectionTargetSchema,
  toResolved,
  visibleText,
  type ResolvedTarget,
  type SectionTarget,
} from '../server/sectionTargets.ts'

const PAGE =
  '<!doctype html><html><body><main data-doop-id="main-1">' +
  '<section data-doop-id="hero" class="hero" data-doop-label="Hero"><h1>Welcome</h1></section>' +
  '<section data-doop-id="pricing"><h2>Pricing</h2><p>Cheap</p></section>' +
  '</main></body></html>'

function first(result: ReturnType<typeof resolveTarget>): ResolvedTarget {
  if (!result.ok) throw new Error(`expected a match, got ${result.code}: ${result.error}`)
  return result.matches[0]!
}

function findElement(fd: FrameDocument, tag: string): Element {
  const stack = [...fd.doc.children]
  for (let node = stack.shift(); node; node = stack.shift()) {
    if (!isTag(node)) continue
    if (node.name === tag) return node
    stack.unshift(...node.children)
  }
  throw new Error(`no <${tag}> in the document`)
}

describe('resolveTarget forms', () => {
  it('resolves an element_id', () => {
    const match = first(resolveTarget(PAGE, { element_id: 'pricing' }))
    expect(match.tagName).toBe('section')
    expect(match.elementId).toBe('pricing')
    expect(match.label).toBe('Pricing')
  })

  it('resolves a label from data-doop-label and from a heading', () => {
    expect(first(resolveTarget(PAGE, { label: 'hero' })).elementId).toBe('hero')
    expect(first(resolveTarget(PAGE, { label: '  pricing  ' })).elementId).toBe('pricing')
  })

  it('resolves a selector', () => {
    const match = first(resolveTarget(PAGE, { selector: 'main > section:first-of-type' }))
    expect(match.elementId).toBe('hero')
  })

  it('describes each target form for messages', () => {
    expect(describeTarget({ element_id: 'x' })).toBe('element_id "x"')
    expect(describeTarget({ label: 'Pricing' })).toBe('label "Pricing"')
    expect(describeTarget({ selector: 'main > h1' })).toBe('selector "main > h1"')
  })
})

describe('source ranges', () => {
  const html = '<section id=a class="wide" title=\'hi\' data-flag disabled><p>One</p><img src=/x/y></section>'
  const match = first(resolveTarget(html, { selector: 'section' }))

  it('covers exactly the outer HTML as written', () => {
    expect(html.slice(match.start, match.end)).toBe(html)
  })

  it('covers the start tag and end tag exactly', () => {
    expect(html.slice(match.startTag.start, match.startTag.end)).toBe(
      '<section id=a class="wide" title=\'hi\' data-flag disabled>',
    )
    expect(match.endTag).toBeDefined()
    expect(html.slice(match.endTag!.start, match.endTag!.end)).toBe('</section>')
    expect(html.slice(match.inner.start, match.inner.end)).toBe('<p>One</p><img src=/x/y>')
  })

  it('covers double-quoted, single-quoted, unquoted and boolean attributes as written', () => {
    expect(html.slice(match.attrs.class!.start, match.attrs.class!.end)).toBe('class="wide"')
    expect(html.slice(match.attrs.title!.start, match.attrs.title!.end)).toBe("title='hi'")
    expect(html.slice(match.attrs.id!.start, match.attrs.id!.end)).toBe('id=a')
    expect(html.slice(match.attrs.disabled!.start, match.attrs.disabled!.end)).toBe('disabled')
    expect(match.attrs.class!.value).toBe('wide')
    expect(match.attrs.id!.value).toBe('a')
    expect(match.attrs.title!.value).toBe('hi')
  })

  it('gives a void element no end tag and an empty inner range', () => {
    const img = first(resolveTarget(html, { selector: 'img' }))
    expect(img.endTag).toBeUndefined()
    expect(img.inner.start).toBe(img.inner.end)
    expect(img.inner.start).toBe(img.startTag.end)
    expect(html.slice(img.start, img.end)).toBe('<img src=/x/y>')
  })

  it('covers implicitly closed elements up to their end offset', () => {
    const list = '<ul><li>a<li>b</ul>'
    const items = resolveTarget(list, { selector: 'li' }, { all: true })
    expect(items.ok).toBe(true)
    if (!items.ok) return
    const firstItem = items.matches[0]!
    expect(list.slice(firstItem.start, firstItem.end)).toBe('<li>a')
    expect(list.slice(firstItem.inner.start, firstItem.inner.end)).toBe('a')
    expect(firstItem.endTag).toBeUndefined()

    const paragraphs = '<div><p>x<p>y</div>'
    const paras = resolveTarget(paragraphs, { selector: 'p' }, { all: true })
    expect(paras.ok).toBe(true)
    if (!paras.ok) return
    const firstPara = paras.matches[0]!
    expect(paragraphs.slice(firstPara.start, firstPara.end)).toBe('<p>x')
    expect(paragraphs.slice(firstPara.inner.start, firstPara.inner.end)).toBe('x')
    expect(firstPara.endTag).toBeUndefined()

    const cells = '<table><tr><td>a<td>b</table>'
    const tds = resolveTarget(cells, { selector: 'td' }, { all: true })
    expect(tds.ok).toBe(true)
    if (!tds.ok) return
    const firstCell = tds.matches[0]!
    expect(cells.slice(firstCell.start, firstCell.end)).toBe('<td>a')
    expect(firstCell.endTag).toBeUndefined()
  })
})

describe('labels', () => {
  it('prefers data-doop-label to the heading', () => {
    const html = '<!doctype html><section data-doop-label="Promo"><h1>Sale</h1></section>'
    expect(first(resolveTarget(html, { label: 'Promo' })).label).toBe('Promo')
    const byHeading = resolveTarget(html, { label: 'Sale' })
    expect(byHeading.ok).toBe(false)
    expect(!byHeading.ok && byHeading.code).toBe('not_found')
    expect(sectionLabel(findElement(parseFrameDocument(html), 'section'))).toBe('Promo')
  })

  it('picks the innermost section for a heading label', () => {
    const html = '<!doctype html><section><h2>Outer</h2><section><h3>Inner</h3></section></section>'
    const result = resolveTarget(html, { label: 'Inner' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.tagName).toBe('section')
    expect(result.matches[0]!.path).toBe('body > section > section')
  })
})

describe('selector resolution', () => {
  const html =
    '<!doctype html><main><section class="card"><h2>One</h2></section><section class="card"><h2>Two</h2></section></main>'

  it('reports candidates for an ambiguous selector', () => {
    const result = resolveTarget(html, { selector: '.card' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ambiguous')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates!.map((candidate) => candidate.text)).toEqual(['One', 'Two'])
    expect(result.error).toContain('narrower selector or all: true')
  })

  it('returns every match sorted by start with all: true', () => {
    const result = resolveTarget(html, { selector: '.card' }, { all: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches.map((match) => match.text)).toEqual(['One', 'Two'])
    expect(result.matches[0]!.start).toBeLessThan(result.matches[1]!.start)
  })

  it('reports an unparseable selector as bad_selector', () => {
    const result = resolveTarget(html, { selector: '[unclosed' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('bad_selector')
    expect(!result.ok && result.error.toLowerCase()).toContain('selector')
  })

  it('reports no match as not_found and names get_frame outline', () => {
    const result = resolveTarget(html, { label: 'Missing' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_found')
    expect(result.error).toContain('get_frame')
    expect(result.error).toContain('outline')
  })

  it('reports a target that is not exactly one form as bad_target', () => {
    const both = { element_id: 'a', label: 'b' } as unknown as SectionTarget
    const result = resolveTarget(html, both)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('bad_target')
    expect(sectionTargetSchema.safeParse({ element_id: 'a' }).success).toBe(true)
    expect(sectionTargetSchema.safeParse({ element_id: 'a', label: 'b' }).success).toBe(false)
  })
})

describe('component instances', () => {
  it('marks elements inside an instance and refuses the write', () => {
    const html =
      '<!doctype html><div data-doop-instance="card"><section data-doop-id="inner"><p>Text</p></section></div>'
    const match = first(resolveTarget(html, { element_id: 'inner' }))
    expect(match.insideInstance).toBe(true)
    expect(match.isInstance).toBe(false)
    const refusal = instanceRefusal(match, 'content')
    expect(refusal).toContain('inside a component instance')
    expect(refusal).toContain('update_component')
  })

  it('refuses content writes on an instance root but allows structure writes', () => {
    const html = '<!doctype html><section data-doop-id="root" data-doop-instance><h2>Root</h2></section>'
    const match = first(resolveTarget(html, { element_id: 'root' }))
    expect(match.isInstance).toBe(true)
    expect(match.insideInstance).toBe(false)
    const refusal = instanceRefusal(match, 'content')
    expect(refusal).toContain('set_text')
    expect(refusal).toContain('update_component')
    expect(instanceRefusal(match, 'structure')).toBeUndefined()
  })
})

describe('text, implied elements and deep nesting', () => {
  it('decodes entities, collapses whitespace and skips inert content', () => {
    const html =
      '<!doctype html><p data-doop-id="p"> Tom &amp; Jerry&nbsp;&#8212; &lt;3 <script>hidden()</script><style>.x{}</style><svg><title>icon</title></svg></p>'
    const doc = parseFrameDocument(html)
    const p = first(resolveTarget(doc, { element_id: 'p' }))
    expect(p.text).toBe('Tom & Jerry — <3')
    expect(visibleText(findElement(doc, 'p'))).toBe('Tom & Jerry — <3')
    expect(visibleText(findElement(doc, 'p'), 5)).toBe('Tom &')
  })

  it('resolves children of an implied body', () => {
    const html = '<!doctype html><main><section data-doop-id="implied"><h1>Hi</h1></section></main>'
    const match = first(resolveTarget(html, { selector: 'body > main > section' }))
    expect(match.elementId).toBe('implied')
    expect(match.path).toBe('body > main > section')
    expect(first(resolveTarget(html, { element_id: 'implied' })).text).toBe('Hi')
  })

  it('walks 5,000 levels of nesting without throwing', () => {
    const depth = 5000
    const html = `<div>${'<div>'.repeat(depth)}<p data-doop-id="deep">Deep</p>${'</div>'.repeat(depth + 1)}`
    const doc = parseFrameDocument(html)
    const match = first(resolveTarget(doc, { element_id: 'deep' }))
    expect(match.tagName).toBe('p')
    expect(match.text).toBe('Deep')
    expect(toResolved(doc, findElement(doc, 'div'))).toBeDefined()
  })

  it('resolves a heading label on 20,000 nested divs in linear time', () => {
    const depth = 20000
    const html = `<!doctype html>${'<div>'.repeat(depth)}<h2>Deep</h2>${'</div>'.repeat(depth)}`
    const doc = parseFrameDocument(html)
    const started = Date.now()
    const result = resolveTarget(doc, { label: 'Deep' })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches[0]!.tagName).toBe('div')
    expect(elapsed).toBeLessThan(500)
  })

  it('builds every path for 20,000 siblings in linear time', () => {
    const html = `<!doctype html>${'<p>a</p>'.repeat(20000)}`
    const doc = parseFrameDocument(html)
    const started = Date.now()
    const result = resolveTarget(doc, { selector: 'p' }, { all: true })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches).toHaveLength(20000)
    expect(result.matches[19999]!.path).toBe('body > p:nth-of-type(20000)')
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('source spans of a large element', () => {
  it('spans a 30 KB footer from its start tag to its end, with and without an end tag', () => {
    const filler = 'x'.repeat(30_000)
    const closed = `<html><body><header>h</header><footer><p>${filler}</p></footer></body></html>`
    const open = `<html><body><header>h</header><footer><p>${filler}`
    const openInBody = `${open}</body></html>`
    for (const html of [closed, open, openInBody]) {
      const result = resolveTarget(html, { selector: 'footer' })
      if (!result.ok) throw new Error(result.error)
      const match = result.matches[0]!
      const start = html.indexOf('<footer')
      const end = html.includes('</footer>')
        ? html.indexOf('</footer>') + 9
        : html.indexOf('</body>') === -1
          ? html.length
          : html.indexOf('</body>')
      expect({ start: match.start, end: match.end }).toEqual({ start, end })
      expect(match.end - match.start).toBeGreaterThan(30_000)
    }
  })
})

describe('source spans of elements left open', () => {
  const tail = '</body></html>'
  const cases: Record<string, { html: string; tag: string; last: string }> = {
    'a table with rows': {
      html: `<section>x</section><table><tr><td>hello world long</td></tr><tr><td>more</td></tr>${tail}`,
      tag: 'table',
      last: '<td>more</td></tr>',
    },
    'a table with a caption': {
      html: `<section>x</section><table><caption>cap</caption><tr><td>a</td></tr>${tail}`,
      tag: 'table',
      last: '<td>a</td></tr>',
    },
    'a select with open options': {
      html: `<section>x</section><select><option>one<option>two${tail}`,
      tag: 'select',
      last: 'two',
    },
  }

  for (const [name, { html, tag, last }] of Object.entries(cases)) {
    it(`ends ${name} at its last content, in the target and in the outline`, () => {
      const end = html.indexOf(last) + last.length
      const start = html.indexOf(`<${tag}`)
      const result = resolveTarget(html, { selector: tag })
      if (!result.ok) throw new Error(result.error)
      expect({ start: result.matches[0]!.start, end: result.matches[0]!.end }).toEqual({ start, end })
      const row = frameOutline(html).sections.find((section) => section.tag === tag)
      expect(row?.bytes).toBe(end - start)
    })

    it(`replaces ${name} without leaving a residue`, () => {
      const result = resolveTarget(html, { selector: tag })
      if (!result.ok) throw new Error(result.error)
      const edits = editsForOp(html, result.matches[0]!, { op: 'replace', html: '<p>new</p>' }, 'body')
      if (!edits.ok) throw new Error(edits.error)
      const applied = applyEdits(html, edits.edits)
      if (!applied.ok) throw new Error(applied.error)
      expect(applied.html).toBe(`<section>x</section><p>new</p>${tail}`)
    })
  }
})
