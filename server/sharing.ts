import express from 'express'
import { eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import { env } from './env.ts'
import * as authSchema from './db/auth-schema.ts'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as workspaces from './workspaces.ts'
import { canvasRole, canManageCanvas, canView, guestRole, type AccessContext, type AccessUser } from './access.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { canvasLink } from './links.ts'
import {
  decoyHash,
  hashLinkPassword,
  hasUnlock,
  passwordProblem,
  signUnlockToken,
  unlockCookieName,
  unlockCookieOptions,
  verifyLinkPassword,
} from './linkAccess.ts'
import { clientIp, createRateLimiter } from './rateLimit.ts'
import { mentionedRole } from '../shared/agents.ts'
import { canvasPages } from '../shared/pages.ts'
import {
  AGENT_REQUEST_NOTICE,
  isMemberRole,
  roleAtLeast,
  type AccessRequestInfo,
  type Canvas,
  type CanvasRole,
  type ElementComment,
  type LinkAccess,
  type LinkAudience,
  type ServerMessage,
} from '../shared/types.ts'

/**
 * Everything sharing adds on top of the access resolver (server/access.ts):
 * the REST gates every route uses, the owner's controls (link access and
 * audience, link password, member roles, domain grants), access requests,
 * the people the @mention picker offers, and the few public endpoints a
 * signed-out visitor can reach (the link-password gate and guest comments).
 */

/* ---- hooks into the realtime layer (server/index.ts owns the sockets) ---- */

interface SharingHooks {
  /** re-resolve every open connection of a canvas after its sharing changed */
  refreshAccess(canvasId: string): void
  /** send one message to every connection of these accounts on a canvas */
  sendToUsers(canvasId: string, userIds: readonly string[], msg: ServerMessage): void
}
let hooks: SharingHooks = { refreshAccess: () => {}, sendToUsers: () => {} }
export function wireSharing(next: SharingHooks) {
  hooks = next
}
export const refreshAccess = (canvasId: string) => hooks.refreshAccess(canvasId)
export const sendToUsers = (canvasId: string, userIds: readonly string[], msg: ServerMessage) =>
  hooks.sendToUsers(canvasId, userIds, msg)

/* ---- who is asking ---- */

/** The signed-in user as the resolver sees them. */
export function accessUserOf(req: express.Request): AccessUser | undefined {
  const u = req.user
  return u ? { id: u.id, email: u.email, emailVerified: u.emailVerified, banned: u.banned } : undefined
}

/** Does the request carry a valid unlock cookie for this canvas's link password? */
export function unlockedByCookie(canvas: Canvas, cookieHeader: string | undefined): boolean {
  return hasUnlock(canvas.id, store.getLinkPasswordHash(canvas.id), cookieHeader)
}

export function unlockedFor(req: Pick<express.Request, 'headers'>, canvas: Canvas): boolean {
  return unlockedByCookie(canvas, req.headers.cookie)
}

export function contextFor(req: Pick<express.Request, 'headers'>, canvas: Canvas): AccessContext {
  return { unlocked: unlockedFor(req, canvas) }
}

export function roleFor(req: express.Request, canvas: Canvas): CanvasRole | null {
  return canvasRole(accessUserOf(req), canvas, contextFor(req, canvas))
}

const ROLE_WORDS: Record<CanvasRole, string> = {
  view: 'view-only access',
  comment: 'comment-only access',
  edit: 'edit access',
  owner: 'owner access',
}

/** Resolve a canvas for a REST route and require at least `min`. Writes the
 *  error response itself and returns null when the request is refused. */
export function requireCanvas(req: express.Request, res: express.Response, canvasId: string, min: CanvasRole = 'view') {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) {
    res.status(404).json({ error: 'not found' })
    return null
  }
  const role = roleFor(req, canvas)
  if (!role) {
    res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
    return null
  }
  if (!roleAtLeast(role, min)) {
    res.status(403).json({ error: `you have ${ROLE_WORDS[role]} on this canvas`, role })
    return null
  }
  return canvas
}

