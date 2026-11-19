import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import { CAPTURE_PRELUDE, captureStory, STYLE_PROPERTIES } from '../shared/storybook/capture.ts'
import { MAX_PROBE_CHARS } from '../shared/storybook/probe.ts'
import { STORYBOOK_LIMITS } from '../shared/storybook/plan.ts'
import { prepareComponent } from '../server/bundleVariants.ts'
import { failedBeforeRendering } from '../server/storybookImportRun.ts'
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

/* The phases a story's render goes through, per Storybook major (read from each version's preview runtime): 7 ends on completed, 8 and 9 on completed or afterEach, 10 on finished. A story that errors ends on errored (and in 10 moves on to finished with the error display still up). */
const PHASES: Record<string, { sequence: string[]; errorDisplay?: boolean }> = {
  'phases-v7--default': { sequence: ['preparing', 'loading', 'rendering', 'playing', 'played', 'completed'] },
  'phases-v8--default': { sequence: ['preparing', 'loading', 'rendering', 'completing', 'completed'] },
  'phases-v9--default': { sequence: ['preparing', 'loading', 'rendering', 'completing', 'completed', 'afterEach'] },
  'phases-v10--default': {
    sequence: ['preparing', 'loading', 'rendering', 'completing', 'completed', 'afterEach', 'finished'],
  },
  'phases-broken--default': { sequence: ['preparing', 'loading', 'rendering', 'errored'] },
  /* Grafana's stories register a mock service worker, which the hardened page may not start: Storybook shows that as an error display */
  'phases-msw--default': { sequence: ['preparing', 'loading', 'rendering', 'errored'], errorDisplay: true },
  'phases-broken10--default': {
    sequence: ['preparing', 'loading', 'rendering', 'errored', 'finished'],
    errorDisplay: true,
  },
}

/* walks the phases faster than the probe polls (50 ms), so a probe that only knew the middle phases would miss them, as it did on a real Storybook 10 */
function phasesPage(id: string): string {
  const plan = PHASES[id]
  return `<!doctype html><html><body class="sb-show-preparing-story"><div id="storybook-root"></div><script>
(function () {
  var sequence = ${JSON.stringify(plan?.sequence ?? [])}
  var id = ${JSON.stringify(id)}
  var render = { phase: sequence[0], story: { id: id, argTypes: {}, initialArgs: {}, component: { displayName: 'Phased' } } }
  window.__STORYBOOK_PREVIEW__ = { currentRender: render }
  document.getElementById('storybook-root').innerHTML = id === 'phases-msw--default'
    ? '<pre>[MSW] Failed to register the Service Worker:\\n\\nThe component failed to render properly</pre>'
    : '<button class="btn">Go</button>'
  var step = 0
  var timer = setInterval(function () {
    step++
    if (step >= sequence.length) return clearInterval(timer)
    render.phase = sequence[step]
    if (sequence[step] === 'errored' && ${JSON.stringify(plan?.errorDisplay ?? false)}) document.body.className = 'sb-show-errordisplay'
  }, 4)
  if (sequence[sequence.length - 1] !== 'errored' && !${JSON.stringify(plan?.errorDisplay ?? false)}) document.body.className = 'sb-show-main'
})()
</script></body></html>`
}

