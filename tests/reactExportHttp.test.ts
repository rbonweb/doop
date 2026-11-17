import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * POST /api/canvases/:id/export/react against the real server: who may export, what a body may say,
 * the scopes, the zip and json answers, the size and rate limits and deleted components.
 */

const doc = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

let server: Server
let owner: Client
let editor: Client
let viewer: Client
let linkVisitor: Client
let stranger: Client
let canvasId: string
let firstPageId: string
let pageTwoId: string
let homeId: string
let aboutId: string
let hiddenId: string
let tagId: string
let deletedId: string

type ExportBody = Record<string, unknown>

const exportReact = (client: Client, id: string, body: ExportBody = {}) =>
  client.post(`/api/canvases/${id}/export/react`, body)

const jsonFiles = async (res: Response) =>
  (await res.json()) as {
    files: { path: string; content: string }[]
    report: { components: { name: string }[]; pages: { name: string; file: string }[]; issues: { kind: string }[] }
  }

const paths = (files: { path: string }[]) => files.map((file) => file.path)

beforeAll(async () => {
  server = await startServer({ REACT_EXPORTS_PER_MIN: '1000' })
  owner = await new Client(server).signUp('react-owner@test.dev', 'Owner')
  editor = await new Client(server).signUp('react-editor@test.dev', 'Editor')
  viewer = await new Client(server).signUp('react-viewer@test.dev', 'Viewer')
  linkVisitor = await new Client(server).signUp('react-link@test.dev', 'Link visitor')
  stranger = await new Client(server).signUp('react-stranger@test.dev', 'Stranger')
  const canvas = (await (await owner.post('/api/canvases', { name: 'Shop: front/end' })).json()) as {
    id: string
    pages?: { id: string; name: string }[]
  }
  canvasId = canvas.id
  expect(
    (await owner.post(`/api/canvases/${canvasId}/members`, { email: 'react-editor@test.dev', role: 'edit' })).status,
  ).toBe(200)
  expect(
    (await owner.post(`/api/canvases/${canvasId}/members`, { email: 'react-viewer@test.dev', role: 'view' })).status,
  ).toBe(200)

  firstPageId = canvas.pages?.[0]?.id ?? `${canvasId}:page1`
  const firstPage = firstPageId
  pageTwoId = 'page-two'
  expect(
    (
      await owner.put(`/api/canvases/${canvasId}/pages`, {
        expectedPages: canvas.pages ?? [{ id: firstPage, name: 'Page 1' }],
        pages: [
          { id: firstPage, name: canvas.pages?.[0]?.name ?? 'Page 1' },
          { id: pageTwoId, name: 'Second' },
        ],
      })
    ).status,
  ).toBe(200)
  const frame = async (name: string, html: string, extra: Record<string, unknown> = {}) =>
    ((await (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html, ...extra })).json()) as { id: string })
      .id
  homeId = await frame(
    'Home',
    doc('<span class="tag" data-doop-id="tagone">New</span><h1>Welcome</h1><img src="/a/logo.png" alt="">'),
    { pageId: firstPage, x: 0, y: 0 },
  )
  hiddenId = await frame('Draft', doc('<p>hidden</p>'), { pageId: firstPage, x: 2000, y: 0, hidden: true })
  aboutId = await frame('About us', doc('<h1>About</h1>'), { pageId: pageTwoId, x: 0, y: 0 })

  const tokens = await owner.post(`/api/canvases/${canvasId}/tokens`, {
    tokens: [{ name: 'brand', type: 'color', value: '#0177d3' }],
  })
  expect(tokens.status).toBe(200)

  const made = await owner.post(`/api/canvases/${canvasId}/components`, {
    name: 'Tag',
    frameId: homeId,
    element: 'tagone',
    replaceMatching: true,
  })
  expect(made.status).toBe(200)
  tagId = ((await made.json()) as { component: { id: string } }).component.id

  const landingId = await frame('Landing', doc('<h2>Landing</h2>'), { pageId: firstPage, x: 1000, y: 0 })
  expect((await owner.post(`/api/frames/${landingId}/instances`, { component: 'Tag' })).status).toBe(200)

  const other = await frame('Hero card', doc('<div class="hero" data-doop-id="heroone"><b>Hero</b></div>'), {
    pageId: pageTwoId,
    x: 1500,
    y: 0,
  })
  const second = await owner.post(`/api/canvases/${canvasId}/components`, {
    name: 'Gone',
    frameId: other,
    element: 'heroone',
  })
  expect(second.status).toBe(200)
  deletedId = ((await second.json()) as { component: { id: string } }).component.id
  expect((await owner.delete(`/api/canvases/${canvasId}/components/${deletedId}`)).status).toBe(200)

  /* a link visitor: signed in, not a member, the canvas open to anyone with the link */
  expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
}, 90_000)