export function requireFrame(req: express.Request, res: express.Response, frameId: string, min: CanvasRole = 'view') {
  const frame = store.getFrame(frameId)
  if (!frame) {
    res.status(404).json({ error: 'frame not found' })
    return null
  }
  return requireCanvas(req, res, frame.canvasId, min) ? frame : null
}

/* ---- accounts ---- */

interface Person {
  id: string
  name: string
  email: string
  emailVerified: boolean
  banned: boolean
}

async function peopleByIds(ids: readonly string[]): Promise<Map<string, Person>> {
  if (!ids.length) return new Map()
  const rows = await db
    .select({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      emailVerified: authSchema.user.emailVerified,
      banned: authSchema.user.banned,
    })
    .from(authSchema.user)
    .where(inArray(authSchema.user.id, [...ids]))
  return new Map(rows.map((r) => [r.id, { ...r, emailVerified: !!r.emailVerified, banned: !!r.banned }]))
}

/** The accounts that can answer an access request: the owner, and the owner
 *  and admins of the canvas's workspace. */
export function canvasManagerIds(canvas: Canvas): string[] {
  const ids = new Set<string>()
  if (canvas.ownerId) ids.add(canvas.ownerId)
  if (canvas.workspaceId) {
    for (const id of workspaces.workspaceMemberIds(canvas.workspaceId)) {
      if (workspaces.hasRole(canvas.workspaceId, id, 'admin')) ids.add(id)
    }
  }
  return [...ids]
}

/* ---- people @mentions ---- */

/** Everyone who can view the canvas and might be @mentioned: the owner,
 *  members, the workspace's members and the people who already wrote in its
 *  threads. Each is re-checked against the resolver (a banned or removed
 *  account never shows). Link-only visitors who never commented are not
 *  listed: the server knows nothing durable about them. */
