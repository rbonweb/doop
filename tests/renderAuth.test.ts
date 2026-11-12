import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verifyAgentKey: vi.fn(),
  getMcpSession: vi.fn(),
  isBanned: vi.fn(),
  getAccessProfile: vi.fn(),
  canvases: new Map<string, Record<string, unknown>>(),
}))

vi.mock('../server/agentKeys.ts', () => ({
  isAgentKeySecret: (s: string) => s.startsWith('dpk_'),
  verifyAgentKey: mocks.verifyAgentKey,
}))
vi.mock('../server/auth.ts', () => ({
  auth: { api: { getMcpSession: mocks.getMcpSession } },
  isBanned: mocks.isBanned,
  getAccessProfile: mocks.getAccessProfile,
}))
vi.mock('../server/store.ts', () => ({
  store: { getCanvas: (id: string) => mocks.canvases.get(id), getDomainGrants: () => [] },
}))
vi.mock('../server/workspaces.ts', () => ({ isWorkspaceMember: () => false, hasRole: () => false }))

const { bearerMayRender } = await import('../server/renderAuth.ts')

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canvases.clear()
  mocks.canvases.set('c1', { id: 'c1', ownerId: 'owner' })
  mocks.canvases.set('shared', { id: 'shared', ownerId: 'owner', linkAccess: 'view', linkAudience: 'anyone' })
  mocks.isBanned.mockResolvedValue(false)
  mocks.getAccessProfile.mockResolvedValue(undefined)
  mocks.verifyAgentKey.mockImplementation(async (s: string) =>
    s === 'dpk_owner' ? { userId: 'owner' } : s === 'dpk_stranger' ? { userId: 'stranger' } : null,
  )
  mocks.getMcpSession.mockResolvedValue(null)
})

describe('bearerMayRender', () => {
  it('refuses requests without a usable bearer', async () => {
    expect(await bearerMayRender({}, 'c1')).toBe(false)
    expect(await bearerMayRender({ authorization: 'Basic abc' }, 'c1')).toBe(false)
    expect(await bearerMayRender({ authorization: 'Bearer' }, 'c1')).toBe(false)
    expect(await bearerMayRender({ authorization: 'dpk_owner' }, 'c1')).toBe(false)
  })

  it('accepts the canvas owner agent key, with a case-insensitive scheme', async () => {
    expect(await bearerMayRender(bearer('dpk_owner'), 'c1')).toBe(true)
    expect(await bearerMayRender({ authorization: 'bearer dpk_owner' }, 'c1')).toBe(true)
  })

  it('refuses a user with no access to the canvas', async () => {
    expect(await bearerMayRender(bearer('dpk_stranger'), 'c1')).toBe(false)
  })

  it('refuses a revoked or unknown key', async () => {
    expect(await bearerMayRender(bearer('dpk_revoked'), 'c1')).toBe(false)
  })

  it('refuses an unknown canvas', async () => {
    expect(await bearerMayRender(bearer('dpk_owner'), 'nope')).toBe(false)
  })

  it('refuses a banned user', async () => {
    mocks.isBanned.mockResolvedValue(true)
    expect(await bearerMayRender(bearer('dpk_owner'), 'c1')).toBe(false)
  })

  it('follows the share link the way MCP reads do', async () => {
    expect(await bearerMayRender(bearer('dpk_stranger'), 'shared')).toBe(true)
    mocks.canvases.set('shared', { id: 'shared', ownerId: 'owner', linkAccess: 'none' })
    expect(await bearerMayRender(bearer('dpk_stranger'), 'shared')).toBe(false)
  })

  it('verifies on every call, so revocation bites at once', async () => {
    expect(await bearerMayRender(bearer('dpk_owner'), 'c1')).toBe(true)
    mocks.verifyAgentKey.mockResolvedValue(null)
    expect(await bearerMayRender(bearer('dpk_owner'), 'c1')).toBe(false)
    expect(mocks.verifyAgentKey).toHaveBeenCalledTimes(2)
  })

  it('accepts an MCP OAuth token whose user has access', async () => {
    mocks.getMcpSession.mockResolvedValue({ userId: 'owner', clientId: 'x' })
    expect(await bearerMayRender(bearer('oauth-token'), 'c1')).toBe(true)
    expect(mocks.getMcpSession).toHaveBeenCalledTimes(1)
  })

  it('refuses an OAuth token that fails or throws, and never throws itself', async () => {
    mocks.getMcpSession.mockRejectedValue(new Error('boom'))
    expect(await bearerMayRender(bearer('oauth-token'), 'c1')).toBe(false)
    mocks.getMcpSession.mockResolvedValue({ userId: null })
    expect(await bearerMayRender(bearer('oauth-token'), 'c1')).toBe(false)
    mocks.verifyAgentKey.mockRejectedValue(new Error('db down'))
    expect(await bearerMayRender(bearer('dpk_owner'), 'c1')).toBe(false)
  })
})
