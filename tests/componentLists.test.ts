import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveToken: () => {},
  deleteToken: () => {},
}))

import { parse } from 'parse5'
import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'
import * as actions from '../server/actions.ts'
import { blankComponent, contextFor } from '../server/components.ts'
import { expandUses } from '../server/componentEngine.ts'
import { changeInstances, insertInstance, validProps } from '../server/componentActions.ts'
import { COMPONENT_ATTR, propValueProblem, type ComponentProp } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

const LINKS: ComponentProp = {
  name: 'links',
  type: 'list',
  fields: { label: { type: 'text' }, url: { type: 'link' }, hot: { type: 'boolean' } },
}

describe('list props', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('lists').id
  })

  function makeComponent(name: string, markup: (id: string) => string, declared: ComponentProp[] = [LINKS]) {
    const def = blankComponent({ name, by: 'Tester', props: declared })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
  }

  const nav = (declared?: ComponentProp[]) =>
    makeComponent(
      'Nav',
      (id) =>
        `<nav ${COMPONENT_ATTR}="${id}"><h2>Menu</h2><ul><li data-doop-each="links"><a data-doop-prop="href:url,label">Home</a><em data-doop-if="hot">hot</em></li></ul></nav>`,
      declared,
    )

  function write(body: string) {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(body) }, actor)
    return page.id
  }

  const html = (frameId: string) => store.getFrame(frameId)!.html
  const instanceHtml = (frameId: string) => /<nav[^>]*data-doop-instance[\s\S]*<\/nav>/.exec(html(frameId))![0]
  const clean = (markup: string) => markup.replace(/ data-doop-(?:part|id|rev)="[^"]*"/g, '')
  const marker = (frameId: string) => /data-doop-props="([^"]*)"/.exec(html(frameId))?.[1]

  const ITEMS = [
    { label: 'A', url: 'https://a.test', hot: true },
    { label: 'B', url: 'https://b.test' },
  ]
  const use = (id: string, items: unknown) =>
    `<doop-use component="${id}" links='${typeof items === 'string' ? items : JSON.stringify(items)}'></doop-use>`
  const issuesOf = (markup: string) => {
    const ctx = contextFor(canvasId)
    expandUses(markup, ctx, [], 0, { final: true })
    return ctx.issues
  }
  const lis = (markup: string) => [...markup.matchAll(/<li[\s\S]*?<\/li>/g)].map((match) => clean(match[0]))
  /* the edited copy of an instance, written back to the frame as a person's edit would be */
  const edit = (frameId: string, change: (markup: string) => string) =>
    actions.updateFrame(frameId, { html: change(html(frameId)) }, actor)

  describe('declaring', () => {
    it('keeps fields, and a default in its one stored form', () => {
      const [prop] = validProps([
        {
          name: 'links',
          type: 'list',
          fields: { label: { type: 'text' }, url: { type: 'link' } },
          default: '[ {"url":"https://a.test", "label":"A"} ]',
        },
      ])
      expect(prop!.fields).toEqual({ label: { type: 'text' }, url: { type: 'link' } })
      expect(prop!.default).toBe('[{"label":"A","url":"https://a.test"}]')
    })

    it.each([
      ['no fields', { name: 'links', type: 'list' }, 'needs fields'],
      ['an empty fields object', { name: 'links', type: 'list', fields: {} }, 'needs fields'],
      ['an unknown field type', { name: 'links', type: 'list', fields: { a: { type: 'number' } } }, 'needs a type of'],
      [
        'a field named constructor',
        { name: 'links', type: 'list', fields: { constructor: { type: 'text' } } },
        'field name',
      ],
      ['an upper-case field name', { name: 'links', type: 'list', fields: { Label: { type: 'text' } } }, 'field name'],
      [
        'fields on another type',
        { name: 'links', type: 'text', fields: { a: { type: 'text' } } },
        'belongs to list props',
      ],
      [
        'a default that does not fit',
        { name: 'links', type: 'list', fields: { a: { type: 'link' } }, default: '[{"a":"javascript:x"}]' },
        'does not fit',
      ],
    ])('refuses %s', (_name, raw, message) => {
      expect(() => validProps([raw])).toThrow(message)
    })

    it('refuses more than twelve fields', () => {
      const fields = Object.fromEntries(Array.from({ length: 13 }, (_, at) => [`f${at}`, { type: 'text' }]))
      expect(() => validProps([{ name: 'links', type: 'list', fields }])).toThrow('at most 12')
    })

    it('infers the prop and its fields from the bindings when it is not declared', () => {
      const def = nav([])
      expect(def.props).toEqual([
        {
          name: 'links',
          type: 'list',
          fields: { url: { type: 'link' }, label: { type: 'text' }, hot: { type: 'boolean' } },
        },
      ])
    })

    it('never makes an item field a prop of the component', () => {
      const def = nav([])
      expect(def.props.map((prop) => prop.name)).toEqual(['links'])
    })
  })

  describe('the shared value check', () => {
    it.each([
      ['valid items', '[{"label":"A","url":"/x","hot":false}]', undefined],
      ['an empty list', '[]', undefined],
      ['a boolean as text', '[{"hot":"true"}]', undefined],
      ['not JSON', 'nope', 'not valid JSON'],
      ['an object', '{"label":"A"}', 'not an array'],
      ['an item that is not an object', '[1]', 'item 0 is not an object'],
      ['text that is an object', '[{"label":{"a":1}}]', 'item 0 gives label a value'],
      ['a javascript: link', '[{"url":"javascript:alert(1)"}]', 'item 0 gives url a value'],
      ['a data:text/html link', '[{"url":"data:text/html,<script>1</script>"}]', 'item 0 gives url a value'],
      ['a boolean that is not one', '[{"hot":"maybe"}]', 'true or false'],
    ])('%s', (_name, value, problem) => {
      const result = propValueProblem(LINKS, value)
      if (problem) expect(result).toContain(problem)
      else expect(result).toBeUndefined()
    })

    it('names the fields and the limits in the problem', () => {
      expect(propValueProblem(LINKS, '1')).toContain('label (text), url (link), hot (boolean)')
      expect(propValueProblem(LINKS, '1')).toContain('at most 100 items')
    })

    it('refuses 101 items and a value past the character cap before parsing it', () => {
      expect(propValueProblem(LINKS, JSON.stringify(Array.from({ length: 101 }, () => ({ label: 'x' }))))).toContain(
        '101 items',
      )
      expect(propValueProblem(LINKS, `[${'{},'.repeat(100_000)}{}]`)).toContain('characters')
    })
  })

  describe('rendering', () => {
    it('repeats the element once per item, in order, each marked with its place', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      expect(lis(instanceHtml(page))).toEqual([
        '<li data-doop-item="0"><a href="https://a.test">A</a><em>hot</em></li>',
        '<li data-doop-item="1"><a href="https://b.test">B</a></li>',
      ])
    })

    it('keeps the template marker and the sample out of the instance, and the items in its props', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      expect(html(page)).not.toContain('data-doop-each')
      expect(html(page)).not.toContain('Home')
      expect(marker(page)).toContain('links')
    })

    it('renders nothing for an empty list, and nothing else changes', () => {
      const def = nav()
      const page = write(use(def.id, []))
      expect(clean(instanceHtml(page))).toContain('<ul></ul>')
      expect(clean(instanceHtml(page))).toContain('<h2>Menu</h2>')
    })

    it('shows the main as its single item for an instance that gives none', () => {
      const def = nav()
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      expect(lis(instanceHtml(page))).toEqual(['<li data-doop-item="0"><a>Home</a><em>hot</em></li>'])
      expect(marker(page)).toBeUndefined()
    })

    it('shows the declared default instead of the sample', () => {
      const def = nav([{ ...LINKS, default: '[{"label":"X"},{"label":"Y"}]' }])
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      expect(lis(instanceHtml(page)).map((li) => /<a[^>]*>(.*?)<\/a>/.exec(li)![1])).toEqual(['X', 'Y'])
      expect(marker(page)).toBeUndefined()
    })

    it('empties a field an item leaves out: no address, no text', () => {
      const def = nav()
      const page = write(use(def.id, [{ label: 'A', url: 'https://a.test' }, { hot: true }]))
      expect(lis(instanceHtml(page))[1]).toBe('<li data-doop-item="1"><a></a><em>hot</em></li>')
    })

    it('keys every part of a copy by the template key and its place, so no two collide', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      const keys = [...instanceHtml(page).matchAll(/data-doop-part="([a-z]+)(?:-(\d+))?"/g)].map((match) => match[0])
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.filter((key) => /-\d"$/.test(key)).length).toBe(5)
    })

    it('reads a component prop inside an item, and lets a field shadow a prop of the same name', () => {
      const def = makeComponent(
        'Tags',
        (id) =>
          `<ul ${COMPONENT_ATTR}="${id}"><li data-doop-each="tags"><b data-doop-prop="label">Tag</b><i data-doop-if="loud" data-doop-prop="note">!</i></li></ul>`,
        [
          { name: 'tags', type: 'list', fields: { label: { type: 'text' }, note: { type: 'text' } } },
          { name: 'loud', type: 'boolean', default: 'false' },
          { name: 'label', type: 'text' },
        ],
      )
      const page = write(
        `<doop-use component="${def.id}" label="outer" loud="true" tags='[{"label":"one","note":"n1"}]'></doop-use>`,
      )
      expect(clean(html(page))).toContain('<li data-doop-item="0"><b>one</b><i>n1</i></li>')
      expect(html(page)).not.toContain('outer')
    })

    it('does not repeat the root, and ignores a list that names no list prop', () => {
      const def = makeComponent(
        'Odd',
        (id) => `<div ${COMPONENT_ATTR}="${id}" data-doop-each="links"><p data-doop-each="nothing">kept</p></div>`,
      )
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      expect(clean(html(page))).toContain('<p>kept</p>')
      expect(html(page)).not.toContain('data-doop-each')
    })

    it('renders table rows', () => {
      const def = makeComponent(
        'Rows',
        (id) =>
          `<table ${COMPONENT_ATTR}="${id}"><tbody><tr data-doop-each="rows"><td data-doop-prop="name">N</td></tr></tbody></table>`,
        [{ name: 'rows', type: 'list', fields: { name: { type: 'text' } } }],
      )
      const page = write(`<doop-use component="${def.id}" rows='[{"name":"a"},{"name":"b"}]'></doop-use>`)
      expect([...clean(html(page)).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => match[1])).toEqual(['a', 'b'])
    })

    it('renders a nested component inside each item with an id that follows from its place', () => {
      const badge = makeComponent(
        'Badge',
        (id) => `<span ${COMPONENT_ATTR}="${id}" data-doop-prop="text">new</span>`,
        [],
      )
      const def = makeComponent(
        'Feed',
        (id) =>
          `<ul ${COMPONENT_ATTR}="${id}"><li data-doop-each="rows"><b data-doop-prop="name">N</b><doop-use component="${badge.id}"></doop-use></li></ul>`,
        [{ name: 'rows', type: 'list', fields: { name: { type: 'text' } } }],
      )
      const one = write(`<doop-use component="${def.id}" rows='[{"name":"a"},{"name":"b"}]'></doop-use>`)
      const ids = [...html(one).matchAll(/<span[^>]*data-doop-id="([a-z0-9]+)"/g)].map((match) => match[1]!)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      /* saved again, the same ids: the page's own markup is what is read back */
      actions.updateFrame(one, { html: html(one) }, actor)
      expect([...html(one).matchAll(/<span[^>]*data-doop-id="([a-z0-9]+)"/g)].map((match) => match[1])).toEqual(ids)
    })
  })

  describe('agents', () => {
    it('takes items as an array through insert_instance and update_instances', () => {
      const def = nav()
      const page = actions.createFrame(canvasId, { name: 'Page', html: doc('') }, actor)!
      const { instanceId } = insertInstance(
        canvasId,
        { frameId: page.id, component: def.id, props: { links: JSON.stringify(ITEMS) } },
        actor,
      )
      expect(lis(instanceHtml(page.id))).toHaveLength(2)
      changeInstances(canvasId, page.id, [{ instanceId, props: { links: JSON.stringify([{ label: 'Only' }]) } }], actor)
      expect(lis(instanceHtml(page.id))).toEqual(['<li data-doop-item="0"><a>Only</a></li>'])
      changeInstances(canvasId, page.id, [{ instanceId, props: { links: '[]' } }], actor)
      expect(lis(instanceHtml(page.id))).toEqual([])
      changeInstances(canvasId, page.id, [{ instanceId, props: { links: '' } }], actor)
      expect(lis(instanceHtml(page.id))).toEqual(['<li data-doop-item="0"><a>Home</a><em>hot</em></li>'])
    })

    it('refuses a bad value naming what is allowed, without echoing a huge one', () => {
      const def = nav()
      const page = actions.createFrame(canvasId, { name: 'Page', html: doc('') }, actor)!
      const huge = JSON.stringify(Array.from({ length: 500 }, () => ({ label: 'x'.repeat(40) })))
      let message = ''
      try {
        insertInstance(canvasId, { frameId: page.id, component: def.id, props: { links: huge } }, actor)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('label (text), url (link), hot (boolean)')
      expect(message.length).toBeLessThan(600)
    })

    it('reads the list back as a JSON attribute in the short form', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      const compact = store.getFrame(page)!.html
      const found = /data-doop-props="([^"]*)"/.exec(compact)![1]!.replace(/&quot;/g, '"')
      expect(JSON.parse(found)).toEqual({
        links: JSON.stringify([
          { hot: true, label: 'A', url: 'https://a.test' },
          { label: 'B', url: 'https://b.test' },
        ]),
      })
    })
  })

  describe('editing an instance in the frame', () => {
    const setup = () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      return { def, page }
    }
    const items = (page: string) => {
      const raw = /data-doop-props="([^"]*)"/
        .exec(html(page))![1]!
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
      return JSON.parse(JSON.parse(raw).links) as unknown[]
    }

    it('saves an unchanged instance byte for byte', () => {
      const { page } = setup()
      const before = html(page)
      actions.updateFrame(page, { html: before }, actor)
      expect(html(page)).toBe(before)
    })

    it('reads a text edit into that item', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace('>B</a>', '>Bee</a>'))
      expect(items(page)).toEqual([
        { hot: true, label: 'A', url: 'https://a.test' },
        { label: 'Bee', url: 'https://b.test' },
      ])
      expect(lis(instanceHtml(page))[1]).toContain('>Bee</a>')
    })

    it('reads a changed link into that item', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace('href="https://a.test"', 'href="https://z.test/x"'))
      expect((items(page)[0] as { url: string }).url).toBe('https://z.test/x')
    })

    it('refuses an edited link that would run code, and keeps the old one', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace('href="https://a.test"', 'href="javascript:alert(1)"'))
      expect((items(page)[0] as { url: string }).url).toBe('https://a.test')
      expect(html(page)).not.toContain('javascript:')
    })

    it('removes the item of a copy removed by hand', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace(/<li data-doop-part="[a-z]+-0" data-doop-item="0">[\s\S]*?<\/li>/, ''))
      expect(items(page)).toEqual([{ label: 'B', url: 'https://b.test' }])
      expect(lis(instanceHtml(page))).toHaveLength(1)
    })

    it('adds an item for a copy duplicated by hand, with its values', () => {
      const { page } = setup()
      edit(page, (markup) => {
        const copy = /<li data-doop-part="[a-z]+-1" data-doop-item="1">[\s\S]*?<\/li>/.exec(markup)![0]
        return markup.replace(copy, `${copy}${copy.replace('>B</a>', '>C</a>')}`)
      })
      expect(items(page)).toEqual([
        { hot: true, label: 'A', url: 'https://a.test' },
        { label: 'B', url: 'https://b.test' },
        { label: 'C', url: 'https://b.test' },
      ])
      expect(lis(instanceHtml(page))).toHaveLength(3)
    })

    it('adds an item for a copy written with no index', () => {
      const { page } = setup()
      edit(page, (markup) => {
        const copy = /<li data-doop-part="[a-z]+-1" data-doop-item="1">[\s\S]*?<\/li>/.exec(markup)![0]
        return markup.replace(copy, `${copy}${copy.replace(' data-doop-item="1"', '').replace('>B</a>', '>New</a>')}`)
      })
      expect((items(page)[2] as { label: string }).label).toBe('New')
    })

    it('follows a copy moved by hand', () => {
      const { page } = setup()
      edit(page, (markup) => {
        const first = /<li data-doop-part="[a-z]+-0" data-doop-item="0">[\s\S]*?<\/li>/.exec(markup)![0]
        return markup.replace(first, '').replace('</ul>', `${first}</ul>`)
      })
      expect((items(page) as { label: string }[]).map((item) => item.label)).toEqual(['B', 'A'])
    })

    it('drops an edit that is not a field and says so, leaving the item and the template alone', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace('<em data-doop-part', '<em class="loud" data-doop-part'))
      expect(html(page)).not.toContain('loud')
      expect(store.getComponents(canvasId)[0]!.rev).toBe(1)
      const issues = actions.takeComponentIssues(page)
      expect(issues.map((issue) => issue.code)).toContain('list_item_edit_dropped')
      expect(issues.find((issue) => issue.code === 'list_item_edit_dropped')!.message).toContain(
        'label (text), url (link), hot (boolean)',
      )
    })

    it('keeps a nested part override from ever being written for a copy', () => {
      const { page } = setup()
      edit(page, (markup) => markup.replace('<h2', '<h2 class="x"').replace('>B</a>', '>Bee</a>'))
      expect(html(page)).toContain('data-doop-overrides')
      expect(html(page)).not.toMatch(/data-doop-overrides="[^"]*-\d/)
    })
  })

  describe('hostile values', () => {
    const items = (page: string) => {
      const raw = /data-doop-props="([^"]*)"/
        .exec(html(page))![1]!
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
      return JSON.parse(JSON.parse(raw).links) as unknown[]
    }
    const rendered = (items: unknown) => {
      const def = nav()
      const page = write(use(def.id, items))
      return { page, markup: html(page), issues: issuesOf(use(def.id, items)) }
    }
    /* parsed, not matched: what a browser would build from it has no script, no image and no handler */
    const noMarkupFrom = (markup: string) => {
      const found: string[] = []
      const walk = (node: { childNodes?: unknown[]; tagName?: string; attrs?: { name: string }[] }) => {
        if (node.tagName) found.push(node.tagName, ...(node.attrs ?? []).map((attr) => attr.name))
        for (const child of (node.childNodes ?? []) as (typeof node)[]) walk(child)
      }
      walk(parse(markup) as never)
      expect(found).not.toContain('script')
      expect(found).not.toContain('img')
      expect(found.filter((name) => /^on/.test(name))).toEqual([])
    }

    it('turns markup in a text field into text', () => {
      const { markup } = rendered([
        { label: '</li><script>alert(1)</script>' },
        { label: '"><img src=x onerror=alert(1)>' },
        { label: '<b>bold</b> &amp; <!-- c -->' },
      ])
      noMarkupFrom(markup)
      expect(markup).toContain('&lt;/li&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &lt;!-- c --&gt;')
      expect((markup.match(/<li /g) ?? []).length).toBe(3)
    })

    it('keeps a quote in a link inside its attribute', () => {
      const { markup } = rendered([{ url: 'https://a.test/" onmouseover="alert(1)', label: 'x' }])
      noMarkupFrom(markup)
      expect(markup).toContain('href="https://a.test/&quot; onmouseover=&quot;alert(1)"')
    })

    it.each([
      ['javascript:alert(1)'],
      ['  JaVa\tScRiPt:alert(1)'],
      ['vbscript:x'],
      ['data:text/html,<script>alert(1)</script>'],
    ])('refuses the address %j and shows the default, never the address', (url) => {
      const { markup, issues } = rendered([{ label: 'x', url }])
      expect(markup).not.toMatch(/javascript:|vbscript:|data:text/i)
      expect(markup).not.toContain('>x<')
      expect(markup).toContain('>Home<')
      expect(issues.map((issue) => issue.code)).toEqual(['invalid_prop_value'])
      expect(issues[0]!.message).toContain('item 0 gives url a value')
      expect(issues[0]!.message).not.toContain('alert')
      expect(issues[0]!.message).not.toContain('"[{')
    })

    it('refuses a 10,000-item array and a huge text without storing either', () => {
      const many = rendered(Array.from({ length: 10_000 }, () => ({ label: 'x' })))
      expect(many.markup).toContain('>Home<')
      expect(many.markup.length).toBeLessThan(2_000)
      expect(many.issues[0]!.message).toContain('10000 items')
      const text = rendered([{ label: 'x'.repeat(5_000) }])
      expect(text.markup).toContain('>Home<')
      expect(text.issues[0]!.code).toBe('invalid_prop_value')
    })

    it('refuses a value over the character cap without parsing it', () => {
      const huge = `[${'{"label":"x"},'.repeat(20_000)}{}]`
      const { markup, issues } = rendered(huge)
      expect(markup).toContain('>Home<')
      expect(issues[0]!.message).toContain('characters')
    })

    it('refuses deeply nested JSON, as an item value and as the whole value', () => {
      const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`
      expect(propValueProblem(LINKS, deep)).toBeDefined()
      expect(propValueProblem(LINKS, `[{"label":${deep}}]`)).toContain('item 0 gives label a value')
      const { markup } = rendered(deep)
      expect(markup).toContain('>Home<')
    })

    it('drops prototype keys as unknown fields without touching any prototype', () => {
      const { markup, issues } = rendered(
        '[{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"prototype":"x","label":"ok"}]',
      )
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.prototype).not.toHaveProperty('polluted')
      expect(markup).toContain('>ok<')
      expect(issues.map((issue) => issue.code)).toEqual(['list_field_dropped'])
      expect(issues[0]!.message).toContain('item 0: __proto__')
      expect(issues[0]!.message).toContain('item 0: constructor')
    })

    it('drops a field the list does not declare, keeps the rest, and names the allowed ones', () => {
      const { markup, issues } = rendered([{ label: 'kept', secret: 'nope' }])
      expect(markup).toContain('>kept<')
      expect(markup).not.toContain('nope')
      expect(issues[0]!.code).toBe('list_field_dropped')
      expect(issues[0]!.message).toContain('item 0: secret')
      expect(issues[0]!.message).toContain('label (text), url (link), hot (boolean)')
    })

    it('does not echo a hostile field name beyond a plain, short form', () => {
      const { issues } = rendered(`[{"${'<script>'.repeat(20)}":"x"}]`)
      expect(issues[0]!.message).not.toContain('<script>')
      expect(issues[0]!.message.length).toBeLessThan(400)
    })

    it('cleans a hostile marker written straight into stored markup on the next write', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      const hostile = JSON.stringify(JSON.stringify([{ label: '<script>x</script>', url: 'javascript:x', evil: 1 }]))
      edit(page, (markup) =>
        markup.replace(
          /data-doop-props="[^"]*"/,
          `data-doop-props="${`{"links":${hostile}}`.replace(/"/g, '&quot;')}"`,
        ),
      )
      expect(html(page)).not.toContain('javascript:')
      expect(html(page)).not.toContain('<script')
      /* the copies the page shows are the truth: they are read back */
      expect(items(page)).toEqual(ITEMS.map(({ hot: _hot, ...item }) => item))
    })

    it('cleans a hostile marker whose copies are gone, to the default', () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      const hostile = JSON.stringify([{ label: '<script>x</script>', url: 'javascript:x' }])
      edit(page, (markup) =>
        markup
          .replace(/<li[\s\S]*<\/li>/, '')
          .replace(
            /data-doop-props="[^"]*"/,
            `data-doop-props="${JSON.stringify({ links: hostile }).replace(/"/g, '&quot;')}"`,
          ),
      )
      expect(html(page)).not.toContain('javascript:')
      expect(html(page)).not.toContain('<script')
      expect(html(page)).toContain('>Home<')
    })

    it('keeps an attribute-breaking label out of the marker', () => {
      const { markup } = rendered([{ label: '"><img src=x onerror=alert(1)>' }])
      const props = /data-doop-props="([^"]*)"/.exec(markup)![1]!
      expect(props).not.toContain('<')
      expect(props).not.toContain('>')
    })
  })

  describe('old markup', () => {
    it('re-saves components and instances without lists byte for byte', () => {
      const card = makeComponent(
        'Card',
        (id) =>
          `<article ${COMPONENT_ATTR}="${id}" class="card"><h3 data-doop-prop="title">Hello</h3><a data-doop-prop="href:link" data-doop-if="showLink">go</a><div data-doop-slot="body"><p>default</p></div></article>`,
        [{ name: 'showlink', type: 'boolean', default: 'true' }],
      )
      const page = write(
        `<doop-use component="${card.id}" title="Hi" link="https://x.test"><template slot="body"><p>mine</p></template></doop-use>`,
      )
      const once = html(page)
      actions.updateFrame(page, { html: once }, actor)
      expect(html(page)).toBe(once)
      actions.updateFrame(page, { html: once.replace('>Hi<', '>Hello again<') }, actor)
      const edited = html(page)
      actions.updateFrame(page, { html: edited }, actor)
      expect(html(page)).toBe(edited)
      expect(edited).toContain('Hello again')
      expect(
        store
          .getComponents(canvasId)
          .find((def) => def.id === card.id)!
          .props.map((prop) => prop.type),
      ).not.toContain('list')
    })

    it('never turns an ordinary prop into a list, and a literal data-doop-each with no list prop renders as plain markup', () => {
      const def = makeComponent(
        'Plain',
        (id) => `<div ${COMPONENT_ATTR}="${id}"><span data-doop-prop="name">N</span></div>`,
        [],
      )
      expect(def.props).toEqual([{ name: 'name', type: 'text' }])
    })
  })

  describe('changing the template', () => {
    it('keeps the items of every instance when the main of the list changes', async () => {
      const def = nav()
      const page = write(use(def.id, ITEMS))
      const main = store.getFrame(def.mainFrameId!)!
      actions.updateFrame(main.id, { html: main.html.replace('<li ', '<li class="row" ') }, actor)
      await propagation.whenIdle()
      expect(lis(instanceHtml(page)).every((li) => li.startsWith('<li class="row" data-doop-item'))).toBe(true)
      expect(lis(instanceHtml(page))).toHaveLength(2)
      expect(instanceHtml(page)).toContain('>A<')
    })
  })
})
