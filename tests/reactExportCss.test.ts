import postcss from 'postcss'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { moduleClassName, splitComponentCss } from '../server/reactExport/cssSplit.ts'

const flat = (css: string) => css.replace(/\s+/g, ' ').trim()

describe('splitComponentCss: classes and variants', () => {
  it('keeps class rules and lists their classes in first-seen order', () => {
    const out = splitComponentCss('.btn { color: red } .label { font-weight: 500 } .btn:hover { color: blue }')
    expect(out.classes).toEqual(['btn', 'label'])
    expect(flat(out.moduleCss)).toBe('.btn { color: red; } .label { font-weight: 500; } .btn:hover { color: blue; }')
    expect(out.globalCss).toBe('')
    expect(out.issues).toEqual([])
  })

  it('keeps variant selectors as written', () => {
    const out = splitComponentCss(
      '.btn[data-tone="ghost"] { background: none } [data-tone="ghost"] .label { opacity: .6 } .btn[data-doop-x="1"] { top: 0 }',
    )
    expect(flat(out.moduleCss)).toContain('.btn[data-tone="ghost"] { background: none; }')
    expect(flat(out.moduleCss)).toContain('[data-tone="ghost"] .label { opacity: .6; }')
    expect(flat(out.moduleCss)).toContain('.btn[data-doop-x="1"]')
    expect(out.classes).toEqual(['btn', 'label'])
  })

  it('splits selector lists and finds classes in each', () => {
    const out = splitComponentCss('.a, .b:hover { color: red }')
    expect(out.classes).toEqual(['a', 'b'])
    expect(out.moduleCss).toBe('.a,\n.b:hover {\n  color: red;\n}\n')
  })

  it('ignores class-like text in attribute values and strings', () => {
    const out = splitComponentCss('a[href$=".pdf"] { color: red } .x[title="a.b, c"] { top: 0 }')
    expect(out.classes).toEqual(['root', 'x'])
    expect(flat(out.moduleCss)).toContain('.root a[href$=".pdf"]')
    expect(flat(out.moduleCss)).toContain('.x[title="a.b, c"]')
  })

  it('reads escaped class names', () => {
    const out = splitComponentCss('.sm\\:flex { display: flex }')
    expect(out.classes).toEqual(['sm:flex'])
  })
})

describe('splitComponentCss: classless rules', () => {
  it('prefixes a classless rule with .root as a descendant', () => {
    const out = splitComponentCss('a { color: red } a:hover, span > b { color: blue }')
    expect(out.moduleCss).toBe('.root a {\n  color: red;\n}\n\n.root a:hover,\n.root span > b {\n  color: blue;\n}\n')
    expect(out.classes).toEqual(['root'])
  })

  it('prefixes a selector starting with an attribute selector as a compound', () => {
    const out = splitComponentCss('[data-size="lg"] { padding: 12px } [data-size="lg"] span { gap: 4px }')
    expect(flat(out.moduleCss)).toBe(
      '.root[data-size="lg"] { padding: 12px; } .root[data-size="lg"] span { gap: 4px; }',
    )
  })

  it('uses a custom root class', () => {
    const out = splitComponentCss('a { color: red } .x { top: 0 }', { rootClass: 'card-root' })
    expect(out.moduleCss).toContain('.card-root a')
    expect(out.classes).toEqual(['card-root', 'x'])
  })

  it('escapes an odd root class instead of letting it break the selector', () => {
    expect(splitComponentCss('a { top: 0 }', { rootClass: 'a b{' }).moduleCss).toContain('.a\\ b\\{ a')
  })

  it('treats a class only inside :not() as classless', () => {
    const out = splitComponentCss('a:not(.skip) { color: red }')
    expect(out.moduleCss).toContain('.root a:not(.skip)')
    expect(out.classes).toContain('skip')
  })

  it('splits a mixed selector list between the module and the global sheet', () => {
    const out = splitComponentCss('html, .a { color: red }')
    expect(out.moduleCss).toBe('.a {\n  color: red;\n}\n')
    expect(out.globalCss).toBe('html {\n  color: red;\n}\n')
  })
})

