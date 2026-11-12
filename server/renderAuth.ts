import type { IncomingHttpHeaders } from 'node:http'
import { fromNodeHeaders } from 'better-auth/node'
import { roleAllows } from '../shared/canvasRole.ts'
import { canvasRole, type AccessUser } from './access.ts'
import { isAgentKeySecret, verifyAgentKey } from './agentKeys.ts'
import { auth, getAccessProfile, isBanned } from './auth.ts'
import { store } from './store.ts'

/** The user an agent bearer (an agent key or an MCP OAuth token) names, checked as `handleMcpRequest` checks it. */
async function bearerUserId(headers: IncomingHttpHeaders): Promise<string | undefined> {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]
  if (!bearer) return undefined
  const session = isAgentKeySecret(bearer)
    ? await verifyAgentKey(bearer)
    : await auth.api.getMcpSession({ headers: fromNodeHeaders(headers) }).catch(() => null)
  return session?.userId || undefined
}

/**
 * Whether the bearer on a `/i/` render request may spend the signed-in render budget instead of the anonymous one.
 * It verifies the bearer exactly as `/mcp` does, then asks the same resolver MCP reads go through (`canvasRole`, with the
 * account's email profile for domain grants) for at least `view` on the frame's canvas.
 * It grants budget only: the route stays public by unguessable id and never serves or withholds an image on this answer.
 * Nothing is cached here, so a revoked key or a ban takes effect on the next request; any failure is `false`.
 */
export async function bearerMayRender(headers: IncomingHttpHeaders, canvasId: string): Promise<boolean> {
  try {
    const userId = await bearerUserId(headers)
    if (!userId || (await isBanned(userId))) return false
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return false
    const profile = await getAccessProfile(userId)
    const who: AccessUser = { id: userId, email: profile?.email, emailVerified: profile?.emailVerified }
    return roleAllows(canvasRole(who, canvas), 'view')
  } catch {
    return false
  }
}
