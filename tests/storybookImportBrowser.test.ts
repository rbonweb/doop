import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import { CAPTURE_PRELUDE, captureStory, STYLE_PROPERTIES } from '../shared/storybook/capture.ts'
import { MAX_PROBE_CHARS } from '../shared/storybook/probe.ts'
import { STORYBOOK_LIMITS } from '../shared/storybook/plan.ts'
import * as screenshot from '../server/screenshot.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { guardPublicPageRequests } from '../server/publicUrl.ts'
import {
  StorybookAccessError,
  StorybookBusyError,
  StorybookIndexError,
  storybookBundle,
  type StorybookImportDeps,
} from '../server/storybookImport.ts'

/* A tiny Storybook with no React and no build: an index.json, and an iframe.html whose script renders the story named by ?id=…&args=… and sets the body classes and __STORYBOOK_PREVIEW__ the way Storybook does. Its Button page is hostile on purpose (script, iframe, handlers, javascript: links, requests to hosts the import must never reach). */

/* every page an import opens is recorded, so the test can see what priority it asked for */
vi.mock('../server/screenshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/screenshot.ts')>()
  return { ...actual, openIsolatedPage: vi.fn(actual.openIsolatedPage) }
})

const ENTRIES = {
  'inputs-button--primary': { type: 'story', id: 'inputs-button--primary', name: 'Primary', title: 'Inputs/Button' },
  'inputs-button--large': { type: 'story', id: 'inputs-button--large', name: 'Large', title: 'Inputs/Button' },
  'inputs-button--docs': { type: 'docs', id: 'inputs-button--docs', name: 'Docs', title: 'Inputs/Button' },
  'data-badge--default': { type: 'story', id: 'data-badge--default', name: 'Default', title: 'Data/Badge' },
  'bad-story--default': { type: 'story', id: 'bad-story--default', name: 'Default', title: 'Bad/Story' },
}

