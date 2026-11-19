import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { findBrowserPath, launchBrowser } from '../server/screenshot.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/* A, B and C on real computed styles in the headless shell (CHROME_PATH), with the markup the server stores. */

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('component CSS scoping in a browser', { timeout: 60_000 }, () => {
  let browser: Browser
  let page: Page
  let canvasId = ''
  let cardId = ''
  let mainFrameId = ''

  beforeAll(async () => {
    browser = await launchBrowser()
    page = await browser.newPage()
  })
  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(() => {
    const canvas = store.createCanvas('scoping browser')
    canvasId = canvas.id
    const card = blankComponent({ name: 'Card', by: 'Tester' })
    cardId = card.id
    store.saveComponent(canvas.id, card)
    const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    mainFrameId = mainFrame.id
    actions.updateFrame(
      mainFrame.id,
      {
        html: doc(
          `<section class="card" ${COMPONENT_ATTR}="${card.id}"><h2 data-doop-prop="title">T</h2><div class="body" data-doop-slot="a"></div></section>`,
          `:root { --accent: rgb(0, 128, 0) }\n.card { color: var(--accent) }\n.card h2 { margin: 0 }\n.card .body p { margin: 3px }`,
        ),
      },
      actor,
    )
  })

  const place = (css: string, extra = '') => {
    const frame = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(
      frame.id,
      {
        html: doc(
          `<doop-use component="Card" title="Hi"><p class="mine">slot</p></doop-use>${extra}<h2 id="outside">out</h2>`,
          css,
        ),
      },
      actor,
    )
    return store.getFrame(frame.id)!.html
  }
  const style = (selector: string, prop: string) =>
    page.evaluate((sel, name) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(name), selector, prop)

  it('A: frame rules stop at the instance, reach slot content and the root, and still style the frame', async () => {
    await page.setContent(
      place('h2 { margin: 40px }\n.mine { color: rgb(255, 0, 0) }\n[data-doop-instance] { margin-top: 9px }'),
    )
    expect(await style('[data-doop-instance] h2', 'margin-top')).toBe('0px')
    expect(await style('#outside', 'margin-top')).toBe('40px')
    expect(await style('.mine', 'color')).toBe('rgb(255, 0, 0)')
    expect(await style('[data-doop-instance]', 'margin-top')).toBe('9px')
    /* inherited properties still flow in from the frame */
    await page.setContent(place('body { font-size: 21px }'))
    expect(await style('.mine', 'font-size')).toBe('21px')
  })

  it('B: a rule of one component does not reach into an instance of another', async () => {
    const button = blankComponent({ name: 'Button', by: 'Tester' })
    store.saveComponent(canvasId, button)
    const frame = actions.createFrame(canvasId, { name: 'ButtonMain', html: '' }, actor)!
    actions.updateFrame(
      frame.id,
      {
        html: doc(
          `<button ${COMPONENT_ATTR}="${button.id}" class="btn"><span class="label">B</span></button>`,
          '.btn { color: rgb(1, 2, 3) } .label { letter-spacing: 2px }',
        ),
      },
      actor,
    )
    /* Card's `.label` rule (a class it has too) must not restyle the Button's label inside a Card instance */
    const cardMain = doc(
      `<section class="card" ${COMPONENT_ATTR}="${cardId}"><h2 data-doop-prop="title">T</h2><span class="label">card label</span><div class="body" data-doop-slot="a"></div></section>`,
      `.card h2 { margin: 0 } .label { font-size: 30px }`,
    )
    actions.updateFrame(mainFrameId, { html: cardMain }, actor)
    const page2 = actions.createFrame(canvasId, { name: 'P2', html: '' }, actor)!
    actions.updateFrame(
      page2.id,
      { html: doc(`<doop-use component="Card" title="x"><doop-use component="Button"></doop-use></doop-use>`) },
      actor,
    )
    await page.setContent(store.getFrame(page2.id)!.html)
    expect(await style('.card > .label', 'font-size')).toBe('30px')
    expect(await style('.btn .label', 'font-size')).not.toBe('30px')
  })

  it('C: the consuming frame and token themes win over the main values; a frame without them renders like the main', async () => {
    await page.setContent(place(''))
    expect(await style('[data-doop-instance]', 'color')).toBe('rgb(0, 128, 0)')
    await page.setContent(place(':root { --accent: rgb(10, 20, 30) }'))
    expect(await style('[data-doop-instance]', 'color')).toBe('rgb(10, 20, 30)')
    await page.setContent(
      place(':root { --accent: rgb(10, 20, 30) } [data-doop-theme="dark"] { --accent: rgb(200, 200, 200) }').replace(
        '<html>',
        '<html data-doop-theme="dark">',
      ),
    )
    expect(await style('[data-doop-instance]', 'color')).toBe('rgb(200, 200, 200)')
  })

  it('main frame: a nested component in a main looks the same as in its instances', async () => {
    const button = blankComponent({ name: 'Button', by: 'Tester' })
    store.saveComponent(canvasId, button)
    const bf = actions.createFrame(canvasId, { name: 'ButtonMain', html: '' }, actor)!
    actions.updateFrame(
      bf.id,
      {
        html: doc(
          `<button class="btn" ${COMPONENT_ATTR}="${button.id}"><span class="label">B</span></button>`,
          '.btn { padding: 2px }',
        ),
      },
      actor,
    )
    const panel = blankComponent({ name: 'Panel', by: 'Tester' })
    store.saveComponent(canvasId, panel)
    const pf = actions.createFrame(canvasId, { name: 'PanelMain', html: '' }, actor)!
    actions.updateFrame(
      pf.id,
      {
        html: doc(
          `<div class="plan" ${COMPONENT_ATTR}="${panel.id}"><doop-use component="Button"></doop-use></div>`,
          '.plan .btn .label { letter-spacing: 3px }',
        ),
      },
      actor,
    )
    const inMain = store.getFrame(pf.id)!.html
    const usage = actions.createFrame(canvasId, { name: 'Usage', html: '' }, actor)!
    actions.updateFrame(usage.id, { html: doc('<doop-use component="Panel"></doop-use>') }, actor)
    await page.setContent(inMain)
    const main = await style('.plan .btn .label', 'letter-spacing')
    await page.setContent(store.getFrame(usage.id)!.html)
    expect(await style('.plan .btn .label', 'letter-spacing')).toBe(main)
    expect(main).toBe('3px')
  })
})
