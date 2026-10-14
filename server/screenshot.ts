import fs from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import sharp from 'sharp'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p)

/** The first usable local browser executable, or null when there is none. */
export function findBrowserPath(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

let browserPromise: Promise<Browser> | null = null

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise
    if (b.connected) return b
    browserPromise = null
  }
  browserPromise = puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
  return browserPromise
}

export interface IsolatedPage {
  page: Page
  close: () => Promise<void>
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
export async function openIsolatedPage(): Promise<IsolatedPage> {
  const browser = await getBrowser()
  const context = await browser.createBrowserContext()
  try {
    const page = await context.newPage()
    let closed = false
    return {
      page,
      close: async () => {
        if (closed) return
        closed = true
        await context.close().catch(() => {})
      },
    }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}

interface FrameViewport {
  width: number
  height: number
  deviceScaleFactor: number
}

/* A capture waits up to this long in total for the page to come to rest: fonts, images, and finite animations and transitions. Infinite or very long animations are captured as they are at the cap. */
export const SETTLE_CAP_MS = 4000

/* The page loads at the viewport it is captured at: resizing it afterwards would start new transitions and lazy-image loads after the settle. */
async function loadFramePage(frame: Frame, viewport: FrameViewport): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage()
  const { page } = loaded
  try {
    const assetOrigin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:4300').origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) => url.origin === assetOrigin && url.pathname.startsWith('/a/'),
    })
    await page.setViewport(viewport)
    try {
      await page.setContent(frame.html || '<!doctype html><html><body></body></html>', {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    await settle(page)
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

/* The load event does not wait for what layout starts afterwards: web fonts named by a linked stylesheet, CSS background images, and entrance animations such as a 0.8 s fade-in. Captured at load, a design shows fallback fonts, missing images and sections half faded in. */
async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + SETTLE_CAP_MS
  const left = () => Math.max(0, deadline - Date.now())
  await page.waitForNetworkIdle({ idleTime: 150, timeout: left() }).catch(() => {})
  /* tsx annotates nested functions with __name, which the page does not have; see inspectFrame */
  await page.evaluate('globalThis.__name = (target) => target')
  await page
    .evaluate(async (ms: number) => {
      const end = performance.now() + ms
      const capped = (work: Promise<unknown>) =>
        Promise.race([work, new Promise((done) => setTimeout(done, Math.max(0, end - performance.now())))])
      const loadedImage = (img: HTMLImageElement) =>
        img.complete
          ? Promise.resolve()
          : new Promise((done) => {
              img.addEventListener('load', done, { once: true })
              img.addEventListener('error', done, { once: true })
            })
      await capped(Promise.all([document.fonts.ready, ...Array.from(document.images, loadedImage)]))
      const finite = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
      await capped(Promise.all(finite.map((a) => a.finished.catch(() => undefined))))
      /* an animation's end state can name a font of its own */
      await capped(document.fonts.ready)
      await capped(new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    }, left())
    .catch(() => {
      /* a page that broke its own globals still gets captured */
    })
}

export interface FrameInspection {
  document: { title: string; width: number; height: number; htmlChars: number }
  design: {
    colors: string[]
    backgrounds: string[]
    fonts: string[]
    fontSizes: string[]
    radii: string[]
    shadows: string[]
    cssVariables: Record<string, string>
  }
  elements: Array<{
    selector: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

/** A compact, rendered representation for agents. It intentionally relies on
 * visible text, semantics, geometry and computed styles rather than classes. */
export async function inspectFrame(frame: Frame): Promise<FrameInspection> {
  /* inspection reads layout and computed styles, which need no viewport past 4000 px; the full page stays in the DOM */
  const loaded = await loadFramePage(frame, {
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
    deviceScaleFactor: 1,
  })
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    const inspection = await page.evaluate(() => {
      const MAX_ELEMENTS = 64
      const MAX_STYLE_SAMPLES = 500
      const semanticTags = new Set([
        'header',
        'nav',
        'main',
        'section',
        'article',
        'aside',
        'footer',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'form',
        'img',
        'ul',
        'ol',
        'table',
      ])

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 1 &&
          rect.height > 1
        )
      }

      function selectorFor(el: Element): string {
        if (el.id && el.id.length < 80) return `#${CSS.escape(el.id)}`
        const parts: string[] = []
        let node: Element | null = el
        while (node && node !== document.body && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const parent: Element | null = node.parentElement
          if (!parent) {
            parts.unshift(tag)
            break
          }
          const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName)
          const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : ''
          parts.unshift(tag + suffix)
          node = parent
        }
        return `body > ${parts.join(' > ')}`
      }

      function cleanText(value: string | null | undefined, max = 180): string | undefined {
        const text = (value || '').replace(/\s+/g, ' ').trim()
        if (!text) return undefined
        return text.length > max ? `${text.slice(0, max - 1)}…` : text
      }

      function normalizedColor(value: string): string | undefined {
        if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return undefined
        return value
      }

      const counts = {
        colors: new Map<string, number>(),
        backgrounds: new Map<string, number>(),
        fonts: new Map<string, number>(),
        fontSizes: new Map<string, number>(),
        radii: new Map<string, number>(),
        shadows: new Map<string, number>(),
      }
      const bump = (map: Map<string, number>, value?: string) => {
        if (value) map.set(value, (map.get(value) || 0) + 1)
      }

      const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
      for (const el of all.slice(0, MAX_STYLE_SAMPLES)) {
        const style = getComputedStyle(el)
        bump(counts.colors, normalizedColor(style.color))
        bump(counts.backgrounds, normalizedColor(style.backgroundColor))
        bump(counts.fonts, style.fontFamily)
        bump(counts.fontSizes, style.fontSize)
        if (style.borderRadius !== '0px') bump(counts.radii, style.borderRadius)
        if (style.boxShadow !== 'none') bump(counts.shadows, style.boxShadow)
      }

      const semantic = all
        .filter((el) => semanticTags.has(el.tagName.toLowerCase()) || !!el.getAttribute('role'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const candidates: HTMLElement[] = []
      const selected = new Set<HTMLElement>()
      const take = (limit: number, predicate: (el: HTMLElement) => boolean) => {
        for (const el of semantic) {
          if (candidates.length >= MAX_ELEMENTS || limit <= 0) break
          if (selected.has(el) || !predicate(el)) continue
          selected.add(el)
          candidates.push(el)
          limit--
        }
      }
      take(18, (el) =>
        ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(el.tagName.toLowerCase()),
      )
      take(16, (el) => /^h[1-6]$/.test(el.tagName.toLowerCase()))
      take(
        16,
        (el) =>
          ['button', 'a', 'input', 'textarea', 'select', 'form'].includes(el.tagName.toLowerCase()) ||
          !!el.getAttribute('role'),
      )
      take(14, (el) => ['p', 'img', 'ul', 'ol', 'table'].includes(el.tagName.toLowerCase()))
      take(MAX_ELEMENTS - candidates.length, () => true)

      const elements = candidates.map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const image = el instanceof HTMLImageElement ? cleanText(el.alt || el.getAttribute('aria-label')) : undefined
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: image || cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
          rect: {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          style: {
            color: style.color,
            background: style.backgroundColor,
            font: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
          },
        }
      })

      const top = (map: Map<string, number>, limit: number) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([value]) => value)
      const rootStyle = getComputedStyle(document.documentElement)
      const cssVariables: Record<string, string> = {}
      for (const name of Array.from(rootStyle)) {
        if (!name.startsWith('--') || Object.keys(cssVariables).length >= 40) continue
        const value = rootStyle.getPropertyValue(name).trim()
        if (value && value.length <= 160) cssVariables[name] = value
      }

      return {
        title: document.title,
        design: {
          colors: top(counts.colors, 10),
          backgrounds: top(counts.backgrounds, 10),
          fonts: top(counts.fonts, 8),
          fontSizes: top(counts.fontSizes, 10),
          radii: top(counts.radii, 8),
          shadows: top(counts.shadows, 6),
          cssVariables,
        },
        elements,
      }
    })

    return {
      document: {
        title: inspection.title,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        htmlChars: frame.html.length,
      },
      design: inspection.design,
      elements: inspection.elements,
    }
  } finally {
    await loaded.close()
  }
}

/* Chrome rasterizes a screenshot into one surface, and a surface past the GPU size limit does not fail: it wraps, so the image of a tall frame repeats or scrambles the top of the page (past 16384 device px in headless Chrome on macOS; earlier for wide frames on a Linux server). A capture taller than this is taken in strips that stay far below any limit, and stitched. */
export const MAX_STRIP_DEVICE_PX = 4096

interface CaptureArea {
  width: number
  height: number
  scale: number
  type: 'png' | 'jpeg'
  quality: number
}

export async function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: { type?: 'png' | 'jpeg'; quality?: number; maxHeight?: number } = {},
): Promise<Buffer> {
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  const loaded = await loadFramePage(frame, { width, height, deviceScaleFactor: scale })
  const { page } = loaded
  try {
    const type = opts.type ?? 'png'
    const quality = opts.quality ?? 90
    const captured = opts.maxHeight && frame.height > opts.maxHeight ? Math.round(opts.maxHeight) : height
    if (captured * scale > MAX_STRIP_DEVICE_PX) {
      return await captureInStrips(page, { width, height: captured, scale, type, quality })
    }
    const clip = captured < height ? { x: 0, y: 0, width, height: captured } : undefined
    const buf = await page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality } : {}),
      ...(clip ? { clip } : {}),
    })
    return Buffer.from(buf)
  } finally {
    await loaded.close()
  }
}

