import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'
import {
  PROTECTED_ATTRS,
  applyEdits,
  checkFragment,
  editsForOp,
  frameOutline,
  mergeStyle,
} from '../server/sectionEdits'
import type { EditableElement, OpBody } from '../server/sectionEdits'

interface TreeLocation {
  startOffset: number
  endOffset: number
  startTag?: { startOffset: number; endOffset: number }
  endTag?: { startOffset: number; endOffset: number }
  attrs?: Record<string, TreeLocation>
}

interface TreeNode {
  nodeName: string
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: TreeNode[]
  content?: TreeNode
  sourceCodeLocation?: TreeLocation | null
}

function findFirst(node: TreeNode, tag: string): TreeNode | undefined {
  const stack: TreeNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (current.tagName?.toLowerCase() === tag) return current
    const children = current.childNodes ?? []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child) stack.push(child)
    }
    if (current.content?.childNodes) {
      for (let index = current.content.childNodes.length - 1; index >= 0; index -= 1) {
        const child = current.content.childNodes[index]
        if (child) stack.push(child)
      }
    }
  }
  return undefined
}

function editable(html: string, tag: string): EditableElement {
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as TreeNode
  const found = findFirst(document, tag)
  const location = found?.sourceCodeLocation
  if (!found || !location?.startTag) throw new Error(`no <${tag}> in ${html}`)
  const attrs: EditableElement['attrs'] = {}
  for (const [name, attr] of Object.entries(location.attrs ?? {})) {
    const value = found.attrs?.find((entry) => entry.name === name)?.value ?? ''
    attrs[name] = { start: attr.startOffset, end: attr.endOffset, value }
  }
  return {
    tagName: (found.tagName ?? tag).toLowerCase(),
    start: location.startOffset,
    end: location.endOffset,
    startTag: { start: location.startTag.startOffset, end: location.startTag.endOffset },
    endTag: location.endTag ? { start: location.endTag.startOffset, end: location.endTag.endOffset } : undefined,
    inner: {
      start: location.startTag.endOffset,
      end: location.endTag?.startOffset ?? location.endOffset,
    },
    attrs,
  }
}

function run(html: string, tag: string, op: OpBody): string {
  const result = editsForOp(html, editable(html, tag), op)
  if (!result.ok) throw new Error(result.error)
  const applied = applyEdits(html, result.edits)
  if (!applied.ok) throw new Error(applied.error)
  return applied.html
}

function refuse(html: string, tag: string, op: OpBody): string {
  const result = editsForOp(html, editable(html, tag), op)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.error
}