describe('splitComponentCss: global rules', () => {
  it('moves :root, html and body rules and @font-face to the global sheet', () => {
    const out = splitComponentCss(
      ':root { --brand: #07f } html { font-size: 16px } body { margin: 0 } :root[data-theme="dark"] { --brand: #fff } @font-face { font-family: X; src: url(/a/x.woff2) } .btn { color: var(--brand) }',
    )
    expect(flat(out.moduleCss)).toBe('.btn { color: var(--brand); }')
    expect(out.globalCss).toContain(':root {\n  --brand: #07f;\n}')
    expect(out.globalCss).toContain('html {')
    expect(out.globalCss).toContain('body {')
    expect(out.globalCss).toContain(':root[data-theme="dark"] {')
    expect(out.globalCss).toContain('@font-face {\n  font-family: X;\n  src: url(/a/x.woff2);\n}')
    expect(out.classes).toEqual(['btn'])
  })

  it('splits a @media block holding both kinds of rule', () => {
    const out = splitComponentCss('@media (min-width: 600px) { :root { --gap: 8px } .a { gap: var(--gap) } }')
    expect(flat(out.moduleCss)).toBe('@media (min-width: 600px) { .a { gap: var(--gap); } }')
    expect(flat(out.globalCss)).toBe('@media (min-width: 600px) { :root { --gap: 8px; } }')
  })
})

describe('splitComponentCss: at-rules', () => {
  it('keeps @keyframes without treating frame selectors as rules', () => {
    const out = splitComponentCss(
      '@keyframes spin { from { transform: rotate(0) } 50%, to { transform: rotate(360deg) } } .a { animation: spin 1s }',
    )
    expect(flat(out.moduleCss)).toBe(
      '@keyframes spin { from { transform: rotate(0); } 50%, to { transform: rotate(360deg); } } .a { animation: spin 1s; }',
    )
    expect(out.classes).toEqual(['a'])
  })

  it('recurses into @media, @container, @supports and @layer', () => {
    const out = splitComponentCss(
      '@media (min-width: 1px) { .a { top: 0 } b { top: 1px } } @container card (min-width: 10px) { .c { top: 0 } } @supports (display: grid) { .d { display: grid } } @layer base { .e { top: 0 } p { top: 2px } }',
    )
    const css = flat(out.moduleCss)
    expect(css).toContain('@media (min-width: 1px) { .a { top: 0; } .root b { top: 1px; } }')
    expect(css).toContain('@container card (min-width: 10px) { .c { top: 0; } }')
    expect(css).toContain('@supports (display: grid) { .d { display: grid; } }')
    expect(css).toContain('@layer base { .e { top: 0; } .root p { top: 2px; } }')
    expect(out.classes).toEqual(['a', 'root', 'c', 'd', 'e'])
  })

  it('keeps a @layer order statement', () => {
    expect(splitComponentCss('@layer base, theme; .a { top: 0 }').moduleCss).toContain('@layer base, theme;')
  })

  it('drops @import and @charset and reports them', () => {
    const out = splitComponentCss('@charset "utf-8"; @import url("https://x.test/a.css"); .a { top: 0 }')
    expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues.map((issue) => issue.kind)).toEqual(['css', 'css'])
    expect(out.issues[0]?.detail).toContain('@charset')
    expect(out.issues[1]?.detail).toContain('@import')
  })

  it('drops an unknown at-rule with a report', () => {
    const out = splitComponentCss('@weird thing { .a { top: 0 } } .b { top: 1px }')
    expect(out.moduleCss).toBe('.b {\n  top: 1px;\n}\n')
    expect(out.issues).toHaveLength(1)
  })
})

