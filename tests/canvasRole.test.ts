import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CanvasRole, MemberRole } from '../shared/types.ts'

/* The role resolver is pure given the in-memory canvas, the workspace roll and
   the domain grants, so these tests build canvases by hand and stub only the
   two modules that reach the database. */
const workspace = vi.hoisted(() => ({ members: new Set<string>() }))
vi.mock('../server/db/persist.ts', () => ({
  saveDomainGrant: async () => {},
  deleteDomainGrant: async () => {},
}))
vi.mock('../server/workspaces.ts', () => ({
  isWorkspaceMember: (workspaceId: string, userId: string) => workspace.members.has(`${workspaceId}:${userId}`),
  hasRole: () => false,
  workspaceMemberIds: () => [],
}))

const { canvasRole, canView, canComment, canEdit, canAccessCanvas, guestRole, hasDurableCanvasAccess } =
  await import('../server/access.ts')
const { store } = await import('../server/store.ts')

function canvas(extra: Partial<Canvas> = {}): Canvas {
  const c: Canvas = {
    id: `c-${Math.random()}`,
    name: 'N',
    ownerId: 'owner',
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    ...extra,
  }
  store.canvases.set(c.id, c)
  return c
}

const person = (id: string, extra: { email?: string; emailVerified?: boolean; banned?: boolean } = {}) => ({
  id,
  email: `${id}@acme.com`,
  emailVerified: true,
  ...extra,
})

beforeEach(() => workspace.members.clear())

describe('canvasRole: each source alone', () => {
  it('the owner is owner', () => {
    expect(canvasRole(person('owner'), canvas())).toBe('owner')
  })

  it('a stranger gets nothing from a private canvas', () => {
    expect(canvasRole(person('stranger'), canvas())).toBeNull()
  })

  it('workspace members can edit', () => {
    workspace.members.add('ws1:wendy')
    expect(canvasRole(person('wendy'), canvas({ workspaceId: 'ws1' }))).toBe('edit')
    expect(canvasRole(person('wendy'), canvas({ workspaceId: 'ws2' }))).toBeNull()
  })

  it.each<[string, MemberRole | undefined, CanvasRole]>([
    ['an invite with no stored role keeps editing, as invites always did', undefined, 'edit'],
    ['a view member', 'view', 'view'],
    ['a comment member', 'comment', 'comment'],
    ['an edit member', 'edit', 'edit'],
  ])('%s', (_name, role, expected) => {
    const c = canvas({ memberIds: ['mia'], ...(role && role !== 'edit' ? { memberRoles: { mia: role } } : {}) })
    expect(canvasRole(person('mia'), c)).toBe(expected)
  })

  it.each<[LinkAccessCase, CanvasRole | null]>([
    ['none', null],
    ['view', 'view'],
    ['comment', 'comment'],
    ['edit', 'edit'],
  ])('the link floor %s gives a signed-in visitor %s', (linkAccess, expected) => {
    expect(canvasRole(person('visitor'), canvas({ linkAccess }))).toBe(expected)
  })

  it('a domain grant applies to a verified address on that domain', () => {
    const c = canvas()
    store.setDomainGrant(c.id, '@Acme.com', 'comment', 'owner')
    expect(canvasRole(person('dana'), c)).toBe('comment')
  })

  it('a domain grant ignores an unverified address', () => {
    const c = canvas()
    store.setDomainGrant(c.id, 'acme.com', 'edit', 'owner')
    expect(canvasRole(person('dana', { emailVerified: false }), c)).toBeNull()
  })

  it('a domain grant ignores other domains, look-alikes and a bare user id', () => {
    const c = canvas()
    store.setDomainGrant(c.id, 'acme.com', 'edit', 'owner')
    expect(canvasRole(person('x', { email: 'x@evilacme.com' }), c)).toBeNull()
    expect(canvasRole(person('x', { email: 'x@acme.com.evil.io' }), c)).toBeNull()
    expect(canvasRole('x', c)).toBeNull()
  })
})