describe('editsForOp', () => {
  it('replaces inner text and escapes markup characters', () => {
    const html = '<div>old &amp; stale</div>'
    expect(run(html, 'div', { op: 'set_text', text: 'x & <y> z' })).toBe('<div>x &amp; &lt;y&gt; z</div>')
  })

  it('refuses set_text on void elements', () => {
    const error = refuse('<img src="/a.png">', 'img', { op: 'set_text', text: 'x' })
    expect(error).toContain('replace_section')
  })

  it('refuses set_text over an anchored descendant', () => {
    const html = '<div><span data-doop-id="e_1">x</span></div>'
    const error = refuse(html, 'div', { op: 'set_text', text: 'y' })
    expect(error).toContain('replace_section')
  })

  it('rewrites an existing attribute with escaping', () => {
    const html = '<div title="a">x</div>'
    expect(run(html, 'div', { op: 'set_attr', name: 'title', value: 'He said "hi" & bye' })).toBe(
      '<div title="He said &quot;hi&quot; &amp; bye">x</div>',
    )
  })

  it('inserts a missing attribute after the last attribute', () => {
    const html = '<div id="a" data-x="1">x</div>'
    expect(run(html, 'div', { op: 'set_attr', name: 'class', value: 'card' })).toBe(
      '<div id="a" data-x="1" class="card">x</div>',
    )
  })

  it('inserts a missing attribute after the tag name when there are none', () => {
    const html = '<div>x</div>'
    expect(run(html, 'div', { op: 'set_attr', name: 'role', value: 'note' })).toBe('<div role="note">x</div>')
  })

  it('keeps an unquoted attribute ending in a slash intact', () => {
    const html = '<a href=/x/>hi</a>'
    expect(run(html, 'a', { op: 'set_attr', name: 'title', value: 'hi' })).toBe('<a href=/x/ title="hi">hi</a>')
  })

  it('refuses protected attributes for set and remove', () => {
    for (const name of PROTECTED_ATTRS) {
      refuse(`<div ${name}="x">y</div>`, 'div', { op: 'set_attr', name, value: 'z' })
      refuse(`<div ${name}="x">y</div>`, 'div', { op: 'remove_attr', name })
    }
  })

  it('removes an attribute with its leading whitespace', () => {
    const html = '<div id="a" class="b" title="c">x</div>'
    expect(run(html, 'div', { op: 'remove_attr', name: 'class' })).toBe('<div id="a" title="c">x</div>')
  })

  it('treats a missing remove_attr as a no-op', () => {
    const html = '<div id="a">x</div>'
    const result = editsForOp(html, editable(html, 'div'), { op: 'remove_attr', name: 'missing' })
    expect(result).toEqual({ ok: true, edits: [] })
  })

  it('merges styles, replacing in place and dropping null properties', () => {
    expect(mergeStyle('color: red; margin: 0', { color: 'blue', 'font-size': '12px', margin: null })).toBe(
      'color: blue; font-size: 12px',
    )
  })

  it('does not split declarations inside a url data payload', () => {
    const existing = 'background: url(data:image/png;base64,AAA;BBB) center no-repeat; color: red'
    expect(mergeStyle(existing, { color: 'blue' })).toBe(
      'background: url(data:image/png;base64,AAA;BBB) center no-repeat; color: blue',
    )
  })

  it('sets style through mergeStyle', () => {
    const html = '<div style="background: url(data:image/png;base64,AAA;BBB) no-repeat">x</div>'
    expect(run(html, 'div', { op: 'set_style', style: { color: 'red' } })).toBe(
      '<div style="background: url(data:image/png;base64,AAA;BBB) no-repeat; color: red">x</div>',
    )
  })

  it('removes the style attribute when the merged style is empty', () => {
    const html = '<div id="a" style="color: red">x</div>'
    expect(run(html, 'div', { op: 'set_style', style: { color: null } })).toBe('<div id="a">x</div>')
  })

  it('inserts before and after an element', () => {
    const html = '<main><div>x</div></main>'
    expect(run(html, 'div', { op: 'insert_before', html: '<p>a</p>' })).toBe('<main><p>a</p><div>x</div></main>')
    expect(run(html, 'div', { op: 'insert_after', html: '<p>b</p>' })).toBe('<main><div>x</div><p>b</p></main>')
  })

  it('refuses inserts and replaces with unclosed fragments', () => {
    const html = '<main><div>x</div></main>'
    refuse(html, 'div', { op: 'insert_before', html: '<div><span>' })
    refuse(html, 'div', { op: 'insert_after', html: '</div>' })
    refuse(html, 'div', { op: 'replace', html: '<div>' })
  })

  it('removes and replaces the whole element', () => {
    const html = '<main><div class="a">x</div><p>y</p></main>'
    expect(run(html, 'div', { op: 'remove' })).toBe('<main><p>y</p></main>')
    expect(run(html, 'div', { op: 'replace', html: '<section>z</section>' })).toBe(
      '<main><section>z</section><p>y</p></main>',
    )
  })
})

describe('applyEdits', () => {
  it('refuses overlapping edits and applies nothing', () => {
    const result = applyEdits('0123456789', [
      { start: 0, end: 5, text: 'a' },
      { start: 3, end: 6, text: 'b' },
    ])
    expect(result.ok).toBe(false)
  })

  it('keeps adjacent inserts in input order', () => {
    const result = applyEdits('abcdef', [
      { start: 3, end: 3, text: 'A' },
      { start: 3, end: 3, text: 'B' },
    ])
    expect(result).toEqual({ ok: true, html: 'abcABdef' })
  })

  it('allows an insert at the boundary of a replacement', () => {
    const result = applyEdits('abcdef', [
      { start: 2, end: 4, text: 'X' },
      { start: 4, end: 4, text: 'Z' },
    ])
    expect(result).toEqual({ ok: true, html: 'abXZef' })
    const before = applyEdits('abcdef', [
      { start: 2, end: 4, text: 'X' },
      { start: 2, end: 2, text: 'Z' },
    ])
    expect(before).toEqual({ ok: true, html: 'abZXef' })
  })

  it('leaves bytes outside an edit unchanged', () => {
    const html = '<main><div class="a">x</div><p>y</p></main>'
    const element = editable(html, 'div')
    const result = editsForOp(html, element, { op: 'set_attr', name: 'class', value: 'b' })
    if (!result.ok) throw new Error(result.error)
    const applied = applyEdits(html, result.edits)
    if (!applied.ok) throw new Error(applied.error)
    const suffix = html.length - element.startTag.end
    expect(applied.html.slice(0, element.startTag.start)).toBe(html.slice(0, element.startTag.start))
    expect(applied.html.slice(-suffix)).toBe(html.slice(element.startTag.end))
  })
})