export async function viewablePeople(canvas: Canvas): Promise<{ userId: string; name: string }[]> {
  const ids = new Set<string>()
  if (canvas.ownerId) ids.add(canvas.ownerId)
  for (const id of canvas.memberIds ?? []) ids.add(id)
  if (canvas.workspaceId) for (const id of workspaces.workspaceMemberIds(canvas.workspaceId)) ids.add(id)
  for (const c of actions.getComments(canvas.id)) if (c.fromUserId) ids.add(c.fromUserId)
  const people = await peopleByIds([...ids])
  return [...people.values()]
    .filter((p) => canView(p, canvas))
    .map((p) => ({ userId: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Keep the mentioned account ids that name a person who can view the canvas
 *  AND whose `@name` actually appears in the text; drop every other id
 *  silently. Order of first mention in the list is kept. */
export async function validMentions(canvas: Canvas, text: string, claimed: unknown): Promise<string[]> {
  if (!Array.isArray(claimed)) return []
  const ids = [...new Set(claimed.filter((id): id is string => typeof id === 'string'))].slice(0, 10)
  if (!ids.length) return []
  const people = await peopleByIds(ids)
  const lower = text.toLowerCase()
  const kept: string[] = []
  for (const id of ids) {
    const person = people.get(id)
    if (!person || !canView(person, canvas)) continue
    if (!lower.includes(`@${person.name.toLowerCase()}`)) continue
    kept.push(id)
  }
  return kept
}

/** The notice for a comment that tried to ask an agent for something the
 *  author may not request, or undefined when nothing was held back. */
export function agentNotice(text: string, role: CanvasRole | null): string | undefined {
  return mentionedRole(text) && !roleAtLeast(role, 'edit') ? AGENT_REQUEST_NOTICE : undefined
}

/* ---- the owner's link settings ---- */

const LINK_ACCESS: readonly LinkAccess[] = ['none', 'view', 'comment', 'edit']
const LINK_AUDIENCES: readonly LinkAudience[] = ['signed-in', 'anyone', 'password']

export interface LinkSettingsInput {
  linkAccess?: unknown
  linkAudience?: unknown
  /** a new password, or null to remove it */
  linkPassword?: unknown
}

/** Validate and apply the owner's link settings. Returns an error message
 *  (a 400) or undefined once applied. */
export async function applyLinkSettings(canvas: Canvas, input: LinkSettingsInput): Promise<string | undefined> {
  const { linkAccess, linkAudience, linkPassword } = input
  if (linkAccess !== undefined && !LINK_ACCESS.includes(linkAccess as LinkAccess))
    return 'linkAccess must be "none", "view", "comment" or "edit"'
  if (linkAudience !== undefined && !LINK_AUDIENCES.includes(linkAudience as LinkAudience))
    return 'linkAudience must be "signed-in", "anyone" or "password"'
  if (linkPassword !== undefined && linkPassword !== null) {
    const problem = passwordProblem(linkPassword)
    if (problem) return problem
  }
  const audience = (linkAudience as LinkAudience | undefined) ?? canvas.linkAudience ?? 'signed-in'
  const willHavePassword = linkPassword === null ? false : linkPassword !== undefined ? true : !!canvas.hasLinkPassword
  if (linkAudience === 'password' && !willHavePassword)
    return 'Set a password before choosing a password-protected link.'
  /* hash first: a failure must leave every setting as it was */
  const hash = typeof linkPassword === 'string' ? await hashLinkPassword(linkPassword) : undefined
  if (linkAccess !== undefined) store.setLinkAccess(canvas.id, linkAccess as LinkAccess)
  if (hash) store.setLinkPasswordHash(canvas.id, hash)
  else if (linkPassword === null) store.setLinkPasswordHash(canvas.id, null)
  /* a link with no password cannot stay password-protected */
  const nextAudience = !willHavePassword && audience === 'password' ? 'signed-in' : audience
  if (linkAudience !== undefined || nextAudience !== (canvas.linkAudience ?? 'signed-in')) {
    store.setLinkAudience(canvas.id, nextAudience)
  }
  refreshAccess(canvas.id)
  return undefined
}

/* ---- access requests ---- */

/** Pending asks nobody answered in 30 days go away; run at boot and on a timer. */
export function startAccessRequestExpiry() {
  const sweep = () => persist.expireAccessRequests(Date.now()).catch((e) => console.error('[access] expiry failed', e))
  void sweep()
  setInterval(sweep, 6 * 60 * 60 * 1000).unref()
}

const requestsPerUser = createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 })

async function notifyManagers(canvas: Canvas, request: AccessRequestInfo) {
  const managers = canvasManagerIds(canvas)
  sendToUsers(canvas.id, managers, { type: 'access:request', request })
  const people = await peopleByIds(managers)
  const note = request.message ? `\n\nThey wrote:\n  “${request.message.replace(/\n/g, '\n  ')}”` : ''
  for (const manager of people.values()) {
    if (manager.banned || !(mailerConfigured || env.NODE_ENV !== 'production')) continue
    sendMail({
      to: manager.email,
      subject: `${request.name} asked for access to “${canvas.name}”`,
      text: `Hi ${manager.name || 'there'},\n\n${request.name} (${request.email}) asked for access to “${canvas.name}”.${note}\n\nOpen the canvas and choose Share to approve or decline: ${canvasLink(canvas.id)}\n`,
    }).catch((err) => console.error(`[access] request email to ${manager.id} failed`, err))
  }
}

/* ---- the signed-in sharing routes (mounted under /api/canvases) ---- */

export const sharingRouter = express.Router()

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function ownerOnly(req: express.Request, res: express.Response, canvasId: string, what: string) {
  const canvas = requireCanvas(req, res, canvasId, 'view')
  if (!canvas) return null
  if (canvas.ownerId !== req.user!.id) {
    res.status(403).json({ error: `only the owner can ${what}` })
    return null
  }
  return canvas
}

/* the mention picker: names and ids only, never addresses */
sharingRouter.get('/:id/people', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'comment')
  if (!canvas) return
  res.json(await viewablePeople(canvas))
})