describe('canvasRole: combinations', () => {
  it('the highest of several sources wins', () => {
    const c = canvas({ memberIds: ['mia'], memberRoles: { mia: 'view' }, linkAccess: 'comment' })
    expect(canvasRole(person('mia'), c)).toBe('comment')
    store.setDomainGrant(c.id, 'acme.com', 'edit', 'owner')
    expect(canvasRole(person('mia'), c)).toBe('edit')
  })

  it('a lower source never lowers a higher one', () => {
    workspace.members.add('ws1:wendy')
    const c = canvas({ workspaceId: 'ws1', memberIds: ['wendy'], memberRoles: { wendy: 'view' }, linkAccess: 'view' })
    expect(canvasRole(person('wendy'), c)).toBe('edit')
  })

  it('a banned account gets nothing, owner included', () => {
    const c = canvas({ memberIds: ['mia'], linkAccess: 'edit' })
    expect(canvasRole(person('mia', { banned: true }), c)).toBeNull()
    expect(canvasRole(person('owner', { banned: true }), c)).toBeNull()
  })

  it('an ownerless legacy canvas stays open so it can be claimed', () => {
    const c = canvas({ ownerId: undefined })
    expect(canvasRole(person('anyone'), c)).toBe('edit')
    expect(canvasRole(undefined, c)).toBe('edit')
  })

  it('no session means no role on an owned canvas, whatever the link says', () => {
    expect(canvasRole(undefined, canvas({ linkAccess: 'edit', linkAudience: 'anyone' }))).toBeNull()
  })
})

describe('password links', () => {
  it('a signed-in visitor needs the unlock cookie for the link floor', () => {
    const c = canvas({ linkAccess: 'comment', linkAudience: 'password' })
    expect(canvasRole(person('visitor'), c)).toBeNull()
    expect(canvasRole(person('visitor'), c, { unlocked: true })).toBe('comment')
  })

  it('members and the owner never need the password', () => {
    const c = canvas({ linkAccess: 'view', linkAudience: 'password', memberIds: ['mia'] })
    expect(canvasRole(person('mia'), c)).toBe('edit')
    expect(canvasRole(person('owner'), c)).toBe('owner')
  })
})

describe('guestRole: the signed-out visitor', () => {
  it.each<[Partial<Canvas>, boolean, 'view' | 'comment' | null]>([
    [{ linkAccess: 'edit' }, false, null], // signed-in-only link
    [{ linkAccess: 'edit', linkAudience: 'signed-in' }, false, null],
    [{ linkAccess: 'none', linkAudience: 'anyone' }, false, null],
    [{ linkAccess: 'view', linkAudience: 'anyone' }, false, 'view'],
    [{ linkAccess: 'comment', linkAudience: 'anyone' }, false, 'comment'],
    [{ linkAccess: 'edit', linkAudience: 'anyone' }, false, 'comment'], // never anonymous edit
    [{ linkAccess: 'edit', linkAudience: 'password' }, false, null], // still locked
    [{ linkAccess: 'edit', linkAudience: 'password' }, true, 'comment'], // unlocked, still capped
    [{ linkAccess: 'view', linkAudience: 'password' }, true, 'view'],
    [{ linkAccess: 'view', linkAudience: 'anyone', ownerId: undefined }, false, null], // legacy canvases are not public
  ])('%j (unlocked: %s) -> %s', (extra, unlocked, expected) => {
    expect(guestRole(canvas(extra), { unlocked })).toBe(expected)
  })
})

describe('helpers', () => {
  it('canView / canComment / canEdit read the resolved role', () => {
    const c = canvas({ memberIds: ['v', 'c', 'e'], memberRoles: { v: 'view', c: 'comment' } })
    expect([canView('v', c), canComment('v', c), canEdit('v', c)]).toEqual([true, false, false])
    expect([canView('c', c), canComment('c', c), canEdit('c', c)]).toEqual([true, true, false])
    expect([canView('e', c), canComment('e', c), canEdit('e', c)]).toEqual([true, true, true])
    expect([canView('s', c), canComment('s', c), canEdit('s', c)]).toEqual([false, false, false])
  })

  it('canAccessCanvas is canView', () => {
    expect(canAccessCanvas).toBe(canView)
  })

  it('durable access ignores the share link and respects the minimum role', () => {
    const c = canvas({ memberIds: ['v', 'e'], memberRoles: { v: 'view' }, linkAccess: 'edit' })
    expect(hasDurableCanvasAccess('visitor', c)).toBe(false)
    expect(hasDurableCanvasAccess('v', c)).toBe(true)
    expect(hasDurableCanvasAccess('v', c, 'edit')).toBe(false)
    expect(hasDurableCanvasAccess('e', c, 'edit')).toBe(true)
    expect(hasDurableCanvasAccess('owner', c, 'edit')).toBe(true)
    store.setDomainGrant(c.id, 'acme.com', 'edit', 'owner')
    expect(hasDurableCanvasAccess(person('dana'), c, 'edit')).toBe(true)
    expect(hasDurableCanvasAccess(person('dana', { emailVerified: false }), c)).toBe(false)
    expect(hasDurableCanvasAccess(person('dana', { banned: true }), c)).toBe(false)
  })
})

type LinkAccessCase = NonNullable<Canvas['linkAccess']>
