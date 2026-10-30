import { nanoid } from 'nanoid'
import {
  canvasPages,
  copyPageName,
  normalizePageTree,
  pageDescendants,
  pageFrames,
  samePages,
} from '../shared/pages.ts'
import { DEFAULT_NOTE_COLOR, NOTE_DEFAULT_SIZE } from '../shared/notes.ts'
import { defaultFrameSize } from '../shared/slides.ts'
import * as persist from './db/persist.ts'
import type {
  Canvas,
  CanvasNote,
  CanvasPageInfo,
  CommunityCategory,
  DomainGrant,
  Frame,
  GuidelineDoc,
  LinkAccess,
  LinkAudience,
  MemberRole,
  MemoryReference,
} from '../shared/types.ts'

/** Who made an edit, beyond the display name: the account behind it and whether
 *  it was a person or an agent. For an agent, `userId` is the account whose
 *  token it connected with. */
export interface EditorInfo {
  userId?: string
  kind?: 'user' | 'agent'
}

/** What a sticky note is made from; position and size have defaults. */
export interface NoteInput {
  pageId?: string
  frameId?: string
  x?: number
  y?: number
  width?: number
  height?: number
  markdown?: string
  color?: string
}

export const MAX_PAGES = 100

export class PageLimitError extends Error {
  constructor() {
    super(`A canvas holds at most ${MAX_PAGES} pages.`)
  }
}

/** A duplicated page: `page` is the copy of `source`; a page with sub-pages is copied whole, so `copiedPages` lists
 *  every new page (the copy first) and `frames` and `notes` are everything copied with them. */
type PageCopy = {
  source: CanvasPageInfo
  page: CanvasPageInfo
  pages: CanvasPageInfo[]
  copiedPages: CanvasPageInfo[]
  frames: Frame[]
  notes: CanvasNote[]
}

const names = (pages: CanvasPageInfo[]) => pages.map((page) => page.name)

/** Where a frame lands on a page: the given coordinates, else to the right of the page's right-most frame (or the
 *  page's first spot when it is empty). */
function placeNewFrame(pageFrameList: readonly Frame[], x?: number, y?: number): { x: number; y: number } {
  if (x !== undefined && y !== undefined) return { x, y }
  const rightmost = pageFrameList.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
  return { x: x ?? (pageFrameList.length ? rightmost + 80 : 120), y: y ?? 120 }
}

