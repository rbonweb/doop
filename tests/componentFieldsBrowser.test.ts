import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'

const attr = (props: Record<string, string>) => JSON.stringify(props).replace(/"/g, '&quot;')
const html = (props: Record<string, string>) =>
  `<!doctype html><html><head></head><body><div data-doop-instance="cdoc" data-doop-rev="1" data-doop-id="inst01" data-doop-props="${attr(props)}" style="width:300px;height:120px"><p>Hello</p></div></body></html>`

const component = {
  id: 'cdoc',
  name: 'Doc',
  description: '',
  template:
    '<div data-doop-part="r"><p data-doop-part="b" data-doop-prop="body">Hello</p><ul data-doop-part="u"><li data-doop-part="i" data-doop-each="tasks"><span data-doop-part="t" data-doop-prop="title">Sample</span></li></ul></div>',
  css: '',
  rawCss: '',
  head: [],
  props: [
    { name: 'body', type: 'richtext' },
    { name: 'tasks', type: 'list', fields: { title: { type: 'text' }, done: { type: 'boolean' } } },
  ],
  slots: [],
  rev: 1,
  mainFrameId: 'main',
  history: [],
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
} as unknown as ComponentDef

describe.skipIf(!findBrowserPath())(
  'rich-text and list prop editors in the Design panel (real contenteditable)',
  () => {
    const pages = pagePerTest()
    let page: Page
    let saved: Frame
    let changes: { changes: { instanceId: string; props: Record<string, string> }[] }[] = []
    const errors: string[] = []

    beforeEach(async () => {
      changes = []
      page = await pages.open()
      page.setDefaultTimeout(5_000)
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.setViewport({ width: 1000, height: 900 })
      await page.setRequestInterception(true)
      page.on('request', async (request) => {
        const { pathname } = new URL(request.url())
        if (pathname === '/api/frames/f/instances' && request.method() === 'PATCH') {
          const body = JSON.parse(request.postData()!) as (typeof changes)[number]
          changes.push(body)
          saved = { ...saved, updatedAt: saved.updatedAt + 1, html: html({ ...props(), ...body.changes[0]!.props }) }
          await request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ frame: saved, missing: [] }),
          })
        } else await request.continue()
      })
      await page.goto(fixtureUrl('elementPanel.html'))
      await page.waitForFunction(() => !!window.elementPanelHarness)
      saved = {
        id: 'f',
        canvasId: 'c',
        name: 'Page',
        x: 40,
        y: 60,
        width: 600,
        height: 500,
        createdAt: 0,
        updatedAt: 0,
        updatedBy: 'Tester',
        html: html({ body: 'Hello', tasks: '[{"title":"One"}]' }),
      } as Frame
      await page.evaluate(
        (frame, def) =>
          window.commentPositionStore.getState().setCanvas({
            id: 'c',
            name: 'Page',
            frames: [frame],
            components: [def],
            createdAt: 0,
            updatedAt: 0,
          }),
        saved,
        component,
      )
      const iframe = (await (await page.waitForSelector('iframe'))!.contentFrame())!
      await iframe.waitForSelector('[data-doop-instance]')
      await page.evaluate(() => window.elementPanelHarness.select('[data-doop-id="inst01"]'))
      await page.waitForSelector('[aria-label="body, rich text"]')
    }, 60_000)

    const props = () => ({ body: 'Hello', tasks: '[{"title":"One"}]' })

    afterAll(() => expect(errors).toEqual([]))

    it('formats rich text with the keyboard, pastes plain text (typed after the bold run, so it stays bold), and saves the subset markup on blur', async () => {
      await page.click('[aria-label="body, rich text"]')
      await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('[aria-label="body, rich text"]')!
        const range = document.createRange()
        range.selectNodeContents(editor)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await page.keyboard.down('Control')
      await page.keyboard.press('b')
      await page.keyboard.up('Control')
      await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('[aria-label="body, rich text"]')!
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        const data = new DataTransfer()
        data.setData('text/plain', ' <i>plain</i>')
        data.setData('text/html', '<p style="color:red">styled</p>')
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await page.click('[aria-label="Add item"]')
      await expect.poll(() => changes.length).toBeGreaterThanOrEqual(1)
      const first = changes[0]!.changes[0]!
      expect(first.instanceId).toBe('inst01')
      expect(first.props.body).toBe('<b>Hello &lt;i&gt;plain&lt;/i&gt;</b>')
    })

    it('adds a list item and saves the whole list in one request', async () => {
      await page.waitForSelector('[data-slot="list-item"]')
      await page.click('[aria-label="Add item"]')
      await expect.poll(() => changes.length).toBe(1)
      expect(changes[0]!.changes[0]!.props).toEqual({ tasks: '[{"title":"One"},{"done":false}]' })
      await page.waitForFunction(() => document.querySelectorAll('[data-slot="list-item"]').length === 2)
    })
  },
)