/* domain grants: everyone with a verified address on a domain gets a role */
sharingRouter.get('/:id/domains', (req, res) => {
  const canvas = ownerOnly(req, res, req.params.id, 'manage domain sharing')
  if (!canvas) return
  res.json({ grants: store.getDomainGrants(canvas.id), verifiedOnly: true, mailer: mailerConfigured })
})

sharingRouter.put('/:id/domains', (req, res) => {
  const canvas = ownerOnly(req, res, req.params.id, 'manage domain sharing')
  if (!canvas) return
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase().replace(/^@/, '') : ''
  if (!DOMAIN.test(domain) || domain.length > 253)
    return res.status(400).json({ error: 'enter a domain like acme.com' })
  if (!isMemberRole(req.body?.role)) return res.status(400).json({ error: 'role must be view, comment or edit' })
  const grant = store.setDomainGrant(canvas.id, domain, req.body.role, req.user!.id)
  if (!grant) return res.status(400).json({ error: 'could not save the domain' })
  refreshAccess(canvas.id)
  res.json(grant)
})

sharingRouter.delete('/:id/domains/:domain', (req, res) => {
  const canvas = ownerOnly(req, res, req.params.id, 'manage domain sharing')
  if (!canvas) return
  if (!store.removeDomainGrant(canvas.id, req.params.domain)) return res.status(404).json({ error: 'no such domain' })
  refreshAccess(canvas.id)
  res.json({ ok: true })
})

/* what the no-access page needs: is a password offered, and has this person already asked */
sharingRouter.get('/:id/gate', async (req, res) => {
  const canvas = store.getCanvas(req.params.id)
  if (!canvas) return res.status(404).json({ error: 'not found' })
  const role = roleFor(req, canvas)
  if (role) return res.json({ access: true })
  const requests = await persist.listAccessRequests(canvas.id)
  const mine = requests.find((r) => r.userId === req.user!.id)
  res.json({
    access: false,
    passwordRequired: (canvas.linkAccess ?? 'none') !== 'none' && canvas.linkAudience === 'password',
    requested: !!mine,
  })
})

sharingRouter.post('/:id/access-requests', async (req, res) => {
  const canvas = store.getCanvas(req.params.id)
  if (!canvas) return res.status(404).json({ error: 'not found' })
  if (roleFor(req, canvas)) return res.status(409).json({ error: 'you already have access to this canvas' })
  const me = req.user!
  if (!requestsPerUser.take(me.id)) return res.status(429).json({ error: 'too many requests — try again later' })
  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 500) : ''
  /* one row per person per canvas. A repeat changes nothing and tells no one
     again; a declined asker sees the same confirmation as anyone else */
  const existing = (await persist.listAccessRequests(canvas.id)).find((r) => r.userId === me.id)
  if (existing) return res.json({ ok: true })
  const request = { canvasId: canvas.id, userId: me.id, ...(message ? { message } : {}), at: Date.now() }
  await persist.saveAccessRequest({ ...request, status: 'pending' })
  void notifyManagers(canvas, { ...request, status: 'pending', name: me.name, email: me.email })
  res.json({ ok: true })
})

sharingRouter.get('/:id/access-requests', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  if (!canManageCanvas(req.user!.id, canvas))
    return res.status(403).json({ error: 'only the owner can see access requests' })
  const pending = (await persist.listAccessRequests(canvas.id)).filter((r) => r.status === 'pending')
  const people = await peopleByIds(pending.map((r) => r.userId))
  res.json(
    pending.flatMap((r): AccessRequestInfo[] => {
      const p = people.get(r.userId)
      return p && !p.banned ? [{ ...r, name: p.name, email: p.email }] : []
    }),
  )
})

