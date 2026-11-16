import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import type Sharp from 'sharp'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import type { CaptureRequest, CaptureResult, Clip } from './renderTypes.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { cachedRenderResponse } from './renderFetchCache.ts'
import { withHostedIcons } from './iconProxy.ts'
import { withHostedPhotos } from './photoProxy.ts'
import { renderedHeight } from './renderLimits.ts'
import { LayerNotFoundError } from './layerExport.ts'
import {
  createRenderer,
  remoteConnectFailure,
  withDeadline,
  type PageOptions,
  type RenderPage,
  type RendererStatus,
} from './renderBrowser.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

const windowsDirectories = process.platform === 'win32' ? windowsBrowserDirectories() : []

const CHROME_PATHS = [
  env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  ...windowsDirectories.map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
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

/** Whether the server has a browser to render with: a remote one
 *  (REMOTE_BROWSER_URL) or a local executable. */
export function rendererAvailable(): boolean {
  return !!env.REMOTE_BROWSER_URL || findBrowserPath() !== null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

/** A fresh headless Chrome with the server's flags. `timeout` bounds the wait
 *  for its DevTools endpoint (puppeteer's default, 30s, unless given);
 *  `protocolTimeout` bounds every DevTools command (puppeteer's 180s unless
 *  given). */
export function launchBrowser(timeout?: number, protocolTimeout?: number): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    timeout,
    protocolTimeout,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
}

/* a stuck DevTools command fails in a minute rather than puppeteer's three,
   so the renderer's health probe gets to judge the browser sooner */
const PROTOCOL_TIMEOUT_MS = 60_000

/** One render attempt, page open to encoded bytes. */
const RENDER_TIMEOUT_MS = 45_000

/* a remote session is billed while it is open: close it this long after its
   last page, well inside the provider's own idle timeout (Cloudflare: 60s) */
const REMOTE_IDLE_CLOSE_MS = 30_000
const REMOTE_CONNECT_TIMEOUT_MS = 30_000
/* closing a heavy page's context is a round trip that waits on the page's
   teardown: a remote one took over 5s after a full website import */
const REMOTE_CLOSE_TIMEOUT_MS = 15_000

/** A Chrome somewhere else, over the DevTools protocol (REMOTE_BROWSER_URL).
 *  Everything past the connect is the same puppeteer API a local one has. */
export function connectRemoteBrowser(url: string, token: string | undefined): Promise<Browser> {
  const connecting = puppeteer.connect({
    browserWSEndpoint: url,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  })
  return withDeadline(connecting, REMOTE_CONNECT_TIMEOUT_MS, 'connecting to the remote browser').catch(
    (error: unknown) => {
      /* a session that opens after its deadline is still billed: close it */
      connecting.then(
        (late) => void late.close().catch(() => {}),
        () => {},
      )
      throw remoteConnectFailure(error)
    },
  )
}

const remoteBrowserUrl = env.REMOTE_BROWSER_URL

const renderer = createRenderer({
  launch: () =>
    remoteBrowserUrl
      ? connectRemoteBrowser(remoteBrowserUrl, env.REMOTE_BROWSER_TOKEN)
      : launchBrowser(undefined, PROTOCOL_TIMEOUT_MS),
  tuning: {
    maxConcurrent: Math.max(1, env.RENDER_CONCURRENCY),
    ...(remoteBrowserUrl ? { idleCloseMs: REMOTE_IDLE_CLOSE_MS, closeTimeoutMs: REMOTE_CLOSE_TIMEOUT_MS } : {}),
  },
})

/** The live shared browser, launched if need be. */
export function getBrowser(): Promise<Browser> {
  return renderer.browser()
}

/** Counters for logs and health checks. */
export function rendererStatus(): RendererStatus {
  return renderer.status()
}

export type IsolatedPage = Pick<RenderPage, 'page' | 'close'>

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context and
 *  returns the page's render slot; a page that is never closed is closed for
 *  its caller when its lease runs out (see renderBrowser.ts). */
export function openIsolatedPage(options?: PageOptions): Promise<IsolatedPage> {
  return renderer.openPage(options)
}

export interface FrameViewport {
  width: number
  height: number
  deviceScaleFactor: number
}

/* A capture waits up to this long in total for the page to come to rest: fonts, images, and finite animations and transitions. Infinite or very long animations are captured as they are at the cap. */
export const SETTLE_CAP_MS = 4000

/** The viewport for reading layout and computed styles: a viewport does not need to span an entire imported landing page for inspection, full-page content remains in the DOM. Also what a caller without a viewport of its own (the PDF export) gets. */
function inspectionViewport(frame: Frame): FrameViewport {
  return {
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
    deviceScaleFactor: 1,
  }
}

/* The page loads at the viewport it is captured at: resizing it afterwards would start new transitions and lazy-image loads after the settle. */
export async function loadFramePage(
  frame: Frame,
  viewport: FrameViewport = inspectionViewport(frame),
  options?: PageOptions,
): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage(options)
  try {
    await loadFrameInto(loaded.page, frame, viewport)
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

async function loadFrameInto(
  page: Page,
  frame: Frame,
  viewport: FrameViewport = inspectionViewport(frame),
): Promise<void> {
  const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
  await guardPublicPageRequests(page, {
    cached: cachedRenderResponse,
    allowUrl: (url) =>
      (url.origin === assetOrigin && /^\/(?:a|icons|photos)\//.test(url.pathname)) ||
      /* webfonts referenced by imported frames (imports request the
         source design's families from Google Fonts) */
      url.origin === 'https://fonts.googleapis.com' ||
      url.origin === 'https://fonts.gstatic.com',
  })
  await page.setViewport(viewport)
  /* setContent leaves the page on about:blank, where the relative /a/...
     asset URLs of imported frames resolve nowhere. In the app an iframe
     inherits the page origin; here a <base> stands in for it — unless the
     frame brought its own (website imports do). */
  let html = withHostedPhotos(withHostedIcons(frame.html || '<!doctype html><html><body></body></html>'))
  if (!/<base\s/i.test(html)) {
    const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + html
  }
  try {
    await page.setContent(html, {
      waitUntil: 'load',
      timeout: 8000,
    })
  } catch {
    /* Slow external resources: inspect whatever has rendered. */
  }
  await settle(page)
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
export function inspectFrame(frame: Frame): Promise<FrameInspection> {
  return renderer.withPage('inspecting the frame', RENDER_TIMEOUT_MS, (page) => inspectOn(page, frame))
}

async function inspectOn(page: Page, frame: Frame): Promise<FrameInspection> {
  await loadFrameInto(page, frame)
  {
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
        const doopId = el.getAttribute('data-doop-id')
        if (doopId) return `[data-doop-id="${doopId}"]`
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
  }
}

/* Chrome rasterizes a screenshot into one surface, and a surface past the GPU size limit does not fail: it wraps, so the image of a tall frame repeats or scrambles the top of the page (past 16384 device px in headless Chrome on macOS; earlier for wide frames on a Linux server). A capture taller than this is taken in strips that stay far below any limit, and stitched. */
export const MAX_STRIP_DEVICE_PX = 4096

interface CaptureArea {
  width: number
  height: number
  scale: number
  type: 'png' | 'jpeg' | 'webp'
  quality: number
}

export interface RenderOptions extends PageOptions {
  type?: 'png' | 'jpeg'
  quality?: number
  maxHeight?: number
  /** cut the render to the box of the first element this CSS selector
   *  matches (a layer export); rejects with LayerNotFoundError when nothing
   *  visible matches */
  layer?: string
}

export function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: RenderOptions = {},
): Promise<Buffer> {
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  return renderer.withPage(
    'rendering the frame',
    RENDER_TIMEOUT_MS,
    async (page) => {
      await loadFrameInto(page, frame, { width, height, deviceScaleFactor: scale })
      return screenshotOn(page, frame, scale, opts)
    },
    { priority: opts.priority },
  )
}

/** The layer's rendered box in design px, whole pixels outward, within
 *  the frame: what the canvas shows of it, since a frame clips what
 *  overflows it. The pixel budget bounds the crop itself, not the frame,
 *  so a layer low on a huge frame still renders. */
async function layerClip(page: Page, selector: string, frame: Frame, scale: number): Promise<Clip> {
  const box = await page.evaluate((sel: string) => {
    let el: Element | null
    try {
      el = document.querySelector(sel)
    } catch {
      return 'invalid' as const
    }
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
    }
  }, selector)
  if (box === 'invalid') throw new LayerNotFoundError(`"${selector}" is not a valid CSS selector`)
  if (!box) throw new LayerNotFoundError(`no element matches ${selector}`)
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  /* judged before rounding outward, which would give an empty box a pixel */
  const visible =
    Math.min(width, box.right) - Math.max(0, box.left) > 0 && Math.min(height, box.bottom) - Math.max(0, box.top) > 0
  if (!visible) throw new LayerNotFoundError(`${selector} has no visible size inside the frame`)
  const x = Math.max(0, Math.floor(box.left))
  const y = Math.max(0, Math.floor(box.top))
  const clipWidth = Math.min(width, Math.ceil(box.right)) - x
  const budget = renderedHeight({ width: clipWidth, height }, scale)
  return { x, y, width: clipWidth, height: Math.min(Math.ceil(box.bottom), height, y + budget) - y }
}

/* the page is already loaded at the frame's full size and the render's scale, so 100vh, height media queries and bottom-fixed elements lay out as they do on the canvas */
async function screenshotOn(page: Page, frame: Frame, scale: number, opts: RenderOptions): Promise<Buffer> {
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  const type = opts.type ?? 'png'
  const quality = opts.quality ?? 90
  const captured = opts.maxHeight && frame.height > opts.maxHeight ? Math.round(opts.maxHeight) : height
  const layer = opts.layer ? await layerClip(page, opts.layer, frame, scale) : undefined
  const area = layer ?? { x: 0, y: 0, width, height: captured }
  if (area.height * scale > MAX_STRIP_DEVICE_PX) {
    return captureInStrips(page, { width: area.width, height: area.height, scale, type, quality }, area)
  }
  const clip = layer ?? (captured < height ? area : undefined)
  const buf = await page.screenshot({
    type,
    ...(type === 'jpeg' ? { quality } : {}),
    ...(clip ? { clip } : {}),
  })
  return Buffer.from(buf)
}

/* sharp resolves its native binary from process.platform when it loads, so it loads on first use: importing this module (browser detection, with a faked platform) must not need it */
async function loadSharp(): Promise<typeof Sharp> {
  return (await import('sharp')).default
}

/* Strips are lossless PNG, so a JPEG is encoded once, from the stitched pixels, exactly as a single capture would be. The viewport keeps the frame's full height, so vh units and fixed elements lay out as they do on the canvas. */
async function captureInStrips(
  page: Page,
  area: CaptureArea,
  /* where the captured region starts in the frame, in design px */
  origin: { x: number; y: number } = { x: 0, y: 0 },
): Promise<Buffer> {
  const outWidth = Math.round(area.width * area.scale)
  const outHeight = Math.round(area.height * area.scale)
  const strips: Buffer[] = []
  for (let top = 0; top < outHeight; top += MAX_STRIP_DEVICE_PX) {
    const rows = Math.min(MAX_STRIP_DEVICE_PX, outHeight - top)
    /* optimizeForSpeed: Chrome's fast PNG compression; strips are intermediates, decoded again below */
    const shot = await page.screenshot({
      type: 'png',
      optimizeForSpeed: true,
      clip: { x: origin.x, y: origin.y + top / area.scale, width: area.width, height: rows / area.scale },
    })
    strips.push(await exactSize(Buffer.from(shot), outWidth, rows))
  }
  /* One strip per row: libvips streams the join into the encoder rather than holding the whole image. The join sizes every cell to the tallest strip, so the short last strip comes back padded and is cropped off. */
  const sharp = await loadSharp()
  const stitched = sharp(strips, { join: { across: 1 } })
    .extract({ left: 0, top: 0, width: outWidth, height: outHeight })
    .flatten({ background: '#ffffff' })
  /* optimised Huffman tables need every coefficient of the image in memory at once (about 1 GB for a 2x export of a 20000 px frame); without them the JPEG streams too */
  if (area.type === 'webp') return stitched.webp({ quality: area.quality, effort: 2 }).toBuffer()
  return area.type === 'jpeg'
    ? stitched.jpeg({ quality: area.quality, optimiseCoding: false }).toBuffer()
    : stitched.png().toBuffer()
}

/* a fractional scale can round a strip one pixel off its slot; stretch it back so strips never overlap or gap */
async function exactSize(png: Buffer, width: number, height: number): Promise<Buffer> {
  const sharp = await loadSharp()
  const meta = await sharp(png).metadata()
  if (meta.width === width && meta.height === height) return png
  return sharp(png).resize(width, height, { fit: 'fill' }).png().toBuffer()
}

/* a region inside the frame, in whole design px: floor the origin, ceil the size, cut at the frame's edges */
function clampRegion(region: Clip, width: number, height: number): Clip {
  const left = Math.max(0, Math.floor(region.x))
  const top = Math.max(0, Math.floor(region.y))
  const right = Math.min(width, Math.ceil(region.x + region.width))
  const bottom = Math.min(height, Math.ceil(region.y + region.height))
  if (!(right > left) || !(bottom > top)) throw new RangeError('region is outside the frame')
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** One capture of a frame, or of a region of it: png, jpg or webp at a scale, taken after an optional `prepare` step (which may pick the region). A region taller than one strip is captured in strips and stitched. Runs on the shared renderer, so a wedged browser is replaced and the capture retried on a fresh page (`prepare` runs again there). */
export function captureFrame(frame: Frame, req: CaptureRequest): Promise<CaptureResult> {
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  const { scale } = req
  return renderer.withPage(
    'capturing the frame',
    RENDER_TIMEOUT_MS,
    async (page) => {
      await loadFrameInto(page, frame, { width, height, deviceScaleFactor: scale })
      const prepared = req.prepare ? await req.prepare(page) : undefined
      const wanted = prepared ?? req.clip ?? { x: 0, y: 0, width, height }
      const region = clampRegion(wanted, width, height)
      const type = req.format === 'jpg' ? 'jpeg' : req.format
      const quality = req.quality ?? (type === 'webp' ? 80 : 90)
      let buf: Buffer
      if (region.height * scale > MAX_STRIP_DEVICE_PX) {
        buf = await captureInStrips(
          page,
          { width: region.width, height: region.height, scale, type, quality },
          { x: region.x, y: region.y },
        )
      } else {
        buf = Buffer.from(await page.screenshot({ type, ...(type === 'png' ? {} : { quality }), clip: region }))
      }
      return {
        buf,
        clip: region,
        width: Math.round(region.width * scale),
        height: Math.round(region.height * scale),
      }
    },
    { priority: req.priority },
  )
}
