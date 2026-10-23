import { ROLE_RANK, roleAtLeast } from '../shared/types.ts'
import type { Canvas, CanvasRole, Frame, MemberRole } from '../shared/types.ts'
import { store } from './store.ts'
import { hasRole, isWorkspaceMember } from './workspaces.ts'

/**
 * Canvas access, Figma-style: private by default. One resolver, `canvasRole`,
 * answers "what may this person do here": the roles are
 * `owner > edit > comment > view`, or null for no access at all. Every
 * canvas-scoped surface (REST, the WS join and its messages, MCP tools) gates
 * through it, via `canView` / `canComment` / `canEdit`.
 *
 * Order of evaluation:
 *  1. a banned account gets nothing;
 *  2. the owner is 'owner';
 *  3. otherwise the highest of: workspace membership ('edit'), the invited
 *     member's own role, a domain grant matching a VERIFIED email address, and
 *     the share link's floor (`linkAccess`), which for a password link also
 *     needs the unlock cookie (`ctx.unlocked`).
 *
 * Ownerless (pre-auth/legacy) canvases stay open so they can be claimed.
 *
 * A signed-out visitor never reaches `canvasRole`; the anonymous-link entry
 * points call `guestRole`, which is the link floor capped at 'comment'. An
 * anonymous visitor can never edit, whatever the link says.
 */

/**
 * Instance admins. Deliberately NOT consulted by canView: that gate is shared
 * with MCP, so an admin branch there would hand every agent holding an
 * admin's OAuth token read/write on every canvas in the instance. Admins get
 * their own routes (server/admin.ts), and reach a specific canvas by
 * impersonating its owner — which goes through the gate below as that owner,
 * leaving session.impersonatedBy behind as the audit trail. A "view as"
 * session stays read-only: the REST gate refuses its writes and the room
 * connection it opens never emits.
 */
export function isAdmin(user: { role?: string | null } | undefined): boolean {
  return user?.role === 'admin'
}

/** What the resolver needs to know about a person. Callers that only hold an
 *  id pass the bare string: domain grants then cannot match. */
export interface AccessUser {
  id: string
  email?: string | null
  emailVerified?: boolean | null
  banned?: boolean | null
}

export type Who = AccessUser | string | undefined

export interface AccessContext {
  /** the visitor presented a valid unlock cookie for this canvas's link password */
  unlocked?: boolean
}

const asUser = (who: Who): AccessUser | undefined => (typeof who === 'string' ? { id: who } : who)

function highest(roles: (MemberRole | null | undefined)[]): MemberRole | null {
  let best: MemberRole | null = null
  for (const role of roles) if (role && (!best || ROLE_RANK[role] > ROLE_RANK[best])) best = role
  return best
}

/** The role the share link grants, or null when the link is off or still locked. */
function linkFloor(canvas: Canvas, ctx: AccessContext): MemberRole | null {
  const access = canvas.linkAccess ?? 'none'
  if (access === 'none') return null
  if (canvas.linkAudience === 'password' && !ctx.unlocked) return null
  return access
}

/** The email domain a verified address belongs to. */
function verifiedDomain(user: AccessUser): string | undefined {
  if (!user.emailVerified || !user.email) return undefined
  const at = user.email.lastIndexOf('@')
  return at > 0 ? user.email.slice(at + 1).toLowerCase() : undefined
}

function durableSources(user: AccessUser, canvas: Canvas): (MemberRole | null)[] {
  const domain = verifiedDomain(user)
  return [
    canvas.workspaceId && isWorkspaceMember(canvas.workspaceId, user.id) ? 'edit' : null,
    canvas.memberIds?.includes(user.id) ? (canvas.memberRoles?.[user.id] ?? 'edit') : null,
    domain ? highest(store.getDomainGrants(canvas.id).map((g) => (g.domain === domain ? g.role : null))) : null,
  ]
}

/** What a signed-out visitor may do through an anyone-with-the-link canvas:
 *  the link floor, capped at 'comment'. Null when the link does not admit
 *  anonymous visitors (signed-in-only, off, or still locked behind its password). */
export function guestRole(canvas: Canvas, ctx: AccessContext = {}): 'view' | 'comment' | null {
  if (!canvas.ownerId) return null
  if (canvas.linkAudience !== 'anyone' && canvas.linkAudience !== 'password') return null
  const floor = linkFloor(canvas, ctx)
  if (!floor) return null
  return floor === 'view' ? 'view' : 'comment'
}

export function canvasRole(who: Who, canvas: Canvas, ctx: AccessContext = {}): CanvasRole | null {
  const user = asUser(who)
  if (user?.banned) return null
  if (!canvas.ownerId) return 'edit'
  if (!user) return null
  if (canvas.ownerId === user.id) return 'owner'
  return highest([...durableSources(user, canvas), linkFloor(canvas, ctx)])
}

export const canView = (who: Who, canvas: Canvas, ctx?: AccessContext): boolean => canvasRole(who, canvas, ctx) !== null
export const canComment = (who: Who, canvas: Canvas, ctx?: AccessContext): boolean =>
  roleAtLeast(canvasRole(who, canvas, ctx), 'comment')
export const canEdit = (who: Who, canvas: Canvas, ctx?: AccessContext): boolean =>
  roleAtLeast(canvasRole(who, canvas, ctx), 'edit')

/** The old yes/no gate, kept under its name: "may this person open the canvas". */
export const canAccessCanvas = canView

/** Durable access only: the owner, invited members, the canvas's workspace and
 *  verified domain grants — NOT share-link visitors. Gates anything that would
 *  outlive the visit itself, like design-sync keys: a bearer secret minted or
 *  read through a share link would keep writing frames long after the owner
 *  turns the link off. `min` is the role the durable access must carry
 *  (default view; anything that writes asks for 'edit'). */
export function hasDurableCanvasAccess(who: Who, canvas: Canvas, min: CanvasRole = 'view'): boolean {
  const user = asUser(who)
  if (!user || user.banned || !canvas.ownerId) return false
  const role: CanvasRole | null = canvas.ownerId === user.id ? 'owner' : highest(durableSources(user, canvas))
  return roleAtLeast(role, min)
}

/** Who may delete a canvas, or move it out of its workspace: its owner,
 *  and the owner/admins of the workspace it lives in — the org keeps
 *  control of the work done in its space. */
export function canManageCanvas(userId: string | undefined, canvas: Canvas): boolean {
  if (!userId) return false
  if (canvas.ownerId === userId) return true
  return !!canvas.workspaceId && hasRole(canvas.workspaceId, userId, 'admin')
}

/** Who may change what is on a canvas (frames, notes, pages): the edit role.
 *  View and comment visitors read and discuss but never change the design. */
export function canEditCanvas(who: Who, canvas: Canvas, ctx?: AccessContext): boolean {
  return canEdit(who, canvas, ctx)
}

/** Whether a caller may change a frame, and so restore its history: the edit
 *  role on the frame's canvas. Reading history only needs `canView`. */
export function canEditFrame(who: Who, frame: Frame, ctx?: AccessContext): boolean {
  const canvas = store.getCanvas(frame.canvasId)
  return !!canvas && canEdit(who, canvas, ctx)
}