sharingRouter.post('/:id/access-requests/:userId/approve', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  if (!canManageCanvas(req.user!.id, canvas))
    return res.status(403).json({ error: 'only the owner can approve access requests' })
  const role: unknown = req.body?.role ?? 'view'
  if (!isMemberRole(role)) return res.status(400).json({ error: 'role must be view, comment or edit' })
  const asked = (await persist.listAccessRequests(canvas.id)).find(
    (r) => r.userId === req.params.userId && r.status === 'pending',
  )
  if (!asked) return res.status(404).json({ error: 'no pending request from that person' })
  /* the row goes first: a half-finished approval must not leave a request that grants nothing */
  await persist.deleteAccessRequest(canvas.id, asked.userId)
  if (asked.userId !== canvas.ownerId) {
    if (store.memberRole(canvas.id, asked.userId)) store.setMemberRole(canvas.id, asked.userId, role)
    else store.addMember(canvas.id, asked.userId, req.user!.id, role)
  }
  refreshAccess(canvas.id)
  const [person] = [...(await peopleByIds([asked.userId])).values()]
  if (person && !person.banned) {
    sendMail({
      to: person.email,
      subject: `You now have access to “${canvas.name}”`,
      text: `Hi ${person.name || 'there'},\n\n${req.user!.name} gave you ${role === 'edit' ? 'edit' : role === 'comment' ? 'comment' : 'view'} access to “${canvas.name}”.\n\nOpen it: ${canvasLink(canvas.id)}\n`,
    }).catch((err) => console.error(`[access] approval email to ${person.id} failed`, err))
  }
  res.json({ ok: true, userId: asked.userId, role })
})

sharingRouter.post('/:id/access-requests/:userId/decline', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  if (!canManageCanvas(req.user!.id, canvas))
    return res.status(403).json({ error: 'only the owner can decline access requests' })
  const asked = (await persist.listAccessRequests(canvas.id)).find(
    (r) => r.userId === req.params.userId && r.status === 'pending',
  )
  if (!asked) return res.status(404).json({ error: 'no pending request from that person' })
  /* silent to the asker: the row stays as "declined" so they cannot re-ask at once */
  await persist.saveAccessRequest({ ...asked, status: 'declined' })
  res.json({ ok: true })
})

/* ---- members and their roles ---- */

sharingRouter.get('/:id/members', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id)
  if (!canvas) return
  const ids = [...(canvas.ownerId ? [canvas.ownerId] : []), ...(canvas.memberIds ?? [])]
  const people = await peopleByIds(ids)
  const isOwner = canvas.ownerId === req.user!.id
  res.json(
    ids.map((id) => ({
      userId: id,
      name: people.get(id)?.name ?? 'Unknown',
      /* addresses are the owner's to see; everyone else gets names */
      email: isOwner || id === req.user!.id ? (people.get(id)?.email ?? '') : '',
      owner: id === canvas.ownerId,
      role: id === canvas.ownerId ? 'owner' : (store.memberRole(canvas.id, id) ?? 'edit'),
    })),
  )
})

sharingRouter.post('/:id/members', async (req, res) => {
  const canvas = ownerOnly(req, res, req.params.id, 'invite people')
  if (!canvas) return
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const role: unknown = req.body?.role ?? 'edit'
  if (!isMemberRole(role)) return res.status(400).json({ error: 'role must be view, comment or edit' })
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (!row) return res.status(404).json({ error: 'no doop account with that email — ask them to sign up first' })
  if (row.id === canvas.ownerId) return res.status(400).json({ error: 'the owner already has access' })
  store.addMember(canvas.id, row.id, req.user!.id, role)
  /* inviting someone who had asked to come in answers their request */
  await persist.deleteAccessRequest(canvas.id, row.id)
  refreshAccess(canvas.id)
  res.json({
    userId: row.id,
    name: row.name,
    email: row.email,
    owner: false,
    role: store.memberRole(canvas.id, row.id),
  })
})

sharingRouter.patch('/:id/members/:userId', (req, res) => {
  const canvas = ownerOnly(req, res, req.params.id, 'change roles')
  if (!canvas) return
  if (!isMemberRole(req.body?.role)) return res.status(400).json({ error: 'role must be view, comment or edit' })
  if (!store.setMemberRole(canvas.id, req.params.userId, req.body.role))
    return res.status(404).json({ error: 'not a collaborator' })
  refreshAccess(canvas.id)
  res.json({ ok: true, role: req.body.role })
})

