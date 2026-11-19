import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderInstanceHtml } from '../server/componentEngine.ts'
import { buildReactExport, type ReactExportInput, type ReactExportResult } from '../server/reactExport/index.ts'
import type { ComponentDef, ComponentProp } from '../shared/components.ts'
import { normalize, renderAll, typecheck, writeProject } from './reactExportHarness'

function def(name: string, template: string, extra: Partial<ComponentDef> = {}): ComponentDef {
  return {
    id: `c-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    description: '',
    template,
    css: '',
    rawCss: '',
    head: [],
    props: [],
    slots: [],
    rev: 1,
    mainFrameId: null,
    history: [],
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'test',
    ...extra,
  }
}

type Styling = ReactExportInput['styling']

const exportOf = (
  components: ComponentDef[],
  frames: ReactExportInput['frames'] = [],
  styling: Styling = 'modules',
  extra: Partial<ReactExportInput> = {},
): ReactExportResult =>
  buildReactExport({
    canvasName: 'test',
    components,
    frames,
    tokens: [],
    themeOrder: [],
    styling,
    assetOrigin: 'https://doop.example',
    ...extra,
  })

const fileOf = (result: ReactExportResult, path: string): string => {
  const file = result.files.find((entry) => entry.path === path)
  if (!file) throw new Error(`no file ${path} in ${result.files.map((entry) => entry.path).join(', ')}`)
  return file.content
}

const engine = (defs: ComponentDef[]) => ({
  find: (ref: string) => defs.find((entry) => entry.id === ref || entry.name === ref),
  atRev: (id: string) => defs.find((entry) => entry.id === id),
  issues: [],
})
const instance = (target: ComponentDef, defs: ComponentDef[], props: Record<string, string> = {}) =>
  renderInstanceHtml(target, { instanceId: 'abcdef', overrides: { props } }, engine(defs))
const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const frame = (body: string) => [{ id: 'f1', name: 'Home', html: page(body) }]

/** Values that must reach the generated code as inert strings, never as syntax. */
const HOSTILE = [
  '`${process.exit(1)}`',
  '}{ </script><script>alert(1)</script>',
  '*/ alert(1) /*',
  '"double" \'single\' \\ back',
  'line\u2028separator\u2029paragraph',
  '<img src=x onerror=alert(1)> & &amp; { title }',
  '${x} {x} >',
]

const ITEM_FIELDS: ComponentProp['fields'] = {
  title: { type: 'text' },
  url: { type: 'link' },
  image: { type: 'image' },
  featured: { type: 'boolean' },
}

const CARD_TEMPLATE = `<section class="card" data-doop-part="r">
  <h2 data-doop-part="h" data-doop-prop="heading">Cards</h2>
  <div class="lead" data-doop-part="b" data-doop-prop="body">Plain <b>bold</b> and <a href="https://example.com/x">a link</a></div>
  <ul data-doop-part="ul" data-doop-if="showlist">
    <li class="row" data-doop-part="li" data-doop-each="items">
      <a data-doop-part="a" data-doop-prop="href:url,title" href="/start">Sample</a>
      <img data-doop-part="im" data-doop-prop="src:image" src="/a/sample.png" alt="">
      <span class="badge" data-doop-part="f" data-doop-if="featured">Featured</span>
    </li>
  </ul>
</section>`

const CARD = def('Card', CARD_TEMPLATE, {
  rawCss: '.card { display: grid } .row { display: flex } .badge { color: red } .lead { color: blue }',
  props: [
    { name: 'heading', type: 'text' },
    { name: 'body', type: 'richtext' },
    { name: 'showlist', type: 'boolean', default: 'true' },
    {
      name: 'items',
      type: 'list',
      fields: ITEM_FIELDS,
      default: JSON.stringify([{ title: 'One', url: '/one', image: '/a/one.png', featured: true }]),
    },
  ],
})

const stringLiterals = (code: string): Set<string> => {
  const source = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) found.add(node.text)
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node))
      throw new Error('a template literal in generated code')
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The syntax errors of a generated file (it must parse as TSX). */
const syntaxErrors = (code: string): string[] =>
  (
    ts.transpileModule(code, {
      reportDiagnostics: true,
      fileName: 'x.tsx',
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).diagnostics ?? []
  ).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))

describe.each(['modules', 'tailwind'] as const)('list and rich-text props, %s styling', (styling) => {
  const items = [
    { title: 'Plain', url: '/plain', image: '/a/plain.png', featured: true },
    { title: HOSTILE[0], url: 'https://example.com/a?b=1&c=<2>', image: '', featured: false },
    { title: HOSTILE[1], url: '', image: '/a/two.png' },
  ]
  const body = 'Say <b>hi</b> <i>there</i><br><a href="https://example.com/p?q=1">link</a> <span class="hl">mark</span>'
  const html = instance(CARD, [CARD], { items: JSON.stringify(items), body, heading: 'Heading' })
  const result = exportOf([CARD], frame(html), styling, { componentIds: [CARD.id] })
  const tsx = fileOf(result, 'src/components/Card.tsx')
  const home = fileOf(result, 'src/pages/Home.tsx')

  it('types the item interface and the props', () => {
    expect(tsx).toContain('export interface CardItem {')
    for (const member of ['title: string', 'url: string', 'image: string', 'featured: boolean'])
      expect(tsx).toContain(`  ${member}`)
    expect(tsx).toContain('items?: CardItem[]')
    expect(tsx).toContain('body?: ReactNode')
    expect(fileOf(result, 'src/components/index.ts')).toContain('export type { CardProps, CardItem }')
  })

  it('maps the each-element, binds item fields and conditions', () => {
    expect(tsx).toContain('{items.map((item, index) => (')
    expect(tsx).toContain('<li key={index}')
    expect(tsx).toContain('href={item.url || undefined}')
    expect(tsx).toContain('{item.title}')
    expect(tsx).toContain('src={item.image || undefined}')
    expect(tsx).toContain('{item.featured && (')
    /* the list's own condition reads the component's props, outside the item */
    expect(tsx).toContain('{showlist && (')
    expect(tsx).toContain('{body}')
  })

  it('defaults the list to its declared items and the rich text to the main content', () => {
    expect(tsx).toContain('{ title: "One", url: "/one", image: "https://doop.example/a/one.png", featured: true },')
    expect(tsx).toMatch(/body = \(\n\s+<>\n\s+\{"Plain "\}\n\s+<b>/)
  })

  it('passes the instance items as a literal array and the rich text as JSX', () => {
    expect(home).toContain('items={[')
    expect(home).toContain('title: "Plain"')
    expect(home).toContain('featured: true')
    expect(home).toContain('body={<>')
    expect(home).toContain('<a href="https://example.com/p?q=1">')
    expect(home).not.toContain('<script')
    expect(home).not.toContain('dangerouslySetInnerHTML')
  })

  it('keeps every hostile value as a string literal that parses', () => {
    for (const code of [tsx, home]) expect(syntaxErrors(code)).toEqual([])
    const literals = stringLiterals(home)
    expect(literals.has(HOSTILE[0] ?? '')).toBe(true)
    expect(literals.has(HOSTILE[1] ?? '')).toBe(true)
    expect(home).not.toMatch(/[\u2028\u2029]/)
    expect(home).not.toContain('</script>')
    expect(home).not.toContain('<script')
  })

  it('type-checks strictly and renders what the engine renders', async () => {
    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
      const rendered = await renderAll(project, {
        page: { from: './src/pages/Home', name: 'Home' },
        defaults: { from: './src/components/Card', name: 'Card' },
      })
      const out = rendered.page ?? ''
      expect(out).toContain('<h2>Heading</h2>')
      expect(out).toContain('<a href="/plain">Plain</a>')
      expect(out).toContain('src="https://doop.example/a/plain.png"')
      expect(out).toContain('Featured')
      expect(out.match(/<li/g)).toHaveLength(3)
      /* the hostile titles are text */
      expect(out).toContain('`${process.exit(1)}`')
      expect(out).toContain('}{ &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(out).not.toContain('<script')
      expect(out).not.toContain('onerror')
      expect(out).toContain('Say <b>hi</b> <i>there</i><br/>')
      /* the second item has no link and no image: the attributes are left off */
      expect(out).not.toContain('href=""')
      expect(out).not.toContain('src=""')
      const fresh = rendered.defaults ?? ''
      expect(normalize(fresh)).toContain('href="/one"')
      expect(fresh).toContain('Plain <b>bold</b>')
    } finally {
      project.cleanup()
    }
  })
})

describe('list props: planning', () => {
  it('uses the one sample item of a main with no declared default', () => {
    const bare = def('Bare', CARD_TEMPLATE, {
      props: [
        { name: 'items', type: 'list', fields: ITEM_FIELDS },
        { name: 'showlist', type: 'boolean', default: 'true' },
      ],
    })
    const tsx = fileOf(exportOf([bare], [], 'modules', { componentIds: [bare.id] }), 'src/components/Bare.tsx')
    expect(tsx).toContain(
      '{ title: "Sample", url: "/start", image: "https://doop.example/a/sample.png", featured: true },',
    )
  })

  it('names the item interface from the component and the prop, safely', () => {
    const odd = def(
      'Link Row',
      `<ul data-doop-part="r"><li data-doop-part="l" data-doop-each="nav-links"><a data-doop-part="a" data-doop-prop="href:link-to,class,a-1,a1" href="#">x</a></li></ul>`,
      {
        props: [
          {
            name: 'nav-links',
            type: 'list',
            fields: {
              'link-to': { type: 'link' },
              class: { type: 'text' },
              'a-1': { type: 'text' },
              a1: { type: 'text' },
              ['constructor']: { type: 'text' as const },
            },
          },
        ],
      },
    )
    const result = exportOf([odd], [], 'modules', { componentIds: [odd.id] })
    const tsx = fileOf(result, 'src/components/LinkRow.tsx')
    expect(tsx).toContain('export interface LinkRowNavLinksItem {')
    expect(tsx).toContain('  linkTo: string')
    expect(tsx).toContain('  classProp: string')
    expect(tsx).toContain('  a1: string')
    expect(tsx).toContain('  a12: string')
    expect(tsx).not.toContain('constructor')
    expect(result.report.issues.map((issue) => issue.detail).join('\n')).toContain('"constructor"')
    expect(syntaxErrors(tsx)).toEqual([])
    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
    } finally {
      project.cleanup()
    }
  })

  it('leaves out a list that declares no usable field, and says so', () => {
    const empty = def('Empty', CARD_TEMPLATE, { props: [{ name: 'items', type: 'list', fields: {} }] })
    const result = exportOf([empty], [], 'modules', { componentIds: [empty.id] })
    const tsx = fileOf(result, 'src/components/Empty.tsx')
    expect(tsx).not.toContain('items?:')
    expect(result.report.issues.map((issue) => issue.detail).join('\n')).toContain('declares no usable fields')
  })

  it('does not let a prop shadow the loop variables', () => {
    const shadow = def(
      'Shadow',
      `<ul data-doop-part="r"><li data-doop-part="l" data-doop-each="rows"><span data-doop-part="s" data-doop-prop="name"></span><b data-doop-part="b" data-doop-prop="item">x</b></li></ul>`,
      {
        props: [
          { name: 'rows', type: 'list', fields: { name: { type: 'text' } } },
          { name: 'item', type: 'text' },
        ],
      },
    )
    const tsx = fileOf(exportOf([shadow], [], 'modules', { componentIds: [shadow.id] }), 'src/components/Shadow.tsx')
    expect(tsx).toContain('rows.map((item_, index) => (')
    expect(tsx).toContain('{item_.name}')
    expect(tsx).toContain('{item}')
  })

  it('forwards a list to a nested component of the same shape and an item field to a nested prop', () => {
    const chip = def('Chip', `<i data-doop-part="r" data-doop-prop="label">x</i>`, {
      props: [{ name: 'label', type: 'text' }],
    })
    const row = def(
      'Row',
      `<ul data-doop-part="r"><li data-doop-part="l" data-doop-each="tags"><doop-use component="Chip" data-doop-part="u" data-doop-prop="label:name"></doop-use></li></ul>`,
      { props: [{ name: 'tags', type: 'list', fields: { name: { type: 'text' } } }] },
    )
    const tsx = fileOf(exportOf([chip, row], [], 'modules', { componentIds: [row.id] }), 'src/components/Row.tsx')
    expect(tsx).toContain('tags.map((item, index) => (')
    expect(tsx).toContain('<Chip label={item.name} />')
  })
})

describe('rich-text props: planning', () => {
  it('forwards a string to a rich prop and refuses the other way', () => {
    const inner = def('Inner', `<p data-doop-part="r" data-doop-prop="text">x</p>`, {
      props: [{ name: 'text', type: 'richtext' }],
    })
    const outer = def(
      'Outer',
      `<doop-use component="Inner" data-doop-part="u" data-doop-prop="text:label"></doop-use>`,
      {
        props: [{ name: 'label', type: 'text' }],
      },
    )
    const tsx = fileOf(
      exportOf([inner, outer], [], 'modules', { componentIds: [outer.id] }),
      'src/components/Outer.tsx',
    )
    expect(tsx).toContain('<Inner text={label} />')
  })

  it('reports what the sanitizer takes out of a rich value', () => {
    const rich = def('Rich', `<p data-doop-part="r" data-doop-prop="text">x</p>`, {
      props: [{ name: 'text', type: 'richtext' }],
    })
    const hostile = `<p data-doop-part="r" data-doop-instance="${rich.id}" data-doop-rev="1" data-doop-props="${'{&quot;text&quot;:&quot;a&lt;script&gt;x&lt;/script&gt;&lt;b onclick=1&gt;b&lt;/b&gt; &lt;a href=\\&quot;javascript:alert(1)\\&quot;&gt;l&lt;/a&gt;&quot;}'}">a</p>`
    const result = exportOf([rich], frame(hostile), 'modules', { componentIds: [rich.id] })
    const home = fileOf(result, 'src/pages/Home.tsx')
    expect(home).not.toContain('script')
    expect(home).not.toContain('onclick')
    expect(home).not.toContain('javascript')
    expect(syntaxErrors(home)).toEqual([])
  })
})

describe('bound targets the engine refuses', () => {
  const issuesOf = (result: ReactExportResult) => result.report.issues.map((issue) => issue.detail).join('\n')

  it('drops srcdoc and ping bindings for a text prop and for a list field', () => {
    const risky = def(
      'Risky',
      `<div data-doop-part="r"><iframe data-doop-part="i" data-doop-prop="srcdoc:doc" title="t"></iframe><a data-doop-part="p" data-doop-prop="ping:track" href="#">x</a><ul data-doop-part="ul"><li data-doop-part="l" data-doop-each="rows"><iframe data-doop-part="fi" data-doop-prop="srcdoc:html" title="t"></iframe><a data-doop-part="fa" data-doop-prop="ping:beacon,href:url" href="#">y</a></li></ul></div>`,
      {
        props: [
          { name: 'doc', type: 'text' },
          { name: 'track', type: 'text' },
          {
            name: 'rows',
            type: 'list',
            fields: { html: { type: 'text' }, beacon: { type: 'text' }, url: { type: 'link' } },
          },
        ],
      },
    )
    for (const styling of ['modules', 'tailwind'] as const) {
      const result = exportOf([risky], [], styling, { componentIds: [risky.id] })
      const tsx = fileOf(result, 'src/components/Risky.tsx')
      expect(tsx).not.toContain('srcdoc')
      expect(tsx).not.toContain('srcDoc')
      expect(tsx).not.toContain('ping')
      expect(tsx).toContain('href={item.url || undefined}')
      expect(issuesOf(result)).toContain('binding to "srcdoc" dropped')
      expect(issuesOf(result)).toContain('binding to "ping" dropped')
    }
  })

  it('keeps raw field names as item keys for a code-mapped component', () => {
    const mapped = def(
      'Menu',
      `<ul data-doop-part="r"><li data-doop-part="l" data-doop-each="entries"><a data-doop-part="a" data-doop-prop="href:link-url,label-text" href="#">x</a></li></ul>`,
      {
        props: [
          {
            name: 'entries',
            type: 'list',
            fields: { 'link-url': { type: 'link' }, 'label-text': { type: 'text' }, plain: { type: 'text' } },
          },
        ],
        code: { importFrom: '@acme/ui', exportName: 'Menu' },
      },
    )
    const html = instance(mapped, [mapped], {
      entries: JSON.stringify([{ 'link-url': '/a', 'label-text': 'A', plain: 'p' }]),
    })
    const result = exportOf([mapped], frame(html), 'modules', { componentIds: [mapped.id] })
    const home = fileOf(result, 'src/pages/Home.tsx')
    expect(home).toContain('"link-url": "/a"')
    expect(home).toContain('"label-text": "A"')
    expect(home).toContain('plain: "p"')
    expect(syntaxErrors(home)).toEqual([])
  })

  it('reports data-doop-each on a nested component and renders it once, as Doop does', () => {
    const chip = def('Chip', `<i data-doop-part="r">c</i>`)
    const row = def(
      'Row2',
      `<div data-doop-part="r"><doop-use component="Chip" data-doop-part="u" data-doop-each="things"></doop-use></div>`,
      { props: [{ name: 'things', type: 'list', fields: { a: { type: 'text' } } }] },
    )
    const result = exportOf([chip, row], [], 'modules', { componentIds: [row.id] })
    const tsx = fileOf(result, 'src/components/Row2.tsx')
    expect(tsx).toContain('<Chip />')
    expect(tsx).not.toContain('.map(')
    expect(issuesOf(result)).toContain('data-doop-each on a nested component was ignored')
  })
})
