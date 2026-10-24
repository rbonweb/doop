import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Frame } from '../shared/types'

declare global {
  interface Window {
    localEditRenders: number
  }
}

describe.skipIf(!findBrowserPath())('local frame edits', () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame
  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/elementPanel.html`)
    await page.waitForFunction(() => !!window.elementPanelHarness)
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
  })

  it('does not replay locally saved HTML, but still renders undo', async () => {
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Local edits',
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: '<!doctype html><html><body><div id="target" style="width:100px;height:50px">Edit me</div></body></html>',
    }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    const frame = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await frame.waitForSelector('#target')
    await page.evaluate(() => window.elementPanelHarness.select('#target'))
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '100')
    await frame.evaluate(() => {
      window.localEditRenders = 0
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'doop:html') window.localEditRenders++
      })
    })
    await page.click('[aria-label="Width"]', { count: 3 })
    await page.keyboard.type('120')
    await page.keyboard.press('Enter')
    await expect.poll(() => saved.html).toContain('width: 120px')
    // Let the 150ms HTML throttle settle: the existing live document stays put.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await frame.evaluate(() => window.localEditRenders)).toBe(0)
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#target') as HTMLElement).style.width === '100px')
    expect(await frame.evaluate(() => window.localEditRenders)).toBeGreaterThan(0)
  }, 15_000)
})
