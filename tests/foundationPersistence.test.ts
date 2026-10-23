import { PGlite } from '@electric-sql/pglite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, ElementComment, Frame, FrameVersion } from '../shared/types.ts'

const migrationsDir = new URL('../server/db/migrations/', import.meta.url)

function migrationSql(tag: string): string {
  return readFileSync(new URL(`${tag}.sql`, migrationsDir), 'utf8').replaceAll('--> statement-breakpoint', '')
}

function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationsDir), 'utf8')) as {
    entries: { tag: string }[]
  }
  return journal.entries.map((e) => e.tag)
}

/** poll until a write-through (fire-and-forget) mutation is visible, instead of sleeping a fixed time */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the write to land')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

it('gives canvas_members rows that predate roles the edit role, and applies on a fresh database', async () => {
  const tags = journalTags().slice(0, journalTags().indexOf('0028_marver_upgrades') + 1)
  expect(tags.at(-1)).toBe('0028_marver_upgrades')
  const dir = mkdtempSync(join(tmpdir(), 'doop-foundation-migration-'))
  const pg = new PGlite(dir)
  try {
    for (const tag of tags.slice(0, -1)) await pg.exec(migrationSql(tag))
    await pg.exec(`INSERT INTO canvas_members (canvas_id, user_id, added_by, added_at) VALUES ('c1', 'u1', 'owner', 1)`)
    await pg.exec(migrationSql('0028_marver_upgrades'))
    const rows = (await pg.query<{ role: string }>(`SELECT role FROM canvas_members`)).rows
    expect(rows).toEqual([{ role: 'edit' }])
    for (const table of [
      'frame_seen',
      'canvas_visits',
      'frame_versions',
      'canvas_domain_grants',
      'canvas_access_requests',
      'canvas_notes',
    ]) {
      expect((await pg.query(`SELECT 1 FROM ${table}`)).rows).toEqual([])
    }
  } finally {
    await pg.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

type Persist = typeof import('../server/db/persist.ts')
let persist: Persist
let workDir: string
let previousCwd: string

beforeAll(async () => {
  previousCwd = process.cwd()
  workDir = mkdtempSync(join(tmpdir(), 'doop-foundation-db-'))
  process.chdir(workDir) // initDb keeps the embedded database in <cwd>/data/pg
  await (await import('../server/db/index.ts')).initDb()
  persist = await import('../server/db/persist.ts')
}, 60_000)

afterAll(() => {
  process.chdir(previousCwd)
  rmSync(workDir, { recursive: true, force: true })
})

function version(frameId: string, n: number): FrameVersion {
  return {
    id: `v-${n}`,
    frameId,
    canvasId: 'c-versions',
    name: 'Hero',
    html: `<p>${n}</p>`,
    width: 640,
    height: 480,
    savedAt: n,
    savedBy: 'Ada',
    reason: 'human',
  }
}

it('keeps the newest 50 versions of a frame and lists them newest first without html', async () => {
  for (let n = 1; n <= 53; n++) await persist.saveFrameVersion(version('f-trim', n))
  await persist.saveFrameVersion({ ...version('f-other', 1), id: 'other-1' })

  const listed = await persist.listFrameVersions('f-trim')
  expect(listed).toHaveLength(persist.MAX_FRAME_VERSIONS)
  expect(listed[0]?.savedAt).toBe(53)
  expect(listed.at(-1)?.savedAt).toBe(4)
  expect(listed[0]).not.toHaveProperty('html')
  expect((await persist.getFrameVersion('v-53'))?.html).toBe('<p>53</p>')
  expect(await persist.getFrameVersion('v-1')).toBeUndefined()
  expect(await persist.listFrameVersions('f-other')).toHaveLength(1)

  await persist.deleteFrameVersions('f-trim')
  expect(await persist.listFrameVersions('f-trim')).toEqual([])
})

it('upserts frame_seen keeping the largest seen timestamp, and the first canvas visit baseline', async () => {
  await persist.saveFrameSeen('u1', 'c1', 'f1', 100)
  await persist.saveFrameSeen('u1', 'c1', 'f1', 50) // a stale tab must not roll it back
  await persist.saveFrameSeen('u1', 'c1', 'f2', 70)
  await persist.saveFrameSeen('u2', 'c1', 'f1', 5)
  await persist.saveFrameSeen('u1', 'c1', 'f1', 200)
  const seen = await persist.listFrameSeen('u1', 'c1')
  expect(Object.fromEntries(seen.map((s) => [s.frameId, s.seenUpdatedAt]))).toEqual({ f1: 200, f2: 70 })

  expect(await persist.getCanvasVisit('u1', 'c1')).toBeUndefined()
  expect(await persist.ensureCanvasVisit('u1', 'c1', 1000)).toBe(1000)
  expect(await persist.ensureCanvasVisit('u1', 'c1', 2000)).toBe(1000)
  expect(await persist.getCanvasVisit('u1', 'c1')).toBe(1000)
})

it('expires only pending access requests older than 30 days', async () => {
  const now = 100 * 24 * 60 * 60 * 1000
  const day = 24 * 60 * 60 * 1000
  await persist.saveAccessRequest({ canvasId: 'c-req', userId: 'old', at: now - 31 * day, status: 'pending' })
  await persist.saveAccessRequest({
    canvasId: 'c-req',
    userId: 'fresh',
    message: 'hi',
    at: now - day,
    status: 'pending',
  })
  await persist.saveAccessRequest({ canvasId: 'c-req', userId: 'no', at: now - 40 * day, status: 'declined' })
  await persist.expireAccessRequests(now)
  const left = await persist.listAccessRequests('c-req')
  expect(left.map((r) => r.userId).sort()).toEqual(['fresh', 'no'])
  expect(left.find((r) => r.userId === 'fresh')?.message).toBe('hi')
  await persist.deleteAccessRequest('c-req', 'fresh')
  expect((await persist.listAccessRequests('c-req')).map((r) => r.userId)).toEqual(['no'])
})

it('round-trips a comment anchor, author kind and mentions through write and hydrate', async () => {
  const canvas: Canvas = { id: 'c-hydrate', name: 'Hydrate', ownerId: 'owner', createdAt: 1, updatedAt: 1, frames: [] }
  persist.saveCanvas(canvas)
  const comment: ElementComment = {
    id: 'cm1',
    canvasId: 'c-hydrate',
    frameId: 'f-hydrate',
    selector: 'main > h1',
    snippet: '<h1>Hi</h1>',
    from: 'Ada',
    fromUserId: 'u-ada',
    text: 'tighten this @Bo',
    at: 5,
    anchor: { v: 1, tag: 'h1', id: 'title', testId: 'hero-title', role: 'heading', quote: 'Hi', fx: 0.25, fy: 0.75 },
    fromKind: 'agent',
    mentions: ['u-bo', 'u-cy'],
  }
  persist.saveComment(comment)
  persist.saveComment({
    id: 'cm2',
    canvasId: 'c-hydrate',
    frameId: 'f-hydrate',
    selector: 'p',
    snippet: '',
    from: 'Bo',
    text: 'old style',
    at: 4,
  })

  const hydrated = await until(async () => {
    const data = await persist.hydrate()
    return data.comments.get('c-hydrate')?.length === 2 ? data : undefined
  })
  const restored = hydrated.comments.get('c-hydrate')?.find((c) => c.id === 'cm1')
  expect(restored).toEqual(comment)
  const legacy = hydrated.comments.get('c-hydrate')?.find((c) => c.id === 'cm2')
  expect(legacy).not.toHaveProperty('anchor')
  expect(legacy).not.toHaveProperty('mentions')
  expect(legacy).not.toHaveProperty('fromKind')
})

it('hydrates frame attribution, slides, notes, roles, grants and keeps the link password hash off the canvas', async () => {
  const canvas: Canvas = {
    id: 'c-share',
    name: 'Share',
    ownerId: 'owner',
    linkAccess: 'comment',
    linkAudience: 'password',
    createdAt: 1,
    updatedAt: 1,
    frames: [],
  }
  persist.saveCanvas(canvas)
  persist.saveLinkPasswordHash('c-share', 'hash-1')
  const frame: Frame = {
    id: 'f-share',
    canvasId: 'c-share',
    name: 'Slide 1',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '<p>1</p>',
    createdAt: 1,
    updatedAt: 2,
    updatedBy: 'Ada',
    updatedByUserId: 'u-ada',
    updatedByKind: 'user',
    slide: true,
    speakerNotes: 'say hello',
  }
  persist.saveFrame(frame, true)
  persist.saveMember('c-share', 'u-view', 'owner', 3, 'view')
  persist.saveMember('c-share', 'u-edit', 'owner', 4)
  await persist.saveDomainGrant({
    canvasId: 'c-share',
    domain: 'acme.com',
    role: 'comment',
    addedBy: 'owner',
    addedAt: 5,
  })
  await persist.saveNote({
    id: 'n1',
    canvasId: 'c-share',
    frameId: 'f-share',
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    markdown: '# todo',
    color: '#fde68a',
    createdBy: 'Ada',
    createdByUserId: 'u-ada',
    createdAt: 6,
    updatedAt: 6,
    updatedBy: 'Ada',
  })

  const hydrated = await until(async () => {
    const data = await persist.hydrate()
    const c = data.canvases.find((x) => x.id === 'c-share')
    return c?.frames.length === 1 && c.memberIds?.length === 2 ? data : undefined
  })
  const restored = hydrated.canvases.find((c) => c.id === 'c-share')!
  expect(restored.frames[0]).toEqual(frame)
  expect(restored.linkAccess).toBe('comment')
  expect(restored.linkAudience).toBe('password')
  expect(restored.hasLinkPassword).toBe(true)
  expect(JSON.stringify(restored)).not.toContain('hash-1')
  expect(hydrated.linkPasswordHashes.get('c-share')).toBe('hash-1')
  expect(restored.memberRoles).toEqual({ 'u-view': 'view' })
  expect(hydrated.domainGrants.get('c-share')).toEqual([
    { canvasId: 'c-share', domain: 'acme.com', role: 'comment', addedBy: 'owner', addedAt: 5 },
  ])
  expect(restored.notes).toHaveLength(1)
  expect(restored.notes?.[0]).toMatchObject({
    id: 'n1',
    frameId: 'f-share',
    markdown: '# todo',
    createdByUserId: 'u-ada',
  })
})

it('adds the frame design stamp as a nullable column, so rows written before it stay valid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doop-stamp-migration-'))
  const pg = new PGlite(dir)
  try {
    const tags = journalTags()
    expect(tags.at(-1)).toBe('0029_frame_content_stamp')
    for (const tag of tags.slice(0, -1)) await pg.exec(migrationSql(tag))
    await pg.exec(
      `INSERT INTO frames (id, canvas_id, name, x, y, width, height, html, created_at, updated_at, updated_by) VALUES ('f1', 'c1', 'F', 0, 0, 1, 1, '', 1, 2, 'a')`,
    )
    await pg.exec(migrationSql('0029_frame_content_stamp'))
    expect((await pg.query(`SELECT content_updated_at FROM frames`)).rows).toEqual([{ content_updated_at: null }])
  } finally {
    await pg.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

it('keeps the design stamp through a save and hydrate, and two boots in a row change no frame', async () => {
  const { store } = await import('../server/store.ts')
  const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
    id,
    canvasId: 'c-boot',
    pageId: 'c-boot:page1',
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    html: '<p></p>',
    createdAt: 10,
    updatedAt: 500,
    updatedBy: 'Ada',
    ...over,
  })
  const canvas: Canvas = {
    id: 'c-boot',
    name: 'Boot',
    ownerId: 'u1',
    createdAt: 10,
    updatedAt: 500,
    frames: [frame('stamped', { contentUpdatedAt: 300 }), frame('legacy')],
  }
  await persist.saveCanvasCopy(canvas)

  const boot = async () => {
    const data = await persist.hydrate()
    store.canvases.clear()
    store.init(data.canvases, data)
    return structuredClone(data.canvases.find((c) => c.id === 'c-boot')!.frames)
  }
  const first = await boot()
  expect(first.find((f) => f.id === 'stamped')?.contentUpdatedAt).toBe(300)
  expect(first.find((f) => f.id === 'legacy')?.contentUpdatedAt).toBeUndefined()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await boot()).toEqual(first)
}, 60_000)

it('replaces frame_seen exactly, or forgets a row, where the plain upsert only grows', async () => {
  await persist.saveFrameSeen('u-undo', 'c1', 'f1', 300)
  await persist.saveFrameSeen('u-undo', 'c1', 'f2', 400)
  await persist.replaceFrameSeen('u-undo', 'c1', 'f1', 100)
  await persist.replaceFrameSeen('u-undo', 'c1', 'f2', null)
  await persist.replaceFrameSeen('u-undo', 'c1', 'f3', 50)
  const rows = await persist.listFrameSeen('u-undo', 'c1')
  expect(Object.fromEntries(rows.map((r) => [r.frameId, r.seenUpdatedAt]))).toEqual({ f1: 100, f3: 50 })
}, 60_000)
