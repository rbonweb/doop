import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** What a story page may reach when the Storybook is on someone else's server: its own origin and the public internet, never this machine or its network. A Storybook on this machine (a directory, a localhost dev server) is the team's own and is left alone. */

const strip = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase()

/** localhost, 127.0.0.0/8 and ::1 */
export function isLoopbackHost(host: string): boolean {
  const name = strip(host)
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (isIP(name) === 4) return name.startsWith('127.')
  return name === '::1' || name === '::ffff:127.0.0.1'
}

/** Whether an address literal is on this machine or a private, link-local or otherwise internal network. */
export function isPrivateAddress(address: string): boolean {
  const name = strip(address)
  const family = isIP(name)
  if (family === 4) {
    const [a = 0, b = 0] = name.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return name === '::' || name === '::1' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name) || name.startsWith('ff')
  }
  return false
}

/** Whether a hostname is one that never leaves the machine or its network, judged by the name alone. */
export function isInternalName(host: string): boolean {
  const name = strip(host)
  if (isIP(name)) return isPrivateAddress(name)
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')
}

export type Resolve = (host: string) => Promise<string[]>

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address)

/**
 * Why a request from a story page must be stopped, or undefined to let it go. Only http, https and websocket requests to somewhere other than the Storybook's own origin are judged: a private or loopback address, or a name that resolves to one, is refused. (The browser resolves the name again when it connects, so a rebinding server could still answer differently; this is a guard against pages that name internal addresses, not a sandbox.)
 */
export async function blockedRequest(
  rawUrl: string,
  storybookOrigin: string,
  resolve: Resolve = resolveAll,
): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol)) return undefined
  if (url.origin === storybookOrigin) return undefined
  if (isInternalName(url.hostname)) return `${url.hostname} is on this machine or its network`
  if (isIP(strip(url.hostname))) return undefined
  try {
    const addresses = await resolve(url.hostname)
    if (addresses.some(isPrivateAddress)) return `${url.hostname} resolves to a private address`
  } catch {
    /* a name that does not resolve fails by itself */
  }
  return undefined
}