function iframePage(leakUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Storybook</title>
<link rel="stylesheet" href="/sb/app.css">
<style>
:root { --brand: #00aa55; }
body { margin: 0; }
.btn { padding: 8px 16px; border: 0; border-radius: 6px; font: 14px Arial; }
.btn--primary { background: #00aa55; color: #fff; }
.btn--secondary { background: #eeeeee; color: #111111; }
.btn--danger { background: #cc0000; color: #fff; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.badge { display: inline-block; padding: 2px 8px; background: #ffe; }
.badge .dot { display: inline-block; width: 6px; height: 6px; background: red; }
.sb-show-main { padding: 1rem; }
.unused { color: pink; }
@media (min-width: 100px) { .btn { letter-spacing: 0.01em; } }
@keyframes unused-spin { to { transform: rotate(1turn); } }
</style></head>
<body class="sb-show-preparing-story"><div id="storybook-root"></div>
<script>
(function () {
  var params = new URLSearchParams(location.search)
  var id = params.get('id')
  var args = { tone: 'primary', label: 'Save', disabled: false, compact: false }
  var given = params.get('args')
  if (given) given.split(';').forEach(function (pair) {
    var at = pair.indexOf(':')
    var value = pair.slice(at + 1)
    args[pair.slice(0, at)] = value === '!true' ? true : value === '!false' ? false : value
  })
  var root = document.getElementById('storybook-root')
  var meta = { argTypes: {}, initialArgs: {} }
  if (id === 'inputs-button--primary' || id === 'inputs-button--large') {
    meta = {
      argTypes: {
        tone: { control: { type: 'select' }, options: ['primary', 'secondary', 'danger'], description: '<b>Look</b> of it' },
        disabled: { control: { type: 'boolean' } },
        label: { control: { type: 'text' } },
        onClick: { action: 'clicked' },
        __proto__: { control: 'text' },
        data: { control: { type: 'object' } },
      },
      initialArgs: { tone: 'primary', label: 'Save', disabled: false },
    }
    root.innerHTML = '<button class="btn btn--' + args.tone + '"' + (args.disabled ? ' disabled' : '') +
      ' onclick="steal()" data-doop-prop="evil" data-doop-id="x"><span class="btn__label" onmouseover="steal()">' + args.label + '</span>' +
      '<script>window.__pwned = 1<\\/script><style>.btn{color:red}</style><iframe src="https://example.invalid/frame"></iframe>' +
      '<a href="javascript:steal()">js</a><img src="${leakUrl}" alt=""><img src="https://example.invalid/pic.png" alt=""></button>'
  } else if (id === 'data-badge--default') {
    meta = { argTypes: { compact: { control: 'boolean' } }, initialArgs: { compact: false } }
    root.innerHTML = '<span class="badge">' + (args.compact ? '<i class="dot"></i>' : '') + 'NEW</span>'
  } else if (id === 'bad-story--default') {
    document.body.className = 'sb-show-errordisplay'
    return
  } else if (id === 'slow--default') {
    return
  } else if (id === 'huge--default') {
    var big = document.createElement('div')
    for (var i = 0; i < 30000; i++) { var d = document.createElement('div'); d.textContent = 'x'.repeat(100); big.appendChild(d) }
    root.appendChild(big)
    meta = { argTypes: {}, initialArgs: {} }
  } else { return }
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'completed', story: { id: id, argTypes: meta.argTypes, initialArgs: meta.initialArgs, component: { displayName: 'Button' } } } }
  document.body.className = 'sb-show-main'
})()
</script></body></html>`
}

/* A story page that fights back. Its script runs before anything of ours but after the probe, which has already captured the browser's own builtins: it replaces the ones the capture and the probe use (JSON.stringify, Object.keys, String.prototype.slice, the outerHTML and innerHTML getters, getComputedStyle, Function.prototype.call and more) and then hands out 50 MB of text, a 50 MB style rule and a preview object made of traps. */
function evilIframePage(id: string): string {
  const sabotage = `
    JSON.stringify = function () { return '"PWNED"' }
    Object.keys = function () { return [] }
    Object.getOwnPropertyDescriptor = function () { return undefined }
    Reflect.ownKeys = function () { return [] }
    Array.isArray = function () { return false }
    String.prototype.slice = function () { return 'PWNED' }
    Function.prototype.call = function () { return 'PWNED' }
    Object.prototype.toJSON = function () { return 'PWNED' }
    Array.prototype.toJSON = function () { return 'PWNED' }
    Object.defineProperty(Element.prototype, 'outerHTML', { configurable: true, get: function () { return 'PWNED' } })
    Object.defineProperty(Element.prototype, 'innerHTML', { configurable: true, get: function () { return 'PWNED' } })
    window.getComputedStyle = function () { return { getPropertyValue: function () { return 'PWNED' }, fontFamily: '', animationName: '' } }
    var big = 'x'.repeat(50 * 1024 * 1024)
  `
  const body =
    id === 'evil-big--default'
      ? `var d = document.createElement('div'); d.className = 'big'; d.textContent = big; root.appendChild(d)`
      : id === 'evil-rule--default'
        ? `var st = document.createElement('style'); st.textContent = '.small{content:"' + big + '"} .small{color:red}'; document.head.appendChild(st)
           root.innerHTML = '<span class="small">NEW</span>'`
        : `root.innerHTML = '<span class="badge">NEW</span>'`
  const preview =
    id === 'evil-meta--default'
      ? `
    var spin = function () { var end = Date.now() + 300; while (Date.now() < end) {} return ['a', 'b'] }
    var argTypes = {
      big: { control: 'text', description: big },
      tone: { control: 'select', options: ['a', 'b'] },
      flip: { get control() { return Math.random() > 0.5 ? 'text' : 'boolean' } },
      trap: new Proxy({}, { ownKeys: function () { throw new Error('no') }, get: function () { throw new Error('no') }, getOwnPropertyDescriptor: function () { throw new Error('no') } }),
      loop: new Proxy({}, { ownKeys: function () { spin(); return Array.from({ length: 2000000 }, function (_, i) { return 'k' + i }) } }),
      toj: { control: 'boolean', toJSON: function () { return 'PWNED' } },
    }
    story = { id: '${id}', argTypes: argTypes, initialArgs: { big: big, tone: 'a' }, component: { displayName: 'Evil' } }`
      : `story = { id: '${id}', argTypes: {}, initialArgs: {} }`
  return `<!doctype html><html><head><meta charset="utf-8"></head><body class="sb-show-preparing-story"><div id="storybook-root"></div><script>
(function () {
  ${sabotage}
  var root = document.getElementById('storybook-root')
  var story
  ${preview}
  ${body}
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'completed', story: story } }
  document.body.className = 'sb-show-main'
})()
</script></body></html>`
}

interface Fake {
  origin: string
  server: Server
  requests: { url: string; cookie?: string; authorization?: string }[]
  extra: Record<string, unknown>
  close: () => Promise<void>
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server))
  })
}

const originOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

let storybook: Fake
let leak: Server
let leakHits = 0
let guardedRequests: string[] = []

function deps(allow: string): StorybookImportDeps {
  guardedRequests = []
  return {
    fetchUrl: (raw, init) => fetch(raw, init as RequestInit),
    parseUrl: (raw) => new URL(raw),
    guard: {
      allowUrl: (url) => url.origin === allow,
      /* what the guard would fetch over the network for any other public URL: nothing leaves, the test records it */
      fetchUrl: async (raw) => {
        guardedRequests.push(String(raw))
        return new Response('', { status: 404 })
      },
    },
  }
}

beforeAll(async () => {
  leak = await listen((_req, res) => {
    leakHits++
    res.end('x')
  })
  const requests: Fake['requests'] = []
  const extra: Record<string, unknown> = {}
  const server = await listen((req, res) => {
    const url = req.url ?? ''
    requests.push({ url, cookie: req.headers.cookie, authorization: req.headers.authorization })
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers })
      res.end(body)
    }
    if (url === '/sb/index.json') return send(200, 'application/json', JSON.stringify({ v: 5, entries: ENTRIES }))
    if (url === '/sb/iframe.html' || url.startsWith('/sb/iframe.html?')) {
      const id = new URL(url, 'http://x').searchParams.get('id') ?? ''
      if (id === 'locked--default') return send(403, 'text/plain', 'no')
      return send(200, 'text/html', iframePage(`${originOf(leak)}/leak.png`))
    }
    if (url === '/sb/app.css') return send(200, 'text/css', '.btn{box-sizing:border-box}')
    if (url === '/private/index.json') return send(401, 'text/plain', 'sign in')
    if (url === '/redirect/index.json')
      return send(302, 'text/plain', '', { location: '/login?next=/redirect/index.json' })
    if (url === '/away/index.json')
      return send(302, 'text/plain', '', { location: 'https://elsewhere.test/index.json' })
    if (url === '/html/index.json') return send(200, 'text/html', '<html>Please sign in</html>')
    if (url === '/lockedframe/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: { 'locked--default': { type: 'story', id: 'locked--default', name: 'Default', title: 'Locked' } },
        }),
      )
    }
    if (url === '/loginframe/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: { 'x--default': { type: 'story', id: 'x--default', name: 'Default', title: 'X' } },
        }),
      )
    }
    if (url.startsWith('/loginframe/iframe.html')) return send(302, 'text/plain', '', { location: '/loginframe/login' })
    if (url === '/loginframe/login') return send(200, 'text/html', '<html>sign in</html>')
    if (url === '/lockedframe/iframe.html' || url.startsWith('/lockedframe/iframe.html?'))
      return send(403, 'text/plain', 'no')
    if (url === '/slow/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: {
            ...ENTRIES,
            'slow--default': { type: 'story', id: 'slow--default', name: 'Default', title: 'Slow' },
          },
        }),
      )
    }
    if (url === '/evil/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: Object.fromEntries(
            ['big', 'rule', 'meta'].map((name) => [
              `evil-${name}--default`,
              {
                type: 'story',
                id: `evil-${name}--default`,
                name: 'Default',
                title: `Evil/${name[0]!.toUpperCase()}${name.slice(1)}`,
              },
            ]),
          ),
        }),
      )
    }
    if (url.startsWith('/evil/iframe.html')) {
      return send(200, 'text/html', evilIframePage(new URL(url, 'http://x').searchParams.get('id') ?? ''))
    }
    if (url === '/huge/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: { 'huge--default': { type: 'story', id: 'huge--default', name: 'Default', title: 'Huge' } },
        }),
      )
    }
    if (
      url === '/slow/iframe.html' ||
      url.startsWith('/slow/iframe.html?') ||
      url === '/huge/iframe.html' ||
      url.startsWith('/huge/iframe.html?')
    ) {
      return send(200, 'text/html', iframePage(`${originOf(leak)}/leak.png`))
    }
    return send(404, 'text/plain', 'not found')
  })
  storybook = {
    origin: originOf(server),
    server,
    requests,
    extra,
    close: () => new Promise((done) => server.close(() => done())),
  }
})

afterAll(async () => {
  await storybook?.close()
  await new Promise((done) => leak?.close(() => done(undefined)))
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe.skipIf(!findBrowserPath())('Storybook import in the hardened renderer', { timeout: 120_000 }, () => {
  it('opens every page as a background render, so an import never starves an interactive one', async () => {
    const opened = vi.mocked(screenshot.openIsolatedPage)
    opened.mockClear()
    await storybookBundle(`${storybook.origin}/sb/`, { include: ['data'] }, deps(storybook.origin))
    expect(opened.mock.calls.length).toBeGreaterThan(1)
    for (const call of opened.mock.calls) expect(call[0]).toEqual({ priority: 'background' })
  })

  it('turns a fake Storybook into a valid bundle and keeps every request inside its origin', async () => {
    const result = await storybookBundle(`${storybook.origin}/sb/`, { package: '@acme/ui' }, deps(storybook.origin))
    const { bundle, issues } = result
    expect(componentBundleSchema.safeParse(bundle).success).toBe(true)
    expect(bundle.source).toEqual({ kind: 'storybook', url: `${storybook.origin}/sb/` })
    expect(bundle.package).toBe('@acme/ui')
    expect(bundle.components.map((component) => component.name)).toEqual(['Button', 'Badge'])

    const button = bundle.components[0]!
    for (const gone of [
      '<script',
      '<iframe',
      '<style',
      'onclick',
      'onmouseover',
      'javascript:',
      'steal',
      'data-doop-id',
      '"evil"',
    ]) {
      expect(button.html, gone).not.toContain(gone)
    }
    expect(button.html).toContain('class="btn btn--primary"')
    expect(button.html).toContain('<span class="btn__label" data-doop-prop="label">Save</span>')
    expect(button.group).toBe('Inputs/Button')
    expect(button.props?.map((prop) => [prop.name, prop.type])).toEqual([
      ['tone', 'enum'],
      ['disabled', 'boolean'],
      ['label', 'text'],
    ])
    expect(button.props?.[0]).toMatchObject({
      options: ['primary', 'secondary', 'danger'],
      default: 'primary',
      description: 'Look of it',
    })
    expect(button.props?.[1]).toMatchObject({ reflect: true, default: 'false' })
    expect(button.css).toContain('.btn')
    expect(button.css).not.toContain('.sb-show-main')
    expect(button.css).not.toContain('.unused')
    expect(button.css).not.toContain('unused-spin')
    expect(button.css).toContain('letter-spacing')
    expect(button.variants?.tone?.secondary?.css).toContain('background-color: rgb(238, 238, 238)')
    expect(button.variants?.tone?.danger?.css).toContain('rgb(204, 0, 0)')
    expect(button.variants?.disabled?.true?.css).toContain('opacity: 0.5')
    expect(button.variants?.tone?.secondary?.html).toBeUndefined()
    expect(button.code).toEqual({
      exportName: 'Button',
      origin: {
        kind: 'storybook',
        storyId: 'inputs-button--primary',
        url: `${storybook.origin}/sb/iframe.html?id=inputs-button--primary&viewMode=story`,
      },
    })

    const badge = bundle.components[1]!
    expect(badge.variants?.compact?.true?.html).toContain('class="dot"')
    expect(badge.variants?.compact?.true?.css).toBeDefined()
    expect(badge.html).toContain('class="badge"')

    expect(bundle.css).toContain('--brand')
    expect(bundle.css).toContain('margin: 0')
    expect(issues).toContainEqual(expect.objectContaining({ component: 'Story', code: 'story_failed' }))
    expect(issues.some((issue) => issue.code === 'argtypes_dropped' && issue.component === 'Button')).toBe(true)
    expect(result.renders).toBeGreaterThan(5)

    /* nothing left the Storybook's origin, and no credentials went with the requests */
    expect(leakHits).toBe(0)
    expect(new Set(guardedRequests)).toEqual(
      new Set(['https://example.invalid/pic.png', 'https://example.invalid/frame']),
    )
    expect(
      storybook.requests.every((request) => request.cookie === undefined && request.authorization === undefined),
    ).toBe(true)
    expect(storybook.requests.every((request) => /^\/sb\//.test(request.url))).toBe(true)
  })

  it('imports only the titles asked for', async () => {
    const { bundle } = await storybookBundle(
      `${storybook.origin}/sb/index.html`,
      { include: ['data'] },
      deps(storybook.origin),
    )
    expect(bundle.components.map((component) => component.name)).toEqual(['Badge'])
  })

  it('leaves a story that never renders out after its 20 second limit, and keeps the rest', async () => {
    const started = Date.now()
    const { bundle, issues } = await storybookBundle(
      `${storybook.origin}/slow/`,
      { include: ['Slow', 'Data'] },
      deps(storybook.origin),
    )
    expect(bundle.components.map((component) => component.name)).toEqual(['Badge'])
    expect(issues.find((issue) => issue.component === 'Slow')?.code).toBe('story_failed')
    expect(Date.now() - started).toBeLessThan(STORYBOOK_LIMITS.renderMs + 6_000)
    /* the per-step timers are cleared, not left to run out */
    expect(process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length).toBeLessThan(10)
  })

  it('refuses a story with too many elements', async () => {
    await expect(storybookBundle(`${storybook.origin}/huge/`, {}, deps(storybook.origin))).rejects.toThrow(
      'too many elements',
    )
  })

  it('survives a page that replaces every builtin and hands out 50 MB of everything, and receives no more than the cap', async () => {
    const seen: { step: string; bytes: number }[] = []
    const started = Date.now()
    const result = await storybookBundle(
      `${storybook.origin}/evil/`,
      {},
      {
        ...deps(storybook.origin),
        observe: (event) => seen.push(event),
      },
    )
    expect(Date.now() - started).toBeLessThan(STORYBOOK_LIMITS.renderMs * 3)
    const { bundle, issues } = result

    /* 50 MB of text: refused by the capture, in the page, with a small answer */
    expect(issues).toContainEqual(
      expect.objectContaining({
        component: 'Big',
        code: 'story_failed',
        message: expect.stringContaining('too large'),
      }),
    )
    expect(bundle.components.map((component) => component.name)).toEqual(['Rule', 'Meta'])

    /* a 50 MB style rule is left out, and said so; the small rule beside it stays */
    const rule = bundle.components[0]!
    expect(rule.css).toBe('.small { color: red; }')
    expect(issues).toContainEqual(expect.objectContaining({ component: 'Rule', code: 'css_rules_oversize' }))

    /* the capture came from an isolated world: not "PWNED", not the replaced getters' answers */
    const meta = bundle.components[1]!
    expect(meta.html).toBe('<span class="badge">NEW</span>')
    expect(JSON.stringify(bundle)).not.toContain('PWNED')

    /* the preview was read by the probe: primitives only, bounded, and the traps and getters did nothing */
    expect(meta.props?.map((prop) => prop.name).sort()).toEqual(['big', 'toj', 'tone'])
    expect(meta.props?.find((prop) => prop.name === 'big')?.description).toHaveLength(300)
    expect(meta.props?.find((prop) => prop.name === 'tone')).toMatchObject({
      type: 'enum',
      options: ['a', 'b'],
      default: 'a',
    })
    expect(meta.code?.exportName).toBe('Evil')

    /* nothing the page sent back was bigger than the caps: 2 MB a capture, the probe's cap for the preview */
    const captures = seen.filter((event) => event.step === 'capture')
    const metas = seen.filter((event) => event.step === 'meta')
    expect(captures.length).toBeGreaterThan(2)
    expect(metas.length).toBe(3)
    for (const event of captures) expect(event.bytes).toBeLessThanOrEqual(STORYBOOK_LIMITS.captureBytes)
    /* a refusal is an object, and it is measured as its JSON, not as nothing */
    expect(captures.some((event) => event.bytes > 20 && event.bytes < 300)).toBe(true)
    for (const event of metas) expect(event.bytes).toBeLessThanOrEqual(MAX_PROBE_CHARS + 1024)
  })

  it('captures a normal story byte for byte the same in the isolated world as in the page’s own world', async () => {
    const { page, close } = await screenshot.openIsolatedPage()
    try {
      await guardPublicPageRequests(page, deps(storybook.origin).guard)
      await page.goto(`${storybook.origin}/sb/iframe.html?id=inputs-button--primary&viewMode=story`)
      await page.waitForFunction("document.body.classList.contains('sb-show-main')")
      const options = {
        textArgs: [{ prop: 'label', value: 'Save' }],
        styleProperties: STYLE_PROPERTIES,
        maxBytes: STORYBOOK_LIMITS.captureBytes,
        maxElements: 300,
      }
      const world = (
        page.mainFrame() as unknown as { isolatedRealm(): { evaluate(...args: unknown[]): Promise<unknown> } }
      ).isolatedRealm()
      await page.evaluate(CAPTURE_PRELUDE)
      await world.evaluate(CAPTURE_PRELUDE)
      const own = await page.evaluate(captureStory, options)
      const isolated = await world.evaluate(captureStory, options)
      expect(typeof isolated).toBe('string')
      expect(isolated).toBe(own)
      expect(JSON.parse(isolated as string).html).toContain('data-doop-prop="label"')
    } finally {
      await close()
    }
  })

  it('refuses a story whose capture is over 2 MB', async () => {
    const { bundle, issues } = await storybookBundle(
      `${storybook.origin}/evil/`,
      { include: ['Evil/Rule'] },
      deps(storybook.origin),
    )
    expect(bundle.components).toHaveLength(1)
    expect(issues.some((issue) => issue.code === 'css_rules_oversize')).toBe(true)
    await expect(
      storybookBundle(`${storybook.origin}/evil/`, { include: ['Evil/Big'] }, deps(storybook.origin)),
    ).rejects.toThrow('too large')
  })

  it('refuses a Storybook that answers 401, one that redirects to sign-in or away, and one that is not a Storybook', async () => {
    await expect(storybookBundle(`${storybook.origin}/private/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookAccessError,
    )
    await expect(storybookBundle(`${storybook.origin}/redirect/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookAccessError,
    )
    /* another address is a redirect to follow by hand, not a sign-in */
    const away = await storybookBundle(`${storybook.origin}/away/`, {}, deps(storybook.origin)).catch(
      (error: unknown) => error,
    )
    expect(away).toBeInstanceOf(StorybookIndexError)
    expect(away).not.toBeInstanceOf(StorybookAccessError)
    expect((away as Error).message).toContain('redirects to another address (https://elsewhere.test)')
    await expect(storybookBundle(`${storybook.origin}/html/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookIndexError,
    )
    await expect(storybookBundle(`${storybook.origin}/nothing/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookIndexError,
    )
  })

  it('stops the whole import when a story page redirects to a sign-in path', async () => {
    await expect(storybookBundle(`${storybook.origin}/loginframe/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookAccessError,
    )
  })

  it('notices a signal that is already aborted, and gives the slot back', async () => {
    const indexFetches = () => storybook.requests.filter((request) => request.url === '/sb/index.json').length
    const before = indexFetches()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before it began'))
    await expect(
      storybookBundle(`${storybook.origin}/sb/`, { signal: controller.signal }, deps(storybook.origin)),
    ).rejects.toThrow('cancelled before it began')
    expect(indexFetches()).toBe(before)
  })

  it('stops the whole import when a story page answers 403', async () => {
    await expect(
      storybookBundle(`${storybook.origin}/lockedframe/`, {}, deps(storybook.origin)),
    ).rejects.toBeInstanceOf(StorybookAccessError)
  })

  it('refuses a private address with the real URL rules', async () => {
    await expect(storybookBundle(`${storybook.origin}/sb/`)).rejects.toThrow('not reachable')
    await expect(storybookBundle('http://localhost:6006/')).rejects.toThrow('not reachable')
    await expect(storybookBundle('http://169.254.169.254/')).rejects.toThrow('not reachable')
    await expect(storybookBundle('file:///etc/passwd')).rejects.toThrow('http(s)')
    await expect(storybookBundle('https://user:pw@example.com/')).rejects.toThrow('credentials')
  })

  it('runs at most 3 imports at once and tells the 4th when to retry', async () => {
    const controller = new AbortController()
    const hanging: StorybookImportDeps = {
      parseUrl: (raw) => new URL(raw),
      fetchUrl: (_raw, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
        ),
    }
    const three = [1, 2, 3].map((n) =>
      storybookBundle(`https://sb${n}.example.test/`, { signal: controller.signal }, hanging).catch(
        (error: unknown) => error,
      ),
    )
    await expect(storybookBundle('https://sb4.example.test/', {}, hanging)).rejects.toBeInstanceOf(StorybookBusyError)
    controller.abort(new Error('stop'))
    for (const outcome of await Promise.all(three)) expect(outcome).not.toBeInstanceOf(StorybookBusyError)
    /* the slots are back */
    await expect(storybookBundle(`${storybook.origin}/private/`, {}, deps(storybook.origin))).rejects.toBeInstanceOf(
      StorybookAccessError,
    )
  })
})
