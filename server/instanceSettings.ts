import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * What an instance admin changes from the Admin page without a restart: the
 * models the server's own Anthropic key runs on, and the invites that let a
 * person create an account on an invite-only instance (DOOP_INVITE_ONLY).
 *
 * Kept as one small JSON file next to the rest of the instance's data
 * (data/instance.json) rather than in a table, so a fork carrying it never
 * collides with upstream's migrations. The file is read on every use, which
 * also lets deploy/doop.sh change it from outside the running server.
 */

const FILE = path.join(process.cwd(), 'data', 'instance.json')

export const DEFAULT_AGENT_MODEL = 'claude-opus-5'
export const DEFAULT_DISTILL_MODEL = 'claude-haiku-4-5-20251001'

/** How long an invite link works. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000

/* names as model providers and proxies spell them: claude-opus-5,
   anthropic/claude-sonnet-5, us.anthropic.claude-opus-5:0, my-proxy@v2 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const inviteSchema = z.object({
  email: z.string(),
  token: z.string(),
  invitedBy: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

const settingsSchema = z.object({
  agentModel: z.string().optional(),
  distillModel: z.string().optional(),
  invites: z.array(inviteSchema).default([]),
})

export type Invite = z.infer<typeof inviteSchema>
type Settings = z.infer<typeof settingsSchema>

export class SettingRefused extends Error {}

function read(): Settings {
  try {
    return settingsSchema.parse(JSON.parse(fs.readFileSync(FILE, 'utf8')))
  } catch {
    /* no file yet, or one this version cannot read: start from defaults */
    return { invites: [] }
  }
}

function write(settings: Settings): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(settings, null, 2))
  fs.renameSync(`${FILE}.tmp`, FILE)
}

/* ---------------------------------------------------------------- models */

export interface ModelSetting {
  /** what runs now */
  value: string
  /** what runs when the admin has not chosen (DOOP_*_MODEL, or Doop's own) */
  default: string
}

export function agentModel(): string {
  return read().agentModel || process.env.DOOP_AGENT_MODEL || DEFAULT_AGENT_MODEL
}

export function distillModel(): string {
  return read().distillModel || process.env.DOOP_DISTILL_MODEL || DEFAULT_DISTILL_MODEL
}

export function modelSettings(): { agent: ModelSetting; distill: ModelSetting } {
  return {
    agent: { value: agentModel(), default: process.env.DOOP_AGENT_MODEL || DEFAULT_AGENT_MODEL },
    distill: { value: distillModel(), default: process.env.DOOP_DISTILL_MODEL || DEFAULT_DISTILL_MODEL },
  }
}

export function assertModelName(name: string): void {
  if (!MODEL_NAME.test(name)) throw new SettingRefused(`"${name}" is not a model name.`)
}

/** An empty name goes back to the default. */
export function setModels(change: { agent?: string; distill?: string }): void {
  const settings = read()
  for (const [key, field] of [
    ['agent', 'agentModel'],
    ['distill', 'distillModel'],
  ] as const) {
    const name = change[key]?.trim()
    if (name === undefined) continue
    if (name === '') {
      delete settings[field]
      continue
    }
    assertModelName(name)
    settings[field] = name
  }
  write(settings)
}

/* --------------------------------------------------------------- invites */

export function inviteOnly(): boolean {
  return ['1', 'true'].includes((process.env.DOOP_INVITE_ONLY ?? '').toLowerCase())
}

function live(invites: Invite[]): Invite[] {
  const now = Date.now()
  return invites.filter((invite) => invite.expiresAt > now)
}

export function listInvites(): Invite[] {
  return live(read().invites).sort((a, b) => b.createdAt - a.createdAt)
}

/** A new invite for `email`, replacing any earlier one for the same address. */
export function createInvite(email: string, invitedBy: string): Invite {
  const address = email.trim().toLowerCase()
  if (!EMAIL.test(address)) throw new SettingRefused(`"${email}" is not an email address.`)
  const settings = read()
  const now = Date.now()
  const invite = {
    email: address,
    token: randomBytes(24).toString('base64url'),
    invitedBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  }
  settings.invites = [...live(settings.invites).filter((i) => i.email !== address), invite]
  write(settings)
  return invite
}

export function revokeInvite(email: string): boolean {
  const settings = read()
  const address = email.trim().toLowerCase()
  const before = settings.invites.length
  settings.invites = live(settings.invites).filter((i) => i.email !== address)
  write(settings)
  return settings.invites.length < before
}

/** The live invite a link carries, if any. */
export function inviteFor(token: string): Invite | undefined {
  if (!token) return undefined
  return live(read().invites).find((invite) => invite.token === token)
}

/** An account was made for this address: its invite is spent. */
export function consumeInvite(email: string): void {
  const settings = read()
  const address = email.toLowerCase()
  if (!settings.invites.some((i) => i.email === address)) return
  settings.invites = live(settings.invites).filter((i) => i.email !== address)
  write(settings)
}

export function inviteLink(invite: Invite): string {
  const origin = process.env.BETTER_AUTH_URL || 'http://localhost:4300'
  return `${origin.replace(/\/$/, '')}/?invite=${invite.token}`
}

/** The header a sign-up carries its invite token in (see src/pages/AuthPage.tsx). */
export const INVITE_HEADER = 'x-doop-invite'