afterAll(() => server?.stop())

describe('who may export', () => {
  it('lets the owner, an editor, a viewer and a share-link visitor export', async () => {
    for (const client of [owner, editor, viewer, linkVisitor]) {
      const res = await exportReact(client, canvasId, { format: 'json' })
      expect(res.status, await res.clone().text()).toBe(200)
    }
  })

  it('answers an account with no access like the other canvas routes, and a missing canvas 404', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    const denied = await exportReact(stranger, canvasId, { format: 'json' })
    expect(denied.status).toBe(403)
    expect((await stranger.get(`/api/canvases/${canvasId}/export.pdf`)).status).toBe(403)
    expect((await exportReact(stranger, 'no-such-canvas')).status).toBe(404)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
  })

  it('needs a session', async () => {
    const res = await fetch(`${server.base}/api/canvases/${canvasId}/export/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})

describe('the body', () => {
  it('refuses what it does not understand with 400', async () => {
    const bad: ExportBody[] = [
      { styling: 'css-in-js' },
      { format: 'tar' },
      { tokens: 'yes' },
      { frameIds: 'abc' },
      { frameIds: [1] },
      { componentIds: [''] },
      { pageId: 5 },
      { frameIds: Array.from({ length: 201 }, (_, i) => `f${i}`) },
      { surprise: true },
    ]
    for (const body of bad) {
      const res = await exportReact(owner, canvasId, body)
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/invalid export request/)
    }
  })

  it('answers 404 for a frame, page or component that is not on the canvas', async () => {
    expect((await exportReact(owner, canvasId, { frameIds: ['nope'] })).status).toBe(404)
    expect((await exportReact(owner, canvasId, { pageId: 'nope' })).status).toBe(404)
    expect((await exportReact(owner, canvasId, { componentIds: ['Nope'] })).status).toBe(404)
  })
})

describe('scope', () => {
  it('exports the first page and the components it uses by default', async () => {
    const { files, report } = await jsonFiles(await exportReact(owner, canvasId, { format: 'json' }))
    expect(report.pages.map((page) => page.name)).toEqual(['Home', 'Landing'])
    expect(paths(files)).toContain('src/pages/Home.tsx')
    expect(paths(files)).toContain('src/components/Tag.tsx')
    expect(paths(files)).not.toContain('src/pages/About-us.tsx')
    expect(paths(files)).not.toContain('src/pages/Draft.tsx')
  })

  it('takes the frames named, in order, hidden ones included when asked for', async () => {
    const { report } = await jsonFiles(
      await exportReact(owner, canvasId, { frameIds: [aboutId, hiddenId], format: 'json' }),
    )
    expect(report.pages.map((page) => page.name)).toEqual(['About us', 'Draft'])
  })

  it('takes a page: its visible screens, not its hidden frames', async () => {
    const { report } = await jsonFiles(await exportReact(owner, canvasId, { pageId: pageTwoId, format: 'json' }))
    expect(report.pages.map((page) => page.name).sort()).toEqual(['About us', 'Hero card'])
    const first = await jsonFiles(await exportReact(owner, canvasId, { pageId: firstPageId, format: 'json' }))
    expect(first.report.pages.map((page) => page.name)).toEqual(['Home', 'Landing'])
  })

  it('takes components alone by id or by name, with no screens', async () => {
    const { files, report } = await jsonFiles(
      await exportReact(owner, canvasId, { componentIds: [tagId], format: 'json' }),
    )
    expect(report.pages).toEqual([])
    expect(report.components.map((component) => component.name)).toEqual(['Tag'])
    expect(paths(files).some((path) => path.startsWith('src/pages/'))).toBe(false)
    const byName = await jsonFiles(await exportReact(owner, canvasId, { componentIds: ['tag'], format: 'json' }))
    expect(byName.report.components.map((component) => component.name)).toEqual(['Tag'])
  })

  it('leaves out a deleted component, and refuses to be asked for it', async () => {
    const all = await jsonFiles(
      await exportReact(owner, canvasId, { pageId: pageTwoId, componentIds: [tagId], format: 'json' }),
    )
    expect(all.report.components.map((component) => component.name)).not.toContain('Gone')
    expect(paths(all.files)).not.toContain('src/components/Gone.tsx')
    expect((await exportReact(owner, canvasId, { componentIds: [deletedId] })).status).toBe(404)
  })

  it('leaves the token files out when asked, and puts them in otherwise', async () => {
    const withTokens = await jsonFiles(await exportReact(owner, canvasId, { format: 'json' }))
    expect(withTokens.files.find((file) => file.path === 'src/tokens.css')?.content).toContain('--brand')
    const without = await jsonFiles(await exportReact(owner, canvasId, { tokens: false, format: 'json' }))
    expect(paths(without.files)).not.toContain('src/tokens.css')
    expect(paths(without.files)).not.toContain('src/tokens.json')
  })

  it('refuses an export with nothing in it', async () => {
    const empty = (await (await owner.post('/api/canvases', { name: 'Empty' })).json()) as { id: string }
    const res = await exportReact(owner, empty.id, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing to export/)
  })

  it('points root-relative asset URLs at the server', async () => {
    const { files } = await jsonFiles(await exportReact(owner, canvasId, { format: 'json' }))
    const home = files.find((file) => file.path === 'src/pages/Home.tsx')!.content
    expect(home).toContain(`${server.base}/a/logo.png`)
  })
})

describe('the zip', () => {
  it('answers a zip named for the canvas, with the layout under one root and the issue count in a header', async () => {
    const res = await exportReact(owner, canvasId, { pageId: firstPageId })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Shop-front-end-react.zip"')
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(Number(res.headers.get('x-doop-export-issues'))).toBeGreaterThanOrEqual(0)
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    const names = Object.keys(zip.files)
    for (const path of [
      'README.md',
      'export-report.json',
      'src/tokens.css',
      'src/tokens.json',
      'src/cx.ts',
      'src/css-modules.d.ts',
      'src/components/Tag.tsx',
      'src/components/Tag.module.css',
      'src/components/index.ts',
      'src/pages/Home.tsx',
      'src/pages/Home.css',
    ]) {
      expect(names, path).toContain(`Shop-front-end-react/${path}`)
    }
    expect(names.every((name) => name.startsWith('Shop-front-end-react/'))).toBe(true)
    const report = JSON.parse(await zip.file('Shop-front-end-react/export-report.json')!.async('string')) as {
      issues: unknown[]
    }
    expect(Number(res.headers.get('x-doop-export-issues'))).toBe(report.issues.length)
  })

  it('counts what did not carry over in the header', async () => {
    const dirty = (await (await owner.post('/api/canvases', { name: 'Dirty' })).json()) as { id: string }
    await owner.post(`/api/canvases/${dirty.id}/frames`, {
      name: 'Page',
      html: doc('<h1 onclick="alert(1)">Hi</h1><script>alert(1)</script>'),
    })
    const res = await exportReact(owner, dirty.id, {})
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('x-doop-export-issues'))).toBeGreaterThanOrEqual(2)
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    const page = await zip.file('Dirty-react/src/pages/Page.tsx')!.async('string')
    expect(page).not.toContain('alert')
  })

  it('gives the same bytes for the same canvas twice', async () => {
    const a = Buffer.from(await (await exportReact(owner, canvasId, {})).arrayBuffer())
    const b = Buffer.from(await (await exportReact(owner, canvasId, {})).arrayBuffer())
    expect(b.equals(a)).toBe(true)
  })
})

describe('json', () => {
  it('answers files and the report', async () => {
    const res = await exportReact(owner, canvasId, { format: 'json', componentIds: [tagId] })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const { files, report } = await jsonFiles(res)
    expect(paths(files)).toEqual([...paths(files)].sort())
    expect(JSON.parse(files.find((file) => file.path === 'export-report.json')!.content)).toEqual(report)
  })

  it('refuses a body of more than 300 KB of files with 413, and still serves the zip', async () => {
    const big = (await (await owner.post('/api/canvases', { name: 'Big' })).json()) as { id: string }
    const paragraphs = Array.from({ length: 1500 }, (_, i) => `<p>${'paragraph text '.repeat(14)}${i}</p>`).join('')
    const made = await owner.post(`/api/canvases/${big.id}/frames`, { name: 'Long', html: doc(paragraphs) })
    expect(made.status).toBe(200)
    const json = await exportReact(owner, big.id, { format: 'json' })
    expect(json.status).toBe(413)
    expect(((await json.json()) as { error: string }).error).toMatch(/300 KB/)
    const zip = await exportReact(owner, big.id, {})
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toBe('application/zip')
  })
})

describe('tailwind', () => {
  it('exports a zip whose tokens.css starts with the Tailwind import and has no module sheet for a fully converted component', async () => {
    const res = await exportReact(owner, canvasId, { pageId: firstPageId, styling: 'tailwind' })
    expect(res.status).toBe(200)
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    const tokens = await zip.file('Shop-front-end-react/src/tokens.css')!.async('string')
    expect(tokens.startsWith('@import "tailwindcss";')).toBe(true)
    expect(tokens).toContain('--brand')
    const report = JSON.parse(await zip.file('Shop-front-end-react/export-report.json')!.async('string')) as {
      styling: string
    }
    expect(report.styling).toBe('tailwind')
    for (const name of Object.keys(zip.files).filter((entry) => entry.endsWith('.module.css'))) {
      /* a module sheet is only a leftover the utilities could not say */
      expect((await zip.file(name)!.async('string')).trim().length, name).toBeGreaterThan(0)
    }
  })

  it('answers json in tailwind mode too', async () => {
    const { files, report } = await jsonFiles(
      await exportReact(owner, canvasId, { format: 'json', styling: 'tailwind' }),
    )
    expect((report as unknown as { styling: string }).styling).toBe('tailwind')
    expect(files.find((file) => file.path === 'src/tokens.css')?.content.startsWith('@import "tailwindcss";')).toBe(
      true,
    )
  })
})

describe('the json size limit', () => {
  it('counts UTF-8 bytes of file content, not characters', async () => {
    const wide = (await (await owner.post('/api/canvases', { name: 'Wide' })).json()) as { id: string }
    /* about 110,000 characters but over 330 KB as UTF-8 */
    const text = '日本語'.repeat(1000)
    const paragraphs = Array.from({ length: 37 }, (_, i) => `<p>${text}${i}</p>`).join('')
    expect((await owner.post(`/api/canvases/${wide.id}/frames`, { name: 'Wide', html: doc(paragraphs) })).status).toBe(
      200,
    )
    const json = await exportReact(owner, wide.id, { format: 'json' })
    expect(json.status).toBe(413)
  })
})

describe('the rate limit', () => {
  it('answers 429 with Retry-After once an account has used its minute, and counts accounts apart', async () => {
    const limited = await startServer({ REACT_EXPORTS_PER_MIN: '3' })
    try {
      const spender = await new Client(limited).signUp('react-spender@test.dev', 'Spender')
      const other = await new Client(limited).signUp('react-other@test.dev', 'Other')
      const canvas = (await (await spender.post('/api/canvases', { name: 'Limit' })).json()) as { id: string }
      await spender.post(`/api/canvases/${canvas.id}/frames`, { name: 'One', html: doc('<p>x</p>') })
      await spender.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'view' })
      for (let i = 0; i < 3; i++) expect((await exportReact(spender, canvas.id, { format: 'json' })).status).toBe(200)
      const refused = await exportReact(spender, canvas.id, { format: 'json' })
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      expect((await exportReact(other, canvas.id, { format: 'json' })).status).toBe(200)
    } finally {
      limited.stop()
    }
  }, 60_000)
})
