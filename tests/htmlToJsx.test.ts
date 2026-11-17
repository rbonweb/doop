import { createRequire } from 'node:module'
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { htmlToJsx, jsString, jsxText, styleToJsx, type HtmlToJsxOptions } from '../server/reactExport/htmlToJsx.ts'
import type { ExportIssue } from '../server/reactExport/issues.ts'

const nodeRequire = createRequire(import.meta.url)

const wrap = (jsx: string) => `export const C = () => (${jsx})`

function transpile(source: string) {
  return ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
}

function expectParses(jsx: string) {
  const out = transpile(wrap(jsx))
  expect(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  return out.outputText
}

/** compile and render the converted JSX with the real react runtime */
function render(jsx: string): string {
  const code = expectParses(jsx)
  const exports: { C?: () => unknown } = {}
  new Function('require', 'exports', code)((id: string) => nodeRequire(id), exports)
  return renderToStaticMarkup(exports.C!() as never)
}

const textOf = (node: Tree.Node): string => {
  if (node.nodeName === '#text') return (node as Tree.TextNode).value
  return 'childNodes' in node ? (node.childNodes as Tree.Node[]).map(textOf).join('') : ''
}
const firstElement = (markup: string) =>
  parseFragment(markup).childNodes.find((n): n is Tree.Element => 'tagName' in n) as Tree.Element
const attrOf = (el: Tree.Element, name: string) => el.attrs.find((a) => a.name === name)?.value

const convert = (html: string, options?: HtmlToJsxOptions) => htmlToJsx(html, options)
const kinds = (issues: ExportIssue[]) => issues.map((i) => i.kind)

describe('attribute names', () => {
  it('maps the React names and keeps booleans bare', () => {
    const { jsx } = convert(
      '<label for="a" class="x y" tabindex="2" data-k="1" aria-label="L"><input id="a" readonly disabled="" autofocus maxlength="3" crossorigin="anonymous"></label>',
    )
    expect(jsx).toContain('htmlFor="a"')
    expect(jsx).toContain('className="x y"')
    expect(jsx).toContain('tabIndex="2"')
    expect(jsx).toContain('data-k="1"')
    expect(jsx).toContain('aria-label="L"')
    expect(jsx).toMatch(/ readOnly[ />]/)
    expect(jsx).toMatch(/ disabled[ />]/)
    expect(jsx).toMatch(/ autoFocus[ />]/)
    expect(jsx).toContain('maxLength="3"')
    expect(jsx).toContain('crossOrigin="anonymous"')
    expectParses(jsx)
  })

  it('maps table, image and iframe attributes', () => {
    const { jsx } = convert(
      '<table><tr><td colspan="2" rowspan="3">x</td></tr></table><img srcset="a.png 1x, b.png 2x" alt=""><iframe allowfullscreen frameborder="0"></iframe>',
    )
    expect(jsx).toContain('colSpan="2"')
    expect(jsx).toContain('rowSpan="3"')
    expect(jsx).toContain('srcSet="a.png 1x, b.png 2x"')
    expect(jsx).toContain('alt=""')
    expect(jsx).toMatch(/allowFullScreen/)
    expect(jsx).toContain('frameBorder="0"')
    expectParses(jsx)
  })

  it('drops names that cannot be JSX attributes and reports them', () => {
    const { jsx, issues } = convert('<div @click="x" v-on:foo="y" a.b="z" ok-name="1"></div>')
    expect(jsx).toBe('<div ok-name="1" />')
    expect(kinds(issues)).toEqual(['dropped-attribute', 'dropped-attribute', 'dropped-attribute'])
  })

  it('drops React-reserved names in any case', () => {
    const { jsx, issues } = convert(
      '<div key="1" REF="2" children="3" dangerouslySetInnerHTML="4" suppresshydrationwarning></div>',
    )
    expect(jsx).toBe('<div />')
    expect(issues).toHaveLength(5)
  })

  it('strips data-doop-* silently and keeps data-* and aria-*', () => {
    const { jsx, issues } = convert('<div data-doop-id="x1" data-doop-label="L" data-x="1" aria-hidden="true"></div>')
    expect(jsx).toBe('<div data-x="1" aria-hidden="true" />')
    expect(issues).toEqual([])
  })
})

describe('svg', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="red" stop-opacity=".5"/></linearGradient></defs><path d="M0 0" stroke-width="2" stroke-linecap="round" fill-opacity=".4" fill-rule="evenodd" clip-path="url(#c)"/><use xlink:href="#g" xml:space="preserve"/></svg>'

  it('uses the camelCase SVG names and leaves viewBox alone', () => {
    const { jsx, issues } = convert(svg)
    expect(issues).toEqual([])
    for (const name of [
      'strokeWidth="2"',
      'strokeLinecap="round"',
      'fillOpacity=".4"',
      'fillRule="evenodd"',
      'clipPath="url(#c)"',
      'stopColor="red"',
      'stopOpacity=".5"',
      'xlinkHref="#g"',
      'xmlSpace="preserve"',
      'xmlnsXlink=',
      'viewBox="0 0 24 24"',
      'preserveAspectRatio="xMidYMid"',
      'gradientUnits="userSpaceOnUse"',
      '<linearGradient',
    ]) {
      expect(jsx).toContain(name)
    }
    expectParses(jsx)
    expect(render(jsx)).toContain('viewBox="0 0 24 24"')
  })

  it('keeps html attribute names for an html element nested in an svg', () => {
    const { jsx } = convert('<svg><foreignObject><div class="a" data-x="1"></div></foreignObject></svg>')
    expect(jsx).toContain('<foreignObject>')
    expect(jsx).toContain('className="a"')
    expectParses(jsx)
  })

  it('drops script and unsafe values inside svg', () => {
    const { jsx, issues } = convert(
      '<svg><script>alert(1)</script><a href="javascript:alert(1)"><animate attributeName="href" to="javascript:alert(1)"/><set to="ok"/></a></svg>',
    )
    expect(jsx).not.toContain('javascript')
    expect(jsx).not.toContain('alert')
    expect(kinds(issues)).toEqual(expect.arrayContaining(['script', 'unsafe-url']))
    expect(jsx).toContain('to="ok"')
  })
})

