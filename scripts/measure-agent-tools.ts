/**
 * Agent tool measurement: times the MCP tools and the `/i/` render route against a running Doop and prints the baseline table as markdown.
 *
 * Usage: DOOP_URL=http://localhost:4400 DOOP_AGENT_KEY=dpk_... bun x tsx scripts/measure-agent-tools.ts
 *
 * DOOP_URL and DOOP_AGENT_KEY are required; there is no default, so a run never lands on production by accident. Point it at a throwaway local server: it creates a canvas, about 30 frames of 140 KB and an asset there.
 * MEASURE_RUNS sets the samples per row (default 5). MEASURE_COOKIE (a signed-in session cookie) adds the owner rows of the render budget table, and MEASURE_RATE=1 runs that table at all: it hammers `/i/` until the 429, so use it only on a server whose budget you own.
 * MEASURE_JSON=<path> also writes the raw rows as JSON. Nothing is written otherwise.
 */

import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = (process.env.DOOP_URL ?? '').replace(/\/+$/, '')
const KEY = process.env.DOOP_AGENT_KEY ?? ''
if (!BASE || !KEY) {
  console.error('Set DOOP_URL (a throwaway server) and DOOP_AGENT_KEY. There is no default.')
  process.exit(1)
}
const RUNS = Math.max(1, Number(process.env.MEASURE_RUNS ?? 5))
const COOKIE = process.env.MEASURE_COOKIE ?? ''
const AGENT = 'measure-agent'

/* ---------- a deterministic marketing page: ~140 KB desktop, the same for the phone at one column */

const WORDS = (
  'design canvas agent frame stream realtime workflow ship faster teams collaborate brand system tokens component ' +
  'prototype review feedback launch metrics growth customers trust security speed quality detail craft motion type ' +
  'layout colour spacing hierarchy contrast delight product roadmap pricing plan seat workspace integrate export'
).split(' ')

const SECTIONS = [
  'Hero',
  'Logos',
  'Features',
  'How it works',
  'Showcase',
  'Metrics',
  'Testimonials',
  'Integrations',
  'Pricing',
  'FAQ',
  'Blog',
  'Footer',
]

const HEADING = 'Design at the speed of thought'

interface Page {
  html: string
  chunks: string[]
}

function buildPage(opts: { phone: boolean; img: string }): Page {
  let seed = 7
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  const sentence = (n: number) => {
    const words = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)] ?? 'design')
    const [first = 'Design', ...rest] = words
    return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${rest.join(' ')}.`
  }
  const para = (sentences: number) =>
    Array.from({ length: sentences }, () => sentence(8 + Math.floor(rnd() * 8))).join(' ')
  const { phone, img } = opts
  const target = 176_500
  const head = `<style>
:root{--ink:#111;--soft:#5f5e5b;--brand:#0177d3;--paper:#fdfdfd;--line:#ececec}
*{box-sizing:border-box;margin:0}
body{font-family:Inter,system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.5}
.sec{padding:${phone ? 40 : 96}px ${phone ? 20 : 80}px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(${phone ? 1 : 3},1fr);gap:${phone ? 16 : 28}px}
.card{border-radius:14px;padding:24px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.05)}
.card h3{font-size:20px;font-weight:600;margin-bottom:8px}
.card p{color:var(--soft);font-size:15px}
.btn{display:inline-block;background:var(--ink);color:#fff;border-radius:10px;padding:12px 20px;font-weight:500}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.card{animation:rise .6s ease both}
@media (max-width:600px){.grid{grid-template-columns:1fr}}
</style>`
  const perSection = Math.floor((target - head.length) / SECTIONS.length)
  let html = head
  SECTIONS.forEach((name, si) => {
    const open = `<section class="sec" style="background:${si % 2 ? '#fff' : '#f7f7f7'}" data-section="${name}"><h2 style="font-size:${phone ? 30 : 44}px;font-weight:600;letter-spacing:-0.02em;margin-bottom:16px">${si === 0 ? HEADING : `${name}: ${sentence(4)}`}</h2><p style="font-size:${phone ? 16 : 19}px;color:#5f5e5b;max-width:720px;margin-bottom:32px">${para(3)}</p><div class="grid">`
    let size = open.length
    let cards = ''
    for (let i = 0; size < perSection - 400; i++) {
      const card = `<div class="card" style="animation-delay:${(i % 6) * 60}ms"><img src="${img}" alt="${name} ${i}" style="width:100%;height:${phone ? 140 : 180}px;object-fit:cover;border-radius:10px;margin-bottom:16px;background:#e8e8e8"><h3 style="letter-spacing:-0.01em">${sentence(3)}</h3><p style="margin-bottom:8px">${para(3)}</p><span class="btn" style="font-size:14px;padding:8px 14px">Learn more</span></div>`
      cards += card
      size += card.length
    }
    html += `${open}${cards}</div></section>`
  })
  /* twelve images across the page, as a real one has */
  let images = 0
  html = html.replace(/<img [^>]*>/g, (m) => (images++ < 12 ? m : ''))
  /* streamed in chunks of at most 3.8 KB at tag boundaries */
  const chunks: string[] = []
  let current = ''
  for (const piece of html.split(/(?<=>)(?=<)/)) {
    if (current.length + piece.length > 3800) {
      chunks.push(current)
      current = ''
    }
    current += piece
  }
  if (current) chunks.push(current)
  return { html, chunks }
}

/* ---------- measuring */

interface Row {
  name: string
  median: number
  max: number
  min: number
  bytes: number
  n: number
  note: string
}

const rows: Row[] = []
const notes: string[] = []
const now = () => performance.now()
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

function record(name: string, ms: number[], bytes: number[], note = ''): void {
  rows.push({
    name,
    median: Math.round(median(ms)),
    max: Math.round(Math.max(...ms)),
    min: Math.round(Math.min(...ms)),
    bytes: Math.round(median(bytes)),
    n: ms.length,
    note,
  })
}

const client = new Client({ name: 'measure-client', version: '1.0.0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${KEY}` } },
  }),
)