/* Primer's shape: the component sits inside theme wrappers, marks itself with data-component, and takes its variant from an attribute its own CSS styles. The wrapper carries no variant. */
function wrappedPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
[data-component="Label"] { padding: 2px 8px; border: 1px solid #999; }
[data-component="Label"][data-variant="danger"] { color: #c00; border-color: #c00; }
</style></head><body class="sb-show-preparing-story"><div id="storybook-root"></div><script>
(function () {
  var args = { variant: 'default', label: 'Label' }
  /* like Primer's Storybook: the args in the URL are ignored (their argTypes have no type name), only the channel's updateStoryArgs changes the story */
  var listeners = {}
  var channel = {
    on: function (event, listener) { (listeners[event] = listeners[event] || []).push(listener) },
    emit: function (event, payload) {
      if (event !== 'updateStoryArgs') return
      Object.assign(args, payload.updatedArgs)
      setTimeout(function () { draw(); (listeners.storyRendered || []).forEach(function (listener) { listener() }) }, 20)
    },
  }
  function draw() {
    document.getElementById('storybook-root').innerHTML =
      '<div data-component="ThemeProvider" data-color-mode="light"><div data-portal-root="true">' +
      '<span data-component="Label" data-variant="' + args.variant + '" class="prc-Label-x7Gq">' + args.label + '</span></div></div>'
  }
  draw()
  window.__STORYBOOK_PREVIEW__ = { channel: channel, currentRender: { phase: 'finished', story: { id: 'wrap-label--default',
    argTypes: { variant: { control: 'select', options: ['default', 'danger'] }, label: { control: 'text' } },
    initialArgs: { variant: 'default', label: 'Label' } } } }
  document.body.className = 'sb-show-main'
})()
</script></body></html>`
}

/* Primer's Button: colours are custom properties on a theme wrapper (`[data-color-mode]`), the variant is an attribute on the button that rules keyed on the class style, and an icon adds a child and drops `data-no-visuals`, so that render is a different tree. */
function themedPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
[data-color-mode="light"] { --btn-primary-bg: #116329; --btn-primary-fg: #ffffff; }
.btn { background-color: transparent; color: #222222; border: 0; padding: 4px 8px; }
.btn:where([data-variant="primary"]) { background-color: var(--btn-primary-bg, #1f883d); color: var(--btn-primary-fg, #fff); }
.btn:where([data-no-visuals]) { padding: 8px; }
.btn :where(.visual) { color: #59636e; fill: currentColor; }
.btn:where([data-variant="primary"]) .visual { color: var(--btn-primary-fg, #fff); }
</style></head><body class="sb-show-preparing-story"><div id="storybook-root"></div><script>
(function () {
  var args = { variant: 'default', icon: 'none' }
  var listeners = {}
  var channel = {
    on: function (event, listener) { (listeners[event] = listeners[event] || []).push(listener) },
    emit: function (event, payload) {
      if (event !== 'updateStoryArgs') return
      Object.assign(args, payload.updatedArgs)
      setTimeout(function () { draw(); (listeners.storyRendered || []).forEach(function (listener) { listener() }) }, 20)
    },
  }
  function draw() {
    var eye = args.icon === 'eye'
    document.getElementById('storybook-root').innerHTML =
      '<div data-component="ThemeProvider" data-color-mode="light"><button data-component="Button" class="btn"' +
      (eye ? '' : ' data-no-visuals="true"') + ' data-variant="' + args.variant + '">' +
      (eye ? '<svg class="visual" width="8" height="8"></svg>' : '') + '<span>Go</span></button></div>'
  }
  draw()
  window.__STORYBOOK_PREVIEW__ = { channel: channel, currentRender: { phase: 'finished', story: { id: 'themed-button--default',
    argTypes: { variant: { control: 'select', options: ['default', 'primary'] }, icon: { control: 'select', options: ['none', 'eye'] } },
    initialArgs: { variant: 'default', icon: 'none' } } } }
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
    if (url === '/phases/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: Object.fromEntries(
            Object.keys(PHASES).map((id) => [
              id,
              {
                type: 'story',
                id,
                name: 'Default',
                title: `Phases/${id.slice(7, -9).replace(/^./, (c) => c.toUpperCase())}`,
              },
            ]),
          ),
        }),
      )
    }
    if (url.startsWith('/phases/iframe.html')) {
      return send(200, 'text/html', phasesPage(new URL(url, 'http://x').searchParams.get('id') ?? ''))
    }
    if (url === '/wrap/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: {
            'wrap-label--default': { type: 'story', id: 'wrap-label--default', name: 'Default', title: 'Wrap/Label' },
          },
        }),
      )
    }
    if (url.startsWith('/wrap/iframe.html')) return send(200, 'text/html', wrappedPage())
    if (url === '/themed/index.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          v: 5,
          entries: {
            'themed-button--default': {
              type: 'story',
              id: 'themed-button--default',
              name: 'Default',
              title: 'Themed/Button',
            },
          },
        }),
      )
    }
    if (url.startsWith('/themed/iframe.html')) return send(200, 'text/html', themedPage())
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
    /* the disabled attribute follows the prop, so the prop is bound to the button and the library's own :disabled rule styles it */
    expect(button.props?.[1]).toMatchObject({ default: 'false' })
    expect(button.props?.[1]?.reflect).toBeUndefined()
    expect(button.html).toMatch(/<button[^>]* data-doop-prop="disabled:disabled"/)
    expect(button.css).toContain(':disabled')
    expect(button.css).toContain('.btn')
    expect(button.css).not.toContain('.sb-show-main')
    expect(button.css).not.toContain('.unused')
    expect(button.css).not.toContain('unused-spin')
    expect(button.css).toContain('letter-spacing')
    expect(button.variants?.tone?.secondary?.css).toContain('background-color: rgb(238, 238, 238)')
    expect(button.variants?.tone?.danger?.css).toContain('rgb(204, 0, 0)')
    expect(button.variants?.disabled).toBeUndefined()
    expect(button.html).not.toContain('data-doop-m-')
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
    /* the text props were read too, and left out because nothing in the markup follows them */
    expect(meta.props?.map((prop) => prop.name)).toEqual(['tone'])
    const unbound = issues.find((issue) => issue.component === 'Meta' && issue.code === 'props_unbound')
    expect(unbound?.message).toContain('big')
    expect(unbound?.message).toContain('toj')
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

  it('knows when a story is done in every Storybook version, and skips the ones that error', async () => {
    const started = Date.now()
    const { bundle, issues } = await storybookBundle(`${storybook.origin}/phases/`, {}, deps(storybook.origin))
    /* each of the four versions' sequences ends on a phase that counts as done, none waits out the render timeout */
    expect(bundle.components.map((component) => component.name).sort()).toEqual(['V10', 'V7', 'V8', 'V9'])
    expect(Date.now() - started).toBeLessThan(STORYBOOK_LIMITS.renderMs)
    const failed = issues
      .filter((issue) => issue.code === 'story_failed' || issue.code === 'story_needs_worker')
      .map((issue) => issue.component)
    expect(issues.find((issue) => issue.component === 'Msw')?.code).toBe('story_needs_worker')
    expect(failed.sort()).toEqual(['Broken', 'Broken10', 'Msw'])
    expect(issues.find((issue) => issue.component === 'Msw')?.message).toContain('needs a service worker')
    expect(issues.find((issue) => issue.component === 'Broken')?.message).toContain(
      'Storybook shows an error for this story',
    )
  })

  it('binds a prop to the element whose attribute follows it, not to the decorator around it', async () => {
    const { bundle, issues } = await storybookBundle(`${storybook.origin}/wrap/`, {}, deps(storybook.origin))
    const [label] = bundle.components
    expect(label?.name).toBe('Label')
    /* the attribute that changes is on the span: the prop is bound there, next to the text binding the span already had */
    expect(label?.html).toMatch(/<span[^>]* data-doop-prop="label,data-variant:variant"/)
    expect(label?.html).not.toMatch(/<div[^>]*data-doop-prop/)
    expect(label?.html).not.toContain('data-doop-m-')
    /* the library's own rule for the value comes along, and no CSS diff stands in for it */
    expect(label?.css).toContain('[data-variant="danger"]')
    expect(label?.variants?.variant).toBeUndefined()
    expect(label?.props?.find((prop) => prop.name === 'variant')).toMatchObject({ type: 'enum', default: 'default' })
    /* a class token is never a prop, and the code mapping names only props there are */
    expect(label?.props?.map((prop) => prop.name).sort()).toEqual(['label', 'variant'])
    expect(label?.code?.props).toBeUndefined()
    expect(issues.filter((issue) => issue.code === 'story_failed')).toEqual([])
  })

  it('keeps the library variant look when an icon makes the render a different tree', async () => {
    const { bundle } = await storybookBundle(`${storybook.origin}/themed/`, {}, deps(storybook.origin))
    const button = bundle.components[0]!
    expect(button.name).toBe('Button')
    /* the other tree's stylesheet carries only what the default's does not, or its scoped copy of the base rule outranks the variant rule */
    const withIcon = button.variants?.icon?.eye
    expect(withIcon?.html).toContain('<svg')
    expect(withIcon?.css ?? '').not.toContain('background-color: transparent')
    const prepared = prepareComponent(button, bundle.css ?? '')
    const page = await (await getBrowser()).newPage()
    try {
      for (const icon of ['none', 'eye']) {
        await page.setContent(`<!doctype html><style>${prepared.css}</style>${prepared.html}`)
        const background = await page.evaluate(
          (chosen, base) => {
            /* an instance: the enum is reflected on the root, a condition shows or hides its element, the bound attribute follows the prop */
            const root = document.body.firstElementChild!
            root.setAttribute('data-icon', chosen)
            for (const el of Array.from(document.querySelectorAll('[data-doop-if]'))) {
              const [name = '', value = ''] = (el.getAttribute('data-doop-if') ?? '').split(/!?=/)
              const negated = (el.getAttribute('data-doop-if') ?? '').includes('!=')
              if (name === 'icon' && (value === chosen) === negated) el.remove()
            }
            const target = document.querySelector('[data-component="Button"]')!
            target.setAttribute('data-variant', 'primary')
            return base + getComputedStyle(target).backgroundColor
          },
          icon,
          `${icon}:`,
        )
        expect(background).toBe(`${icon}:rgb(17, 99, 41)`)
      }
    } finally {
      await page.close()
    }
  })

  it('keeps the library rule that colours an icon for a variant no render shows with an icon', async () => {
    const { bundle } = await storybookBundle(`${storybook.origin}/themed/`, {}, deps(storybook.origin))
    const button = bundle.components[0]!
    /* the rule needs the primary variant and the icon, and no render has both: the default has no icon, the icon render is the default variant */
    const rule = '[data-variant="primary"]) .visual'
    expect(
      [button.css, ...Object.values(button.variants?.icon ?? {}).map((variant) => variant.css)].join('\n'),
    ).toContain(rule)
    const prepared = prepareComponent(button, bundle.css ?? '')
    const page = await (await getBrowser()).newPage()
    try {
      await page.setContent(`<!doctype html><style>${prepared.css}</style>${prepared.html}`)
      const look = await page.evaluate(() => {
        /* an instance with variant=primary and icon=eye */
        const root = document.body.firstElementChild!
        root.setAttribute('data-icon', 'eye')
        for (const el of Array.from(document.querySelectorAll('[data-doop-if]'))) {
          const condition = el.getAttribute('data-doop-if') ?? ''
          const [name = '', value = ''] = condition.split(/!?=/)
          if (name === 'icon' && (value === 'eye') === condition.includes('!=')) el.remove()
        }
        const button = document.querySelector('[data-component="Button"]')!
        button.setAttribute('data-variant', 'primary')
        const icon = button.querySelector('svg')!
        const channel = (value: number) => {
          const unit = value / 255
          return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
        }
        const luminance = (colour: string) => {
          const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number)
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        /* fill is currentColor in the fixture, and Chrome reports it resolved */
        const fill = getComputedStyle(icon).fill
        const resolved = fill.startsWith('rgb') ? fill : getComputedStyle(icon).color
        const background = getComputedStyle(button).backgroundColor
        const [light, dark] = [luminance(resolved), luminance(background)].sort((a, b) => b - a)
        return { fill: resolved, background, contrast: (light! + 0.05) / (dark! + 0.05) }
      })
      expect(look.background).toBe('rgb(17, 99, 41)')
      expect(look.fill).toBe('rgb(255, 255, 255)')
      expect(look.contrast).toBeGreaterThan(3)
    } finally {
      await page.close()
    }
  })

  it('keeps rules for another value of a state, written in any shape, and none that need only an identity attribute', async () => {
    const page = await (await getBrowser()).newPage()
    try {
      /* a lone component (one data-component value) whose state is data-variant; the rules are the shapes a library writes */
      await page.setContent(`<!doctype html><style>
.btn { color: black; }
.btn:where([data-variant="primary"]) .vis { color: white; }
[data-variant="primary"] > .vis { fill: white; }
.btn > [data-variant="primary"] { outline-width: 2px; }
.btn[DATA-VARIANT="primary"] .vis { stroke: white; }
.btn:where([data-variant="primary"], [data-variant="danger"]) .vis { opacity: 0.9; }
[data-variant="primary"] { margin-left: 1px; }
.btn:where([data-component="IconButton"]) .vis { margin-top: 2px; }
[data-testid="other"] .vis { margin-right: 3px; }
[data-color-mode="dark"] .vis { margin-bottom: 4px; }
.other .vis { padding-top: 5px; }
</style><div id="storybook-root"><span class="btn" data-component="Button" data-variant="default" data-testid="one"><i class="vis"></i></span></div>`)
      await page.evaluate(CAPTURE_PRELUDE)
      const options = {
        textArgs: [],
        styleProperties: STYLE_PROPERTIES,
        maxBytes: STORYBOOK_LIMITS.captureBytes,
        maxElements: 300,
      }
      const shot = JSON.parse((await page.evaluate(captureStory, options)) as string) as { ok: boolean; css: string }
      expect(shot.ok).toBe(true)
      /* the state is taken away to ask whether the rule could reach: a compound, a descendant, a list, a case-insensitive name and a leading or trailing combinator all stay valid */
      expect(shot.css).toContain('.btn:where([data-variant="primary"]) .vis')
      expect(shot.css).toContain('[data-variant="primary"] > .vis')
      expect(shot.css).toContain('.btn > [data-variant="primary"]')
      expect(shot.css).toMatch(/\.btn\[data-variant="primary"\] \.vis/i)
      expect(shot.css).toContain('[data-variant="danger"]')
      /* a rule made only of state would match every element, and one on an identity attribute or another class is not the component's */
      expect(shot.css).not.toContain('margin-left')
      expect(shot.css).not.toContain('IconButton')
      expect(shot.css).not.toContain('data-testid="other"')
      expect(shot.css).not.toContain('data-color-mode')
      expect(shot.css).not.toContain('.other')
    } finally {
      await page.close()
    }
  })

  it('flattens cascade layers into true cascade order, keeps the theme and the registered properties, and the utilities beat the reset', async () => {
    const page = await (await getBrowser()).newPage()
    const bare = await (await getBrowser()).newPage()
    try {
      /* the shape of a Tailwind v4 stylesheet: the layer statement, a theme on :root,:host, a reset in base, utilities, @property registrations and the @layer properties fallback that Chromium does not apply */
      await page.setContent(`<!doctype html>
<style>
@layer theme, base, components, utilities;
@layer theme{:root,:host{--spacing:.25rem;--text-sm:.875rem;--text-sm--line-height:calc(1.25/.875);--font-weight-medium:500;--default-font-family:"Inter",sans-serif}}
@layer base{*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}html,:host{font-family:var(--default-font-family,sans-serif);line-height:1.5}}
@layer utilities{
.inline-flex{display:inline-flex}
.px-4{padding-inline:calc(var(--spacing)*4)}
.border{border-style:var(--tw-border-style);border-width:1px}
.text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}
.font-medium{--tw-font-weight:var(--font-weight-medium);font-weight:var(--font-weight-medium)}
}
@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}
@property --tw-unused{syntax:"*";inherits:false;initial-value:7}
@property --tw-leading{syntax:"*";inherits:false}
@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-border-style:solid}}}
</style>
<style>
@layer components{.btn{padding:1px;margin-left:9px}}
@media (min-width: 1px){@layer utilities{.py-2{padding-block:calc(var(--spacing)*2)}}@layer components{.btn{margin-left:3px}}}
@layer base{body{background:#fff}}
</style>
<div id="storybook-root"><button class="btn inline-flex px-4 py-2 border text-sm font-medium">Button</button></div>`)
      await page.evaluate(CAPTURE_PRELUDE)
      const options = {
        textArgs: [],
        styleProperties: STYLE_PROPERTIES,
        maxBytes: STORYBOOK_LIMITS.captureBytes,
        maxElements: 300,
      }
      const shot = JSON.parse((await page.evaluate(captureStory, options)) as string) as {
        ok: boolean
        css: string
        sharedRules: string[]
        rootFont?: string
      }
      expect(shot.ok).toBe(true)
      const sharedText = shot.sharedRules.join('\n')
      expect(shot.css).not.toContain('@layer')
      expect(sharedText).not.toContain('@layer')
      /* theme first, then the reset, then the later base rule: the layer's order, not the source's */
      const at = (text: string) => shot.sharedRules.findIndex((rule) => rule.includes(text))
      expect(at('--spacing')).toBeGreaterThanOrEqual(0)
      expect(shot.sharedRules[at('--spacing')]).toContain(':root')
      expect(at('--spacing')).toBeLessThan(at('box-sizing'))
      expect(at('box-sizing')).toBeLessThan(at('background'))
      /* @property fallback comes first of all, only for the property a kept rule reads and that has an initial value */
      expect(at('--tw-border-style: solid')).toBe(0)
      expect(sharedText).not.toContain('--tw-unused')
      expect(sharedText).not.toContain('--tw-leading')
      /* the @supports fallback stays conditional, never applied unconditionally */
      expect(shot.sharedRules.filter((rule) => rule.startsWith('@supports'))).toHaveLength(1)
      /* components before utilities, and a media group holding two layers is split, each part wrapped by the same condition */
      expect(shot.css.indexOf('.btn')).toBeLessThan(shot.css.indexOf('.px-4'))
      const groups = shot.css.match(/@media \(min-width: 1px\) \{/g) ?? []
      expect(groups).toHaveLength(2)
      expect(shot.css.lastIndexOf('.py-2')).toBeGreaterThan(shot.css.indexOf('.btn {\n  margin-left: 3px'))
      expect(shot.rootFont).toBe(await page.evaluate(() => getComputedStyle(document.body).fontFamily))
      expect(shot.rootFont).toContain('sans-serif')

      /* what the frame will hold: the shared rules, then the component's, with nothing else of the page's */
      await bare.setContent(
        `<!doctype html><style>${shot.sharedRules.join('\n')}\n${shot.css}</style><button class="btn inline-flex px-4 py-2 border text-sm font-medium">Button</button>`,
      )
      const look = await bare.evaluate(() => {
        const style = getComputedStyle(document.querySelector('button')!)
        return {
          left: style.paddingLeft,
          top: style.paddingTop,
          borderStyle: style.borderTopStyle,
          borderWidth: style.borderTopWidth,
          size: style.fontSize,
          weight: style.fontWeight,
          margin: style.marginLeft,
        }
      })
      expect(look).toEqual({
        left: '16px',
        top: '8px',
        borderStyle: 'solid',
        borderWidth: '1px',
        size: '14px',
        weight: '500',
        margin: '3px',
      })
    } finally {
      await page.close()
      await bare.close()
    }
  })

  it('stops the whole import when a story page answers 403', async () => {
    const error = await storybookBundle(`${storybook.origin}/lockedframe/`, {}, deps(storybook.origin)).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(StorybookAccessError)
    /* browser work was spent on that page, so the slot is not refunded: otherwise it is free renderer time */
    expect((error as StorybookAccessError).duringRender).toBe(true)
    expect(failedBeforeRendering(error)).toBe(false)
  })

  it('refunds an index that answers 401 before any body is read, never one that was downloaded and rejected', async () => {
    const denied = await storybookBundle(`${storybook.origin}/private/`, {}, deps(storybook.origin)).catch(
      (caught: unknown) => caught,
    )
    expect(failedBeforeRendering(denied)).toBe(true)
    const notJson = await storybookBundle(`${storybook.origin}/html/`, {}, deps(storybook.origin)).catch(
      (caught: unknown) => caught,
    )
    expect(notJson).toBeInstanceOf(StorybookIndexError)
    expect(failedBeforeRendering(notJson)).toBe(false)
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
