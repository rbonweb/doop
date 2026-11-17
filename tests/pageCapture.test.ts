import { afterAll, describe, expect, it } from 'vitest'
import { snapshotDocument } from '../server/pageCapture.ts'
import { findBrowserPath, getBrowser, openIsolatedPage } from '../server/screenshot.ts'

/* The snapshot sanitizer website import runs in the page. `legacySnapshot` is a verbatim copy of the inline block it was moved out of (server/importer.ts, before this module), so the move is proven to change nothing. */
function legacySnapshot(maxHeight: number) {
  for (const el of document.querySelectorAll(
    'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe',
  ))
    el.remove()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]')) meta.remove()
  const executableUrlAttributes = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
  for (const el of document.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'ping') el.removeAttribute(attr.name)
      else if (executableUrlAttributes.has(name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }
  const sheets: string[] = []
  for (const l of document.querySelectorAll<HTMLLinkElement>('link')) {
    if (l.relList.contains('stylesheet') && l.href && !l.disabled && (!l.media || window.matchMedia(l.media).matches)) {
      sheets.push(l.href)
    }
    l.remove()
  }
  const baseUrl = document.baseURI
  for (const base of document.querySelectorAll('base')) base.remove()
  return {
    baseUrl,
    sheets,
    title: document.title,
    height: Math.min(Math.max(document.documentElement.scrollHeight, 400), maxHeight),
    html: document.documentElement.outerHTML,
  }
}

const HOSTILE = `<!doctype html><html><head><title>Pricing</title>
<meta http-equiv="refresh" content="3600;url=https://evil.test"><meta name="description" content="kept">
<base href="https://cdn.test/app/">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/print.css" media="print"><link rel="icon" href="/f.ico">
<script>window.__pwned = true</script><noscript><img src="https://t.test/p.gif"></noscript></head>
<body onload="steal()"><h1 onclick="steal()">Plans</h1>
<a href="javascript:steal()" id="js">x</a><a href="  JavaScript:steal()" id="js2">x</a><a href="/ok" ping="https://t.test/p">ok</a>
<form action="javascript:steal()"><button formaction="javascript:steal()">go</button></form>
<iframe src="https://evil.test"></iframe><iframe srcdoc="<script>steal()</script>"></iframe>
<object data="x.swf"></object><embed src="x.swf"><applet code="x"></applet><portal src="https://evil.test"></portal><fencedframe></fencedframe>
<img src="javascript:steal()" onerror="steal()"><svg onload="steal()"><a xlink:href="javascript:steal()"><text>t</text></a></svg>
<div style="height:3000px">tall</div></body></html>`

describe.skipIf(!findBrowserPath())('snapshotDocument in the headless shell', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await (await getBrowser()).close()
  })

  async function snapshot(fn: typeof snapshotDocument | typeof legacySnapshot, html: string) {
    const { page, close } = await openIsolatedPage()
    try {
      /* the hostile page loads nothing and runs nothing: only its DOM is under test */
      await page.setJavaScriptEnabled(false)
      await page.setRequestInterception(true)
      page.on('request', (request) => void request.abort().catch(() => {}))
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      return await page.evaluate(fn, 6000)
    } finally {
      await close()
    }
  }

  it('strips scripts, frames, handlers, srcdoc, ping and javascript: URLs from a hostile page', async () => {
    const snap = await snapshot(snapshotDocument, HOSTILE)
    for (const gone of [
      '<script',
      '<noscript',
      '<iframe',
      '<object',
      '<embed',
      '<applet',
      '<portal',
      '<fencedframe',
      '<link',
      '<base',
      'http-equiv',
      'onload',
      'onclick',
      'onerror',
      'srcdoc',
      'ping=',
      'formaction',
      'javascript:',
      'JavaScript:',
    ]) {
      expect(snap.html, gone).not.toContain(gone)
    }
    expect(snap.html).toContain('name="description"')
    expect(snap.html).toContain('<h1>Plans</h1>')
    expect(snap.title).toBe('Pricing')
    expect(snap.baseUrl).toBe('https://cdn.test/app/')
    expect(snap.sheets).toEqual(['https://cdn.test/site.css'])
    expect(snap.height).toBeGreaterThanOrEqual(3000)
  })

  it('produces exactly what the inline block in importer.ts did', async () => {
    for (const html of [
      HOSTILE,
      '<!doctype html><html><body><p>plain</p></body></html>',
      '<p onclick="x()">fragment',
    ]) {
      expect(await snapshot(snapshotDocument, html)).toEqual(await snapshot(legacySnapshot, html))
    }
  })

  it('caps the height and never reports less than 400', async () => {
    expect((await snapshot(snapshotDocument, '<body><div style="height:20000px"></div>')).height).toBe(6000)
    expect((await snapshot(snapshotDocument, '<body>x')).height).toBeGreaterThanOrEqual(400)
  })
})