describe('checkFragment', () => {
  it('refuses an element with a missing end tag', () => {
    const result = checkFragment('<div><span>')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/line 1, column 1/)
  })

  it('refuses a stray end tag', () => {
    const result = checkFragment('</div>')
    expect(result.ok).toBe(false)
  })

  it('accepts optional end tags', () => {
    expect(checkFragment('<li>a<li>b')).toEqual({ ok: true })
    expect(checkFragment('<p>x')).toEqual({ ok: true })
  })

  it('uses the context tag when given', () => {
    expect(checkFragment('<td>a</td>', 'tr')).toEqual({ ok: true })
  })
})

describe('frameOutline', () => {
  it('outlines a page container, labels, styles and scripts', () => {
    const html = [
      '<!doctype html><html><head>',
      '<style data-doop-style="base">.a{color:red}</style>',
      '</head><body><main>',
      '<header data-doop-label="Site header"><h1>Welcome <b>home</b></h1></header>',
      '<section data-doop-id="e_1"><h2>Intro</h2><p>Hello <strong>world</strong></p></section>',
      '<section aria-label="Pricing"><p>Prices</p></section>',
      '<doop-use component="Hero"><div>x</div></doop-use>',
      '<footer><h3>Foot</h3><p>bye</p></footer>',
      '<script>var a = 1</script>',
      '<style>.b{}</style>',
      '</main></body></html>',
    ].join('')
    const outline = frameOutline(html)
    expect(outline.container).toBe('body > main')
    expect(outline.bytes).toBe(html.length)
    expect(outline.sections.map((section) => section.tag)).toEqual([
      'header',
      'section',
      'section',
      'doop-use',
      'footer',
    ])
    expect(outline.sections.map((section) => section.label)).toEqual([
      'Site header',
      'Intro',
      'Pricing',
      'Hero',
      'Foot',
    ])
    expect(outline.sections[1]?.elementId).toBe('e_1')
    expect(outline.sections[1]?.text).toBe('Intro Hello world')
    expect(outline.sections[2]?.path).toBe('body > main > section:nth-of-type(2)')
    expect(outline.sections[0]?.bytes).toBe(html.indexOf('</header>') + '</header>'.length - html.indexOf('<header'))
    expect(outline.styles).toEqual([{ bytes: 13, marker: 'data-doop-style' }, { bytes: 4 }])
    expect(outline.scripts).toBe(1)
    expect(outline.truncated).toBeUndefined()
  })

  it('descends into a single wrapper but not into a paragraph', () => {
    expect(frameOutline('<body><div><p><span>x</span></p></div></body>').container).toBe('body > div')
    expect(frameOutline('<body><p><span>x</span></p></body>').container).toBe('body')
    expect(frameOutline('<body><h1>t</h1></body>').container).toBe('body')
  })

  it('caps sections and reports the remainder', () => {
    const html = `<body><main>${'<section><p>x</p></section>'.repeat(65)}</main></body>`
    const outline = frameOutline(html)
    expect(outline.sections).toHaveLength(60)
    expect(outline.truncated).toBe(5)
  })

  it('keeps a large page outline under 3 KB', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '
    const sections = Array.from({ length: 12 }, (_, index) => {
      const body = filler.repeat(160)
      return `<section data-doop-label="S${index + 1}"><p>${body}</p></section>`
    }).join('')
    const html = `<body><main>${sections}</main></body>`
    expect(html.length).toBeGreaterThan(140_000)
    const outline = frameOutline(html)
    expect(outline.sections).toHaveLength(12)
    expect(JSON.stringify(outline).length).toBeLessThan(3 * 1024)
  })
})
