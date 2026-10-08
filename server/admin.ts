import express from 'express'
import { inArray, count, eq, sql } from 'drizzle-orm'
import { store } from './store.ts'
import { isAdmin } from './access.ts'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { requestUpdate, UpdateRefused, updateInfo } from './selfUpdate.ts'
import { checkServerModel } from './agentModel.ts'
import {
  assertModelName,
  createInvite,
  inviteLink,
  listInvites,
  modelSettings,
  revokeInvite,
  setModels,
  SettingRefused,
} from './instanceSettings.ts'

/**
 * Instance-admin surface, mounted at /api/admin (so already behind the
 * session gate in index.ts). Read-only by design: it lists what exists, and
 * the way in to a specific canvas is impersonation — better-auth's own
 * /api/auth/admin/impersonate-user — not a privileged read here. That keeps
 * canAccessCanvas the single answer to "may this user see this canvas",
 * which matters because MCP shares it.
 */
export const adminRouter = express.Router()

/* 404 rather than 403: a non-admin should not learn the surface exists. */
adminRouter.use((req, res, next) => {
  if (!isAdmin(req.user)) return res.status(404).end()
  next()
})

/** Every canvas on the instance, newest activity first, with its owner. */
adminRouter.get('/canvases', async (req, res) => {
  const { total, canvases } = store.listAllCanvases()
  const ownerIds = [...new Set(canvases.map((c) => c.ownerId).filter((id): id is string => !!id))]
  const owners = ownerIds.length
    ? await db
        .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, ownerIds))
    : []
  const byId = new Map(owners.map((o) => [o.id, o]))
  res.json({
    total,
    canvases: canvases.map((c) => ({ ...c, owner: c.ownerId ? byId.get(c.ownerId) : undefined })),
  })
})

/** The three numbers worth knowing at a glance. */
adminRouter.get('/stats', async (req, res) => {
  const [users] = await db.select({ n: count() }).from(authSchema.user)
  const canvases = [...store.canvases.values()]
  res.json({
    users: users?.n ?? 0,
    canvases: canvases.length,
    frames: canvases.reduce((n, c) => n + c.frames.length, 0),
  })
})

/** Accounts, for the "view as" picker and (later) ban/role management. */
adminRouter.get('/users', async (req, res) => {
  const rows = await db
    .select({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      role: authSchema.user.role,
      banned: authSchema.user.banned,
      createdAt: authSchema.user.createdAt,
    })
    .from(authSchema.user)
  const owned = new Map<string, number>()
  for (const c of store.canvases.values()) {
    if (c.ownerId) owned.set(c.ownerId, (owned.get(c.ownerId) ?? 0) + 1)
  }
  res.json(
    rows
      .map((u) => ({ ...u, createdAt: u.createdAt.getTime(), canvasCount: owned.get(u.id) ?? 0 }))
      .sort((a, b) => b.createdAt - a.createdAt),
  )
})

/** The running version, the latest release, and how an update is going. */
adminRouter.get('/update', async (req, res) => {
  res.json(await updateInfo(req.query.fresh === '1'))
})

/** Ask the host to install the latest release (see server/selfUpdate.ts). */
adminRouter.post('/update', async (req, res) => {
  try {
    res.json(await requestUpdate(String(req.body?.tag ?? ''), req.user!.email))
  } catch (e) {
    if (e instanceof UpdateRefused) return res.status(409).json({ error: e.message })
    console.error('[update] request failed', e)
    res.status(500).json({ error: 'The update request could not be written.' })
  }
})

/** Invites waiting to be used, each with the link to send. */
adminRouter.get('/invites', (req, res) => {
  res.json(listInvites().map((invite) => ({ ...invite, token: undefined, link: inviteLink(invite) })))
})

/** A new invite link for an address that has no account yet. */
adminRouter.post('/invites', async (req, res) => {
  const email = String(req.body?.email ?? '')
    .trim()
    .toLowerCase()
  const [existing] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(sql`lower(${authSchema.user.email})`, email))
  if (existing) return res.status(409).json({ error: `${email} already has an account.` })
  try {
    const invite = createInvite(email, req.user!.email)
    res.json({ ...invite, token: undefined, link: inviteLink(invite) })
  } catch (e) {
    if (e instanceof SettingRefused) return res.status(400).json({ error: e.message })
    console.error('[invites] could not save', e)
    res.status(500).json({ error: 'The invite could not be saved.' })
  }
})

adminRouter.delete('/invites/:email', (req, res) => {
  if (!revokeInvite(req.params.email)) return res.status(404).json({ error: 'No invite for that address.' })
  res.json({ ok: true })
})

function modelsView() {
  return {
    ...modelSettings(),
    /* whether the server's own key exists, and where its calls go */
    serverKey: Boolean(process.env.ANTHROPIC_API_KEY),
    baseUrl: process.env.ANTHROPIC_BASE_URL || null,
  }
}

/** The models the server's Anthropic key runs on. */
adminRouter.get('/models', (req, res) => {
  res.json(modelsView())
})

/** Change them; an empty name goes back to the default. */
adminRouter.put('/models', (req, res) => {
  const change: { agent?: string; distill?: string } = {}
  if (typeof req.body?.agent === 'string') change.agent = req.body.agent
  if (typeof req.body?.distill === 'string') change.distill = req.body.distill
  try {
    setModels(change)
  } catch (e) {
    if (e instanceof SettingRefused) return res.status(400).json({ error: e.message })
    throw e
  }
  res.json(modelsView())
})

/** Try a model name with one small call before saving it. */
adminRouter.post('/models/test', async (req, res) => {
  const model = String(req.body?.model ?? '').trim()
  try {
    assertModelName(model)
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'not a model name' })
  }
  res.json(await checkServerModel(model))
})
