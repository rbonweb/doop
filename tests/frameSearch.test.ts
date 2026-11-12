import { describe, expect, it } from 'vitest'
import {
  compileQuery,
  findInHtml,
  findInText,
  imageSources,
  RegexTimeoutError,
  regexBudget,
  replaceInHtml,
  replaceInText,
  snippetAround,
  textNodes,
} from '../server/frameSearch.ts'

function query(find: string, opts?: { regex?: boolean; caseSensitive?: boolean }): RegExp {
  const result = compileQuery(find, opts)
  if (!result.ok) throw new Error(result.error)
  return result.re
}

describe('compileQuery', () => {
  it('escapes plain finds and keeps regex patterns as given', () => {
    expect(findInText('<p>a.b</p>', query('a.b'))).toHaveLength(1)
    expect(findInText('<p>axb</p>', query('a.b'))).toHaveLength(0)
    expect(findInText('<p>axb</p>', query('a.b', { regex: true }))).toHaveLength(1)
  })

  it('refuses empty, over-long, invalid and catastrophic patterns', () => {
    const refused = [
      compileQuery(''),
      compileQuery('a'.repeat(501)),
      compileQuery('(unclosed', { regex: true }),
      compileQuery('(a+)+', { regex: true }),
    ]
    for (const result of refused) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    }
    expect(compileQuery('a'.repeat(500), { regex: true }).ok).toBe(true)
  })

  it('is case-insensitive unless asked otherwise', () => {
    expect(findInText('<p>Hello</p>', query('hello'))).toHaveLength(1)
    expect(findInText('<p>Hello</p>', query('hello', { caseSensitive: true }))).toHaveLength(0)
  })
})

describe('textNodes', () => {
  it('skips script, style, head and other raw-text containers', () => {
    const html = [
      '<!DOCTYPE html><html><head><title>needle title</title>',
      '<style>.needle { color: red }</style></head><body>',
      '<script>const needle = 1</script><noscript>needle noscript</noscript>',
      '<textarea>needle textarea</textarea><template><p>needle template</p></template>',
      '<p>needle body</p></body></html>',
    ].join('')
    const nodes = textNodes(html)
    expect(nodes.map((node) => node.text)).toEqual(['needle body'])
    expect(findInText(html, query('needle'))).toHaveLength(1)
  })

  it('keeps the raw source range and decodes entities', () => {
    const html = '<p>a &amp; b&nbsp;c</p>'
    const [node] = textNodes(html)
    expect(node?.text).toBe('a & b\u00a0c')
    expect(node?.raw).toBe('a &amp; b&nbsp;c')
    expect(html.slice(node?.start, node?.end)).toBe(node?.raw)
    expect(node?.locked).toBe(false)
  })
})

describe('findInText', () => {
  it('marks text locked by the node or an ancestor', () => {
    const html = '<p>target</p><p data-doop-locked>target</p><div data-doop-locked><span>target</span></div>'
    const hits = findInText(html, query('target'))
    expect(hits).toHaveLength(3)
    expect(hits[0]?.locked).toBeUndefined()
    expect(hits[1]?.locked).toBe(true)
    expect(hits[2]?.locked).toBe(true)
  })

  it('stops at the limit', () => {
    const html = `<p>${'x '.repeat(100)}</p>`
    expect(findInText(html, query('x'))).toHaveLength(50)
    expect(findInText(html, query('x'), 3)).toHaveLength(3)
    expect(findInText(html, query('x'), 0)).toHaveLength(0)
  })

  it('snippets each hit with collapsed whitespace', () => {
    const [hit] = findInText('<p>alpha   beta</p>', query('beta'))
    expect(hit?.snippet).toBe('alpha beta')
  })
})

describe('findInHtml', () => {
  it('matches raw markup with offsets into the source', () => {
    const html = '<p class="needle">x</p>'
    const [hit] = findInHtml(html, query('class="needle"'))
    expect(hit?.start).toBe(3)
    expect(html.slice(hit?.start, hit?.end)).toBe('class="needle"')
    expect(findInHtml(html, query('p'), 1)).toHaveLength(1)
  })
})

describe('replaceInText', () => {
  it('re-encodes entities in replaced nodes only', () => {
    const html = '<p>a &amp; b&nbsp;c</p>'
    const result = replaceInText(html, query('&'), 'and')
    expect(result.count).toBe(1)
    expect(result.lockedSkipped).toBe(0)
    expect(result.html).toBe('<p>a and b&nbsp;c</p>')
  })

  it('leaves the rest of the document byte-identical', () => {
    const html = '<div>one</div>\n<div>two</div><div data-doop-locked>two</div>'
    const result = replaceInText(html, query('two'), 'TWO')
    expect(result.count).toBe(1)
    expect(result.lockedSkipped).toBe(1)
    expect(result.html).toBe('<div>one</div>\n<div>TWO</div><div data-doop-locked>two</div>')
  })

  it('replaces every match in a node and uses $1 references in regex mode', () => {
    const result = replaceInText('<p>hello world</p>', query('(\\w+) (\\w+)', { regex: true }), '$2 $1')
    expect(result.count).toBe(1)
    expect(result.html).toBe('<p>world hello</p>')
    const repeated = replaceInText('<p>a a a</p>', query('a'), 'b')
    expect(repeated.count).toBe(3)
    expect(repeated.html).toBe('<p>b b b</p>')
  })
})