sharingRouter.delete('/:id/members/:userId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id)
  if (!canvas) return
  if (canvas.ownerId !== req.user!.id && req.params.userId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner can remove collaborators' })
  if (!store.removeMember(canvas.id, req.params.userId)) return res.status(404).json({ error: 'not a collaborator' })
  refreshAccess(canvas.id)
  res.json({ ok: true })
})

/* ---- public endpoints: no session required (mounted under /api/public) ---- */

export const publicRouter = express.Router()

/** Guests are throttled hard: a public link must not be a free spam relay. */
const guestPerMinute = createRateLimiter({ max: 6, windowMs: 60_000 })
const guestPerHour = createRateLimiter({ max: 40, windowMs: 60 * 60_000 })
const guestPerCanvasHour = createRateLimiter({ max: 150, windowMs: 60 * 60_000 })
const unlockPerCanvas = createRateLimiter({ max: 8, windowMs: 10 * 60_000 })
const unlockPerIp = createRateLimiter({ max: 40, windowMs: 10 * 60_000 })

/** Exposed so tests can drive the limits without waiting out the windows. */
export const limiters = { guestPerMinute, guestPerHour, guestPerCanvasHour, unlockPerCanvas, unlockPerIp }

export const GUEST_MARK = ' (guest)'
export const MAX_GUEST_NAME = 40

/** A visitor's display name: control characters out, whitespace collapsed,
 *  any "(guest)" they typed themselves removed (the server adds the real
 *  marker), then the marker appended. Null when nothing usable is left. */
export function guestDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\(\s*guest\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GUEST_NAME)
    .trim()
  return clean ? `${clean}${GUEST_MARK}` : null
}

/* Is this canvas reachable without an account, and what stands in the way?
   'open': the link admits guests (any password already entered). 'password':
   a password is needed first. 'signin': nothing public here, so the page asks
   for an account exactly as it does for a private canvas. Missing and private
   canvases answer identically. */
publicRouter.get('/canvas/:id', (req, res) => {
  const canvas = store.getCanvas(req.params.id)
  res.set('Cache-Control', 'no-store')
  if (!canvas || !canvas.ownerId || (canvas.linkAccess ?? 'none') === 'none') return res.json({ mode: 'signin' })
  if (canvas.linkAudience === 'password') {
    return res.json({ mode: unlockedFor(req, canvas) ? 'open' : 'password' })
  }
  res.json({ mode: canvas.linkAudience === 'anyone' ? 'open' : 'signin' })
})

publicRouter.post('/canvas/:id/unlock', async (req, res) => {
  const ip = clientIp(req)
  const key = `${ip}|${req.params.id}`
  if (!unlockPerCanvas.take(key) || !unlockPerIp.take(ip)) {
    res.set('Retry-After', String(Math.max(unlockPerCanvas.retryAfter(key), unlockPerIp.retryAfter(ip), 1)))
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' })
  }
  const canvas = store.getCanvas(req.params.id)
  const stored = canvas ? store.getLinkPasswordHash(canvas.id) : undefined
  const offered = canvas && canvas.linkAudience === 'password' && (canvas.linkAccess ?? 'none') !== 'none'
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 1000) : ''
  /* a missing canvas or an unprotected one costs the same hash as a wrong guess */
  const ok = await verifyLinkPassword(password, offered && stored ? stored : await decoyHash())
  if (!ok || !canvas || !offered || !stored) return res.status(401).json({ error: 'Incorrect password.' })
  unlockPerCanvas.reset(key)
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.cookie(unlockCookieName(canvas.id), signUnlockToken(canvas.id, stored), unlockCookieOptions(secure))
  res.json({ ok: true })
})

/* Guest comments. A guest is a signed-out visitor on an anyone-with-the-link
   canvas: they may comment and reply (never resolve, never ask an agent for
   changes), as a name they chose, marked "(guest)", with no account id. */