describe('elements', () => {
  it('self-closes void elements', () => {
    const { jsx } = convert('<p>a<br>b<hr><img src="a.png"></p>')
    expect(jsx).toContain('<br />')
    expect(jsx).toContain('<hr />')
    expect(jsx).toContain('<img src="a.png" />')
    expectParses(jsx)
  })

  it('drops script, style, link, meta and friends with issues', () => {
    const { jsx, issues } = convert(
      '<div><script>alert(1)</script><style>a{}</style><link rel="x" href="a"><meta charset="x"><object data="x"></object><embed src="x"><noscript>n</noscript><template><b>t</b></template><p>kept</p></div>',
    )
    expect(jsx).toContain('kept')
    expect(jsx).not.toMatch(/alert|<style|<link|<meta|<object|<embed|noscript|template/)
    expect(kinds(issues).filter((k) => k === 'script')).toHaveLength(1)
    expect(kinds(issues).filter((k) => k === 'dropped-element')).toHaveLength(7)
  })

  it('drops comments with an issue and unexpanded doop-use elements', () => {
    const { jsx, issues } = convert('<div><!-- secret --><doop-use component="X"></doop-use>a</div>')
    expect(jsx).not.toContain('secret')
    expect(jsx).not.toContain('doop-use')
    expect(kinds(issues).sort()).toEqual(['comment', 'dropped-element'])
  })

  it('drops tag names that are not safe JSX names with their subtree', () => {
    const { jsx, issues } = convert('<div><foo:bar>x</foo:bar><this>y</this><p>z</p></div>')
    expect(jsx).not.toMatch(/foo|this|[xy]\b/)
    expect(kinds(issues)).toEqual(['dropped-element', 'dropped-element'])
  })

  it('keeps custom elements', () => {
    const { jsx } = convert('<my-widget data-a="1">x</my-widget>')
    expect(jsx).toContain('<my-widget data-a="1">')
    expectParses(jsx)
  })

  it('gives empty input null, one root as is and several roots a fragment', () => {
    expect(convert('').jsx).toBe('null')
    expect(convert('  \n ').jsx).toBe('null')
    expect(convert('<p>a</p>').jsx).toBe('<p>\n  {"a"}\n</p>')
    const many = convert('<p>a</p><p>b</p>').jsx
    expect(many.startsWith('<>')).toBe(true)
    expect(many.endsWith('</>')).toBe(true)
    expectParses(many)
    expectParses(convert('hello').jsx)
  })

  it('never emits dangerouslySetInnerHTML', () => {
    const { jsx } = convert('<div dangerouslySetInnerHTML="x">y</div><textarea>z</textarea>')
    expect(jsx).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('event handlers and urls', () => {
  it('drops on* attributes and reports them', () => {
    const { jsx, issues } = convert('<button onclick="alert(1)" onMouseOver="x()" class="b">go</button>')
    expect(jsx).not.toMatch(/onclick|alert|onMouseOver/i)
    expect(kinds(issues)).toEqual(['event-handler', 'event-handler'])
  })

  it('drops srcdoc', () => {
    const { jsx, issues } = convert('<iframe srcdoc="<script>alert(1)</script>"></iframe>')
    expect(jsx).toBe('<iframe />')
    expect(kinds(issues)).toEqual(['dropped-attribute'])
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscr\nipt:alert(1)',
    'java&#x09;script&colon;alert(1)',
    '&#106;avascript:alert(1)',
    '  javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('drops the unsafe url %j', (url) => {
    const { jsx, issues } = convert(`<a href="${url}">x</a><img src="${url}"><form action="${url}"></form>`)
    expect(jsx).not.toMatch(/href=|src=|action=/)
    expect(jsx).not.toMatch(/alert|msgbox/)
    expect(kinds(issues)).toEqual(['unsafe-url', 'unsafe-url', 'unsafe-url'])
  })

  it('keeps data:image urls and ordinary links', () => {
    const { jsx, issues } = convert(
      '<img src="data:image/png;base64,AAAA"><a href="https://example.com/a?b=1&amp;c=2">x</a>',
    )
    expect(issues).toEqual([])
    expect(jsx).toContain('src="data:image/png;base64,AAAA"')
    expect(jsx).toContain('href={"https://example.com/a?b=1&c=2"}')
    expectParses(jsx)
  })

  it('drops only the unsafe entries of a srcset', () => {
    const { jsx, issues } = convert('<img srcset="a.png 1x, javascript:alert(1) 2x, c.png 3x">')
    expect(jsx).toContain('srcSet="a.png 1x, c.png 3x"')
    expect(jsx).not.toContain('javascript')
    expect(kinds(issues)).toEqual(['unsafe-url'])
    expect(convert('<img srcset="javascript:alert(1) 1x">').jsx).toBe('<img />')
  })
})

describe('style', () => {
  it('converts a style string to an object', () => {
    const { jsx, issues } = convert(
      '<div style="color: red; --accent-color: #fff; -webkit-box-pack: center; -ms-flex: 1; background-color: blue"></div>',
    )
    expect(issues).toEqual([])
    expect(jsx).toBe(
      '<div style={{ color: "red", "--accent-color": "#fff", WebkitBoxPack: "center", msFlex: "1", backgroundColor: "blue" }} />',
    )
    expectParses(jsx)
  })

  it('removes !important and reports it', () => {
    const issues: ExportIssue[] = []
    expect(styleToJsx('color: red !important', issues)).toBe('{{ color: "red" }}')
    expect(kinds(issues)).toEqual(['style'])
  })

  it.each([
    'background: url(javascript:alert(1))',
    'background: url("JaVa\\53 cript:alert(1)")',
    'background: url( "data:text/html,x" )',
    'width: expression(alert(1))',
    'width: expr/**/ession(alert(1))',
    'border-color: javascript:x',
    'behavior: url(x.htc)',
  ])('drops the unsafe declaration %j', (decl) => {
    const issues: ExportIssue[] = []
    const out = styleToJsx(`${decl}; color: red`, issues)
    expect(out).toBe('{{ color: "red" }}')
    expect(kinds(issues)).toEqual(['style'])
  })

  it('keeps safe urls and returns null for an empty style', () => {
    const issues: ExportIssue[] = []
    expect(styleToJsx('background: url(https://a.test/x.png)', issues)).toBe(
      '{{ background: "url(https://a.test/x.png)" }}',
    )
    expect(styleToJsx('', issues)).toBeNull()
    expect(styleToJsx('background: url(data:image/png;base64,AA)', issues)).not.toBeNull()
    expect(issues).toEqual([])
  })
})

describe('forms', () => {
  it('uses uncontrolled defaults', () => {
    const { jsx } = convert(
      '<input value="v" checked><textarea>line1\nline2</textarea><select><option value="a">A</option><option value="b" selected>B</option></select>',
    )
    expect(jsx).toContain('defaultValue="v"')
    expect(jsx).toContain('defaultChecked')
    expect(jsx).toContain('defaultValue={"line1\\nline2"}')
    expect(jsx).toContain('<select defaultValue="b">')
    expect(jsx).not.toMatch(/ selected/)
    const markup = render(jsx)
    expect(markup).toContain('value="v"')
    expect(markup).toContain('checked=""')
    expect(markup).toContain('<option value="b" selected="">B</option>')
  })

  it('uses an array for a multiple select', () => {
    const { jsx } = convert(
      '<select multiple><option selected>One</option><option>Two</option><option selected>Three</option></select>',
    )
    expect(jsx).toContain('defaultValue={["One", "Three"]}')
    expectParses(jsx)
  })
})

describe('whitespace', () => {
  it('collapses runs and drops edge and block-adjacent whitespace', () => {
    const { jsx } = convert('<div>\n  <p>  a   b\n c </p>\n  <p>x</p>\n</div>')
    expect(jsx).toBe('<div>\n  <p>\n    {"a b c"}\n  </p>\n  <p>\n    {"x"}\n  </p>\n</div>')
  })

  it('keeps a space between inline siblings', () => {
    const { jsx } = convert('<p><b>a</b> <i>b</i></p>')
    expect(jsx).toContain('{" "}')
    expect(render(jsx)).toBe('<p><b>a</b> <i>b</i></p>')
  })

  it('keeps text exactly inside pre, textarea and code', () => {
    const { jsx } = convert('<pre>  a\n   b  </pre><p>x <code>  a  b </code></p>')
    expect(jsx).toContain('{"  a\\n   b  "}')
    expect(jsx).toContain('{"  a  b "}')
  })

  it('emits no stray text inside tables', () => {
    const { jsx } = convert('<table>\n <tbody>\n <tr> <td>a</td> <td>b</td> </tr>\n </tbody>\n</table>')
    expect(render(jsx)).toBe('<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>')
  })
})

describe('hooks', () => {
  it('lets visit replace an element with an expression and sees data-doop-* attributes', () => {
    const seen: string[] = []
    const { jsx } = convert('<div><span data-doop-prop="label">Label</span><b>keep</b></div>', {
      visit: (el) => {
        const prop = el.attrs.find((a) => a.name === 'data-doop-prop')
        if (prop) {
          seen.push(prop.value)
          return `{${prop.value}}`
        }
        return undefined
      },
    })
    expect(seen).toEqual(['label'])
    expect(jsx).toContain('{label}')
    expect(jsx).toContain('{"keep"}')
    expect(jsx).not.toContain('Label')
  })

  it('lets visit return a bare expression for a single root', () => {
    expect(convert('<i>x</i>', { visit: () => '{props.children}' }).jsx).toBe('props.children')
  })

  it('overrides one attribute through ctx.element and can add or drop others', () => {
    const { jsx } = convert('<a href="/x" class="c" title="t">go</a>', {
      visit: (el, ctx) =>
        el.tagName === 'a' ? ctx.element({ href: '{href}', title: null, rel: '{"noopener"}' }) : undefined,
    })
    expect(jsx).toContain('href={href}')
    expect(jsx).toContain('className="c"')
    expect(jsx).toContain('rel={"noopener"}')
    expect(jsx).not.toContain('title')
  })

  it('lets visit wrap the default children', () => {
    const { jsx } = convert('<ul><li>a</li></ul>', {
      visit: (el, ctx) => (el.tagName === 'li' ? `<Item>${ctx.children()}</Item>` : undefined),
    })
    expect(jsx).toContain('<Item>{"a"}</Item>')
  })

  it('reports visitor issues and does not repeat the element issues', () => {
    const { issues } = convert('<p onclick="x">a</p>', {
      visit: (_el, ctx) => {
        ctx.element()
        ctx.issues.push({ kind: 'name', detail: 'mine' })
        return ctx.element()
      },
    })
    expect(kinds(issues)).toEqual(['event-handler', 'name'])
  })

  it('uses the className hook', () => {
    const { jsx } = convert('<div class="a b"><p class="c"></p><i></i></div>', {
      className: (classes) => `{styles[${jsString(classes.join(' '))}]}`,
    })
    expect(jsx).toContain('className={styles["a b"]}')
    expect(jsx).toContain('className={styles["c"]}')
  })

  it('uses a custom indent', () => {
    expect(convert('<p>a</p>', { indent: '\t' }).jsx).toBe('<p>\n\t{"a"}\n</p>')
  })
})

describe('injection corpus', () => {
  const payloads = [
    '{',
    '}',
    '{{',
    '}}',
    '{alert(1)}',
    '</script>',
    '</script><script>alert(1)</script>',
    '<!--',
    '-->',
    '`',
    '${alert(1)}',
    '`${alert(1)}`',
    '*/',
    '/*',
    '*/ alert(1) /*',
    '\\',
    '\\"',
    '"',
    "'",
    '" onload="alert(1)',
    'a b',
    '\u00a0\u2028\u2029',
    '&lt;b&gt;',
    '&amp;amp;',
    '</div><div>',
    '{" "}',
    '\ud800',
    'a\ud83d\ude00b',
  ]
  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  /** what the converter sees for a payload: parse5's reading of the HTML we built from it */
  const seen = (payload: string) => textOf(parseFragment(`<i>${escapeHtml(payload)}</i>`))
  const outsideStrings = (jsx: string) => jsx.replace(/"(?:[^"\\]|\\.)*"/g, '""')

  const check = (jsx: string) => {
    expectParses(jsx)
    expect(jsx).not.toMatch(/<\/script/i)
    expect(jsx).not.toContain('dangerouslySetInnerHTML')
    expect(outsideStrings(jsx)).not.toContain('`')
    expect(jsx).not.toMatch(/[\u2028\u2029]/)
  }

  it.each(payloads)('keeps %j as data in text', (payload) => {
    const { jsx, issues } = convert(`<span>${escapeHtml(payload)}</span>`)
    check(jsx)
    expect(issues).toEqual([])
    const markup = render(jsx)
    expect(textOf(firstElement(markup))).toBe(seen(payload))
  })

  it.each(payloads)('keeps %j as data in an attribute value', (payload) => {
    const { jsx, issues } = convert(`<span title="${escapeHtml(payload)}" data-p="${escapeHtml(payload)}">x</span>`)
    check(jsx)
    expect(issues).toEqual([])
    const el = firstElement(render(jsx))
    const expected = textOf(parseFragment(`<i>${escapeHtml(payload)}</i>`))
    expect(attrOf(el, 'title')).toBe(expected)
    expect(attrOf(el, 'data-p')).toBe(expected)
  })

  it.each(payloads)('keeps %j as data in a style custom property', (payload) => {
    const html = `<span style="--x: ${escapeHtml(payload)}">x</span>`
    const { jsx } = convert(html)
    check(jsx)
    const original = attrOf(firstElement(html), 'style') ?? ''
    const expected = original.replace(/^--x:\s*/, '').trim()
    // an unquoted `;` ends a CSS declaration, so that payload is not one value
    if (expected === '' || payload.includes(';') || /!\s*important\s*$/i.test(expected)) return
    const style = attrOf(firstElement(render(jsx)), 'style')
    if (style === undefined) {
      // the whole declaration was refused as unsafe; nothing ran, so nothing is left to compare
      return
    }
    expect(style.replace(/^--x:/, '')).toBe(expected)
  })

  it.each(payloads)('keeps %j as data through the exported helpers', (payload) => {
    check(`<>${jsxText(payload)}</>`)
    check(`<i title={${jsString(payload)}}>{${jsString(payload)}}</i>`)
  })

  it('keeps every payload together in one tree', () => {
    const html = payloads.map((p) => `<p title="${escapeHtml(p)}">${escapeHtml(p)}</p>`).join('')
    const { jsx } = convert(html)
    check(jsx)
    const paragraphs = parseFragment(render(jsx)).childNodes.filter((n): n is Tree.Element => 'tagName' in n)
    expect(paragraphs.map(textOf)).toEqual(payloads.map(seen))
  })
})

describe('a realistic component body', () => {
  const body = `
    <article class="card" data-doop-id="c1" style="display: flex; gap: 12px; --card-pad: 16px; padding: var(--card-pad)">
      <svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M5 12h14" /><path d="M12 5v14"/>
      </svg>
      <img src="/photos/a.jpeg" srcset="/photos/a.jpeg 1x, /photos/a@2x.jpeg 2x" alt="A &amp; B" width="320" height="200">
      <h3>Title &mdash; “quoted”</h3>
      <p>Some <strong>bold</strong> text, with a <a href="https://example.com/?a=1&amp;b=2" target="_blank">link</a>.</p>
      <label for="email">Email</label>
      <input id="email" type="email" name="email" placeholder="you@example.com" required value="x@y.z">
      <button type="submit" class="btn" onclick="track()" disabled>Send</button>
    </article>`

  it('transpiles and renders', () => {
    const { jsx, issues } = convert(body)
    expect(kinds(issues)).toEqual(['event-handler'])
    expectParses(jsx)
    const markup = render(jsx)
    expect(markup).toContain('<article class="card"')
    expect(markup).toContain('--card-pad:16px')
    expect(markup).toMatch(/srcset="\/photos\/a.jpeg 1x, \/photos\/a@2x.jpeg 2x"/i)
    expect(markup).toContain('alt="A &amp; B"')
    expect(markup).toContain('for="email"')
    expect(markup).toContain('value="x@y.z"')
    expect(markup).not.toContain('onclick')
    expect(markup).not.toContain('data-doop')
    expect(textOf(firstElement(markup))).toContain('Title — “quoted”')
  })
})