describe('splitComponentCss: unsafe declarations', () => {
  const unsafe = [
    'background: url(javascript:alert(1))',
    'background: url("JaVa\\9script:alert(1)")',
    'background: url(\\6a avascript:alert(1))',
    'background: \\75rl(javascript:alert(1))',
    'background: url(data:text/html,<script>alert(1)</script>)',
    'background: url( "vbscript:x" )',
    'width: expression(alert(1))',
    'behavior: url(x.htc)',
    '-moz-binding: url(x.xml#a)',
    'background: image-set("javascript:alert(1)" 1x)',
  ]

  it.each(unsafe)('drops %s and reports it', (declaration) => {
    const out = splitComponentCss(`.a { color: red; ${declaration}; top: 0 }`)
    expect(out.moduleCss).toBe('.a {\n  color: red;\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({ kind: 'css', path: '.a' })
  })

  it('keeps a raster data URI, a site path and an https URL', () => {
    const out = splitComponentCss(
      '.a { background: url(data:image/png;base64,iVBORw0KGgo=) } .b { background: url(/a/x.png) } .c { background: url("https://x.test/y.png") }',
    )
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toContain('url(data:image/png;base64,iVBORw0KGgo=)')
    expect(out.moduleCss).toContain('url(/a/x.png)')
    expect(out.moduleCss).toContain('url("https://x.test/y.png")')
  })

  it('drops the whole rule when nothing safe is left', () => {
    const out = splitComponentCss('.a { width: expression(1) } .b { top: 0 }')
    expect(out.moduleCss).toBe('.b {\n  top: 0;\n}\n')
    expect(out.classes).toEqual(['b'])
    expect(out.issues).toHaveLength(1)
  })

  it('checks custom properties and declarations in the global sheet and at-rules too', () => {
    const out = splitComponentCss(
      ':root { --x: url(javascript:a) } @font-face { src: url(javascript:b) } @media print { .a { background: url(javascript:c); top: 0 } }',
    )
    expect(out.globalCss).toBe('')
    expect(out.moduleCss).not.toContain('javascript')
    expect(out.issues).toHaveLength(3)
  })

  it('drops a malformed declaration', () => {
    const out = splitComponentCss('.a { color red; top: 0 }')
    expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
  })
})

describe('splitComponentCss: reading', () => {
  it('is not confused by braces and semicolons in comments and strings', () => {
    const out = splitComponentCss(
      '/* } { ; .fake { color: red } */ .a::before { content: "} { ;"; color: red } /* x */ .b { content: \'}\' }',
    )
    expect(out.classes).toEqual(['a', 'b'])
    expect(out.moduleCss).toContain('content: "} { ;";')
    expect(out.moduleCss).toContain("content: '}';")
    expect(out.moduleCss).not.toContain('fake')
    expect(out.issues).toEqual([])
  })

  it('keeps a semicolon inside an unquoted url', () => {
    const out = splitComponentCss('.a { background: url(data:image/png;base64,AAAA); top: 0 }')
    expect(out.moduleCss).toContain('url(data:image/png;base64,AAAA);')
    expect(out.moduleCss).toContain('top: 0;')
  })

  it('survives an unterminated block and stray braces', () => {
    const out = splitComponentCss('} .a { top: 0 } .b { top: 1px')
    expect(out.classes).toEqual(['a', 'b'])
  })

  it('returns empty sheets for empty input', () => {
    expect(splitComponentCss('')).toEqual({ moduleCss: '', classes: [], globalCss: '', issues: [] })
  })
})

describe('splitComponentCss: hardening', () => {
  it('drops declarations with unbalanced parens, brackets or quotes', () => {
    for (const css of ['.a{b:c(}', '.a{content:"abc}', '.a{b:c[}', ".a{b:'x}", '.a{b:c)}', '.a{b:c\\ }']) {
      const out = splitComponentCss(`${css} .z { top: 0 }`)
      expect(() => postcss.parse(out.moduleCss), css).not.toThrow()
      expect(out.moduleCss, css).not.toContain('b:')
      expect(out.issues.length, css).toBeGreaterThan(0)
    }
  })

  it('drops a rule or at-rule whose prelude does not balance', () => {
    const out = splitComponentCss('.a[x { top: 0 } @media (min-width: 1px { .b { top: 0 } } .ok { top: 1px }')
    expect(() => postcss.parse(out.moduleCss)).not.toThrow()
    expect(out.moduleCss).not.toContain('.b')
    expect(out.issues.length).toBeGreaterThan(0)
  })

  it('keeps an @layer statement only in its plain form', () => {
    expect(splitComponentCss('@layer a, b.c, d-e;').moduleCss).toBe('@layer a, b.c, d-e;\n')
    for (const css of [
      '@layer x ( ; @import url(https://evil/x.css) ; .z{a:b}',
      '@layer ;',
      '@layer a, ;',
      '@layer "x";',
    ]) {
      const out = splitComponentCss(css)
      expect(out.moduleCss, css).not.toContain('@import')
      expect(out.moduleCss, css).not.toContain('@layer x')
      expect(out.issues.length, css).toBeGreaterThan(0)
    }
  })

  it('refuses preludes that carry a semicolon or a brace', () => {
    const out = splitComponentCss(
      '@media (a;b) { .x { top: 0 } } @keyframes a;b { from { top: 0 } } @keyframes ok { from; { top: 0 } 10px { top: 1px } to { top: 2px } }',
    )
    expect(flat(out.moduleCss)).toBe('.root b { from { top: 0; } } @keyframes ok { to { top: 2px; } }')
    expect(out.issues.length).toBeGreaterThanOrEqual(3)
  })

  it.each([
    'composes: b from "../../../etc/passwd.css"',
    'composes: x from global',
    'compose-with: y',
    'COMPOSES: z',
    'comp\\6fses: z',
  ])('drops %s', (declaration) => {
    const out = splitComponentCss(`.a { ${declaration}; top: 0 }`)
    expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
  })

  it.each([
    ':global(.x) .a',
    ':global .b',
    '.c :global(body)',
    ':local(.d)',
    '.e:GLOBAL(.f)',
    '.g:\\67 lobal(.h)',
    ':global(body)',
    'html:global(.x)',
  ])('drops the selector %s', (selector) => {
    const out = splitComponentCss(`${selector} { color: red } .ok { top: 0 }`)
    expect(out.moduleCss).toBe('.ok {\n  top: 0;\n}\n')
    expect(out.globalCss).toBe('')
    expect(out.issues).toHaveLength(1)
  })

  it('drops only the bad selector of a list', () => {
    const out = splitComponentCss('.a, :global(.b), .c { top: 0 }')
    expect(out.moduleCss).toBe('.a,\n.c {\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
  })

  it.each(['.', '#', '. b', '.a >', '.a + ', '.a > > .b', '.1a', '.-1', 'a.', '.a#', '.a::', '.a >,', '.-'])(
    'drops the badly formed selector "%s"',
    (selector) => {
      const out = splitComponentCss(`${selector} { color: red } .ok { top: 0 }`)
      expect(out.moduleCss, selector).toBe('.ok {\n  top: 0;\n}\n')
      expect(out.issues.length, selector).toBeGreaterThan(0)
    },
  )

  it('keeps well formed selectors with combinators, pseudos and ids', () => {
    const out = splitComponentCss('.a > .b ~ .c + #d, .e:nth-child(2n+1) > a::before, .f:not(.g) { top: 0 }')
    expect(out.issues).toEqual([])
    expect(out.classes).toEqual(['a', 'b', 'c', 'e', 'f', 'g'])
  })

  it('drops a nested block with a bad selector or a custom property block', () => {
    const out = splitComponentCss('.a { top: 0; :global(.x) { color: red } --v: { a: b } &:hover { color: blue } }')
    expect(flat(out.moduleCss)).toBe('.a { top: 0; &:hover { color: blue; } }')
    expect(out.issues).toHaveLength(2)
  })
})

describe('splitComponentCss: urls a bundler would resolve', () => {
  const local = [
    'url(x.png)',
    'url(./x.png)',
    'url(../x.png)',
    'url(../../../../home/x/.ssh/id_rsa)',
    'url("../secret.png")',
    "url('./a/b.png')",
    'url(~pkg/secret.png)',
    'url(/a/../../x.png)',
    'url(/a/..%2f..%2fx.png)',
    'url(/a/%2e%2e/x.png)',
    'url(\\2e\\2e/x.png)',
    'url("\\2e \\2e /x.png")',
    'url(/a/..\\5c x.png)',
    'url(file:///etc/passwd)',
    'url(C:/x.png)',
    'url()',
    'url(a.png), url(https://x.test/b.png)',
    'image-set("../x.png" 1x, "/a/y.png" 2x)',
    'image-set(url(x.png) 1x)',
  ]

  it.each(local)('drops background: %s', (value) => {
    const out = splitComponentCss(`.a { top: 0; background: ${value} }`)
    expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({ kind: 'css' })
  })

  it.each([
    'url(https://x.test/a.png)',
    'url("http://x.test/a.png")',
    'url(//cdn.test/a.png)',
    'url(/a/x.png)',
    'url("/photos/pexels/1.jpeg?w=10&h=10")',
    'url(/a/x..png)',
    'url(#grad)',
    'url("#grad")',
    'url(data:image/png;base64,AAAA)',
    'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E")',
    'linear-gradient(red, blue), url(/a/x.png)',
    'image-set("/a/x.png" 1x, "https://x.test/y.png" 2x)',
    'image-set(url(/a/x.png) 1x)',
  ])('keeps background: %s', (value) => {
    const out = splitComponentCss(`.a { background: ${value} }`)
    expect(out.issues, value).toEqual([])
    expect(out.moduleCss, value).toContain('background:')
  })

  it('drops a relative @font-face source from the global sheet', () => {
    const out = splitComponentCss('@font-face { font-family: X; src: url(./x.woff2) }')
    expect(out.globalCss).not.toContain('x.woff2')
    expect(out.issues).toHaveLength(1)
  })
})

describe('splitComponentCss: url() read like CSS', () => {
  const importedAtTopLevel = (sheet: string) => {
    let found = false
    postcss.parse(sheet).walkAtRules('import', () => {
      found = true
    })
    return found
  }

  it('does not let a bad url hide the rules after it', () => {
    const out = splitComponentCss('.a{b:url(http://x"y)} @import url(https://evil/x.css); .c{d:url(http://z"w)}')
    expect(() => postcss.parse(out.moduleCss)).not.toThrow()
    expect(importedAtTopLevel(out.moduleCss)).toBe(false)
    expect(out.moduleCss).not.toContain('@import')
    expect(out.moduleCss).not.toContain('evil')
    expect(out.issues.length).toBeGreaterThanOrEqual(2)
  })

  it('parses the second exact bad input', () => {
    const out = splitComponentCss(".a{background:url(#..''%2E\"~~)}")
    expect(() => postcss.parse(out.moduleCss)).not.toThrow()
    expect(out.moduleCss).toBe('')
    expect(out.issues).toHaveLength(1)
  })

  it.each([
    'url(a"b)',
    "url(a'b)",
    'url(a(b)',
    'url(a b)',
    'url(a\tb)',
    'url(a\\\nb)',
    'url(a\u0001b)',
    'url(\\75 "x)',
    '\\75rl(/a/x"y.png)',
    'URL(/a/x y.png)',
  ])('drops a bad-url token %j and reads on after its first )', (value) => {
    const out = splitComponentCss(`.a { top: 0; background: ${value} } .z { left: 1px }`)
    expect(out.moduleCss, value).toBe('.a {\n  top: 0;\n}\n\n.z {\n  left: 1px;\n}\n')
    expect(out.issues, value).toHaveLength(1)
  })

  it('keeps braces, semicolons, quotes and comment markers inside a good url token', () => {
    const out = splitComponentCss('.a { background: url(/a/x;y}z/*w.png) } .b { top: 0 }')
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toContain('url(/a/x;y}z/*w.png)')
    expect(out.classes).toEqual(['a', 'b'])
  })

  it('allows whitespace around an unquoted url and escaped characters in it', () => {
    const out = splitComponentCss('.a { background: url(  /a/x.png  ) } .b { background: url(/a/\\78 .png) }')
    expect(out.issues).toEqual([])
    expect(out.classes).toEqual(['a', 'b'])
  })

  it.each(['b: http://x@import b:', 'b: c@d', 'b: c{d}', 'b: c(d;e)', 'b: red:root', 'b: a :hover'])(
    'drops the value %j',
    (declaration) => {
      const out = splitComponentCss(`.a { top: 0; ${declaration} }`)
      expect(() => postcss.parse(out.moduleCss)).not.toThrow()
      expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
      expect(out.issues.length).toBeGreaterThan(0)
    },
  )

  it('keeps a colon inside parens, a string, a url and a custom property', () => {
    const out = splitComponentCss('.a { --x: a:b; b: f(a:b); content: "a:b"; background: url(http://x.test/a) }')
    expect(out.issues).toEqual([])
  })

  it('keeps @, braces and semicolons inside a string', () => {
    const out = splitComponentCss('.a { content: "a@b {c;d}" }')
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toContain('content: "a@b {c;d}";')
  })

  it.each([
    'image("../x.png")',
    'image-set("x.png" 1x)',
    '-webkit-image-set("../x.png" 1x)',
    'cross-fade("x.png", "/a/y.png", 50%)',
    'element("javascript:x")',
    'IMAGE("./x.png")',
    '\\69mage("x.png")',
    'src("x.png")',
  ])('applies the url rule to the strings of %s', (value) => {
    const out = splitComponentCss(`.a { top: 0; background: ${value} }`)
    expect(out.moduleCss, value).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues, value).toHaveLength(1)
  })

  it.each(['image("/a/x.png")', 'cross-fade("/a/x.png", "https://x.test/y.png", 50%)'])('keeps %s', (value) => {
    expect(splitComponentCss(`.a { background: ${value} }`).issues).toEqual([])
  })

  it.each(['url(///evil.test/x.png)', 'url("///evil.test/x.png")', 'url(https:///x.png)', 'url(////x.png)'])(
    'drops %s',
    (value) => {
      expect(splitComponentCss(`.a { background: ${value} }`).issues).toHaveLength(1)
    },
  )

  it('keeps a protocol-relative url with two slashes', () => {
    expect(splitComponentCss('.a { background: url(//cdn.test/x.png) }').issues).toEqual([])
  })

  it('refuses a url() in a selector or an at-rule prelude', () => {
    const out = splitComponentCss('.a[x=url(y)] { top: 0 } @media url(x) { .b { top: 0 } } .ok { top: 1px }')
    expect(out.moduleCss).toBe('.ok {\n  top: 1px;\n}\n')
  })
})

describe('splitComponentCss: one URL text for validation and output', () => {
  it('removes a backslash-newline before checking, so the checked url is the written url', () => {
    const out = splitComponentCss('.a { background: url(ht\\\ntp://ok/x) }')
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toBe('.a {\n  background: url(http://ok/x);\n}\n')
  })

  it('reads a line continuation in a quoted url as the string does', () => {
    const out = splitComponentCss('.a { background: url("/\\\n/cdn.test/x") }')
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toBe('.a {\n  background: url("//cdn.test/x");\n}\n')
  })

  it('does not eat an escaped backslash in front of a newline: that string is unterminated and is dropped', () => {
    const out = splitComponentCss('.a { top: 0; content: "a\\\\\nb" }')
    expect(out.moduleCss).toBe('.a {\n  top: 0;\n}\n')
    expect(out.issues).toHaveLength(1)
  })

  it.each([
    'url(ht\\ tp://ok/x)',
    'url("ht\\ tp://ok/x")',
    'url("ht\\9 tp://ok/x")',
    'url("/a/x\\a y")',
    'url("\\9 /a/x/../../y")',
  ])('does not let whitespace or a control character turn %s into an allowed url', (value) => {
    const out = splitComponentCss(`.a { top: 0; background: ${value} }`)
    expect(out.moduleCss).not.toContain('background')
    expect(out.issues).toHaveLength(1)
  })

  it('keeps a space inside a path as written', () => {
    const out = splitComponentCss('.a { background: url("/a/x\\ y.png") }')
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toContain('url("/a/x\\ y.png")')
  })
})

describe('splitComponentCss: rewriteUrl', () => {
  const absolute = (url: string) => (url.startsWith('/') && !url.startsWith('//') ? `https://doop.design${url}` : url)

  it('rewrites url() and image-function addresses and writes them as quoted strings', () => {
    const out = splitComponentCss(
      '.a { background: url(/a/x.png) } .b { background: url("/photos/y.jpeg?w=1") } .c { background-image: image-set("/a/z.png" 1x, "/a/w.png" 2x) } @font-face { font-family: X; src: url(/fonts/x.woff2) format("woff2") } .d { background: url(https://x.test/k.png), url(#grad) }',
      { rewriteUrl: absolute },
    )
    expect(out.issues).toEqual([])
    expect(out.moduleCss).toContain('background: url("https://doop.design/a/x.png");')
    expect(out.moduleCss).toContain('background: url("https://doop.design/photos/y.jpeg?w=1");')
    expect(out.moduleCss).toContain('image-set("https://doop.design/a/z.png" 1x, "https://doop.design/a/w.png" 2x)')
    expect(out.globalCss).toContain('src: url("https://doop.design/fonts/x.woff2") format("woff2");')
    expect(out.moduleCss).toContain('url("https://x.test/k.png"), url("#grad")')
    expect(() => postcss.parse(out.moduleCss)).not.toThrow()
    expect(() => postcss.parse(out.globalCss)).not.toThrow()
  })

  it('calls it only for urls that passed the safety check', () => {
    const seen: string[] = []
    splitComponentCss(
      '.a { background: url(/a/x.png) } .b { background: url(../x.png) } .c { background: url(javascript:x) } .d { color: red }',
      {
        rewriteUrl: (url) => {
          seen.push(url)
          return url
        },
      },
    )
    expect(seen).toEqual(['/a/x.png'])
  })

  it('drops a declaration whose rewritten url is not allowed, with an issue', () => {
    for (const bad of ['javascript:alert(1)', '../x.png', 'x.png', 'data:text/html,x', '///x', '']) {
      const out = splitComponentCss('.a { top: 0; background: url(/a/x.png) }', { rewriteUrl: () => bad })
      expect(out.moduleCss, bad).toBe('.a {\n  top: 0;\n}\n')
      expect(out.issues, bad).toHaveLength(1)
    }
  })

  it('escapes quotes and backslashes in the rewritten address', () => {
    const out = splitComponentCss('.a { background: url(/a/x.png) } .z { top: 0 }', {
      rewriteUrl: () => 'https://x.test/a"b\\c.png',
    })
    expect(out.moduleCss).toContain('url("https://x.test/a\\"b\\\\c.png")')
    expect(() => postcss.parse(out.moduleCss)).not.toThrow()
    expect(out.classes).toEqual(['a', 'z'])
  })

  it('leaves everything as written without it', () => {
    expect(splitComponentCss('.a { background: url(/a/x.png) }').moduleCss).toContain('url(/a/x.png)')
  })
})

/** a small seeded generator, so a failure repeats */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRAGMENTS = [
  '\\\n',
  'url(/a/x.png)',
  'url("/a/x")',
  '"/a/x"',
  '.a',
  '.b',
  '.',
  '#',
  'a',
  '*',
  '&',
  '>',
  '+',
  '~',
  ',',
  ':',
  '::',
  ':hover',
  ':not(',
  ':global(',
  ':global',
  ':local(',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '"',
  "'",
  ';',
  '\\',
  '/*',
  '*/',
  ' ',
  '\n',
  '=',
  '!important',
  '@media',
  '@layer',
  '@keyframes x',
  '@keyframes',
  '@font-face',
  '@import',
  '@charset "x"',
  '@supports',
  '@container',
  '@property',
  '@page',
  'from',
  'to',
  '50%',
  'url(',
  'url(x.png)',
  'url(javascript:',
  'expression(',
  'composes: a from "x"',
  'color: red',
  'content: "',
  'background: url(',
  '--x: ',
  ':root',
  'html',
  'body',
  '[data-a="b"]',
  '[data-a=',
  '1',
  '-',
  'x',
]

describe('splitComponentCss: output always parses', () => {
  it('writes a moduleCss and globalCss that postcss reads, and holds no @import, for 30,000 random inputs', () => {
    const random = seeded(20240611)
    const failures: string[] = []
    for (let n = 0; n < 30000; n++) {
      const length = 1 + Math.floor(random() * 28)
      let css = ''
      for (let i = 0; i < length; i++) css += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!
      const out = splitComponentCss(css, {
        rootClass: random() < 0.5 ? 'root' : 'x y',
        rewriteUrl: random() < 0.5 ? (url) => (url.startsWith('/') ? `https://doop.design${url}` : url) : undefined,
      })
      for (const sheet of [out.moduleCss, out.globalCss]) {
        try {
          postcss.parse(sheet).walkAtRules('import', () => {
            throw new Error('an @import survived')
          })
        } catch (error) {
          failures.push(`${JSON.stringify(css)} -> ${String(error)}`)
          break
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
  })
})

function transpileDiagnostics(value: string): ts.Diagnostic[] {
  const output = ts.transpileModule(`const x = <div className=${value} />`, {
    reportDiagnostics: true,
    fileName: 'x.tsx',
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  })
  return output.diagnostics ?? []
}

describe('moduleClassName', () => {
  const known = new Set(['btn', 'label', 'is-active'])

  it('wraps one known class as styles["x"]', () => {
    expect(moduleClassName(['btn'], known)).toBe('{styles["btn"]}')
  })

  it('leaves one unknown class a string literal', () => {
    expect(moduleClassName(['mystery'], known)).toBe('{"mystery"}')
  })

  it('joins several with cx, known ones through styles', () => {
    expect(moduleClassName(['btn', 'mystery', 'label'], known)).toBe('{cx(styles["btn"], "mystery", styles["label"])}')
  })

  it('uses custom helper names', () => {
    expect(moduleClassName(['btn', 'x'], known, { styles: 's', cx: 'cn' })).toBe('{cn(s["btn"], "x")}')
  })

  it('drops repeated classes and handles an empty list', () => {
    expect(moduleClassName(['btn', 'btn'], known)).toBe('{styles["btn"]}')
    expect(moduleClassName([], known)).toBe('{""}')
  })

  it.each([
    [['btn']],
    [['btn', 'x']],
    [[]],
    [['a"b', "c'd", 'e\\f', '</script>', '{x}', 'line\nbreak', 'a b']],
    [['a"b', 'ok']],
  ])('emits valid JSX attribute text for %j', (classes) => {
    const moduleClasses = new Set(['a"b', 'btn'])
    const value = moduleClassName(classes, moduleClasses)
    expect(transpileDiagnostics(value)).toEqual([])
    expect(value).not.toContain('</script>')
    expect(value).not.toMatch(/[\u2028\u2029\n]/)
  })
})
