import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'

const html = (rules = '') => `<!doctype html><html><head><style data-doop-component-source="cbutton">
  [data-doop-component] { display: block; width: 120px; padding: 4px; background: #eee }
  [data-size="lg"] { padding: 40px }${rules}
</style></head><body><button data-doop-component="cbutton" data-doop-part="r" data-doop-id="main01">Buy</button></body></html>`

const component = {
  id: 'cbutton',
  name: 'Button',
  description: '',
  template: '<button data-doop-part="r">Buy</button>',
  css: '',
  rawCss: '',
  head: [],
  props: [{ name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' }],
  slots: [],
  rev: 1,
  mainFrameId: 'f',
  history: [],
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
} as unknown as ComponentDef

describe.skipIf(!findBrowserPath())('variant preview in the Design panel', () => {
  const pages = pagePerTest()
  let page: Page
  let saved: Frame
  let framePatches: Partial<Frame>[] = []
  let variantPosts: { ops: unknown[] }[] = []
  const errors: string[] = []

  beforeEach(async () => {
    framePatches = []
    variantPosts = []
    page = await pages.open()
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const { pathname } = new URL(request.url())
      const json = (body: unknown) =>
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      if (pathname === '/api/canvases/c/components/cbutton/variants') {
        if (request.method() === 'POST') {
          variantPosts.push(JSON.parse(request.postData()!))
          await json({ component, props: [], rules: [], instances_updated: 0, frames_updated: 0 })
        } else await json({ props: [], rules: [] })
      } else if (pathname === '/api/frames/f' && request.method() === 'PATCH') {
        framePatches.push(JSON.parse(request.postData()!))
        saved = { ...saved, ...framePatches.at(-1) }
        await json(saved)
      } else await request.continue()
    })
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.waitForFunction(() => !!window.elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Components',
      x: 40,
      y: 60,
      width: 600,
      height: 500,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: html(),
    } as Frame
    await page.evaluate(
      (frame, def) =>
        window.commentPositionStore.getState().setCanvas({
          id: 'c',
          name: 'Components',
          frames: [frame],
          components: [def],
          createdAt: 0,
          updatedAt: 0,
        }),
      saved,
      component,
    )
    const iframe = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await iframe.waitForSelector('[data-doop-component]')
    await page.evaluate(() => window.elementPanelHarness.select('[data-doop-id="main01"]'))
    await page.waitForSelector('select[aria-label="Preview size"]')
    await page.waitForSelector('input[aria-label="Corner radius"]')
  }, 60_000)

  afterAll(() => expect(errors).toEqual([]))

  const padding = async () => {
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    return frame.$eval('[data-doop-component]', (el) => getComputedStyle(el).paddingTop)
  }
  const sizeAttr = async () => {
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    return frame.$eval('[data-doop-component]', (el) => el.getAttribute('data-size'))
  }

  it('previews a variant live, writes a style edit to it instead of inline, and never saves the preview', async () => {
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    expect(await padding()).toBe('4px')

    await page.select('select[aria-label="Preview size"]', 'lg')
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-doop-component]')!).paddingTop === '40px',
    )
    await page.waitForFunction(() =>
      document.querySelector('[data-slot="variant-editing"]')?.textContent?.includes('Editing size=lg'),
    )

    /* a Design panel edit now belongs to the previewed combination: one set_style, no inline write to the frame */
    await page.click('input[aria-label="Corner radius"]', { count: 3 })
    await page.keyboard.press('Backspace')
    await page.type('input[aria-label="Corner radius"]', '9')
    await page.keyboard.press('Enter')
    await expect.poll(() => variantPosts.length).toBe(1)
    expect(variantPosts[0]).toEqual({
      ops: [{ op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { 'border-radius': '9px' } }],
    })
    expect(framePatches).toEqual([])

    /* the server rewrites the main's stylesheet and the room sends the frame: the preview survives the render and shows the rule */
    await page.evaluate((next) => window.elementPanelHarness.remote(next), {
      ...saved,
      updatedAt: 1,
      html: html('\n  [data-size="lg"] { border-radius: 9px }'),
    })
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-doop-component]')!).borderTopLeftRadius === '9px',
    )
    expect(await sizeAttr()).toBe('lg')

    /* a geometry edit stays inline and saves the document: the previewed attribute is not in what is saved */
    await page.evaluate(() =>
      window.elementPanelHarness.geometry('[data-doop-id="main01"]', { kind: 'rotate', value: 3 }),
    )
    await expect.poll(() => framePatches.length).toBeGreaterThan(0)
    expect(framePatches.at(-1)!.html).toContain('rotate')
    expect(framePatches.at(-1)!.html).not.toMatch(/<button[^>]*data-size/)

    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent === 'Back to base')!
        .click()
    })
    await frame.waitForFunction(() => !document.querySelector('[data-doop-component]')!.hasAttribute('data-size'))
    expect(await sizeAttr()).toBeNull()
  }, 40_000)
})