function guestGate(req: express.Request, res: express.Response, canvasId: string): Canvas | null {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || guestRole(canvas, contextFor(req, canvas)) !== 'comment') {
    res.status(403).json({ error: 'comments are not open to guests on this canvas' })
    return null
  }
  return canvas
}

function guestThrottle(req: express.Request, res: express.Response, canvasId: string): boolean {
  const ip = clientIp(req)
  if (guestPerMinute.take(ip) && guestPerHour.take(ip) && guestPerCanvasHour.take(canvasId)) return true
  res.set('Retry-After', String(Math.max(guestPerMinute.retryAfter(ip), guestPerHour.retryAfter(ip), 1)))
  res.status(429).json({ error: 'You are commenting too fast. Wait a moment and try again.' })
  return false
}

const MAX_GUEST_COMMENT = 2000

function withNotice(comment: ElementComment, text: string): ElementComment & { notice?: string } {
  const notice = agentNotice(text, 'comment')
  return notice ? { ...comment, notice } : comment
}

publicRouter.post('/frames/:id/comments', (req, res) => {
  const frame = store.getFrame(req.params.id)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  if (!guestGate(req, res, frame.canvasId)) return
  const name = guestDisplayName(req.body?.name)
  if (!name) return res.status(400).json({ error: 'tell us your name first' })
  const text = String(req.body?.text ?? '')
    .trim()
    .slice(0, MAX_GUEST_COMMENT)
  if (!text) return res.status(400).json({ error: 'empty comment' })
  if (!guestThrottle(req, res, frame.canvasId)) return
  const { selector, snippet } = req.body ?? {}
  const comment = actions.addElementComment(
    frame.id,
    { selector: String(selector ?? ''), snippet: String(snippet ?? ''), text },
    name,
    undefined,
    'user',
    { allowAgent: false },
  )
  if (!comment) return res.status(404).json({ error: 'frame not found or empty text' })
  res.json(withNotice(comment, text))
})

/* a guest's comment pinned to a point on the canvas rather than to an element: same gate, name, notice and rate limits as a frame comment */
publicRouter.post('/canvases/:id/comments', (req, res) => {
  const canvas = guestGate(req, res, req.params.id)
  if (!canvas) return
  const name = guestDisplayName(req.body?.name)
  if (!name) return res.status(400).json({ error: 'tell us your name first' })
  const { pageId, x, y } = req.body ?? {}
  if (typeof pageId !== 'string' || !canvasPages(canvas).some((page) => page.id === pageId))
    return res.status(400).json({ error: 'page not found' })
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
  const text = String(req.body?.text ?? '')
    .trim()
    .slice(0, MAX_GUEST_COMMENT)
  if (!text) return res.status(400).json({ error: 'empty comment' })
  if (!guestThrottle(req, res, canvas.id)) return
  const comment = actions.addCanvasComment(
    canvas.id,
    { pageId, x: Number(x), y: Number(y), text },
    name,
    undefined,
    'user',
    { allowAgent: false },
  )
  if (!comment) return res.status(409).json({ error: 'page removed meanwhile' })
  res.json(withNotice(comment, text))
})

publicRouter.post('/comments/:id/replies', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!guestGate(req, res, found.canvasId)) return
  const name = guestDisplayName(req.body?.name)
  if (!name) return res.status(400).json({ error: 'tell us your name first' })
  const text = String(req.body?.text ?? '')
    .trim()
    .slice(0, MAX_GUEST_COMMENT)
  if (!text || !actions.openThread(req.params.id))
    return res.status(404).json({ error: 'thread resolved or empty text' })
  if (!guestThrottle(req, res, found.canvasId)) return
  const reply = actions.replyToComment(req.params.id, text, name, undefined, 'user', { allowAgent: false })
  if (!reply) return res.status(409).json({ error: 'thread resolved meanwhile' })
  res.json(withNotice(reply, text))
})
