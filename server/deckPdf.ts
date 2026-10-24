import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { openIsolatedPage, SETTLE_CAP_MS } from './screenshot.ts'
import { env } from './env.ts'

/**
 * A deck as one PDF: one page per slide, each page exactly the slide's own width × height, in the order given.
 *
 * Every slide becomes a full-page iframe (srcdoc) in one document, so a slide keeps its own viewport, its vh/vw units and
 * its fixed elements, exactly as it has in present mode. Each slide is put in the state a viewer sees once it has
 * arrived: `data-sl-play` on <html> for the show, and `data-sl-entered` set after its entrance animations had a chance to
 * start, so a design that hides things until `[data-sl-entered]` still prints complete.
 */

const EMPTY_DOCUMENT = '<!doctype html><html><body></body></html>'

/** Slide dimensions as the CSS the page lays out with: whole pixels, at least 1. */
function sizeOf(slide: Frame): { width: number; height: number } {
  return { width: Math.max(1, Math.round(slide.width)), height: Math.max(1, Math.round(slide.height)) }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** The single document the PDF is printed from. Exported so its structure can be checked without a browser. */
export function deckDocument(slides: readonly Frame[]): string {
  const sizes = new Map<string, number>()
  const slideSize = slides.map((slide) => {
    const { width, height } = sizeOf(slide)
    const key = `${width}x${height}`
    if (!sizes.has(key)) sizes.set(key, sizes.size)
    return { width, height, key }
  })
  /* named pages give each distinct slide size its own page size */
  const pageRules = [...sizes.entries()]
    .map(([key, i]) => {
      const [w, h] = key.split('x')
      return `@page s${i} { size: ${w}px ${h}px; margin: 0 } .s${i} { page: s${i} }`
    })
    .join('\n')
  const body = slides
    .map((slide, i) => {
      const { width, height, key } = slideSize[i]!
      const html = slide.html || EMPTY_DOCUMENT
      return `<section class="slide s${sizes.get(key)}" style="width:${width}px;height:${height}px"><iframe title="${escapeAttribute(slide.name)}" srcdoc="${escapeAttribute(html)}"></iframe></section>`
    })
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
.slide{position:relative;overflow:hidden;break-after:page}
.slide:last-child{break-after:auto}
.slide iframe{display:block;width:100%;height:100%;border:0}
${pageRules}
</style></head><body>${body}</body></html>`
}

export async function renderDeckPdf(slides: readonly Frame[]): Promise<Buffer> {
  if (!slides.length) throw new Error('A deck needs at least one slide')
  const loaded = await openIsolatedPage()
  const { page } = loaded
  try {
    const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) => url.origin === assetOrigin && url.pathname.startsWith('/a/'),
    })
    const first = sizeOf(slides[0]!)
    await page.setViewport({ ...first, deviceScaleFactor: 1 })
    try {
      await page.setContent(deckDocument(slides), { waitUntil: 'load', timeout: 15_000 })
    } catch {
      /* slow external resources: print whatever has rendered */
    }
    await page.waitForNetworkIdle({ idleTime: 200, timeout: SETTLE_CAP_MS }).catch(() => {})
    await playSlides(page)
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    return Buffer.from(pdf)
  } finally {
    await loaded.close()
  }
}

/* Runs in the page: the same-origin srcdoc frames are reachable through contentDocument. */
async function playSlides(page: Page): Promise<void> {
  await page.evaluate(`(async function () {
    var deadline = performance.now() + ${SETTLE_CAP_MS}
    var left = function () { return Math.max(0, deadline - performance.now()) }
    var capped = function (work) {
      return Promise.race([work, new Promise(function (done) { setTimeout(done, left()) })])
    }
    var docs = Array.prototype.map.call(document.querySelectorAll('.slide iframe'), function (f) { return f.contentDocument })
      .filter(Boolean)
    var images = function (doc) {
      return Array.prototype.map.call(doc.images, function (img) {
        return img.complete ? Promise.resolve() : new Promise(function (done) {
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        })
      })
    }
    await capped(Promise.all(docs.map(function (doc) { return Promise.all([doc.fonts.ready].concat(images(doc))) })))
    var frame = function () { return new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(done) }) }) }
    /* the show is on and every slide has been painted in its resting state, then it arrives */
    docs.forEach(function (doc) { doc.documentElement.setAttribute('data-sl-play', '') })
    await frame()
    docs.forEach(function (doc) { doc.documentElement.setAttribute('data-sl-entered', '') })
    await frame()
    var running = []
    docs.forEach(function (doc) {
      doc.getAnimations().forEach(function (a) {
        if (a.playState === 'running' && isFinite(Number(a.effect && a.effect.getComputedTiming().endTime))) running.push(a.finished.catch(function () {}))
      })
    })
    await capped(Promise.all(running))
    await frame()
  })()`)
}
