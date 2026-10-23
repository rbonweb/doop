import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password-protected share links.
 *
 * The password is hashed with scrypt (random 16-byte salt) and stored as
 * `scrypt$N$salt$hash`; only the hash ever leaves this module. A visitor who
 * knows the password gets a cookie scoped to that one canvas, signed with
 * BETTER_AUTH_SECRET over the canvas id and a fingerprint of the stored hash,
 * so changing (or clearing) the password invalidates every cookie issued
 * before. The cookie is HttpOnly and SameSite=Lax, and Secure over https.
 */

export const MIN_LINK_PASSWORD = 8
export const MAX_LINK_PASSWORD = 200
export const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
/* 128 * N * r bytes for the scrypt working set, with headroom */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

function scryptAsync(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      },
    )
  })
}

/** Why a candidate password is not acceptable, or undefined when it is. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string') return 'password required'
  if (password.length < MIN_LINK_PASSWORD) return `The password needs at least ${MIN_LINK_PASSWORD} characters.`
  if (password.length > MAX_LINK_PASSWORD) return `The password can be at most ${MAX_LINK_PASSWORD} characters.`
  return undefined
}

/** `scrypt$N$salt$hash`, salt and hash base64url. */
export async function hashLinkPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, SCRYPT_N)
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

/** Constant-time check of a password against a stored hash. A malformed hash never matches. */
export async function verifyLinkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rawN, rawSalt, rawHash] = stored.split('$')
  const n = Number(rawN)
  if (scheme !== 'scrypt' || !Number.isInteger(n) || n < 1024 || n > 1_048_576 || !rawSalt || !rawHash) return false
  const expected = Buffer.from(rawHash, 'base64url')
  if (expected.length !== KEY_LENGTH) return false
  const actual = await scryptAsync(password, Buffer.from(rawSalt, 'base64url'), n)
  return timingSafeEqual(actual, expected)
}

/* a throwaway hash, so a wrong id costs the same time as a wrong password */
let decoy: Promise<string> | undefined
export function decoyHash(): Promise<string> {
  return (decoy ??= hashLinkPassword(randomBytes(12).toString('hex')))
}

/* ---- the unlock cookie ---- */

function secret(): string {
  return process.env.BETTER_AUTH_SECRET || 'doop-dev-secret-not-for-production'
}

/** Cookie names allow only token characters; canvas ids are nanoids, but be safe. */
export function unlockCookieName(canvasId: string): string {
  return `doop_lp_${canvasId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Ties a cookie to the stored password hash without revealing any of it. */
function fingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 22)
}

function sign(canvasId: string, passwordHash: string, expires: number): string {
  return createHmac('sha256', secret())
    .update(`lp1|${canvasId}|${fingerprint(passwordHash)}|${expires}`)
    .digest('base64url')
}

export function signUnlockToken(canvasId: string, passwordHash: string, now = Date.now()): string {
  const expires = now + UNLOCK_TTL_MS
  return `${expires}.${sign(canvasId, passwordHash, expires)}`
}

export function verifyUnlockToken(canvasId: string, passwordHash: string, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.')
  if (dot < 1) return false
  const expires = Number(token.slice(0, dot))
  if (!Number.isFinite(expires) || expires <= now || expires > now + UNLOCK_TTL_MS + 60_000) return false
  const given = Buffer.from(token.slice(dot + 1))
  const wanted = Buffer.from(sign(canvasId, passwordHash, expires))
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** One cookie's value out of a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Does this Cookie header carry a valid unlock for the canvas? `passwordHash`
 *  is the canvas's current hash; without one nothing can be unlocked. */
export function hasUnlock(
  canvasId: string,
  passwordHash: string | undefined,
  cookieHeader: string | undefined,
): boolean {
  if (!passwordHash) return false
  const token = readCookie(cookieHeader, unlockCookieName(canvasId))
  return !!token && verifyUnlockToken(canvasId, passwordHash, token)
}

/** The Set-Cookie attributes for the unlock cookie. */
export function unlockCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: UNLOCK_TTL_MS }
}