interface Call {
  ms: number
  bytes: number
  result: Awaited<ReturnType<typeof client.callTool>>
}

async function call(name: string, args: Record<string, unknown>): Promise<Call> {
  const start = now()
  const result = await client.callTool({ name, arguments: { ...args, agent_name: AGENT } })
  const ms = now() - start
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content).slice(0, 300)}`)
  return { ms, bytes: JSON.stringify(result).length, result }
}

function textOf(c: Call): string {
  const blocks = (c.result.content ?? []) as { type: string; text?: string }[]
  return blocks.find((block) => block.type === 'text')?.text ?? ''
}

/** The few fields of a tool's JSON answer the measurement reads. */
interface Answer {
  id?: string
  url?: string
  asset_url?: string
  frame?: { id?: string }
  [key: string]: unknown
}

function jsonOf(c: Call): Answer | null {
  try {
    return JSON.parse(textOf(c)) as Answer
  } catch {
    return null
  }
}

async function bench(name: string, n: number, run: (i: number) => Promise<Call>, note?: (last: Call) => string) {
  const ms: number[] = []
  const bytes: number[] = []
  let last: Call | undefined
  for (let i = 0; i < n; i++) {
    last = await run(i)
    ms.push(last.ms)
    bytes.push(last.bytes)
  }
  record(name, ms, bytes, last && note ? note(last) : '')
  return last as Call
}

const tools = await client.listTools()
notes.push(`tools/list: ${tools.tools.length} tools, ${JSON.stringify(tools).length} bytes`)

const canvas = jsonOf(await call('create_canvas', { name: 'Agent tool measurement' }))
const canvasId = String(canvas?.id ?? '')
if (!canvasId) throw new Error('create_canvas returned no id')
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0177d3"/><stop offset="1" stop-color="#f05a1a"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/></svg>'
const upload = jsonOf(await call('upload_asset', { canvas_id: canvasId, data: Buffer.from(svg).toString('base64') }))
const assetUrl = String(
  upload?.url ??
    upload?.asset_url ??
    Object.values(upload ?? {}).find((v) => typeof v === 'string' && v.includes('/a/')),
)
const imgSrc = assetUrl.startsWith('http') ? assetUrl : `${BASE}${assetUrl}`

const desktop = buildPage({ phone: false, img: imgSrc })
const phonePage = buildPage({ phone: true, img: imgSrc })
notes.push(
  `desktop html ${desktop.html.length} B in ${desktop.chunks.length} chunks; phone html ${phonePage.html.length} B in ${phonePage.chunks.length} chunks; 12 images each`,
)

const frames: string[] = []

async function streamNew(i: number, page: Page, width: number, height: number, name: string) {
  const start = now()
  let bytes = 0
  const created = await call('create_frame', {
    canvas_id: canvasId,
    name,
    html: '<div></div>',
    width,
    height,
    x: i * (width + 100),
    y: 0,
  })
  bytes += created.bytes
  const id = String(jsonOf(created)?.frame?.id ?? '')
  if (!id) throw new Error(`create_frame returned no frame id: ${textOf(created).slice(0, 200)}`)
  const appendMs: number[] = []
  for (let k = 0; k < page.chunks.length; k++) {
    const appended = await call('append_frame_html', {
      frame_id: id,
      html_chunk: page.chunks[k],
      start: k === 0 || undefined,
      done: k === page.chunks.length - 1 || undefined,
    })
    appendMs.push(appended.ms)
    bytes += appended.bytes
  }
  return { ms: now() - start, bytes, id, appendMs, createMs: created.ms }
}

const appendMs: number[] = []
await bench(
  `create_frame + append stream (${desktop.chunks.length} chunks)`,
  RUNS,
  async (i) => {
    const r = await streamNew(i, desktop, 1440, 4000, `Landing ${i}`)
    frames.push(r.id)
    appendMs.push(...r.appendMs)
    return { ms: r.ms, bytes: r.bytes, result: { content: [] } }
  },
  () => `per append median ${Math.round(median(appendMs))} ms, max ${Math.round(Math.max(...appendMs))} ms`,
)
const first = frames[0] ?? ''

let version = 0
await bench('set_frame_html (whole page)', RUNS, () =>
  call('set_frame_html', { frame_id: first, html: `${desktop.html}<!-- v${++version} -->` }),
)

let heading = HEADING
await bench('edit_frame_html (one heading)', RUNS, async (i) => {
  const next = `${HEADING} ${i}`
  const r = await call('edit_frame_html', { frame_id: first, old_str: heading, new_str: next })
  heading = next
  return r
})

await bench(
  'get_frame (whole page)',
  RUNS,
  () => call('get_frame', { frame_id: first }),
  (r) => `text ${textOf(r).length} B`,
)

while (frames.length < 20) {
  const created = await call('create_frame', {
    canvas_id: canvasId,
    name: `Dup ${frames.length}`,
    html: '<div></div>',
    width: 1440,
    height: 4000,
    x: frames.length * 1540,
    y: 5000,
  })
  const id = String(jsonOf(created)?.frame?.id ?? '')
  await call('set_frame_html', { frame_id: id, html: desktop.html })
  frames.push(id)
}
await bench(
  'get_canvas (20 frames)',
  RUNS,
  () => call('get_canvas', { canvas_id: canvasId }),
  (r) => {
    const structured = (r.result as { structuredContent?: unknown }).structuredContent
    return `text ${textOf(r).length} B, structuredContent ${structured ? JSON.stringify(structured).length : 'none'} B`
  },
)

const phone = await streamNew(99, phonePage, 390, 4000, 'Phone')
const phoneId = phone.id

const shotNote = (r: Call) =>
  (r.result.content as { type: string; data?: string }[])
    .map((block) => block.type + (block.data ? ` (${block.data.length} b64 chars)` : ''))
    .join(', ')
await bench(
  'get_frame_screenshot 1440 x 4000, 1x',
  RUNS,
  () => call('get_frame_screenshot', { frame_id: first }),
  shotNote,
)
await bench(
  'get_frame_screenshot 1440 x 4000, 2x',
  3,
  () => call('get_frame_screenshot', { frame_id: first, scale: 2 }),
  shotNote,
)
await bench(
  'get_frame_screenshot 390 phone, 1x',
  RUNS,
  () => call('get_frame_screenshot', { frame_id: phoneId }),
  shotNote,
)
await bench(
  'export_frame png',
  RUNS,
  () => call('export_frame', { frame_id: first, format: 'png' }),
  (r) => textOf(r).slice(0, 120),
)

/* ---------- the /i/ route: cold (first request after a save) and warm (same version again) */

interface Fetched {
  ms: number
  status: number
  bytes: number
  retryAfter: string | null
}

async function getImage(id: string, query = '', headers: Record<string, string> = {}): Promise<Fetched> {
  const start = now()
  const res = await fetch(`${BASE}/i/${id}.png${query}`, { headers })
  const body = Buffer.from(await res.arrayBuffer())
  return { ms: now() - start, status: res.status, bytes: body.length, retryAfter: res.headers.get('retry-after') }
}

const bearerHeaders = { authorization: `Bearer ${KEY}` }
const cold1: number[] = []
const warm1: number[] = []
const cold2: number[] = []
const warm2: number[] = []
const size1: number[] = []
const size2: number[] = []
for (let i = 0; i < RUNS; i++) {
  await call('set_frame_html', { frame_id: first, html: `${desktop.html}<!-- i${i} -->` })
  const a = await getImage(first, '', bearerHeaders)
  const b = await getImage(first, '', bearerHeaders)
  const c = await getImage(first, '?scale=2', bearerHeaders)
  const d = await getImage(first, '?scale=2', bearerHeaders)
  for (const r of [a, b, c, d])
    if (r.status !== 200) notes.push(`/i/ answered ${r.status} (retry-after ${r.retryAfter})`)
  cold1.push(a.ms)
  warm1.push(b.ms)
  cold2.push(c.ms)
  warm2.push(d.ms)
  size1.push(a.bytes)
  size2.push(c.bytes)
}
record('GET /i/<id>.png cold', cold1, size1, 'first request after a save')
record('GET /i/<id>.png warm', warm1, size1, 'same version again')
record('GET /i/<id>.png?scale=2 cold', cold2, size2, 'new cache key, same version')
record('GET /i/<id>.png?scale=2 warm', warm2, size2, 'cached')

/* ---------- the render budget: where the first 429 comes from (hammers /i/, opt in) */

const budget: string[] = []
if (process.env.MEASURE_RATE === '1') {
  const tiny = String(
    jsonOf(
      await call('create_frame', {
        canvas_id: canvasId,
        name: 'Tiny',
        html: '<div style="padding:20px;font:16px sans-serif">tiny</div>',
        width: 200,
        height: 120,
        x: 0,
        y: 9000,
      }),
    )?.frame?.id ?? '',
  )
  let mode = 0
  const discover = async (label: string, ip: string, headers: Record<string, string>, concurrent: boolean) => {
    mode++
    const start = now()
    const results: { n: number; status: number }[] = []
    let firstLimited: { n: number; at: number; retryAfter: string | null } | undefined
    const scaleFor = (i: number) => (0.5 + (mode * 45 + i) * 0.01).toFixed(2)
    for (let sent = 0; !firstLimited && sent < 40;) {
      const batch = concurrent ? 10 : 1
      const done = await Promise.all(
        Array.from({ length: batch }, async (_, k) => {
          const n = sent + k + 1
          const r = await getImage(tiny, `?scale=${scaleFor(sent + k)}`, { 'x-forwarded-for': ip, ...headers })
          return { n, r, at: now() - start }
        }),
      )
      for (const { n, r, at } of done) {
        results.push({ n, status: r.status })
        if (r.status === 429 && (!firstLimited || n < firstLimited.n))
          firstLimited = { n, at, retryAfter: r.retryAfter }
      }
      sent += batch
    }
    const ok = results.filter((r) => r.status === 200).length
    const limited = results.filter((r) => r.status === 429).length
    budget.push(
      `| ${label} | ${results.length} | ${ok} | ${limited} | ${firstLimited ? `#${firstLimited.n} at ${Math.round(firstLimited.at)} ms, Retry-After ${firstLimited.retryAfter}` : 'none'} |`,
    )
  }
  if (COOKIE) {
    await discover('sequential, session cookie', '10.8.0.1', { cookie: COOKIE }, false)
    await discover('concurrent 10, session cookie', '10.8.0.2', { cookie: COOKIE }, true)
  }
  await discover('sequential, agent bearer', '10.8.0.3', bearerHeaders, false)
  await discover('concurrent 10, agent bearer', '10.8.0.4', bearerHeaders, true)
  await discover('sequential, anonymous', '10.8.0.5', {}, false)
}

await client.close()

/* ---------- the table */

const kb = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(2)} MB`
    : bytes >= 1000
      ? `${(bytes / 1000).toFixed(1)} KB`
      : `${bytes} B`
const lines = [
  `Measured against ${BASE}, N=${RUNS}.`,
  '',
  '| Call | Median | Max | Response | Note |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.name} | ${r.median} ms | ${r.max} ms | ${kb(r.bytes)} | ${r.note} |`),
  '',
  ...notes.map((n) => `- ${n}`),
]
if (budget.length) {
  lines.push(
    '',
    '| Render budget (/i/, 200 x 120 frame, a new scale per request) | Sent | 200 | 429 | First 429 |',
    '| --- | --- | --- | --- | --- |',
    ...budget,
  )
}
console.log(lines.join('\n'))
if (process.env.MEASURE_JSON) writeFileSync(process.env.MEASURE_JSON, JSON.stringify({ rows, notes, budget }, null, 2))