/** A frame moved to another canvas: the frame itself, the canvases it left and joined, and the notes that went with it. */
export type FrameMove = { frame: Frame; source: Canvas; target: Canvas; notes: CanvasNote[] }

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 */
class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId
  /* server-only sharing state: kept beside the canvases, never on them,
     because a Canvas is sent whole to every client in the room */
  private domainGrants = new Map<string, DomainGrant[]>() // canvasId -> grants
  private linkPasswordHashes = new Map<string, string>() // canvasId -> hash
  /** the page copy in flight per canvas, so the next one waits for it */
  private pageCopies = new Map<string, Promise<unknown>>()

  init(
    canvases: Canvas[],
    serverOnly: { domainGrants?: Map<string, DomainGrant[]>; linkPasswordHashes?: Map<string, string> } = {},
  ) {
    for (const [id, grants] of serverOnly.domainGrants ?? []) this.domainGrants.set(id, grants)
    for (const [id, hash] of serverOnly.linkPasswordHashes ?? []) this.linkPasswordHashes.set(id, hash)
    for (const c of canvases) {
      c.pages = normalizePageTree(canvasPages(c))
      this.canvases.set(c.id, c)
      for (const f of c.frames) {
        /* A frame whose page is gone (the server died between a frame move
           and the page's deletion: moves persist on a debounce, pages at
           once) rejoins the first page instead of vanishing from every page. */
        if (!f.pageId || !c.pages.some((page) => page.id === f.pageId)) {
          f.pageId = c.pages[0]!.id
          persist.saveFrame(f, true)
        }
        this.frameIndex.set(f.id, c.id)
      }
    }
  }

  /** The dashboard row for one canvas. `viewerId` decides only whether the
   *  canvas is marked as shared-with-me; pass undefined for views that have
   *  no viewer-relative meaning (the admin index). */
  private toMeta(c: Canvas, viewerId?: string) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      shared: viewerId !== undefined ? c.ownerId !== viewerId || undefined : undefined,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      frameCount: c.frames.length,
      /* most recently touched frame — the home dashboard renders it as the
         canvas preview via the public /i/ image pipeline */
      previewFrameId: c.frames.length ? c.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : undefined,
    }
  }

  /** Canvases visible to a user: their own, ones they were invited to, and
   *  every canvas in the workspaces they belong to (the caller resolves
   *  membership — see workspaces.canvasesFor). Unowned (legacy/seeded)
   *  canvases are NOT listed — listing them to everyone leaked one user's
   *  work onto every other user's dashboard. They remain reachable by their
   *  unguessable id and claimable there. */
  listCanvases(userId: string, workspaceIds: readonly string[] = []) {
    return [...this.canvases.values()]
      .filter(
        (c) =>
          c.ownerId === userId ||
          c.memberIds?.includes(userId) ||
          (c.workspaceId !== undefined && workspaceIds.includes(c.workspaceId)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => this.toMeta(c, userId))
  }

  /** The canvas signup made for this user (server/auth.ts): the oldest one
   *  they own. Undefined once they have deleted it, or for an account that
   *  predates the signup hook. */
  firstCanvasOf(userId: string): Canvas | undefined {
    let first: Canvas | undefined
    for (const c of this.canvases.values()) {
      if (c.ownerId === userId && (!first || c.createdAt < first.createdAt)) first = c
    }
    return first
  }

  /** Every canvas on the instance, for the admin index only. Access is the
   *  caller's problem — the only caller is server/admin.ts, behind isAdmin.
   *  A deliberately separate method rather than a flag on listCanvases: a
   *  boolean parameter is the kind of thing that eventually gets passed
   *  `true` from a route that shouldn't. */
  /** Every canvas, unfiltered and unsummarised, for server-side loops that
   *  apply their own access check per user (Live Activity push-to-start). */
  allCanvases(): Canvas[] {
    return [...this.canvases.values()]
  }

  listAllCanvases(limit = 200) {
    const all = [...this.canvases.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      total: all.length,
      canvases: all.slice(0, limit).map((c) => ({
        ...this.toMeta(c),
        linkAccess: c.linkAccess ?? 'none',
        memberCount: c.memberIds?.length ?? 0,
      })),
    }
  }

  createCanvas(name: string, ownerId?: string, workspaceId?: string): Canvas {
    const now = Date.now()
    const canvas: Canvas = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now, frames: [] }
    if (workspaceId) canvas.workspaceId = workspaceId
    this.canvases.set(canvas.id, canvas)
    canvas.pages = canvasPages(canvas)
    persist.saveCanvas(canvas)
    return canvas
  }

  /** Copy reusable design content into a new private canvas. Collaboration,
   * activity, tasks, external connections and the gallery listing belong to
   * the source only. `name` defaults to "<source> copy"; `dropDemo` leaves
   * product-made onboarding frames behind (a gallery copy is the design,
   * not the welcome tour that happened to sit next to it); `workspaceId`
   * files the copy in a workspace (the caller checks membership). */
  async duplicateCanvas(
    id: string,
    ownerId: string,
    by: string,
    options: { name?: string; dropDemo?: boolean; workspaceId?: string } = {},
  ): Promise<Canvas | undefined> {
    const source = this.canvases.get(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    const sourceFrames = options.dropDemo ? source.frames.filter((frame) => !frame.demo) : source.frames
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    /* slide / speakerNotes ride along with the spread; who edited the source last does not */
    const frames = sourceFrames.map(({ updatedByUserId: _user, updatedByKind: _kind, ...frame }) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      canvasId,
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
      updatedBy: by,
    }))
    /* notes follow their frame; a note on a frame the copy dropped (demo) is dropped with it */
    const notes = source.notes
      ?.filter((note) => !note.frameId || frameIds.has(note.frameId))
      .map((note) => ({
        ...note,
        id: nanoid(10),
        canvasId,
        ...(note.frameId ? { frameId: frameIds.get(note.frameId)! } : {}),
        createdAt: now,
        updatedAt: now,
        updatedBy: by,
      }))
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const references = source.references?.map((ref) => ({
      ...ref,
      id: nanoid(10),
      frameId: frameIds.get(ref.frameId) ?? ref.frameId,
      pinnedBy: by,
      pinnedAt: now,
    }))
    const canvas: Canvas = {
      id: canvasId,
      name: options.name ?? `${source.name} copy`,
      ownerId,
      createdAt: now,
      updatedAt: now,
      frames,
      pages: canvasPages(source).map((page) => ({ ...page })),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
      ...(notes?.length ? { notes } : {}),
    }
    await persist.saveCanvasCopy(canvas)
    this.canvases.set(canvas.id, canvas)
    for (const frame of frames) this.frameIndex.set(frame.id, canvas.id)
    return canvas
  }

  /** Copy a page, every frame on it and its sticky notes (same names, geometry and html under fresh ids) into a new
   * page named "<source> copy" (numbered when that name is taken). A page with sub-pages is copied whole: the copy
   * keeps the source's parent, its sub-pages keep their shape under the new root, and the copy lands after the
   * source's last sub-page. Copies of one canvas run one after another so two at once cannot pick the same name or
   * overshoot the page limit; memory changes only once the copy is durable, as with duplicateCanvas. Rejects with
   * PageLimitError when the copy would not fit under the page limit. */
  duplicatePage(canvasId: string, pageId: string, by: string): Promise<PageCopy | undefined> {
    const previous = this.pageCopies.get(canvasId) ?? Promise.resolve()
    const task = previous.then(
      () => this.copyPage(canvasId, pageId, by),
      () => this.copyPage(canvasId, pageId, by),
    )
    this.pageCopies.set(canvasId, task)
    const release = () => {
      if (this.pageCopies.get(canvasId) === task) this.pageCopies.delete(canvasId)
    }
    void task.then(release, release)
    return task
  }

  private async copyPage(canvasId: string, pageId: string, by: string): Promise<PageCopy | undefined> {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    const source = pages.find((page) => page.id === pageId)
    if (!source) return undefined
    const subtree = [source, ...pageDescendants(pages, source.id)]
    /* the copy sits where the source does, so it is no deeper than the source and the depth limit holds */
    if (pages.length + subtree.length > MAX_PAGES) throw new PageLimitError()
    const now = Date.now()
    const pageIds = new Map(subtree.map((page) => [page.id, nanoid(10)]))
    const copies: CanvasPageInfo[] = subtree.map((page) => {
      const { parentId, ...rest } = page
      const id = pageIds.get(page.id)!
      if (page.id === source.id) {
        const root: CanvasPageInfo = { ...rest, id, name: copyPageName(source.name, names(pages)) }
        return parentId === undefined ? root : { ...root, parentId }
      }
      return { ...rest, id, parentId: pageIds.get(parentId!)! }
    })
    const page = copies[0]!
    const frameIds = new Map<string, string>()
    const frames: Frame[] = subtree.flatMap((sourcePage) =>
      pageFrames(canvas, sourcePage.id).map(({ updatedByUserId: _user, updatedByKind: _kind, ...frame }) => {
        const id = nanoid(10)
        frameIds.set(frame.id, id)
        return {
          ...frame,
          id,
          pageId: pageIds.get(sourcePage.id)!,
          createdAt: now,
          updatedAt: now,
          contentUpdatedAt: now,
          updatedBy: by,
        }
      }),
    )
    /* a note on a frame goes with the frame, a free note with its page */
    const notes: CanvasNote[] = (canvas.notes ?? []).flatMap((note) => {
      const frameId = note.frameId ? frameIds.get(note.frameId) : undefined
      const copiedPageId = note.pageId ? pageIds.get(note.pageId) : undefined
      if (note.frameId ? !frameId : !copiedPageId) return []
      const { frameId: _frame, pageId: _page, ...rest } = note
      return [
        {
          ...rest,
          id: nanoid(10),
          ...(frameId ? { frameId } : {}),
          ...(copiedPageId ? { pageId: copiedPageId } : {}),
          createdAt: now,
          updatedAt: now,
          updatedBy: by,
        },
      ]
    })
    const next = [...pages]
    next.splice(pages.indexOf(subtree[subtree.length - 1]!) + 1, 0, ...copies)
    await persist.savePageCopy({ ...canvas, pages: next, updatedAt: now }, frames, notes)
    if (this.canvases.get(canvasId) !== canvas) return undefined
    /* a page save may have landed during the write: slot the copy after the
       source's subtree wherever it is now (or last, if the source is gone),
       under a name the live list does not use */
    const live = canvasPages(canvas)
    if (names(live).includes(page.name)) page.name = copyPageName(source.name, names(live))
    if (page.parentId !== undefined && !live.some((candidate) => candidate.id === page.parentId)) delete page.parentId
    const liveSource = live.find((candidate) => candidate.id === pageId)
    const lastOfSource = liveSource ? (pageDescendants(live, pageId).at(-1) ?? liveSource) : undefined
    const at = lastOfSource ? live.indexOf(lastOfSource) + 1 : live.length
    canvas.pages = normalizePageTree([...live.slice(0, at), ...copies, ...live.slice(at)])
    canvas.frames.push(...frames)
    if (notes.length) (canvas.notes ??= []).push(...notes)
    for (const frame of frames) this.frameIndex.set(frame.id, canvasId)
    canvas.updatedAt = Math.max(canvas.updatedAt, now)
    if (!samePages(canvas.pages, next)) persist.saveCanvas(canvas)
    return { source, page, pages: canvas.pages, copiedPages: copies, frames, notes }
  }

  setPages(canvasId: string, pages: import('../shared/types.ts').CanvasPageInfo[]) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const firstId = canvasPages(canvas)[0]!.id
    for (const frame of canvas.frames) {
      if (!frame.pageId) {
        frame.pageId = firstId
        persist.saveFrame(frame, true)
      }
    }
    const normalized = normalizePageTree(pages)
    canvas.pages = normalized
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return normalized
  }

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
    this.domainGrants.delete(id)
    this.linkPasswordHashes.delete(id)
    persist.deleteCanvas(id)
    return c
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    c.ownerId = userId
    persist.saveCanvas(c)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: LinkAccess): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'none') delete c.linkAccess
    else c.linkAccess = mode
    persist.saveCanvas(c)
    return c
  }

  /** Who the share link admits ('signed-in' is the default and stored as unset). */
  setLinkAudience(id: string, audience: LinkAudience): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (audience === 'signed-in') delete c.linkAudience
    else c.linkAudience = audience
    persist.saveCanvas(c)
    return c
  }

  /** Set (a hash) or clear (null) the link password. The hash stays in the
   *  store's server-only map; the canvas only learns `hasLinkPassword`. */
  setLinkPasswordHash(id: string, hash: string | null): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (hash) {
      this.linkPasswordHashes.set(id, hash)
      c.hasLinkPassword = true
    } else {
      this.linkPasswordHashes.delete(id)
      delete c.hasLinkPassword
    }
    persist.saveLinkPasswordHash(id, hash)
    return c
  }

  getLinkPasswordHash(id: string): string | undefined {
    return this.linkPasswordHashes.get(id)
  }

  /* ---- sharing by email domain (server-only) ---- */

  getDomainGrants(canvasId: string): DomainGrant[] {
    return this.domainGrants.get(canvasId) ?? []
  }

  /** Grant everyone on an email domain a role; re-granting a domain changes its role. */
  setDomainGrant(canvasId: string, domain: string, role: MemberRole, addedBy: string): DomainGrant | undefined {
    if (!this.canvases.has(canvasId)) return undefined
    const clean = domain.trim().toLowerCase().replace(/^@/, '')
    if (!clean) return undefined
    const grants = this.domainGrants.get(canvasId) ?? []
    const grant: DomainGrant = { canvasId, domain: clean, role, addedBy, addedAt: Date.now() }
    this.domainGrants.set(canvasId, [...grants.filter((g) => g.domain !== clean), grant])
    void persist.saveDomainGrant(grant)
    return grant
  }

  removeDomainGrant(canvasId: string, domain: string): boolean {
    const clean = domain.trim().toLowerCase().replace(/^@/, '')
    const grants = this.domainGrants.get(canvasId) ?? []
    if (!grants.some((g) => g.domain === clean)) return false
    const rest = grants.filter((g) => g.domain !== clean)
    if (rest.length) this.domainGrants.set(canvasId, rest)
    else this.domainGrants.delete(canvasId)
    void persist.deleteDomainGrant(canvasId, clean)
    return true
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  setWorkspace(id: string, workspaceId: string | undefined): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    persist.saveCanvas(c)
    return c
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again. */
  detachWorkspace(workspaceId: string): void {
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        delete c.workspaceId
        persist.saveCanvas(c)
      }
    }
  }

  /* ---- community gallery ---- */

  /** List (or re-describe) a canvas in the gallery. Keeps the original
   *  publish date on edits so "newest" stays honest. Not a design edit, so
   *  updatedAt is left alone. */
  publishCanvas(id: string, listing: { description: string; category: CommunityCategory }): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.publishedAt ??= Date.now()
    c.category = listing.category
    if (listing.description) c.description = listing.description
    else delete c.description
    persist.saveCanvas(c)
    return c
  }

  unpublishCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    delete c.publishedAt
    delete c.description
    delete c.category
    persist.saveCanvas(c)
    return c
  }

  /** Every published canvas, newest listing first. Access is deliberately
   *  not a question here: publishing is the owner's opt-in, and the gallery
   *  exposes previews and copies, never the canvas itself. */
  listPublished(): Canvas[] {
    return [...this.canvases.values()]
      .filter((c) => c.publishedAt !== undefined)
      .sort((a, b) => b.publishedAt! - a.publishedAt!)
  }

  /** A gallery copy went out — the trending signal. */
  recordCommunityCopy(id: string) {
    const c = this.canvases.get(id)
    if (!c) return
    c.copyCount = (c.copyCount ?? 0) + 1
    persist.saveCanvas(c)
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed.
   *  `role` defaults to 'edit', what every invite meant before roles existed. */
  addMember(canvasId: string, userId: string, addedBy: string, role: MemberRole = 'edit'): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!(c.memberIds ??= []).includes(userId)) {
      c.memberIds.push(userId)
      if (role !== 'edit') (c.memberRoles ??= {})[userId] = role
      persist.saveMember(canvasId, userId, addedBy, Date.now(), role)
    }
    return c
  }

  /** The role an invited user holds; undefined when they are not a member. */
  memberRole(canvasId: string, userId: string): MemberRole | undefined {
    const c = this.canvases.get(canvasId)
    if (!c?.memberIds?.includes(userId)) return undefined
    return c.memberRoles?.[userId] ?? 'edit'
  }

  /** Change an existing member's role. False when they are not a member. */
  setMemberRole(canvasId: string, userId: string, role: MemberRole): boolean {
    const c = this.canvases.get(canvasId)
    if (!c?.memberIds?.includes(userId)) return false
    if (role === 'edit') {
      if (c.memberRoles) {
        delete c.memberRoles[userId]
        if (Object.keys(c.memberRoles).length === 0) delete c.memberRoles
      }
    } else (c.memberRoles ??= {})[userId] = role
    persist.saveMemberRole(canvasId, userId, role)
    return true
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
    if (c.memberRoles) {
      delete c.memberRoles[userId]
      if (Object.keys(c.memberRoles).length === 0) delete c.memberRoles
    }
    persist.deleteMember(canvasId, userId)
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.name = name
    c.updatedAt = Date.now()
    persist.saveCanvas(c)
    return c
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const docs = (c.guidelines ??= [])
    const now = Date.now()
    let doc = docs.find((d) => d.name === name)
    if (doc) {
      doc.markdown = markdown
      doc.updatedAt = now
      doc.updatedBy = by
      if (pos) Object.assign(doc, pos)
      if (title !== undefined) doc.title = title || undefined
    } else {
      const placed = pos ?? this.placeGuideline(c, docs.length)
      doc = { name, markdown, ...(title ? { title } : {}), updatedAt: now, updatedBy: by, ...placed }
      docs.push(doc)
      docs.sort((a, b) => a.name.localeCompare(b.name))
    }
    c.updatedAt = now
    persist.saveGuideline(canvasId, doc)
    persist.saveCanvas(c)
    return doc
  }

  private placeGuideline(c: Canvas, index: number): { x: number; y: number } {
    const CARD_W = 360
    if (!c.frames.length) return { x: 120, y: 120 + index * 380 }
    const minX = Math.min(...c.frames.map((f) => f.x))
    const minY = Math.min(...c.frames.map((f) => f.y))
    return { x: minX - CARD_W - 100, y: minY + index * 380 }
  }

  /** Patch card position / display title; content and history stay untouched. */
  patchGuideline(
    canvasId: string,
    name: string,
    patch: { x?: number; y?: number; title?: string },
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    const doc = c?.guidelines?.find((d) => d.name === name)
    if (!c || !doc) return undefined
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    persist.saveGuideline(canvasId, doc)
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    persist.deleteGuideline(canvasId, name)
    persist.saveCanvas(c)
    return true
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its HTML now, decoupled from the frame. */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    ;(c.references ??= []).unshift(ref)
    persist.saveReference(canvasId, ref)
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    const [ref] = c.references!.splice(idx, 1)
    persist.deleteReference(id)
    return ref
  }

  getFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    return this.canvases.get(canvasId)?.frames.find((f) => f.id === frameId)
  }

  createFrame(
    canvasId: string,
    input: {
      name: string
      pageId?: string
      x?: number
      y?: number
      width?: number
      height?: number
      html?: string
      demo?: boolean
      slide?: boolean
      speakerNotes?: string
      hidden?: boolean
      locked?: boolean
    },
    by: string,
    editor: EditorInfo = {},
  ): Frame | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const pageId = input.pageId ?? canvasPages(c)[0]!.id
    if (!canvasPages(c).some((page) => page.id === pageId)) return undefined
    const now = Date.now()
    const { x, y } = placeNewFrame(pageFrames(c, pageId), input.x, input.y)
    const frame: Frame = {
      id: nanoid(10),
      canvasId,
      pageId,
      name: input.name,
      x,
      y,
      width: input.width ?? defaultFrameSize(input.slide).width,
      height: input.height ?? defaultFrameSize(input.slide).height,
      html: input.html ?? '',
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
      updatedBy: by,
    }
    if (editor.userId) frame.updatedByUserId = editor.userId
    if (editor.kind) frame.updatedByKind = editor.kind
    if (input.demo) frame.demo = true
    if (input.slide) frame.slide = true
    if (input.speakerNotes) frame.speakerNotes = input.speakerNotes
    if (input.hidden) frame.hidden = true
    if (input.locked) frame.locked = true
    c.frames.push(frame)
    c.updatedAt = now
    this.frameIndex.set(frame.id, canvasId)
    persist.saveFrame(frame, true)
    persist.saveCanvas(c)
    return frame
  }

  updateFrame(
    frameId: string,
    patch: Partial<
      Pick<
        Frame,
        'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'slide' | 'speakerNotes' | 'hidden' | 'locked'
      >
    >,
    by: string,
    editor: EditorInfo = {},
  ): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    if (
      patch.pageId !== undefined &&
      !canvasPages(this.canvases.get(frame.canvasId)!).some((p) => p.id === patch.pageId)
    )
      return undefined
    /* a design change is html or the name; a move, resize or page move touches updatedAt only. The review marks follow
       the design stamp, so shuffling frames around never reads as someone having changed them. */
    const designChanged =
      (patch.html !== undefined && patch.html !== frame.html) || (patch.name !== undefined && patch.name !== frame.name)
    /* a frame from before the stamp existed keeps the time it last changed as its design time, frozen before this bump */
    if (!designChanged) frame.contentUpdatedAt ??= frame.updatedAt
    Object.assign(frame, patch)
    // Also serves as the optimistic-save version, including writes in the same millisecond.
    frame.updatedAt = Math.max(Date.now(), frame.updatedAt + 1)
    if (designChanged) {
      frame.contentUpdatedAt = frame.updatedAt
      frame.updatedBy = by
      /* attribution describes the latest design edit, so a stale account id never outlives its name */
      if (editor.userId) frame.updatedByUserId = editor.userId
      else delete frame.updatedByUserId
      if (editor.kind) frame.updatedByKind = editor.kind
      else delete frame.updatedByKind
    }
    if (frame.slide === false) delete frame.slide
    if (!frame.speakerNotes) delete frame.speakerNotes
    const c = this.canvases.get(frame.canvasId)!
    c.updatedAt = frame.updatedAt
    persist.saveFrame(frame) // debounced: streaming appends land as one write per burst
    persist.saveCanvas(c)
    return frame
  }

  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    const [frame] = c.frames.splice(idx, 1)
    c.updatedAt = Date.now()
    this.frameIndex.delete(frameId)
    persist.deleteFrame(frameId)
    /* a note attached to the frame goes with it; free-floating notes stay */
    for (const note of (c.notes ?? []).filter((n) => n.frameId === frameId)) this.deleteNote(canvasId, note.id)
    persist.saveCanvas(c)
    return frame
  }

  /** Move a frame to a page of another canvas, keeping its id and everything on it. Attached sticky notes follow,
   *  shifted by the frame's own delta; the frame's design history and review state are re-pointed in the database. */
  moveFrame(
    frameId: string,
    targetCanvasId: string,
    where: { pageId?: string; x?: number; y?: number },
    by: string,
    editor: EditorInfo = {},
  ): FrameMove | undefined {
    const sourceId = this.frameIndex.get(frameId)
    const source = sourceId ? this.canvases.get(sourceId) : undefined
    const target = this.canvases.get(targetCanvasId)
    const frame = source?.frames.find((f) => f.id === frameId)
    if (!source || !target || !frame || source === target) return undefined
    const pageId = where.pageId ?? canvasPages(target)[0]!.id
    if (!canvasPages(target).some((page) => page.id === pageId)) return undefined

    const { x, y } = placeNewFrame(pageFrames(target, pageId), where.x, where.y)
    const dx = x - frame.x
    const dy = y - frame.y
    const now = Date.now()

    source.frames.splice(source.frames.indexOf(frame), 1)
    const leaving = (source.notes ?? []).filter((n) => n.frameId === frameId)
    if (source.notes) {
      source.notes = source.notes.filter((n) => n.frameId !== frameId)
      if (source.notes.length === 0) delete source.notes
    }
    const notes = leaving.map((note) => {
      Object.assign(note, { canvasId: targetCanvasId, pageId, x: note.x + dx, y: note.y + dy })
      note.updatedAt = now
      note.updatedBy = by
      return note
    })
    if (notes.length) (target.notes ??= []).push(...notes)

    Object.assign(frame, { canvasId: targetCanvasId, pageId, x, y })
    /* the monotonic stamp updateFrame uses, so a save racing the move cannot share its version */
    frame.updatedAt = Math.max(now, frame.updatedAt + 1)
    /* a move is not a design change: contentUpdatedAt (what the review marks follow) stays as it was */
    frame.contentUpdatedAt ??= frame.updatedAt
    frame.updatedBy = by
    if (editor.userId) frame.updatedByUserId = editor.userId
    else delete frame.updatedByUserId
    if (editor.kind) frame.updatedByKind = editor.kind
    else delete frame.updatedByKind
    target.frames.push(frame)
    this.frameIndex.set(frameId, targetCanvasId)

    source.updatedAt = frame.updatedAt
    target.updatedAt = frame.updatedAt
    persist.saveFrameMove(frame, notes)
    persist.saveCanvas(source)
    persist.saveCanvas(target)
    return { frame, source, target, notes }
  }

  /* ---- sticky notes ---- */

  getNotes(canvasId: string): CanvasNote[] {
    return this.canvases.get(canvasId)?.notes ?? []
  }

  /** The note with this id and the canvas it lives on, wherever it is. */
  findNote(id: string): { note: CanvasNote; canvasId: string } | undefined {
    for (const c of this.canvases.values()) {
      const note = c.notes?.find((n) => n.id === id)
      if (note) return { note, canvasId: c.id }
    }
    return undefined
  }

  createNote(canvasId: string, input: NoteInput, by: string, byUserId?: string): CanvasNote | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    if (input.frameId && this.frameIndex.get(input.frameId) !== canvasId) return undefined
    if (input.pageId && !canvasPages(c).some((page) => page.id === input.pageId)) return undefined
    const now = Date.now()
    const note: CanvasNote = {
      id: nanoid(10),
      canvasId,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.frameId ? { frameId: input.frameId } : {}),
      x: input.x ?? 120,
      y: input.y ?? 120,
      width: input.width ?? NOTE_DEFAULT_SIZE.width,
      height: input.height ?? NOTE_DEFAULT_SIZE.height,
      markdown: input.markdown ?? '',
      color: input.color ?? DEFAULT_NOTE_COLOR,
      createdBy: by,
      ...(byUserId ? { createdByUserId: byUserId } : {}),
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }
    ;(c.notes ??= []).push(note)
    c.updatedAt = now
    void persist.saveNote(note)
    persist.saveCanvas(c)
    return note
  }

  updateNote(
    canvasId: string,
    id: string,
    patch: Partial<Pick<CanvasNote, 'x' | 'y' | 'width' | 'height' | 'markdown' | 'color'>>,
    by: string,
  ): CanvasNote | undefined {
    const c = this.canvases.get(canvasId)
    const note = c?.notes?.find((n) => n.id === id)
    if (!c || !note) return undefined
    Object.assign(note, patch)
    note.updatedAt = Date.now()
    note.updatedBy = by
    c.updatedAt = note.updatedAt
    void persist.saveNote(note)
    persist.saveCanvas(c)
    return note
  }

  deleteNote(canvasId: string, id: string): CanvasNote | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.notes?.findIndex((n) => n.id === id) ?? -1
    if (!c || idx === -1) return undefined
    const [note] = c.notes!.splice(idx, 1)
    if (c.notes!.length === 0) delete c.notes
    c.updatedAt = Date.now()
    void persist.deleteNote(id)
    persist.saveCanvas(c)
    return note
  }
}

export const store = new Store()
