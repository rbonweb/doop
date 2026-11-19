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

import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'
import * as actions from '../server/actions.ts'
import { blankComponent, contextFor } from '../server/components.ts'
import { expandUses } from '../server/componentEngine.ts'
import { changeInstances, insertInstance, validProps } from '../server/componentActions.ts'
import { COMPONENT_ATTR, MAX_RICHTEXT_CHARS, propValueProblem, type ComponentProp } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('rich-text props', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('rich text').id
  })

  const props = (): ComponentProp[] => [{ name: 'title', type: 'richtext' }]

  function makeComponent(name: string, markup: (id: string) => string, declared: ComponentProp[] = props()) {
    const def = blankComponent({ name, by: 'Tester', props: declared })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
  }

  const card = () =>
    makeComponent(
      'Card',
      (id) => `<div ${COMPONENT_ATTR}="${id}"><h2 data-doop-prop="title">Hello <b>world</b></h2><p>fixed</p></div>`,
    )

  function write(body: string) {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(body) }, actor)
    return page.id
  }

  const html = (frameId: string) => store.getFrame(frameId)!.html
  /* the template's own elements wear part keys; what a value brings does not */
  const heading = (frameId: string) =>
    /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(html(frameId))![1]!.replace(/ data-doop-part="[a-z]+"/g, '')
  const marker = (frameId: string) => /data-doop-props="([^"]*)"/.exec(html(frameId))?.[1]
  const issuesOf = (markup: string) => {
    const ctx = contextFor(canvasId)
    expandUses(markup, ctx, [], 0, { final: true })
    return ctx.issues
  }
  const instanceHtml = (frameId: string) => /<div[^>]*data-doop-instance[\s\S]*<\/div>/.exec(html(frameId))![0]

  describe('declaring and reading', () => {
    it('is a prop type, kept on the component with no default of its own', () => {
      const def = card()
      expect(def.props).toEqual([{ name: 'title', type: 'richtext' }])
      expect(validProps([{ name: 'title', type: 'richtext', default: '<b>x</b>' }])).toEqual([
        { name: 'title', type: 'richtext' },
      ])
    })

    it('refuses a value over the cap in the shared check', () => {
      const prop: ComponentProp = { name: 'title', type: 'richtext' }
      expect(propValueProblem(prop, '<b>fine</b>')).toBeUndefined()
      expect(propValueProblem(prop, 'x'.repeat(MAX_RICHTEXT_CHARS))).toBeUndefined()
      expect(propValueProblem(prop, 'x'.repeat(MAX_RICHTEXT_CHARS + 1))).toContain('at most 20,000 characters')
    })

    it('renders the main untouched where no instance gives a value', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      expect(heading(page)).toBe('Hello <b>world</b>')
      expect(marker(page)).toBeUndefined()
    })
  })

  describe('through <doop-use>', () => {
    it('binds the sanitised value as the element content', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}" title="<b>Hi</b> there &amp; <i>you</i>"></doop-use>`)
      expect(heading(page)).toBe('<b>Hi</b> there &amp; <i>you</i>')
      expect(marker(page)).toContain('Hi')
    })

    it('keeps an https link and a span class', () => {
      const def = card()
      const page = write(
        `<doop-use component="${def.id}" title="<a href='https://x.com'>go</a> <span class='em'>now</span>"></doop-use>`,
      )
      expect(heading(page)).toBe('<a href="https://x.com">go</a> <span class="em">now</span>')
    })

    it('strips hostile markup, stores only the clean value and names what went in an issue', () => {
      const def = card()
      const markup = `<doop-use component="${def.id}" title="<b onclick='steal()'>Hi</b><script>steal()</script><a href='javascript:steal()'>x</a>"></doop-use>`
      const issues = issuesOf(markup)
      expect(issues.map((issue) => issue.code)).toEqual(['richtext_sanitized'])
      expect(issues[0]!.message).toContain('onclick attribute on <b>')
      expect(issues[0]!.message).toContain('<script> and its content')
      expect(issues[0]!.message).toContain('unsafe link address')
      expect(issues[0]!.message).not.toContain('steal')
      const page = write(markup)
      expect(heading(page)).toBe('<b>Hi</b>x')
      expect(html(page)).not.toContain('steal')
      expect(html(page)).not.toContain('onclick')
    })

    it('says nothing when there was nothing to remove', () => {
      const def = card()
      expect(issuesOf(`<doop-use component="${def.id}" title="<b>Hi</b>"></doop-use>`)).toEqual([])
    })

    it('does not set a value over the cap, and says why', () => {
      const def = card()
      const issues = issuesOf(
        `<doop-use component="${def.id}" title="${'x'.repeat(MAX_RICHTEXT_CHARS + 1)}"></doop-use>`,
      )
      expect(issues).toHaveLength(1)
      expect(issues[0]!.code).toBe('invalid_prop_value')
      expect(issues[0]!.message).toContain('at most 20,000 characters')
    })

    it('sanitises a hostile marker written straight into stored markup', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}" title="<b>ok</b>"></doop-use>`)
      const hostile = html(page).replace(
        /data-doop-props="[^"]*"/,
        `data-doop-props="${JSON.stringify({ title: '<img src=x onerror=alert(1)>t<script>alert(1)</script>' }).replace(/"/g, '&quot;')}"`,
      )
      actions.updateFrame(page, { html: hostile }, actor)
      expect(html(page)).not.toContain('onerror')
      expect(html(page)).not.toContain('<script')
    })
  })

  describe('through the instance tools', () => {
    it('update_instances stores the sanitised value and reports what it removed', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      const id = /data-doop-id="([^"]+)"|id="([^"]+)"/.exec(html(page).replace(/^[\s\S]*?<body>/, ''))!
      const instanceId = (id[1] ?? id[2])!
      changeInstances(
        canvasId,
        page,
        [{ instanceId, props: { title: '<i onmouseover=x>Hey</i><iframe src=//evil></iframe>' } }],
        actor,
      )
      expect(heading(page)).toBe('<i>Hey</i>')
      expect(html(page)).not.toContain('onmouseover')
      expect(html(page)).not.toContain('iframe')
      const issues = actions.takeComponentIssues(page)
      expect(issues.map((issue) => issue.code)).toContain('richtext_sanitized')
      expect(issues.map((issue) => issue.message).join(' ')).not.toContain('evil')
    })

    it('update_instances refuses a value over the cap', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      const instanceId = /data-doop-id="([^"]+)"/.exec(html(page))?.[1] ?? /\bid="([^"]+)"/.exec(html(page))![1]!
      expect(() =>
        changeInstances(canvasId, page, [{ instanceId, props: { title: 'x'.repeat(MAX_RICHTEXT_CHARS + 1) } }], actor),
      ).toThrow(/at most 20,000 characters/)
    })

    it('insert_instance sanitises too', () => {
      const def = card()
      const page = write('<main></main>')
      insertInstance(
        canvasId,
        { frameId: page, component: def.name, props: { title: '<b>New</b><script>x</script>' } },
        actor,
      )
      expect(heading(page)).toBe('<b>New</b>')
      expect(actions.takeComponentIssues(page).map((issue) => issue.code)).toContain('richtext_sanitized')
    })

    it('"" puts the main back', () => {
      const def = card()
      const page = write(`<doop-use component="${def.id}" title="<i>mine</i>"></doop-use>`)
      const instanceId = /\bid="([^"]+)"/.exec(html(page))![1]!
      changeInstances(canvasId, page, [{ instanceId, props: { title: '' } }], actor)
      expect(heading(page)).toBe('Hello <b>world</b>')
      expect(marker(page)).toBeUndefined()
    })
  })

  describe('editing an instance on the canvas', () => {
    function placed() {
      const def = card()
      const page = write(`<doop-use component="${def.id}"></doop-use>`)
      return { def, page }
    }
    const withWelcome = (main: string) => main.replace(/(<h2[^>]*>)[\s\S]*?(<\/h2>)/, '$1Welcome <em>home</em>$2')
    const edit = (page: string, inner: string) =>
      actions.updateFrame(page, { html: html(page).replace(/(<h2[^>]*>)[\s\S]*?(<\/h2>)/, `$1${inner}$2`) }, actor)

    it('records formatted text as the prop value, not as a part override', () => {
      const { page } = placed()
      edit(page, 'Hello <b>there</b> and <i>you</i>')
      expect(heading(page)).toBe('Hello <b>there</b> and <i>you</i>')
      expect(marker(page)).toBe('{&quot;title&quot;:&quot;Hello <b>there</b> and <i>you</i>&quot;}')
      expect(html(page)).not.toContain('data-doop-overrides')
    })

    it('keeps a link and drops what a browser adds around a run (style, data-doop-run, a div)', () => {
      const { page } = placed()
      edit(
        page,
        'Go <a href="https://x.com">now</a> <span style="color:red" data-doop-run="">red</span><div><strong>x</strong></div>',
      )
      expect(heading(page)).toBe('Go <a href="https://x.com">now</a> red<strong>x</strong>')
    })

    it('cannot create anything outside the subset', () => {
      const { page } = placed()
      edit(
        page,
        '<b onclick="steal()">x</b><img src=x onerror=steal()><script>steal()</script><a href="javascript:steal()">l</a>',
      )
      expect(html(page)).not.toContain('steal')
      expect(heading(page)).toBe('<b>x</b>l')
    })

    it('leaves nothing recorded when the edit puts back the default', () => {
      const { page } = placed()
      edit(page, 'Changed <i>x</i>')
      expect(marker(page)).toBeDefined()
      edit(page, 'Hello <b>world</b>')
      expect(marker(page)).toBeUndefined()
      expect(heading(page)).toBe('Hello <b>world</b>')
    })

    it('ignores whitespace-only changes', () => {
      const { page } = placed()
      edit(page, 'Hello   <b>world</b>\n')
      expect(marker(page)).toBeUndefined()
    })

    it('follows a change of the main for an instance with no value of its own', async () => {
      const { def, page } = placed()
      const mainFrame = store.getFrame(def.mainFrameId!)!
      actions.updateFrame(mainFrame.id, { html: withWelcome(mainFrame.html) }, actor)
      await propagation.whenIdle()
      expect(heading(page)).toBe('Welcome <em>home</em>')
    })

    it('keeps its own value when the main changes', async () => {
      const { def, page } = placed()
      edit(page, 'Mine <b>only</b>')
      const mainFrame = store.getFrame(def.mainFrameId!)!
      actions.updateFrame(mainFrame.id, { html: withWelcome(mainFrame.html) }, actor)
      await propagation.whenIdle()
      expect(heading(page)).toBe('Mine <b>only</b>')
    })

    it('does not set a value over the cap, and the frame still saves', () => {
      const { page } = placed()
      edit(page, 'x'.repeat(MAX_RICHTEXT_CHARS + 1))
      expect(actions.takeComponentIssues(page).map((issue) => issue.code)).toContain('invalid_prop_value')
      expect(marker(page)).toBeUndefined()
    })
  })

  describe('text props keep their behaviour', () => {
    it('a text binding still replaces only its own text, beside an icon', () => {
      const def = makeComponent('Btn', (id) => `<a ${COMPONENT_ATTR}="${id}" data-doop-prop="label"><i>*</i>Go</a>`, [
        { name: 'label', type: 'text' },
      ])
      const page = write(`<doop-use component="${def.id}" label="<b>Stop</b>"></doop-use>`)
      expect(html(page)).toMatch(/<i data-doop-part="[a-z]+">\*<\/i>&lt;b&gt;Stop&lt;\/b&gt;/)
    })
  })

  describe('slots', () => {
    const panel = () =>
      makeComponent(
        'Panel',
        (id) =>
          `<section ${COMPONENT_ATTR}="${id}"><header data-doop-slot="header">h</header><div data-doop-slot="body">b</div></section>`,
        [],
      )
    const single = () =>
      makeComponent(
        'Box',
        (id) => `<section ${COMPONENT_ATTR}="${id}"><div data-doop-slot="body">b</div></section>`,
        [],
      )

    it('says where unnamed content went when a component has several slots, and still places it', () => {
      const def = panel()
      const markup = `<doop-use component="${def.id}"><p>loose</p><template slot="body">B</template></doop-use>`
      const issues = issuesOf(markup)
      expect(issues).toHaveLength(1)
      expect(issues[0]!.code).toBe('unnamed_slot_content')
      expect(issues[0]!.message).toMatch(/went into “(header|body)”/)
      expect(issues[0]!.message).toContain('several slots')
      const page = write(markup)
      expect(html(page)).toContain('<p>loose</p>')
      expect(html(page)).toContain('B')
    })

    it('says which slot name is unknown and what the component has', () => {
      const def = panel()
      const markup = `<doop-use component="${def.id}"><template slot="footer">F</template></doop-use>`
      const issues = issuesOf(markup)
      expect(issues).toHaveLength(1)
      expect(issues[0]!.code).toBe('unknown_slot')
      expect(issues[0]!.message).toContain('no slot “footer”')
      expect(issues[0]!.message).toMatch(/\(it has (header, body|body, header)\)/)
      expect(html(write(markup))).toContain('F')
    })

    it('stays quiet for named content and for a component with one slot', () => {
      const several = panel()
      expect(issuesOf(`<doop-use component="${several.id}"><template slot="header">H</template></doop-use>`)).toEqual(
        [],
      )
      const one = single()
      expect(
        issuesOf(`<doop-use component="${one.id}"><p>loose</p><template slot="other">O</template></doop-use>`),
      ).toEqual([])
    })
  })

  describe('old markup', () => {
    it('re-saves an instance and a main with no rich-text props byte for byte', () => {
      const main =
        '<div data-doop-component="cOLD0000001" data-doop-part="aaaa"><h2 data-doop-part="bbbb" data-doop-prop="title">Hello</h2><div data-doop-part="cccc" data-doop-slot="body">b</div></div>'
      const def = blankComponent({ name: 'Old', by: 'Tester', props: [] })
      store.saveComponent(canvasId, def)
      const mainFrame = actions.createFrame(canvasId, { name: 'Old main', html: '' }, actor)!
      actions.updateFrame(mainFrame.id, { html: doc(main.replace('cOLD0000001', def.id)) }, actor)
      const page = write(
        `<doop-use component="${def.id}" id="abcdefghi" title="World"><template slot="body">B</template></doop-use>`,
      )
      const first = html(page)
      expect(instanceHtml(page)).toContain('<h2 data-doop-part="bbbb">World</h2>')
      actions.updateFrame(page, { html: first }, actor)
      expect(html(page)).toBe(first)
      actions.updateFrame(page, { html: first }, actor)
      expect(html(page)).toBe(first)
      expect(actions.takeComponentIssues(page)).toEqual([])
    })
  })
})