describe('replaceInHtml', () => {
  it('replaces over the raw source and counts matches', () => {
    const result = replaceInHtml('<p class="a">a</p>', query('a'), 'b')
    expect(result.count).toBe(3)
    expect(result.html).toBe('<p clbss="b">b</p>')
    const captured = replaceInHtml(
      '<a href="/x">x</a>',
      query('href="([^"]+)"', { regex: true }),
      'href="/y" data-was="$1"',
    )
    expect(captured.html).toBe('<a href="/y" data-was="/x">x</a>')
  })
})

describe('imageSources', () => {
  it('collects every image source kind in document order, deduplicated', () => {
    const html = [
      '<html><head><style>.a { background: url("/style-bg.png") }',
      ".b { background: url('/quoted.png') }</style></head><body>",
      '<img src="/a.png" srcset="/b.png 1x, /c.png 2x">',
      '<img src="/a.png">',
      '<picture><source srcset="/d.png 1x"></picture>',
      '<video poster="/poster.jpg"></video>',
      '<svg><image href="/svg-href.svg"></image><image xlink:href="/svg-xlink.svg"></image></svg>',
      '<div style="background-image: url(/inline.png)"></div></body></html>',
    ].join('')
    expect(imageSources(html)).toEqual([
      '/style-bg.png',
      '/quoted.png',
      '/a.png',
      '/b.png',
      '/c.png',
      '/d.png',
      '/poster.jpg',
      '/svg-href.svg',
      '/svg-xlink.svg',
      '/inline.png',
    ])
  })
})

describe('snippetAround', () => {
  it('cuts with an ellipsis and collapses whitespace', () => {
    expect(snippetAround('0123456789abcdefghij', 10, 12, 2)).toBe('…89abcd…')
    expect(snippetAround('hello   world', 6, 11)).toBe('hello world')
    expect(snippetAround('short', 0, 5)).toBe('short')
  })
})

describe('deep documents', () => {
  it('walks 5,000-deep nesting without throwing', () => {
    const deep = `${'<div>'.repeat(5000)}needle${'</div>'.repeat(5000)}`
    expect(findInText(deep, query('needle'))).toHaveLength(1)
    expect(replaceInText(deep, query('needle'), 'found').count).toBe(1)
    expect(textNodes(deep)).toHaveLength(1)
  })
})

describe('catastrophic patterns', () => {
  const adversarial = `${'a'.repeat(30)}!`
  const html = `<p>${adversarial}</p>`

  it.each(['(a|a)+$', '(\\w+\\s?)+$', '(a+|b)+$'])(
    'stops %s within a second, in text and in source scope',
    (pattern) => {
      const compiled = compileQuery(pattern, { regex: true })
      if (!compiled.ok) throw new Error(compiled.error)
      for (const run of [
        () => findInText(html, compiled.re, 3, regexBudget()),
        () => findInHtml(html, compiled.re, 3, regexBudget()),
        () => replaceInText(html, compiled.re, 'x', { budget: regexBudget() }),
        () => replaceInHtml(html, compiled.re, 'x', { budget: regexBudget() }),
      ]) {
        const startedAt = performance.now()
        expect(run).toThrow(RegexTimeoutError)
        expect(performance.now() - startedAt).toBeLessThan(1000)
      }
    },
  )

  it('keeps matching ordinary regexes after a timeout, $1 included', () => {
    const slow = compileQuery('(a|a)+$', { regex: true })
    if (!slow.ok) throw new Error(slow.error)
    expect(() => findInText(html, slow.re, 3, regexBudget())).toThrow(RegexTimeoutError)
    const ordinary = compileQuery('(\\w+)@(\\w+)', { regex: true })
    if (!ordinary.ok) throw new Error(ordinary.error)
    const result = replaceInText('<p>me@home</p>', ordinary.re, '$2:$1', { budget: regexBudget() })
    expect(result).toMatchObject({ html: '<p>home:me</p>', count: 1 })
    expect(replaceInHtml('<p>me@home</p>', ordinary.re, '$2:$1', { budget: regexBudget() }).html).toBe('<p>home:me</p>')
  })

  it('shares one budget across frames, so a spent budget refuses the next call', () => {
    const budget = regexBudget(1)
    budget.remainingMs = 0
    const ordinary = compileQuery('a', { regex: true })
    if (!ordinary.ok) throw new Error(ordinary.error)
    expect(() => findInHtml(html, ordinary.re, 3, budget)).toThrow(RegexTimeoutError)
  })

  it('marks plain finds literal and regex finds not', () => {
    expect(compileQuery('a.b')).toMatchObject({ ok: true, literal: true })
    expect(compileQuery('a.b', { regex: true })).toMatchObject({ ok: true, literal: false })
  })
})

describe('literal replacements', () => {
  it('insert $&, $$ and $1 as written in literal mode', () => {
    expect(replaceInText('<p>cost</p>', query('cost'), '$&$&-$$-$1', { literal: true }).html).toBe(
      '<p>$&amp;$&amp;-$$-$1</p>',
    )
    expect(replaceInHtml('<p>cost</p>', query('cost'), '$&$$', { literal: true }).html).toBe('<p>$&$$</p>')
  })

  it('still expands them in regex mode', () => {
    expect(replaceInText('<p>cost</p>', query('c(o)st', { regex: true }), '$&-$1-$$').html).toBe('<p>cost-o-$</p>')
  })
})
