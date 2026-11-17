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

/** The 16 bytes of an IPv6 literal (as `new URL(...).hostname` or a resolver gives it, with or without a dotted-quad tail), or undefined when it is not one. */
function ipv6Bytes(address: string): number[] | undefined {
  let text = strip(address)
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const parts = tail[1]!.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => part > 255)) return undefined
    text =
      text.slice(0, -tail[1]!.length) +
      ((parts[0]! << 8) | parts[1]!).toString(16) +
      ':' +
      ((parts[2]! << 8) | parts[3]!).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const read = (part: string) => (part ? part.split(':') : [])
  const head = read(halves[0]!)
  const rest = halves.length === 2 ? read(halves[1]!) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...rest]
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    const value = parseInt(group, 16)
    bytes.push(value >> 8, value & 255)
  }
  return bytes
}

function isPrivateV4(a: number, b: number): boolean {
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

/** Whether an address literal is on this machine or a private, link-local or otherwise internal network, an IPv4 address carried inside an IPv6 one (mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) judged by the IPv4 address it carries. */
export function isPrivateAddress(address: string): boolean {
  const name = strip(address)
  const family = isIP(name)
  if (family === 4) {
    const [a = 0, b = 0] = name.split('.').map(Number)
    return isPrivateV4(a, b)
  }
  if (family !== 6) return false
  const bytes = ipv6Bytes(name)
  /* an IPv6 literal we cannot read is not trusted */
  if (!bytes) return true
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0)
  const [b0 = 0, b1 = 0] = bytes
  /* the IPv4 address carried inside, if the prefix says there is one */
  const carried =
    (zero(0, 10) && bytes[10] === 255 && bytes[11] === 255) || zero(0, 12)
      ? bytes.slice(12)
      : zero(0, 8) && bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0
        ? bytes.slice(12)
        : b0 === 0 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)
          ? bytes.slice(12)
          : b0 === 0x20 && b1 === 0x02
            ? bytes.slice(2, 6)
            : undefined
  if (carried) return isPrivateV4(carried[0]!, carried[1]!)
  return (
    (b0 & 0xfe) === 0xfc || // unique local fc00::/7
    (b0 === 0xfe && (b1 & 0x80) !== 0) || // link local and site local fe80::/9
    b0 === 0xff || // multicast
    (b0 === 0 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) || // other NAT64 (local-use 64:ff9b:1::/48)
    (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0 && bytes[3] === 0) || // Teredo 2001::/32
    (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) // documentation 2001:db8::/32
  )
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
