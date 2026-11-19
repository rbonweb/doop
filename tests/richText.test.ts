import { describe, expect, it } from 'vitest'
import { MAX_RICHTEXT_CHARS } from '../shared/components.ts'
import { MAX_RICHTEXT_DEPTH, describeRemoved, sanitizeRichText } from '../server/richText.ts'

const clean = (value: string) => sanitizeRichText(value).html

describe('sanitizeRichText: what stays', () => {
  it('keeps text, escaping it canonically', () => {
    expect(clean('plain & text')).toBe('plain &amp; text')
    expect(sanitizeRichText('plain text').removed).toEqual([])
  })

  it('keeps b, i, strong, em and br', () => {
    expect(clean('<b>a</b><i>b</i><strong>c</strong><em>d</em>x<br>y<br/>z')).toBe(
      '<b>a</b><i>b</i><strong>c</strong><em>d</em>x<br>y<br>z',
    )
  })

  it('closes unclosed tags', () => {
    expect(clean('<b>unclosed <i>tags')).toBe('<b>unclosed <i>tags</i></b>')
  })

  it('keeps an absolute http or https link and nothing else on it', () => {
    expect(clean('<a href="https://x.com/a?b=1&c=2" target="_blank" rel="x" onclick="evil()">x</a>')).toBe(
      '<a href="https://x.com/a?b=1&amp;c=2">x</a>',
    )
    expect(clean('<a href="http://x.com">x</a>')).toBe('<a href="http://x.com">x</a>')
  })

  it('keeps a span with a plain class and drops its other attributes', () => {
    expect(clean('<span class="ok other_1 a-b" style="color:red" id=q>t</span>')).toBe(
      '<span class="ok other_1 a-b">t</span>',
    )
  })

  it('unwraps a span with nothing on it', () => {
    expect(clean('<span>bare</span>')).toBe('bare')
  })

  it('keeps entities as text, never as markup', () => {
    expect(clean('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(clean('a&nbsp;b &amp;amp;')).toBe('a&nbsp;b &amp;amp;')
  })
})

describe('sanitizeRichText: hostile input', () => {
  const corpus: [string, string][] = [
    ['a<script>alert(1)</script>b', 'ab'],
    ['a<style>p{}</style>b', 'ab'],
    ['<iframe src="x">hi</iframe>t', 't'],
    ['<object data="x">fallback</object>t', 't'],
    ['<svg onload=alert(1)><circle/></svg>ok', 'ok'],
    ['<math><mi xlink:href="javascript:alert(1)">x</mi></math>y', 'y'],
    ['<template><script>x</script></template>z', 'z'],
    ['<img src=x onerror=alert(1)>', ''],
    ['<b onclick="x()">bold</b>', '<b>bold</b>'],
    ['<b onmouseover=alert(1) style="x">bold</b>', '<b>bold</b>'],
    ['<b><script>alert(1)</script>t</b>', '<b>t</b>'],
    ['<b><style>x{}</style><i>t</i></b>', '<b><i>t</i></b>'],
    ['<span class="x&quot; onmouseover=alert(1) y">t</span>', 't'],
    ['<span class="a" onclick=x>t</span>', '<span class="a">t</span>'],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '"&gt;'],
    ['<!-- <script>alert(1)</script> -->after', 'after'],
    ['<!--><img src=x onerror=alert(1)>-->', '--&gt;'],
    ['<style><b>x</b></style>', ''],
    ['<xmp><b>x</b></xmp>', ''],
    ['<plaintext><b>x</b>', ''],
    ['<textarea></textarea><script>1</script>', ''],
    ['<select><option>o</option></select>', ''],
    ['<form><button onclick=x>go</button></form>', 'go'],
    ['<div><b>x</b></div>', '<b>x</b>'],
    ['<p>one</p><p>two</p>', 'onetwo'],
    ['<table><tr><td>cell</td></tr></table>', 'cell'],
  ]
  it.each(corpus)('%j becomes %j', (input, output) => {
    expect(clean(input)).toBe(output)
  })

  const links: [string, string][] = [
    ['JaVaScRiPt:alert(1)', 'mixed case javascript:'],
    ['java\tscript:alert(1)', 'a tab inside the scheme'],
    ['java\nscript:alert(1)', 'a newline inside the scheme'],
    ['&#106;avascript:alert(1)', 'a numeric entity in the scheme'],
    ['&#x6A;avascript&colon;alert(1)', 'a hex entity and &colon;'],
    ['&#0000106avascript:alert(1)', 'a padded numeric entity'],
    [' https://ok.com', 'a leading space'],
    ['https://ok.com/a b', 'a space inside'],
    ['https://ok.com\\@evil.com', 'a backslash'],
    ['data:text/html,<script>alert(1)</script>', 'a data: address'],
    ['vbscript:msgbox(1)', 'a vbscript: address'],
    ['//evil.com', 'a protocol-relative address'],
    ['/relative', 'a relative path'],
    ['relative', 'a bare word'],
    ['mailto:a@b.com', 'mailto:'],
    ['tel:123', 'tel:'],
    ['https:evil.com', 'a scheme with no slashes'],
    ['http://', 'no host'],
    ['https://x.com/&quot;onmouseover=&quot;x', 'a quote'],
  ]
  it.each(links)('refuses the link address %j (%s): the link becomes its text', (href) => {
    const result = sanitizeRichText(`<a href="${href}">x</a>`)
    expect(result.html).toBe('x')
    expect(result.removed).toContain('unsafe link address')
  })

  it('unwraps a link with no address', () => {
    expect(clean('<a>x</a>')).toBe('x')
  })

  it('never lets nested links nest', () => {
    expect(clean('<a href="https://a.com"><a href="https://b.com">nest</a></a>')).not.toMatch(/<a [^>]*><a /)
  })

  it('names what it removed without echoing the value', () => {
    const { removed } = sanitizeRichText('<b onclick="steal()">x</b><script>steal()</script>')
    expect(removed).toEqual(['onclick attribute on <b>', '<script> and its content'])
    expect(describeRemoved(removed)).not.toContain('steal')
  })
})

describe('sanitizeRichText: bounds and idempotence', () => {
  it('refuses a value over the cap and says so', () => {
    const result = sanitizeRichText('x'.repeat(MAX_RICHTEXT_CHARS + 1))
    expect(result.html).toBe('')
    expect(result.removed[0]).toContain('20,000')
  })

  it('takes a value at the cap', () => {
    expect(clean('x'.repeat(MAX_RICHTEXT_CHARS))).toHaveLength(MAX_RICHTEXT_CHARS)
  })

  it('flattens nesting past the depth limit and keeps the text', () => {
    const deep = `${'<b>'.repeat(MAX_RICHTEXT_DEPTH + 10)}deep${'</b>'.repeat(MAX_RICHTEXT_DEPTH + 10)}`
    const result = sanitizeRichText(deep)
    expect(result.html.match(/<b>/g)).toHaveLength(MAX_RICHTEXT_DEPTH)
    expect(result.html).toContain('deep')
    expect(result.removed).toEqual([`nesting deeper than ${MAX_RICHTEXT_DEPTH} (flattened)`])
  })

  it('survives markup nested far past the call stack', () => {
    const deep = `${'<div>'.repeat(60_000)}x`.slice(0, MAX_RICHTEXT_CHARS)
    expect(() => sanitizeRichText(deep)).not.toThrow()
  })

  it('is idempotent over the whole corpus', () => {
    const inputs = [
      'plain',
      'a<br>b',
      '<b>unclosed <i>tags',
      '<a href="https://x.com/?a=1&b=2">x &amp; y</a>',
      '<span class="a b">t</span>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<!--><img src=x onerror=alert(1)>-->',
      '&lt;b&gt; &amp;lt; &nbsp;',
      '<b><i><a href="https://a.com"><span class="c">x</span></a></i></b>',
      '<a href="https://a.com"><a href="https://b.com">nest</a></a>',
      '<math><mi>x</mi></math><svg><title><b>x</b></title></svg>',
      '<p>one<p>two<table><td>x',
      '"><b>',
      '<b> </b>',
    ]
    for (const input of inputs) {
      const once = clean(input)
      expect(clean(once), input).toBe(once)
    }
  })
})
