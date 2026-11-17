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
