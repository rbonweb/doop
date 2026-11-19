// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { ComponentProp } from '../shared/components'
import {
  addListItem,
  listItemsOf,
  listItemTitle,
  listSample,
  moveListItem,
  newListItem,
  removeListItem,
  setListField,
} from '../src/lib/listProps'
import {
  richTextForField,
  richTextSubset,
  richTextTemplateValue,
  sameRichText,
  webAddress,
} from '../src/lib/richTextProp'

const prop: ComponentProp = {
  name: 'links',
  type: 'list',
  fields: { label: { type: 'text' }, url: { type: 'link' }, cover: { type: 'image' }, hot: { type: 'boolean' } },
}

it('reads a stored value into items, and a value that is not a list into none', () => {
  expect(listItemsOf(prop, '[{"label":"A","hot":true}]')).toEqual([{ label: 'A', hot: true }])
  expect(listItemsOf(prop, '')).toEqual([])
  expect(listItemsOf(prop, 'not json')).toEqual([])
  expect(listItemsOf(prop, '[{"url":"javascript:alert(1)"}]')).toEqual([])
})

it('builds the next list without touching the one it was given', () => {
  const items = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
  expect(moveListItem(items, 0, 2).map((item) => item.label)).toEqual(['B', 'C', 'A'])
  expect(moveListItem(items, 2, 1).map((item) => item.label)).toEqual(['A', 'C', 'B'])
  expect(moveListItem(items, 0, 5)).toEqual(items)
  expect(moveListItem(items, 1, 1)).toEqual(items)
  expect(removeListItem(items, 1).map((item) => item.label)).toEqual(['A', 'C'])
  expect(addListItem(items, { label: 'X' }, 0).map((item) => item.label)).toEqual(['A', 'X', 'B', 'C'])
  expect(addListItem(items, { label: 'X' }).map((item) => item.label)).toEqual(['A', 'B', 'C', 'X'])
  expect(setListField(items, 1, 'label', 'Z').map((item) => item.label)).toEqual(['A', 'Z', 'C'])
  expect(setListField(items, 1, 'label', '')[1]).toEqual({})
  expect(items.map((item) => item.label)).toEqual(['A', 'B', 'C'])
})

it('starts a new item with its on/off fields off and the rest left out', () => {
  expect(newListItem(prop)).toEqual({ hot: false })
})

it('names an item by its first filled-in text', () => {
  expect(listItemTitle(prop, { label: '  Docs ', url: 'https://x.dev' })).toBe('Docs')
  expect(listItemTitle(prop, { url: 'https://x.dev' })).toBeUndefined()
})

it('works out the one item a main stands for, as the server does', () => {
  const template =
    '<nav data-doop-part="r"><a data-doop-part="a" data-doop-each="links" data-doop-prop="href:url,label"><img data-doop-part="i" data-doop-prop="cover" src="/a/cover.png"><b data-doop-part="b" data-doop-if="hot">New</b>Docs</a></nav>'
  expect(listSample({ template }, prop)).toEqual([{ cover: '/a/cover.png', hot: true, label: 'Docs' }])
  expect(listSample({ template: '<nav data-doop-part="r"></nav>' }, prop)).toEqual([])
})

it('turns what the field holds into the subset: bold, italic, line breaks and http(s) links only', () => {
  const holder = document.createElement('div')
  holder.innerHTML =
    '<b>one</b> <strong>two</strong> <em>three</em><div>next line</div><a href="https://x.dev/a?b=1&c=2">go</a><a href="javascript:alert(1)">bad</a><span style="font-weight:700">heavy</span><script>alert(1)</script>'
  expect(richTextSubset(holder)).toBe(
    '<b>one</b> <b>two</b> <i>three</i><br>next line<a href="https://x.dev/a?b=1&amp;c=2">go</a>bad<b>heavy</b>',
  )
})

it('escapes text, so typed markup stays text', () => {
  const holder = document.createElement('div')
  holder.textContent = '<img src=x onerror=alert(1)> & "quotes"'
  expect(richTextSubset(holder)).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;')
})

it('shows a stored value rebuilt through the same walk', () => {
  expect(richTextForField('a <i>b</i><script>x</script><a href="ftp://h/f">c</a>')).toBe('a <i>b</i>c')
  expect(sameRichText('<strong>a</strong>', '<b>a</b>')).toBe(true)
  expect(sameRichText('<b>a</b>', '<i>a</i>')).toBe(false)
})

it('reads a main’s bound content as the field’s default', () => {
  expect(richTextTemplateValue('<p data-doop-prop="body">Hi <em>you</em></p>', 'body')).toBe('Hi <i>you</i>')
  expect(richTextTemplateValue('<p data-doop-prop="body">Hi</p>', 'other')).toBe('')
})

it('accepts only an absolute http or https address', () => {
  expect(webAddress(' https://example.com/a ')).toBe('https://example.com/a')
  expect(webAddress('http://localhost:3000')).toBe('http://localhost:3000')
  for (const bad of [
    '',
    'example.com',
    '/relative',
    'javascript:alert(1)',
    'mailto:a@b.c',
    'https://a b',
    'https:///x',
    'https://x"y',
  ])
    expect(webAddress(bad)).toBeNull()
})