/* Strips are lossless PNG, so a JPEG is encoded once, from the stitched pixels, exactly as a single capture would be. The viewport keeps the frame's full height, so vh units and fixed elements lay out as they do on the canvas. */
async function captureInStrips(page: Page, area: CaptureArea): Promise<Buffer> {
  const outWidth = Math.round(area.width * area.scale)
  const outHeight = Math.round(area.height * area.scale)
  const strips: Buffer[] = []
  for (let top = 0; top < outHeight; top += MAX_STRIP_DEVICE_PX) {
    const rows = Math.min(MAX_STRIP_DEVICE_PX, outHeight - top)
    /* optimizeForSpeed: Chrome's fast PNG compression; strips are intermediates, decoded again below */
    const shot = await page.screenshot({
      type: 'png',
      optimizeForSpeed: true,
      clip: { x: 0, y: top / area.scale, width: area.width, height: rows / area.scale },
    })
    strips.push(await exactSize(Buffer.from(shot), outWidth, rows))
  }
  /* One strip per row: libvips streams the join into the encoder rather than holding the whole image. The join sizes every cell to the tallest strip, so the short last strip comes back padded and is cropped off. */
  const stitched = sharp(strips, { join: { across: 1 } })
    .extract({ left: 0, top: 0, width: outWidth, height: outHeight })
    .flatten({ background: '#ffffff' })
  /* optimised Huffman tables need every coefficient of the image in memory at once (about 1 GB for a 2x export of a 20000 px frame); without them the JPEG streams too */
  return area.type === 'jpeg'
    ? stitched.jpeg({ quality: area.quality, optimiseCoding: false }).toBuffer()
    : stitched.png().toBuffer()
}

/* a fractional scale can round a strip one pixel off its slot; stretch it back so strips never overlap or gap */
async function exactSize(png: Buffer, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(png).metadata()
  if (meta.width === width && meta.height === height) return png
  return sharp(png).resize(width, height, { fit: 'fill' }).png().toBuffer()
}
