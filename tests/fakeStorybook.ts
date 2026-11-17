import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A tiny published Storybook with no React and no build, for tests that run the real import against it: an index.json and an iframe.html whose script renders the story named by ?id=…&args=… and sets the body class and `__STORYBOOK_PREVIEW__` the way Storybook does. Components: Inputs/Button (tone enum, disabled boolean, label text) and Data/Badge, each root marked data-component="<its name>" as Primer marks its elements. `/private/` answers 401 and `/gone/` 404. */

const ENTRIES = {
  'inputs-button--primary': { type: 'story', id: 'inputs-button--primary', name: 'Primary', title: 'Inputs/Button' },
  'inputs-button--large': { type: 'story', id: 'inputs-button--large', name: 'Large', title: 'Inputs/Button' },
  'data-badge--default': { type: 'story', id: 'data-badge--default', name: 'Default', title: 'Data/Badge' },
}

const IFRAME = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; }
.btn { padding: 8px 16px; border: 0; border-radius: 6px; font: 14px Arial; }
.btn--primary { background: #00aa55; color: #fff; }
.btn--secondary { background: #eeeeee; color: #111111; }
.btn:disabled { opacity: 0.5; }
.badge { display: inline-block; padding: 2px 8px; background: #ffe; }
</style></head><body class="sb-show-preparing-story"><div id="storybook-root"></div><script>
(function () {
  var params = new URLSearchParams(location.search)
  var id = params.get('id')
  var args = { tone: 'primary', label: 'Save', disabled: false }
  var given = params.get('args')
  if (given) given.split(';').forEach(function (pair) {
    var at = pair.indexOf(':')
    var value = pair.slice(at + 1)
    args[pair.slice(0, at)] = value === '!true' ? true : value === '!false' ? false : value
  })
  var root = document.getElementById('storybook-root')
  var meta = { argTypes: {}, initialArgs: {} }
  if (id.indexOf('inputs-button') === 0) {
    meta = {
      argTypes: { tone: { control: { type: 'select' }, options: ['primary', 'secondary'] }, disabled: { control: 'boolean' }, label: { control: 'text' } },
      initialArgs: { tone: 'primary', label: 'Save', disabled: false },
    }
    root.innerHTML = '<button data-component="Button" class="btn btn--' + args.tone + '"' + (args.disabled ? ' disabled' : '') + '><span>' + args.label + '</span></button>'
  } else {
    root.innerHTML = '<span data-component="Badge" class="badge">NEW</span>'
  }
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'completed', story: { id: id, argTypes: meta.argTypes, initialArgs: meta.initialArgs } } }
  document.body.className = 'sb-show-main'
})()
</script></body></html>`

export interface FakeStorybook {
  /** `http://127.0.0.1:<port>`; a Storybook lives under `/sb/` */
  origin: string
  /** every path the server was asked for */
  requests: string[]
  close(): Promise<void>
}

export interface FakeStorybookOptions {
  /** hold every story page this long before answering, so an import is mid-render for a while */
  iframeDelayMs?: number
  /** a story page was asked for */
  onIframe?: () => void
  /** a story page's request was cut off by the client before it was answered */
  onCut?: () => void
}

export async function startFakeStorybook(options: FakeStorybookOptions = {}): Promise<FakeStorybook> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    requests.push(url)
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    if (url === '/sb/index.json') return send(200, 'application/json', JSON.stringify({ v: 5, entries: ENTRIES }))
    if (url.startsWith('/sb/iframe.html')) {
      options.onIframe?.()
      if (!options.iframeDelayMs) return send(200, 'text/html', IFRAME)
      const timer = setTimeout(() => send(200, 'text/html', IFRAME), options.iframeDelayMs)
      res.on('close', () => {
        clearTimeout(timer)
        if (!res.writableEnded) options.onCut?.()
      })
      return
    }
    if (url.startsWith('/private/')) return send(401, 'text/plain', 'sign in')
    send(404, 'text/plain', 'not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
