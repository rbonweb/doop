import { env } from './env.ts'
import {
  catalogEntry,
  changeInstances,
  componentDetail,
  ComponentError,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  findComponent,
  findComponentCandidates,
  importComponent,
  insertInstance,
  restoreComponentVersion,
  syncComponent,
  updateComponent,
} from './componentActions.ts'
import { z } from 'zod'
import { previewDocument } from './componentPreview.ts'
import { codeSchema, propSchema } from './componentTools.ts'
import { canvasPages, framePageId, normalizePageTree, samePages, validatePageTree } from '../shared/pages.ts'
import { normalizePageBackground } from '../shared/pageBackground.ts'
import { MAX_STACK_WRITES, type StackWrite } from '../shared/frameStack.ts'
import { normalizeRotation } from '../shared/frameRotation.ts'
import type { CommentAnchorInput } from '../shared/comments.ts'
import type { LocaleConfig } from '../shared/locales.ts'
import { FIRST_CANVAS_PATH, SIGNUP_PARAM, parseSignupMethod } from '../shared/firstCanvas.ts'
import { localAgentRouter, handleLocalAgentMcp, wake as wakeUserWork } from './localAgent.ts'
import { handleGeminiCloudMcp } from './geminiCloudMcp.ts'
import { geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { eq, inArray } from 'drizzle-orm'
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node'
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { WebSocketServer, WebSocket } from 'ws'
import { GuideLimitError, PageLimitError, store } from './store.ts'
import { parseGuide } from '../shared/guides.ts'
import { getImage, getRender, invalidateFrameImages } from './previews.ts'
import { parseRenderQuery, renderExt, renderMime } from './renderParams.ts'
import { startRenderSweep } from './renderStore.ts'
import { scheduleWarm, startRenderWarm } from './renderWarm.ts'
import { bearerMayRender } from './renderAuth.ts'
import * as actions from './actions.ts'
import { liveActivitiesRouter, logLiveActivityRequests, startLiveActivityDelivery } from './liveActivities.ts'
import { onCanvasEvent } from './events.ts'
import { claimsOn, onClaimsChange, type FrameClaim } from './frameClaims.ts'
import * as imageDescriptions from './imageDescriptions.ts'
import * as commentNotifications from './commentNotifications.ts'
import { notificationsRouter } from './notifications.ts'
import * as webhooks from './webhooks.ts'
import { webhooksRouter } from './webhookRoutes.ts'
import { seenRouter } from './seenRoutes.ts'
import {
  canvasRole,
  canManageCanvas,
  guestRole,
  hasDurableCanvasAccess,
  isAdmin,
  roomMessageNeeds,
  type AccessUser,
} from './access.ts'
import { deckRouter } from './deckRoutes.ts'
import { MAX_SPEAKER_NOTES_CHARS } from '../shared/slides.ts'
import {
  accessUserOf,
  agentNotice,
  applyLinkSettings,
  publicRouter,
  requireCanvas as requireCanvasRole,
  requireFrame as requireFrameRole,
  roleFor,
  sharingRouter,
  startAccessRequestExpiry,
  unlockedByCookie,
  validMentions,
  wireSharing,
  GUEST_MARK,
  guestDisplayName,
} from './sharing.ts'
import { fontsRouter } from './fontRoutes.ts'
import { AvatarInputError, clearAvatar, setAvatar } from './avatars.ts'
import { MAX_AVATAR_BYTES, avatarUrl } from '../shared/avatar.ts'
import { fontsForCanvas, hydrateFonts } from './fonts.ts'
import { tokensCss, tokensMarkdown, tokensTailwind } from '../shared/designTokens.ts'
import { auth, initAuth, syncAdmins, getUserName, loginProvidersConfig } from './auth.ts'
import { getInstanceSettings, hydrateInstanceSettings, loginPolicy } from './instanceSettings.ts'
import { inviteFor, inviteOnly } from './instanceConfig.ts'
import { adminRouter } from './admin.ts'
import { communityRouter, parseListing, publishableFrames } from './community.ts'
import { automationsRouter, startScheduler } from './automations.ts'
import { startMcpTokenPrune } from './mcpTokens.ts'
import { integrationsRouter, relayDesktopCallback } from './integrations.ts'
import { extensions } from './extensions.ts'
import * as workspaces from './workspaces.ts'
import * as billing from './billing.ts'
import * as demo from './demo.ts'
import { db, initDb } from './db/index.ts'
import { resealSecrets } from './secretBackfill.ts'
import { encryptionConfigured } from './secretBox.ts'
import * as authSchema from './db/auth-schema.ts'
import * as persist from './db/persist.ts'
import { handleMcpRequest } from './mcp.ts'
import {
  getAsset,
  reconcileAssetRefs,
  beginTicketUpload,
  ticketAssetMeta,
  endTicketUpload,
  createAsset,
  MAX_ASSET_BYTES,
  assetEtag,
  etagMatches,
  assetResponseHeaders,
  assetUsage,
  onAssetReplaced,
  replaceAsset,
  isTextAsset,
} from './assets.ts'
import { compressedBundle, compressedOnce, immutableAssets, negotiateCoding } from './compression.ts'
import * as ingest from './ingest.ts'
import * as agentKeys from './agentKeys.ts'
import * as backgrounds from './backgrounds.ts'
import * as storage from './storage.ts'
import * as github from './github.ts'
import * as githubApp from './githubApp.ts'
import { seed } from './seed.ts'
import * as allowance from './allowance.ts'
import * as modelAccounts from './modelAccounts.ts'
import { getLocalAgentPreference } from './localAgentPreferences.ts'
import { serverTierInfo } from './agentModel.ts'
import { imageModelAvailability, serverImageGenEnabled } from './imageGen.ts'
import { setImagePref } from './imagePrefs.ts'
import { accountsView, listRunners, menuFor } from './agentRunners.ts'
import { CustomProviderError, discoverCustomModels, takeProbeSlot, testCustomProvider } from './customProviders.ts'
import { CustomProviderUrlError, customProvidersEnabled, reachableUrl } from './customProviderFetch.ts'
import {
  isCustomProviderKind,
  normalizeBaseUrl,
  parseCustomHeaders,
  parseCustomKey,
  parseCustomProviderConfig,
  CUSTOM_API_TYPES,
} from '../shared/customProvider.ts'
import { setStoredDefault } from './agentDefaults.ts'
import { isRunnerProvider } from '../shared/agentRunner.ts'
import { modelCatalogFor } from './modelCatalog.ts'
import { mentionedRole } from '../shared/agents.ts'
import { activeAgentTasks } from '../shared/agentActivity.ts'
import { colorFor } from '../shared/types.ts'
import { isPeerViewport } from '../shared/viewport.ts'
import { roleAtLeast } from '../shared/types.ts'
import { exportScaleSuffix, fitExportScale, parseExportScale } from '../shared/exportScale.ts'
import * as userEvents from './userEvents.ts'
import type { Canvas, CanvasPageInfo, CanvasRole, ClientMessage, Presence, ServerMessage } from '../shared/types.ts'

const PORT = env.PORT

/* Identifies the client bundle this process serves. Hashing dist/index.html
   works because Vite writes hashed asset names into it — any frontend change
   changes the hash, while server-only deploys and plain restarts do not.
   Clients compare it across reconnects to know their loaded bundle is stale. */
const BUILD_ID = (() => {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(process.cwd(), 'dist', 'index.html')))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'dev'
  }
})()

/* boot: connect the DB, hydrate memory, import pre-DB store.json once */
await initDb()
await backgrounds.initBackgrounds()
initAuth()
await syncAdmins() // ADMIN_EMAILS -> user.role, for accounts that already exist
let data = await persist.hydrate()
if (data.canvases.length === 0 && (await persist.importLegacyJson())) {
  data = await persist.hydrate()
}
store.init(data.canvases, data)
await workspaces.hydrateWorkspaces() // before the first request: canvasRole reads membership
await hydrateInstanceSettings() // the sign-in policy, read on every signup
await webhooks.hydrateWebhooks()
await hydrateFonts() // before the first request: frame writes add the faces they use
billing.reportBillingConfig()
actions.hydrateLogs(data)
seed()

/* Never-attempted queued cards get their first pickup after boot. Hydration
   marks interrupted claimed cards as failed, so they are excluded until a
   human explicitly retries them. */
{
  const pending = [...data.tasks.entries()]
    .filter(([, list]) => list.some((t) => t.queuedBy && !t.agentName && !t.endedAt))
    .map(([canvasId]) => canvasId)
  pending.forEach((canvasId, i) => {
    setTimeout(
      () => {
        import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
      },
      5_000 + i * 30_000,
    )
  })
  if (pending.length) console.log(`[resident] ${pending.length} canvas(es) with new queued cards — starting after boot`)
}

/* asset bookkeeping (no deletion): every upload records its canvas, and
   asset_refs tracks which frames reference which assets — kept in sync on
   every durable frame write, rebuilt here from the stored frames. Nothing
   is ever deleted; asset_refs is the ledger any future cleanup would be
   built on. */
reconcileAssetRefs()
  .then((n) => n && console.log(`[assets] reconciled ${n} asset ref(s)`))
  .catch((e) => console.error('[assets] reconcile failed', e))
/* image descriptions for agents: recover the backlog and listen for new assets. */
void imageDescriptions.startImageDescriptions(broadcast)

/* One stray rejection must never take down the multiplayer server: Node's
   default is to exit, which turned a single aborted analytics upload into
   sitewide 502s (2026-08-20). Log loudly instead — a real bug shows up here
   as a stack trace, not an outage. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason)
})

/* flush debounced frame writes before the process dies — with a hard-exit
   timeout so a wedged DB can never keep the process (and the port) alive */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 1500).unref()
    persist
      .flush((id) => store.getFrame(id))
      .catch((err) => console.error('flush on shutdown failed', err))
      .finally(() => process.exit(0))
  })
}

/* ------------------------------------------------- realtime rooms */

interface Conn {
  ws: WebSocket
  canvasId: string
  /** the session's user — the role is re-read from it on every message, so
   *  a link changed mid-visit takes effect without a reconnect. Unset for a
   *  signed-out guest on a link-shared canvas. */
  userId?: string
  presence: Presence
  /** an admin viewing as someone else: receives updates, emits nothing.
   *  Showing their borrowed identity as a live cursor would tell the room
   *  the owner is here when they aren't. */
  silent?: boolean
  /** the account behind the socket; unset for a signed-out guest */
  user?: AccessUser
  /** a signed-out visitor on an anyone-with-the-link canvas */
  guest?: boolean
  /** what this socket may do, re-resolved whenever sharing changes */
  role: CanvasRole
  /** the Cookie header of the upgrade request: carries the link-password unlock */
  cookie?: string
}

/* A guest (and a view-only member) is sent the canvas itself, its comments and presence, nothing of the team's working
   conversation: agent tasks, Memory and the activity feed. The list is closed by default: a new message type stays
   hidden from them until it is placed here. An agent's status line is its task's summary, so it is withheld too. */
const RESTRICTED_MESSAGES: ReadonlySet<ServerMessage['type']> = new Set([
  'presence:join',
  'presence:leave',
  'cursor',
  'viewport',
  'editing',
  'comment',
  'frame:drag',
  'frame:created',
  'frame:updated',
  'frame:deleted',
  'frame:streaming',
  'frame:claims',
  'canvas:renamed',
  'canvas:pages',
  'note:upsert',
  'note:delete',
  /* the design itself: ruler guides, components and tokens frames render with, a reloaded stylesheet */
  'guide',
  'component',
  'tokens',
  'asset:updated',
  'canvas:deleted',
  'role',
  'error',
  'mention',
])
const isRestricted = (c: Conn) => c.guest || c.role === 'view'

/** A presence as a restricted connection sees it: without the status line, which carries the task summary. */
function restrictedPresence<P extends Presence>({ status: _status, ...presence }: P): Omit<P, 'status'> {
  return presence
}

/** A room message as a guest or view-only member may see it, or null when it is withheld. */
function forRestricted(msg: ServerMessage): ServerMessage | null {
  if (!RESTRICTED_MESSAGES.has(msg.type)) return null
  if (msg.type === 'frame:claims') return withoutClaimNotes(msg)
  return msg.type === 'presence:join' ? { ...msg, presence: restrictedPresence(msg.presence) } : msg
}

type ClaimsMessage = Extract<ServerMessage, { type: 'frame:claims' }>

/** The claims a guest or view-only member sees: who holds a frame, not what they said they were doing. */
function withoutClaimNotes(msg: ClaimsMessage): ClaimsMessage {
  return { ...msg, claims: msg.claims.map((claim) => ({ ...claim, note: '' })) }
}

/** A canvas's advisory claims as the room carries them. */
function claimsMessage(canvasId: string, claims: FrameClaim[]): ClaimsMessage {
  return {
    type: 'frame:claims',
    canvasId,
    claims: claims.map((c) => ({
      frameId: c.frameId,
      holder: c.holder,
      note: c.note,
      expiresAt: new Date(c.expiresAt).toISOString(),
    })),
  }
}

const conns = new Map<WebSocket, Conn>()

function room(canvasId: string): Conn[] {
  return [...conns.values()].filter((c) => c.canvasId === canvasId)
}

/** A changed profile photo reaches every room the person is in: their
 *  presence is re-announced with the new face (a join for a known clientId
 *  is an update on the client). */
function refreshPresenceImage(userId: string, image: string | undefined): void {
  for (const conn of conns.values()) {
    if (conn.userId !== userId || conn.silent) continue
    conn.presence = { ...conn.presence, image }
    broadcast(conn.canvasId, { type: 'presence:join', presence: conn.presence }, conn.presence.clientId)
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(canvasId: string, msg: ServerMessage, excludeClientId?: string) {
  for (const c of room(canvasId)) {
    if (excludeClientId && c.presence.clientId === excludeClientId) continue
    const shown = isRestricted(c) ? forRestricted(msg) : msg
    if (shown) send(c.ws, shown)
  }
}

/* one message to every socket these accounts have on the canvas */
function sendToUsers(canvasId: string, userIds: readonly string[], msg: ServerMessage) {
  for (const c of room(canvasId)) if (c.user && userIds.includes(c.user.id)) send(c.ws, msg)
}

/* Sharing changed (a role, the link, a domain grant, the password): re-resolve
   every socket on the canvas. Someone who lost access is closed, not left
   listening; everyone else learns their new role so the UI follows. */
function refreshRoomAccess(canvasId: string) {
  const canvas = store.getCanvas(canvasId)
  for (const c of room(canvasId)) {
    const role = canvas
      ? c.guest
        ? guestRole(canvas, { unlocked: unlockedByCookie(canvas, c.cookie) })
        : canvasRole(c.user, canvas, { unlocked: unlockedByCookie(canvas, c.cookie) })
      : null
    if (!role) {
      c.ws.close(4403, 'no access')
      continue
    }
    if (role !== c.role) {
      c.role = role
      send(c.ws, { type: 'role', role })
    }
    /* the room now drops this visitor's editing messages, including the one that would clear their badge,
       so clear it for them */
    if (!roleAtLeast(role, 'edit') && c.presence.activeFrameId) {
      c.presence.activeFrameId = null
      broadcast(canvasId, { type: 'editing', clientId: c.presence.clientId, frameId: null }, c.presence.clientId)
    }
  }
}

/* Agents show up in presence while they are actively calling tools. */
interface AgentPresence extends Presence {
  lastSeen: number
}
const agentPresences = new Map<string, Map<string, AgentPresence>>() // canvasId -> name -> presence

function agentTouch(
  canvasId: string,
  agentName: string,
  frameId?: string | null,
  status?: string | null,
  owner?: string,
) {
  let byName = agentPresences.get(canvasId)
  if (!byName) agentPresences.set(canvasId, (byName = new Map()))
  let p = byName.get(agentName)
  const isNew = !p
  if (!p) {
    p = {
      clientId: `agent:${agentName}`,
      name: agentName,
      color: colorFor(agentName),
      kind: 'agent',
      owner,
      lastSeen: Date.now(),
      activeFrameId: frameId ?? null,
    }
    byName.set(agentName, p)
  }
  p.lastSeen = Date.now()
  if (owner && !p.owner) p.owner = owner
  if (frameId !== undefined) p.activeFrameId = frameId
  let statusChanged = false
  if (status !== undefined) {
    const next = status?.trim() || undefined
    if (p.status !== next) {
      p.status = next
      statusChanged = true
    }
  }
  if (isNew) {
    broadcast(canvasId, { type: 'presence:join', presence: p })
  } else {
    if (frameId !== undefined) {
      broadcast(canvasId, { type: 'editing', clientId: p.clientId, frameId: p.activeFrameId ?? null })
    }
    if (statusChanged) {
      broadcast(canvasId, { type: 'status', clientId: p.clientId, status: p.status ?? null })
    }
  }
}

/* claims change when an agent claims, releases or lets one lapse: the room always gets the whole list */
onClaimsChange((canvasId, claims) => broadcast(canvasId, claimsMessage(canvasId, claims)))

setInterval(() => {
  const now = Date.now()
  for (const [canvasId, byName] of agentPresences) {
    for (const [name, p] of byName) {
      /* an agent with a posted status is likely thinking between tool calls —
         keep it (and its status) on screen longer before expiring */
      if (now - p.lastSeen > (p.status ? 60_000 : 20_000)) {
        byName.delete(name)
        broadcast(canvasId, { type: 'presence:leave', clientId: p.clientId })
        actions.endAgentTasks(canvasId, p.name) // an agent that went silent is no longer "working on" anything
      }
    }
  }
}, 5000)

/* What a guest or a view-only member is sent of the canvas record: the design
   itself (frames, pages, notes), without who is on it or the team's style
   guides and Memory. */
function publicCanvasView(canvas: Canvas, guest: boolean): Canvas {
  const { guidelines: _guidelines, references: _references, ...rest } = canvas
  if (!guest) return rest
  const { memberIds: _members, memberRoles: _roles, ownerId: _owner, workspaceId: _workspace, ...visible } = rest
  return visible
}

actions.wire(broadcast, agentTouch)
/* a stylesheet was replaced in place: open canvases reload it in the frames that link it, and those frames' cached screenshots are dropped (their html and updatedAt did not change, so nothing else would) */
onAssetReplaced(({ assetId, version, frameIds }) => {
  const byCanvas = new Map<string, string[]>()
  for (const frameId of frameIds) {
    invalidateFrameImages(frameId)
    scheduleWarm(frameId)
    const frame = store.getFrame(frameId)
    if (frame) byCanvas.set(frame.canvasId, [...(byCanvas.get(frame.canvasId) ?? []), frameId])
  }
  for (const [canvasId, ids] of byCanvas)
    broadcast(canvasId, { type: 'asset:updated', assetId, version, frameIds: ids })
})
wireSharing({ refreshAccess: refreshRoomAccess, sendToUsers })
startAccessRequestExpiry()
/* after the room has been told: email for the people who were not in it */
onCanvasEvent(commentNotifications.onCanvasEvent)
/* a person @mentioned in a comment who is in the room hears about it live
   (toast + a pulsing pin); the email path above covers everyone else */
onCanvasEvent((canvasId, event) => {
  if (event.type !== 'comment.created' && event.type !== 'comment.replied') return
  const { comment } = event
  const targets = (comment.mentions ?? []).filter((id) => id !== comment.fromUserId)
  if (targets.length) sendToUsers(canvasId, targets, { type: 'mention', comment })
})
onCanvasEvent(webhooks.onCanvasEvent)
onCanvasEvent(imageDescriptions.onCanvasEvent)

/* ------------------------------------------------- http api */

const app = express()

/* Railway/Fly terminate TLS in front of us; trust the proxy so req.protocol
   and secure cookies see https, and OAuth metadata echoes the right origin */
app.set('trust proxy', 1)

/* DOOP_NOINDEX keeps a private instance out of search results. The header
   rides every response, pages and images alike, and is what search engines
   act on; robots.txt below still lets them fetch everything, because a
   crawler refused a page never sees its noindex and may list the bare URL. */
const NOINDEX = env.DOOP_NOINDEX
if (NOINDEX) {
  app.use((_req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
    next()
  })
}

app.get('/healthz', (_req, res) => res.json({ ok: true }))

/* how many canvases have their frame HTML in memory (store.load / evictIdle) */
app.get('/healthz/store', (_req, res) => {
  res.json(store.stats())
})

/* ------------------------------------------------------------------ */
/* PostHog relay: the client sends analytics + session-replay traffic  */
/* to this origin (/relay/...) and we forward it, so ad blockers that  */
/* match PostHog's domains never see a request to block. Mounted       */
/* before express.json — replay payloads are compressed binary and     */
/* must pass through untouched. Cookies are stripped: our auth session */
/* must not leak to a third party.                                     */
/* ------------------------------------------------------------------ */

const PH_INGEST = env.POSTHOG_INGEST_HOST
const PH_ASSETS = env.POSTHOG_ASSETS_HOST
const PH_DROP_HEADERS = new Set(['host', 'connection', 'cookie', 'content-length', 'accept-encoding'])

app.use('/relay', async (req, res) => {
  /* /static/* is PostHog's CDN (lazy bundles, toolbar); everything else
     (/e, /s, /flags, /array) is the ingestion API */
  const upstream = req.url.startsWith('/static/') ? PH_ASSETS : PH_INGEST

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && !PH_DROP_HEADERS.has(k)) headers[k] = v
  }
  /* keep the incoming XFF chain — its first entry is the real client IP
     and PostHog geolocates from it. Overwriting with req.ip would send
     Railway's edge-PoP address instead (trust proxy only strips one hop).
     Fall back to req.ip when there is no chain (local dev). */
  if (!headers['x-forwarded-for'] && req.ip) headers['x-forwarded-for'] = req.ip

  try {
    /* the body read must sit inside the try: navigating away mid-upload
       aborts big session-replay POSTs, which rejects this stream — left
       uncaught, that single abort would take down the whole process */
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    const r = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    /* accept-encoding was stripped, so the body is identity — but drop
       length/encoding headers anyway and let Express size the response */
    res.status(r.status)
    r.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding' && k !== 'connection')
        res.set(k, v)
    })
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch {
    /* analytics must never surface errors to the app */
    if (!res.headersSent) res.status(502)
    res.end()
  }
})

/* ------------------------------------------------------------------ */
/* Public frame images: /i/<frameId>.png|jpg — shareable/hotlinkable   */
/* (og:image etc). Unauthenticated by the same unguessable-id logic as */
/* canvas share links; renders the CURRENT frame, so embedded images   */
/* stay up to date as the design iterates. Caching, rate limiting and  */
/* render dispatch live in previews.ts — this route is HTTP only.      */
/* ------------------------------------------------------------------ */

app.get('/i/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  if (ext !== 'png' && ext !== 'jpg' && ext !== 'webp') return res.status(404).end()
  /* metadata only: a cached image needs no html, and a render reads the
     one frame's html when it starts (store.renderableFrame) */
  const frame = store.getFrame(id)
  if (!frame) return res.status(404).end()

  /* the render limit targets anonymous hotlink abuse — a logged-in user
     loading a dashboard of many canvases shouldn't hit it (and behind
     the Railway proxy many users can share one req.ip). Only called
     when the budget is exhausted, so cached serves stay auth-free. An
     agent key counts too, but only for people who can see this frame. */
  const isAuthenticated = async () =>
    !!(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)) ||
    (await bearerMayRender(req.headers, frame.canvasId).catch(() => false))
  const ip = req.ip ?? 'unknown'

  /* the dashboard card's small persisted jpeg keeps its own path */
  if (req.query.preview !== undefined && ext === 'jpg') {
    const scale = fitExportScale(frame, parseExportScale(req.query.scale) ?? 1)
    let result: Awaited<ReturnType<typeof getImage>>
    try {
      result = await getImage(frame, {
        ext,
        scale,
        quality: Math.min(100, Math.max(1, Number(req.query.quality) || 90)),
        preview: true,
        ip,
        isAuthenticated,
      })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
    }
    if (result.status === 'rate-limited') {
      res.set('Retry-After', '60')
      return res.status(429).json({ error: 'render rate limit — cached URLs are unaffected' })
    }
    res.set('Content-Type', 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=60')
    if (req.query.download !== undefined) {
      const safe = frame.name.replace(/[^\w\- ]+/g, '').trim() || 'frame'
      res.set('Content-Disposition', `attachment; filename="${safe}${exportScaleSuffix(scale)}.${ext}"`)
    }
    return res.send(result.buf)
  }

  const params = parseRenderQuery(frame, ext, req.query)
  if ('error' in params) return res.status(400).json({ error: params.error })
  let result: Awaited<ReturnType<typeof getRender>>
  try {
    result = await getRender(frame, params, { ip, isAuthenticated })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
  if (result.status === 'rate-limited') {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'render rate limit — cached URLs are unaffected' })
  }
  const { buf, etag } = result

  res.set('Content-Type', renderMime(params.format))
  res.set('ETag', etag)
  /* a URL pinned to this version of the frame never changes; a bare one always revalidates against the strong ETag (a 304 costs no render and a stale image is never served) */
  res.set('Cache-Control', req.query.v === String(frame.updatedAt) ? 'public, max-age=31536000, immutable' : 'no-cache')
  if (req.query.download !== undefined) {
    const safe = frame.name.replace(/[^\w\- ]+/g, '').trim() || 'frame'
    res.set(
      'Content-Disposition',
      `attachment; filename="${safe}${exportScaleSuffix(params.scale)}.${renderExt(params.format)}"`,
    )
  }
  if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end()
  res.send(buf)
})

/* ------------------------------------------------------------------ */
/* Uploaded assets: /a/<assetId>.<ext> — images, and stylesheets that frames link with <link rel="stylesheet">. Images are immutable, so far-future caching is safe. A stylesheet can be replaced in place (replaceAsset in assets.ts): its plain URL always serves the latest and revalidates against an ETag of <id>-<version>, while /a/<id>.css?v=<n> serves revision n and is immutable. Public by the same unguessable-id logic as /i/ (frame HTML embedding these URLs renders for anyone who can see the canvas). */
/* ------------------------------------------------------------------ */

app.get('/a/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  try {
    const pinned = typeof req.query.v === 'string' && /^\d{1,9}$/.test(req.query.v) ? Number(req.query.v) : undefined
    const found = await getAsset(id, pinned)
    if (!found || found.meta.ext !== ext) return res.status(404).end()
    const { mime, version } = found.meta
    const revision = { id, version, pinned: pinned !== undefined }
    res.set(assetResponseHeaders(mime, revision))
    /* Fonts load with CORS from sandboxed frames with opaque origins. Assets are public by unguessable id. */
    res.set('Access-Control-Allow-Origin', '*')
    if (req.query.download !== undefined) res.set('Content-Disposition', `attachment; filename="${id}.${ext}"`)
    /* Sandboxed frames have opaque origins, so the browser never caches what they load: a logo or theme stylesheet linked from 50 frames is fetched 50 times per canvas open. Text assets therefore go out compressed. */
    const textAsset = isTextAsset(mime)
    if (textAsset) res.vary('Accept-Encoding')
    const coding = textAsset ? negotiateCoding(req.headers['accept-encoding']) : undefined
    /* a validator names one exact byte sequence, so each content coding gets its own */
    if (res.getHeader('ETag')) {
      const etag = assetEtag(revision, coding ?? undefined)
      res.set('ETag', etag)
      if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end()
    }
    if (!coding) return res.send(found.buf)
    res.set('Content-Encoding', coding)
    res.send(await compressedOnce(`asset:${id}:${version}`, found.buf, coding))
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'asset fetch failed' })
  }
})

/* Curated background library (server/backgrounds.ts): /bg/<id>.webp and  */
/* /bg/<id>-t.webp straight from object storage. Public and immutable —  */
/* the catalog is checked in, the bytes are put there by the import      */
/* script and never rewritten under the same id.                         */
app.get('/bg/:file', async (req, res) => {
  const key = backgrounds.keyForFile(req.params.file)
  if (!key) return res.status(404).end()
  try {
    const buf = await storage.getObject(key)
    if (!buf) return res.status(404).end()
    res.set('Content-Type', 'image/webp')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('X-Content-Type-Options', 'nosniff')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'background fetch failed' })
  }
})

/* ------------------------------------------------------------------ */
/* One-time asset uploads: the upload_asset MCP tool mints a ticket and */
/* the agent curls the file here (curl -T file /u/<token>), so bytes    */
/* go disk -> doop without ever passing through the model. Mounted      */
/* before express.json — the body IS the file. The token is the         */
/* capability: unguessable, single-use, 15-minute TTL.                  */
/* ------------------------------------------------------------------ */

/* What a replacement answers with. The previous version is only worth a URL when this call made a new version, and version 1 has no predecessor. */
function replacementLinks(asset: { id: string; ext: string; version: number }, unchanged: boolean) {
  const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
  return { url, ...(!unchanged && asset.version > 1 ? { previous_url: `${url}?v=${asset.version - 1}` } : {}) }
}

app.put('/u/:token', async (req, res) => {
  const { token } = req.params
  const ticket = beginTicketUpload(token)
  if (!ticket)
    return res
      .status(410)
      .json({ error: 'invalid, expired or already-used upload ticket — request a new one via the upload_asset tool' })
  let success = false
  try {
    /* on any early rejection, destroy the request stream — otherwise curl
       keeps sending a body nobody reads and the connection deadlocks */
    if (Number(req.headers['content-length'] || 0) > MAX_ASSET_BYTES) {
      res.status(413).json({ error: 'file exceeds the 5 MB limit' })
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).length
      if (total > MAX_ASSET_BYTES) {
        res.status(413).json({ error: 'file exceeds the 5 MB limit' })
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    if (ticket.replaceAssetId) {
      /* a ticket minted to replace a stylesheet in place: same id and URL, a new version */
      const replaced = await replaceAsset(ticket.replaceAssetId, Buffer.concat(chunks), {
        uploadedBy: ticket.uploadedBy,
        ownerId: ticket.ownerId,
        canvasId: ticket.canvasId,
      })
      if (!replaced.ok) return res.status(400).json({ error: replaced.error })
      success = true
      const { url, previous_url } = replacementLinks(replaced.asset, replaced.unchanged)
      return res.json({
        ok: true,
        replaced: true,
        unchanged: replaced.unchanged,
        url,
        version: replaced.asset.version,
        ...(previous_url ? { previous_url } : {}),
        mime: replaced.asset.mime,
        size_bytes: replaced.asset.size,
        note: replaced.unchanged
          ? `The file is identical to version ${replaced.asset.version} — nothing changed.`
          : `Replaced in place — the same URL now serves version ${replaced.asset.version}. Open canvases reload it${previous_url ? `; ${previous_url} still serves the previous version` : ''}.`,
      })
    }
    /* tickets come only from upload_asset, which takes theme stylesheets as well as images */
    const asset = await createAsset(Buffer.concat(chunks), ticketAssetMeta(ticket), { stylesheets: true })
    success = true
    const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
    res.json({
      ok: true,
      url,
      mime: asset.mime,
      size_bytes: asset.size,
      usage: assetUsage(asset.mime, url),
      note: 'Permanent public URL — reference it in frame HTML.',
    })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
  } finally {
    endTicketUpload(token, success)
  }
})

/* better-auth handles /api/auth/* — mounted before express.json (it reads
   the raw body itself) and before the session gate below. Being mounted
   earlier means it also escapes the read-only rule on /api, so an admin
   who is viewing as someone else is filtered here instead:
     - the MCP OAuth flow authorises off the browser session, so it would
       mint a long-lived agent token belonging to the person being viewed,
       outliving the 15-minute view-as session entirely;
     - every other write (update-user, change-email, revoke-sessions, …)
       would edit the account of the person being viewed while the banner
       says "read only".
   An allowlist, not a blocklist: whatever endpoints a future better-auth
   plugin adds are refused by default rather than discovered later. */
const MCP_OAUTH_PATHS = /^\/api\/auth\/(mcp\/|oauth2\/(authorize|consent|token))/
const VIEW_AS_ALLOWED = /^\/api\/auth\/(sign-out|admin\/stop-impersonating)$/
app.all('/api/auth/*', async (req, res, next) => {
  /* Admin → Sign-in turned email/password sign-up off: the form is hidden,
     and the call it would make is refused too. Sign-in, password resets and
     provider sign-ups go on as before. */
  if (req.path === '/api/auth/sign-up/email' && !getInstanceSettings().emailPasswordSignup) {
    return res
      .status(403)
      .json({ code: 'SIGNUP_DISABLED', message: 'Sign-up with email and password is off on this instance.' })
  }
  const restricted = MCP_OAUTH_PATHS.test(req.path) || (req.method !== 'GET' && !VIEW_AS_ALLOWED.test(req.path))
  if (restricted) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
    if (session && (session.session as { impersonatedBy?: string | null }).impersonatedBy) {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
  }
  toNodeHandler(auth)(req, res).catch(next)
})

/* Stripe webhooks: the signature covers the exact bytes, so this route takes
   the raw body and sits ahead of the JSON parser; no session — Stripe is the
   caller. Everything it does is in server/workspaces.ts. */
app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  workspaces.handleStripeWebhook(req, res).catch((err) => {
    console.error('[billing] webhook crashed', err)
    if (!res.headersSent) res.status(500).json({ error: 'webhook handling failed' })
  })
})

for (const extension of extensions) {
  if (extension.webhookRouter) app.use(`/webhooks/${extension.id}`, extension.webhookRouter())
}

app.use(express.json({ limit: '10mb' }))
app.all('/gemini-cloud/mcp/:id', (req, res, next) => {
  handleGeminiCloudMcp(req, res).catch(next)
})
app.all('/local-agent/mcp/:id', (req, res, next) => {
  handleLocalAgentMcp(req, res).catch(next)
})

/* Where a brand-new account lands: the canvas signup created for it
   (server/auth.ts databaseHooks), where the demo agent is waiting to
   perform. better-auth sends new Google / Microsoft / SSO users here as
   their newUserCallbackURL and the email form comes here too, so every
   signup path shares one landing. Signed out, or without a canvas of their
   own any more, the dashboard will do. Ahead of the /api session guard:
   a browser arrives here, so a missing session is a redirect, not a 401. */
app.get(FIRST_CANVAS_PATH, async (req, res) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  /* ?connect=1 rides along: the lifecycle emails link here with a static URL
     and the canvas page opens the Connect AI modal on it. Signed out (an
     email opened in a fresh browser), the login page gets this URL as its
     redirect_to, so the destination survives the sign-in. The bare path
     keeps sending a signed-out browser to the dashboard as before. */
  const connect = req.query.connect === '1' ? '?connect=1' : ''
  if (!session)
    return res.redirect(connect ? `/?redirect_to=${encodeURIComponent(`${FIRST_CANVAS_PATH}${connect}`)}` : '/')
  /* ?signup=<method>: a provider sign-in that just created this account
     (src/pages/AuthPage.tsx). It rides on to wherever the account lands so
     the app can report the signup with its method, then drops it. */
  const method = typeof req.query[SIGNUP_PARAM] === 'string' ? parseSignupMethod(req.query[SIGNUP_PARAM]) : null
  const landing = new URLSearchParams(connect.slice(1))
  if (method) landing.set(SIGNUP_PARAM, method)
  const query = landing.size ? `?${landing}` : ''
  const canvas = store.firstCanvasOf(session.user.id)
  res.redirect(canvas ? `/c/${canvas.id}${query}` : `/${query}`)
})

/* Public: does an account exist for this email? Drives the login page's
   "no account found — sign up instead" prompt. Existence is already
   observable through signup's "user already exists" error, so this
   endpoint reveals nothing new. */
app.post('/api/account-exists', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const [row] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  res.json({ exists: !!row })
})

/* Public: is SSO configured, and what should the login button say? Static
   build shared across self-hosted deploys can't know this at build time —
   see server/auth.ts loginProvidersConfig for what's safe to expose here. */
app.get('/api/oidc-config', (req, res) => {
  const providers = loginProvidersConfig()
  res.json({ ...providers, ...loginPolicy(providers.enabled) })
})

/* Public: the interface language for visitors who have not picked one. The
   client asks before its first render, so sign-in already speaks it. */
app.get('/api/locale-config', (_req, res) => {
  const config: LocaleConfig = { defaultLocale: env.DEFAULT_LOCALE }
  res.json(config)
})

/* whether the sign-in page may offer sign-up at all (DOOP_INVITE_ONLY) */
app.get('/api/signup-config', (req, res) => {
  res.json({ inviteOnly: inviteOnly() })
})

/* An invite link's address, for the sign-up form to show. Open to anyone:
   the token is 192 random bits, and answers only for itself. */
app.get('/api/invites/:token', (req, res) => {
  const invite = inviteFor(req.params.token)
  if (!invite) return res.status(404).json({ error: 'This invite link has expired or was already used.' })
  res.json({ email: invite.email, expiresAt: invite.expiresAt })
})

/* ------------------------------------------------------------------ */
/* Design sync ingest: the doop-sync snippet on a foreign origin posts */
/* DOM snapshots here. The canvas-scoped write-only secret in the path */
/* is the whole credential (no cookies), so this stays outside the     */
/* /api session gate and answers its own CORS preflight. The route-    */
/* level parser also accepts text/plain — that's what sendBeacon      */
/* sends when a page unloads mid-capture.                              */
/* ------------------------------------------------------------------ */

app.options('/ingest/:key', (_req, res) => {
  ingest.setIngestCors(res)
  res.status(204).end()
})

app.post('/ingest/:key', express.json({ limit: '10mb', type: () => true }), (req, res) => {
  ingest.handleIngest(req, res).catch((err) => {
    console.error('[ingest] failed', err)
    if (!res.headersSent) res.status(500).json({ error: 'sync failed' })
  })
})

/* The few endpoints a signed-out visitor can reach: whether a share link is
   open to guests or behind a password, the password gate itself, and guest
   comments. Each one decides for itself (server/sharing.ts) — nothing here
   reads a session. */
app.use('/api/public', publicRouter)

/* everything else under /api requires a logged-in user; the session's user
   is authoritative for names — clients don't get to pick who they are */
interface SessionUser {
  id: string
  name: string
  email: string
  emailVerified?: boolean
  banned?: boolean | null
  /** the profile photo's URL; shown only when avatarUrl() admits it */
  image?: string | null
  role?: string | null
}
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      /** admin's user id when this session is a "view as" — see /api/admin */
      impersonatedBy?: string
    }
  }
}
/* an OAuth redirect begun in the desktop app lands in the system browser,
   whose session (if any) is not the app's: relay it back to the app before
   the gate looks at that session (shared/desktopConnect.ts) */
app.get('/api/integrations/:provider/callback', relayDesktopCallback)
app.use('/api/live-activities', logLiveActivityRequests)
app.use('/api', async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    req.user = session.user
    req.impersonatedBy = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? undefined
    /* Viewing as someone else is read-only, full stop. Every doop mutation is
       a non-GET REST call — the websocket after `join` carries only cursor,
       editing and frame:drag — so this single rule covers the whole surface.
       better-auth's own routes are mounted earlier (/api/auth/*), so signing
       out and stop-impersonating are unaffected. */
    if (req.impersonatedBy && req.method !== 'GET') {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
    next()
  } catch (err) {
    next(err)
  }
})

/* Every route naming a canvas, frame or comment gets that canvas's frame
   HTML loaded before its handler runs (store.load), so handlers keep
   reading the store synchronously, and held until the response is done, so
   a handler awaiting something slow (an import, a render) keeps it.
   Behind the session gate, so only a signed-in request can bring a canvas
   into memory. */
function loadFirst(canvasOf: (id: string) => string | undefined): express.RequestHandler {
  return (req, res, next) => {
    const canvasId = canvasOf(String(req.params.id))
    if (!canvasId) return next()
    store.load(canvasId).then(() => {
      res.once('close', store.hold(canvasId))
      next()
    }, next)
  }
}
app.use(
  '/api/canvases/:id',
  loadFirst((id) => id),
)
app.use(
  '/api/frames/:id',
  loadFirst((id) => store.getFrame(id)?.canvasId),
)
app.use(
  '/api/comments/:id',
  loadFirst((id) => actions.findComment(id)?.canvasId),
)

/* Home's push channel: tells an open dashboard its canvas list changed */
app.get('/api/me/events', userEvents.subscribe)

app.get('/api/me', async (req, res) => {
  const { id, name, email, image } = req.user!
  res.json({
    id,
    name,
    email,
    image: avatarUrl(image),
    admin: isAdmin(req.user),
    /* 'team' while a member of a live paid workspace — the account menu's plan line */
    plan: workspaces.planFor(id),
    /* the SPA cannot infer this: impersonation swaps the session cookie
       outright, so everything else on this response describes the person
       being viewed, not the admin doing the viewing */
    impersonating: req.impersonatedBy ? { byName: (await getUserName(req.impersonatedBy)) ?? 'an admin' } : undefined,
  })
})

/* The profile photo: raw image bytes in, the face's URL out. Rooms the
   person is in see the new face at once; the session the browser holds is
   re-read by the page, since better-auth serves it from the row. */
app.post('/api/me/avatar', express.raw({ type: () => true, limit: MAX_AVATAR_BYTES + 1024 }), async (req, res) => {
  try {
    const image = await setAvatar(req.user!.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
    refreshPresenceImage(req.user!.id, image)
    res.json({ image })
  } catch (e) {
    if (e instanceof AvatarInputError) res.status(400).json({ error: e.message })
    else {
      console.error('[avatar] upload failed', e)
      res.status(500).json({ error: 'the photo could not be saved — try again' })
    }
  }
})

app.delete('/api/me/avatar', async (req, res, next) => {
  try {
    await clearAvatar(req.user!.id)
    refreshPresenceImage(req.user!.id, undefined)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/* Resolve the application from the consent code itself, never a client name or
   id supplied by the page. Only the account authorizing the code may use it. */
async function mcpConsent(code: string, userId: string) {
  const [request] = await db.select().from(authSchema.verification).where(eq(authSchema.verification.identifier, code))
  if (!request || request.expiresAt <= new Date()) return null
  let value: { userId?: string; clientId?: string; requireConsent?: boolean } | null
  try {
    value = JSON.parse(request.value)
  } catch {
    return null
  }
  if (!value || value.userId !== userId || value.requireConsent !== true || typeof value.clientId !== 'string')
    return null
  const [client] = await db
    .select()
    .from(authSchema.oauthApplication)
    .where(eq(authSchema.oauthApplication.clientId, value.clientId))
  return client && !client.disabled ? { name: client.name } : null
}

app.get('/api/mcp-consent/:code', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    const client = await mcpConsent(req.params.code!, req.user!.id)
    if (!client)
      return res.status(404).json({ error: 'This connection request has expired. Start again from your agent.' })
    res.json(client)
  } catch (error) {
    next(error)
  }
})

app.post('/api/mcp-consent/:code', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    if (typeof req.body?.accept !== 'boolean') return res.status(400).json({ error: 'Choose whether to connect.' })
    if (!(await mcpConsent(req.params.code!, req.user!.id)))
      return res.status(404).json({ error: 'This connection request has expired. Start again from your agent.' })
    const result = await auth.api.oAuthConsent({
      headers: fromNodeHeaders(req.headers),
      body: { accept: req.body.accept, consent_code: req.params.code! },
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

/* Canvas access on the REST surface: resolve the canvas (or the frame's
   canvas) and run it through the role resolver (server/access.ts, via server/sharing.ts) before touching anything.
   `need` is the least role the route needs: view for reads, comment for
   commenting, edit for everything that changes the design. `need` is required
   on purpose: a route that forgets it does not compile, rather than defaulting
   open. Both helpers write the error response themselves and return null. */
/** The signed-in person as the actor of a REST write. The name is the
 *  account's, never the body's; the body's `actor.clientId` is kept, since it
 *  is only the browser tab's presence token, which lets the room tell that
 *  tab's own writes from everyone else's (the remote-edit flash). */
function userActor(req: express.Request) {
  const clientId = req.body?.actor?.clientId
  return actions.resolveActor({
    name: req.user!.name,
    kind: 'user',
    userId: req.user!.id,
    clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : undefined,
  })
}

const requireCanvas = requireCanvasRole

/** The frame, once the caller holds `need` on its canvas, plus the optimistic-concurrency check path editing relies on:
 *  when the caller sends the `updatedAt` it last saw, a frame that moved on meanwhile answers 409 with the current
 *  frame. */
function requireFrame(
  req: express.Request,
  res: express.Response,
  frameId: string,
  need: CanvasRole,
  expectedUpdatedAt?: unknown,
) {
  const frame = requireFrameRole(req, res, frameId, need)
  if (!frame) return null
  if (expectedUpdatedAt !== undefined) {
    if (typeof expectedUpdatedAt !== 'number' || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      res.status(400).json({ error: 'expectedUpdatedAt must be a nonnegative integer' })
      return null
    }
    // PATCH and DELETE mutate the store synchronously after this check.
    if (frame.updatedAt !== expectedUpdatedAt) {
      res.status(409).json({ error: 'The frame changed while you were editing. Please try again.', frame })
      return null
    }
  }
  return frame
}

app.use('/api/local-agent', localAgentRouter)
app.use('/api/image-descriptions', imageDescriptions.imageDescriptionsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/webhooks', webhooksRouter)
app.use('/api/canvases', seenRouter)
app.use('/api/canvases', deckRouter)
app.use('/api/fonts', fontsRouter)

/* the font library a canvas designs with: its workspace's, or its owner's */
app.get('/api/canvases/:id/fonts', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (canvas) res.json(fontsForCanvas(canvas))
})
app.use('/api/admin', adminRouter)
app.use('/api/community', communityRouter)
app.use('/api/automations', automationsRouter)
app.use('/api/integrations', integrationsRouter)
app.use('/api/workspaces', workspaces.workspacesRouter)
app.use('/api/live-activities', liveActivitiesRouter)
startLiveActivityDelivery()
app.use('/api/billing', billing.billingRouter)

/* free-tier meter for the resident team: {used, limit, connected, byoModel} */
app.get('/api/agent-allowance', (req, res) => {
  allowance
    .getAllowance(req.user!.id)
    .then((a) => res.json(a))
    .catch(() => res.status(500).json({ error: 'allowance unavailable' }))
})

/* the connections the composer may send a task to, and the Settings default */
app.get('/api/agent-runners', (req, res) => {
  listRunners(req.user!.id)
    .then((runners) => res.json(runners))
    .catch(() => res.status(500).json({ error: 'runners unavailable' }))
})

/* which connection comments, @mentions and automations run on; it has to be
   one that is connected and on right now */
app.put('/api/agent-runners/default', async (req, res) => {
  const provider: unknown = req.body?.provider
  if (!isRunnerProvider(provider)) return res.status(400).json({ error: 'unknown connection' })
  try {
    const userId = req.user!.id
    const usable =
      provider === 'claude-local'
        ? (await getLocalAgentPreference(userId)).enabled
        : (await modelAccounts.getAccount(userId, provider))?.enabled
    if (!usable) return res.status(400).json({ error: 'connect and switch that on first' })
    await setStoredDefault(userId, provider)
    res.json(await accountsView(userId))
    wakeUserWork(userId)
  } catch {
    res.status(500).json({ error: 'could not change the default' })
  }
})

/* ---- the user's own model account: what keeps the Doop Agent running once
   the free tasks are gone. Tokens live server-side and are never returned. */

/* Every account route answers with the whole Settings view (every account,
   on or off, and the default): the client re-renders straight from it. */
app.get('/api/model-account', (req, res) => {
  accountsView(req.user!.id)
    .then((view) => res.json(view))
    .catch(() => res.status(500).json({ error: 'account status unavailable' }))
})

app.get('/api/model-account/models', async (req, res) => {
  try {
    const kind: unknown = req.query.kind
    if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
    const account = await modelAccounts.getAccount(req.user!.id, kind)
    if (!account) return res.json({ models: [], live: false })
    /* a ChatGPT token may have lapsed since the last run; a refresh that
       fails leaves the stale token to be refused, which the catalog reports
       as "reconnect" rather than this route failing outright */
    const live = await Promise.race([
      modelAccounts.withFreshToken(account).catch(() => account),
      /* the refresh has no timeout of its own; a stalled token endpoint
         must not hold the picker past the catalog's own budget */
      new Promise<typeof account>((resolve) => setTimeout(resolve, 8_000, account).unref()),
    ])
    res.json(await modelCatalogFor(live, menuFor(account)))
  } catch {
    res.status(500).json({ error: 'models unavailable' })
  }
})

/* one account's model tier, (OpenAI kinds) how hard it thinks, or whether
   it is switched on — one field per request, the view comes back either way */
app.patch('/api/model-account/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
  try {
    const userId = req.user!.id
    const { model, effort, enabled } = (req.body ?? {}) as { model?: unknown; effort?: unknown; enabled?: unknown }
    if (typeof enabled === 'boolean') await modelAccounts.setAccountEnabled(userId, kind, enabled)
    else if (effort !== undefined) await modelAccounts.setAccountEffort(userId, kind, String(effort))
    else await modelAccounts.setAccountModel(userId, kind, String(model ?? ''))
    res.json(await accountsView(userId))
    /* switching one on can make queued work runnable */
    if (enabled === true) wakeUserWork(userId)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not change that account' })
  }
})

/* OpenAI's only registered redirect is a loopback URL, so the browser's
   callback is reachable by us exactly when the browser is on this machine.
   A forwarded request came through a proxy and is by definition not. */
function isSameMachine(req: express.Request): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false
  const ip = req.socket.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/* step 1 of the ChatGPT flow: hand back the OpenAI authorize URL to open.
   `catching` tells the client we will pick the redirect up ourselves, so it
   can poll instead of asking the user to copy anything. */
app.post('/api/model-account/chatgpt/authorize', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  const started = modelAccounts.beginChatgptAuth(req.user!.id)
  const catching = isSameMachine(req) ? await modelAccounts.startCallbackCatcher() : false
  res.json({ ...started, catching })
})

/* step 2: the user pastes the redirect URL they landed on; we do the code
   exchange server-side, so the browser never handles a token */
app.post('/api/model-account/chatgpt', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    await modelAccounts.completeChatgptAuth(req.user!.id, String(req.body?.redirect ?? ''))
    res.json(await accountsView(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect that ChatGPT account' })
  }
})

/* device flow: no redirect URI at all, so it works wherever Doop is hosted.
   We poll OpenAI in the background; the browser polls the status below. */
app.post('/api/model-account/chatgpt/device', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    res.json(await modelAccounts.beginDeviceAuth(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not start a device sign-in' })
  }
})

app.get('/api/model-account/chatgpt/device', (req, res) => {
  res.json(modelAccounts.deviceAuthStatus(req.user!.id) ?? { status: 'none' })
})

app.delete('/api/model-account/chatgpt/device', (req, res) => {
  modelAccounts.cancelDeviceAuth(req.user!.id)
  res.json({ ok: true })
})

/* each key connects beside whatever else is connected: nothing is switched
   off, and the default changes only when the person marks another one */
const KEY_CONNECTS = {
  'openai-key': modelAccounts.connectApiKey,
  'anthropic-key': modelAccounts.connectAnthropicKey,
  'openrouter-key': modelAccounts.connectOpenRouterKey,
  'gemini-key': modelAccounts.connectGeminiKey,
  'deepseek-key': modelAccounts.connectDeepSeekKey,
  'kimi-key': modelAccounts.connectKimiKey,
  'kimi-code': modelAccounts.connectKimiCodeKey,
} as const
for (const [kind, connect] of Object.entries(KEY_CONNECTS)) {
  app.post(`/api/model-account/${kind}`, async (req, res) => {
    try {
      await connect(req.user!.id, String(req.body?.apiKey ?? ''))
      res.json(await accountsView(req.user!.id))
      wakeUserWork(req.user!.id)
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'could not save that API key' })
    }
  })
}

/* ---- custom providers: any OpenAI- or Anthropic-compatible endpoint, by
   its base URL. One is a model account of kind `custom:<id>`, so switching it
   on or off, picking its model, making it the default and disconnecting it
   are the routes above; these create and edit it, and help set it up. */

app.use('/api/custom-providers', (_req, res, next) => {
  if (!customProvidersEnabled()) return res.status(404).json({ error: 'custom providers are off on this server' })
  next()
})

/** The key and headers a request carries: a field left out is undefined, so
 *  an edit keeps the stored one; an empty key clears it. */
function customSecrets(body: Record<string, unknown>): { apiKey?: string; headers?: Record<string, string> } {
  const secrets: { apiKey?: string; headers?: Record<string, string> } = {}
  if (body.apiKey !== undefined) {
    const key = parseCustomKey(body.apiKey)
    if (!key.ok) throw new CustomProviderError(key.error)
    secrets.apiKey = key.value
  }
  if (body.headers !== undefined) {
    const headers = parseCustomHeaders(body.headers)
    if (!headers.ok) throw new CustomProviderError(headers.error)
    secrets.headers = headers.value
  }
  return secrets
}

/** A validated provider description whose URL this server may reach. */
function customConfig(body: unknown) {
  const config = parseCustomProviderConfig(body)
  if (!config.ok) throw new CustomProviderError(config.error)
  reachableUrl(config.value.baseUrl)
  return config.value
}

/** The secrets a set-up request should use: what it carries, else (for a
 *  provider being edited) what is stored for it. */
async function probeSecrets(userId: string, body: Record<string, unknown>) {
  const given = customSecrets(body)
  const stored = isCustomProviderKind(body.kind) ? await modelAccounts.getAccount(userId, body.kind) : null
  const apiKey = given.apiKey ?? stored?.apiKey
  const headers = given.headers ?? stored?.headers
  return { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) }
}

function customFailure(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof CustomProviderError || error instanceof CustomProviderUrlError) {
    return res.status(400).json({ error: error.message })
  }
  /* the provider's own error text (a 400 body, a refused model) is what the
     person needs to fix their endpoint; never a stack */
  const message = error instanceof Error ? error.message.slice(0, 500) : fallback
  return res.status(400).json({ error: message || fallback })
}

app.post('/api/custom-providers', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const config = customConfig(body)
    await modelAccounts.connectCustomProvider(req.user!.id, config, customSecrets(body))
    res.json(await accountsView(req.user!.id))
    wakeUserWork(req.user!.id)
  } catch (error) {
    customFailure(res, error, 'could not add that provider')
  }
})

app.put('/api/custom-providers/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!isCustomProviderKind(kind)) return res.status(400).json({ error: 'unknown provider' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    await modelAccounts.updateCustomProvider(req.user!.id, kind, customConfig(body), customSecrets(body))
    res.json(await accountsView(req.user!.id))
    wakeUserWork(req.user!.id)
  } catch (error) {
    customFailure(res, error, 'could not save that provider')
  }
})

/* the endpoint's own model list, to fill the form's rows */
app.post('/api/custom-providers/models', async (req, res) => {
  const userId = req.user!.id
  if (!takeProbeSlot(userId)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const apiType = CUSTOM_API_TYPES.find((type) => type === body.apiType)
    if (!apiType) throw new CustomProviderError('Pick the API type')
    const baseUrl = normalizeBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '')
    if (!baseUrl.ok) throw new CustomProviderError(baseUrl.error)
    const models = await discoverCustomModels({
      config: { apiType, baseUrl: baseUrl.value },
      ...(await probeSecrets(userId, body)),
    })
    res.json({ models })
  } catch (error) {
    customFailure(res, error, 'could not list that endpoint’s models')
  }
})

/* one short turn that has to call a tool: the agent cannot work without it */
app.post('/api/custom-providers/test', async (req, res) => {
  const userId = req.user!.id
  if (!takeProbeSlot(userId)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const config = customConfig(body)
    const model = config.models.find((option) => option.id === body.model) ?? config.models[0]
    if (!model) throw new CustomProviderError('Add a model to test')
    await testCustomProvider({ config, ...(await probeSecrets(userId, body)) }, model)
    res.json({ ok: true, model: model.id })
  } catch (error) {
    customFailure(res, error, 'the test turn failed')
  }
})

app.delete('/api/model-account/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
  await modelAccounts.disconnect(req.user!.id, kind)
  res.json(await accountsView(req.user!.id))
})

/* ---- which image model generate_image draws with (the shared registry;
   entries the payer cannot run are shown but disabled) */

app.get('/api/image-model', (req, res) => {
  imageModelAvailability(req.user!.id)
    .then((models) => res.json({ models }))
    .catch(() => res.status(500).json({ error: 'image models unavailable' }))
})

app.put('/api/image-model', async (req, res) => {
  try {
    const model = String(req.body?.model ?? '')
    const models = await imageModelAvailability(req.user!.id)
    const entry = models.find((m) => m.id === model)
    if (!entry) throw new Error('unknown image model')
    if (!entry.available) throw new Error('that image model is not available on your account or this server')
    await setImagePref(req.user!.id, model)
    res.json({ models: await imageModelAvailability(req.user!.id) })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not change the image model' })
  }
})

/* ---- Agent keys: account-scoped bearer credentials for /mcp, the headless
   agent path (see server/agentKeys.ts). The secret appears exactly once, in
   the create response; the list carries only each key's start. The /api
   session gate above means impersonating admins can look but not mint. */

app.get('/api/agent-keys', async (req, res) => {
  res.json(await agentKeys.listAgentKeys(req.user!.id))
})

app.post('/api/agent-keys', async (req, res) => {
  const key = await agentKeys.createAgentKey(req.user!.id, String(req.body?.name ?? ''))
  if (!key) return res.status(400).json({ error: 'agent key limit reached — revoke one you no longer use' })
  res.json(key)
})

app.delete('/api/agent-keys/:id', async (req, res) => {
  if (!(await agentKeys.deleteAgentKey(req.user!.id, req.params.id)))
    return res.status(404).json({ error: 'agent key not found' })
  res.json({ ok: true })
})

app.get('/api/canvases', async (req, res) => {
  const list = workspaces.canvasesFor(req.user!.id)
  /* the people on each canvas (owner first, then invited members) resolve
     to names in one query — the home tiles wear them as an avatar stack */
  const peopleIds = new Set<string>()
  for (const c of list) for (const id of canvasPeopleIds(c.id)) peopleIds.add(id)
  const users = new Map<string, { name: string; image: string | null }>()
  if (peopleIds.size) {
    const rows = await db
      .select({ id: authSchema.user.id, name: authSchema.user.name, image: authSchema.user.image })
      .from(authSchema.user)
      .where(inArray(authSchema.user.id, [...peopleIds]))
    for (const r of rows) users.set(r.id, r)
  }
  res.json(
    list.map((c) => {
      /* which agents have worked on this canvas (most recent first), with
         the user whose token they connected under and when they last worked */
      const seen = new Map<string, { owner?: string; lastAt: number }>()
      for (const t of actions.getTasks(c.id)) {
        if (!t.agentName) continue // unclaimed board cards have no agent yet
        if (!seen.has(t.agentName)) seen.set(t.agentName, { owner: t.owner, lastAt: t.startedAt })
      }
      return {
        ...c,
        people: canvasPeopleIds(c.id).map((id) => ({
          id,
          name: users.get(id)?.name ?? 'Unknown',
          image: avatarUrl(users.get(id)?.image),
        })),
        agents: [...seen].slice(0, 8).map(([name, v]) => ({ name, owner: v.owner, lastAt: v.lastAt })),
        activeTasks: activeAgentTasks(actions.getTasks(c.id)),
      }
    }),
  )
})

/** owner first, then invited members, each once */
function canvasPeopleIds(canvasId: string): string[] {
  const c = store.getCanvas(canvasId)
  if (!c) return []
  return [...new Set([...(c.ownerId ? [c.ownerId] : []), ...(c.memberIds ?? [])])]
}

/* A workspace canvas needs membership and a workspace that may still grow —
   the 402 is what every client turns into the upgrade modal. */
function requireGrowableWorkspace(req: express.Request, res: express.Response, workspaceId: string) {
  const ws = workspaces.getWorkspace(workspaceId)
  if (!ws || !workspaces.isWorkspaceMember(ws.id, req.user!.id)) {
    res.status(404).json({ error: 'workspace not found' })
    return null
  }
  if (!workspaces.isActive(ws)) {
    workspaces.planRequired(res, ws)
    return null
  }
  return ws
}

app.post('/api/canvases', (req, res) => {
  const name = String(req.body?.name || 'Untitled canvas')
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined
  if (workspaceId && !requireGrowableWorkspace(req, res, workspaceId)) return
  res.json(store.createCanvas(name, req.user!.id, workspaceId))
})

/* members and their roles, domain grants, access requests, the mention picker */
app.use('/api/canvases', sharingRouter)

app.post('/api/canvases/:id/duplicate', async (req, res) => {
  const source = store.getCanvas(req.params.id)
  if (!source) return res.status(404).json({ error: 'not found' })
  if (!hasDurableCanvasAccess(accessUserOf(req), source, 'edit'))
    return res.status(403).json({ error: 'access denied' })
  /* a copy stays in the workspace when the copier is a member of it and the
     workspace may still take canvases; otherwise it lands in their personal space */
  const sourceWs = source.workspaceId ? workspaces.getWorkspace(source.workspaceId) : undefined
  const workspaceId =
    sourceWs && workspaces.isWorkspaceMember(sourceWs.id, req.user!.id) && workspaces.isActive(sourceWs)
      ? sourceWs.id
      : undefined
  try {
    const copy = await store.duplicateCanvas(source.id, req.user!.id, req.user!.name, { workspaceId })
    res.json(copy)
  } catch (error) {
    console.error('[canvas] duplicate failed', error)
    res.status(500).json({ error: 'could not duplicate canvas' })
  }
})

app.get('/api/canvases/:id', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  /* the caller's own role rides along, so the editor knows to go read-only */
  if (c) res.json({ ...c, role: roleFor(req, c) })
})

/* Community gallery listing — the owner's call alone, like link access.
   PUT both lists and re-describes; DELETE takes it down. */
app.put('/api/canvases/:id/publish', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can publish a canvas' })
  if (!publishableFrames(c).length) return res.status(400).json({ error: 'add a frame before publishing' })
  const listing = parseListing(req.body)
  if (typeof listing === 'string') return res.status(400).json({ error: listing })
  const published = store.publishCanvas(c.id, listing)!
  res.json({ publishedAt: published.publishedAt, description: published.description, category: published.category })
})

app.delete('/api/canvases/:id/publish', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can unpublish a canvas' })
  store.unpublishCanvas(c.id)
  res.json({ ok: true })
})

/* Move a canvas into a workspace (its owner, who must be a member, while it
   may grow) or back out to its owner's personal space (the owner, or a
   workspace admin). Moving is an access change, not an edit: every member
   of the target workspace can open it from now on. */
app.put('/api/canvases/:id/workspace', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const target = req.body?.workspaceId
  if (target !== null && typeof target !== 'string')
    return res.status(400).json({ error: 'workspaceId must be a workspace id or null' })
  if (!canManageCanvas(req.user!.id, c))
    return res.status(403).json({ error: 'only the canvas owner or a workspace admin can move it' })
  if (target !== null) {
    if (target === c.workspaceId) return res.json({ ok: true })
    /* an admin's say over a workspace canvas ends at moving it out: re-homing
       it into another workspace — one the owner may not even belong to — is
       the owner's call alone */
    if (c.ownerId !== req.user!.id)
      return res.status(403).json({ error: 'only the canvas owner can move it into a workspace' })
    if (!requireGrowableWorkspace(req, res, target)) return
  }
  store.setWorkspace(c.id, target ?? undefined)
  res.json({ ok: true })
})

app.post('/api/canvases/:id/claim', (req, res) => {
  const c = store.claimCanvas(req.params.id, req.user!.id)
  if (!c) return res.status(409).json({ error: 'not found or already owned' })
  res.json({ ok: true })
})

/* recent activity across all of the user's canvases, for the home dashboard */
app.get('/api/home/activity', (req, res) => {
  const canvases = workspaces.canvasesFor(req.user!.id)
  const items = canvases.flatMap((c) =>
    actions
      .getActivity(c.id)
      .slice(0, 20)
      .map((a) => ({ ...a, canvasId: c.id, canvasName: c.name })),
  )
  items.sort((a, b) => b.at - a.at)
  res.json(items.slice(0, 14))
})

app.delete('/api/canvases/:id', (req, res) => {
  const c = store.getCanvas(req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  /* only the owner (or an admin of its workspace) may delete; unclaimed
     (legacy) canvases are reachable only by direct link and must be claimed
     before they can be destroyed */
  if (!c.ownerId) return res.status(403).json({ error: 'claim it first' })
  if (!canManageCanvas(req.user!.id, c)) return res.status(403).json({ error: 'not yours' })
  actions.deleteCanvas(c.id)
  res.json({ ok: true })
})

app.patch('/api/canvases/:id', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  const { name, linkAccess, linkAudience, linkPassword } = req.body ?? {}
  const touchesLink = linkAccess !== undefined || linkAudience !== undefined || linkPassword !== undefined
  const renames = typeof name === 'string' && name.trim() !== ''
  /* the link policy is the owner's alone — collaborators can rename, not lock;
     and renaming is a design edit, which a view or comment role does not have */
  if (touchesLink && c.ownerId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner can change link access' })
  if (renames && !roleAtLeast(roleFor(req, c), 'edit'))
    return res.status(403).json({ error: 'you do not have edit access to this canvas' })
  if (touchesLink) {
    const problem = await applyLinkSettings(c, { linkAccess, linkAudience, linkPassword })
    if (problem) return res.status(400).json({ error: problem })
  }
  if (renames) {
    const actor = userActor(req)
    actions.renameCanvas(c.id, name.trim(), actor)
  }
  res.json({
    ok: true,
    linkAccess: c.linkAccess ?? 'none',
    linkAudience: c.linkAudience ?? 'signed-in',
    hasLinkPassword: !!c.hasLinkPassword,
  })
})

/* ---- design-sync keys: mint/list/revoke the write-only snippet creds.
   Owner and invited members only — NOT link-edit visitors. A key is a
   durable bearer credential, so someone whose access is only the share
   link must not be able to mint one (or read an existing secret) and
   keep writing frames after the owner turns the link off. */

function requireDurableCanvas(req: express.Request, res: express.Response, canvasId: string) {
  const c = requireCanvas(req, res, canvasId, 'edit')
  if (!c) return null
  if (!hasDurableCanvasAccess(accessUserOf(req), c, 'edit')) {
    res.status(403).json({ error: 'sync keys are managed by the owner and invited members' })
    return null
  }
  return c
}

app.get('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const keys = await ingest.listSyncKeys(c.id)
  res.json(keys.map((k) => ({ ...k, frames: ingest.syncedFrameCount(c, k.id) })))
})

app.post('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const key = await ingest.createSyncKey(c.id, String(req.body?.name ?? ''), req.user!.id)
  res.json({ ...key, frames: 0 })
})

/* the flow map is design insight, not a credential — anyone who can see the
   frames can see how they connect */
app.get('/api/canvases/:id/sync-flow', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  res.json(await ingest.getSyncFlow(c))
})

app.delete('/api/canvases/:id/sync-keys/:keyId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await ingest.deleteSyncKey(req.params.id, req.params.keyId)))
    return res.status(404).json({ error: 'sync key not found' })
  res.json({ ok: true })
})

/* ---- GitHub import source: connect a repo, enumerate its screens, land the
   selected ones as frames. Same durable-access rule as sync keys — the
   stored PAT is a standing credential, so link-edit visitors must not be
   able to create or exercise a connection. Tokens never leave the server. */

app.get('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const connections = await github.listConnections(c.id)
  res.json(
    connections.map((conn) => ({ ...github.connectionInfo(conn), frames: github.importedFrameCount(c, conn.id) })),
  )
})

app.post('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  try {
    /* app mode: a signed pass from the install round-trip stands in for the
       token, binding the GitHub App installation to this canvas */
    let grants: githubApp.InstallationGrant[] | undefined
    if (typeof req.body?.pass === 'string') {
      grants = githubApp.redeemInstallPass(req.body.pass, c.id)
      if (!grants) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
    }
    const conn = await github.createConnection({
      canvasId: c.id,
      repo: String(req.body?.repo ?? ''),
      token: typeof req.body?.token === 'string' ? req.body.token : undefined,
      grants,
      branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
      createdBy: req.user!.id,
    })
    res.json({ ...github.connectionInfo(conn), frames: 0 })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect the repository' })
  }
})

/* ---- GitHub App install flow: click Connect on the canvas, pick repos on
   GitHub's install screen, land back on the canvas with a repo picker. The
   signed state/pass pair keeps guessable installation ids from being bound
   to canvases that never started an install (server/githubApp.ts). */

app.get('/api/github/app', (req, res) => {
  res.json({ enabled: githubApp.appEnabled(), slug: githubApp.appSlug() })
})

app.post('/api/canvases/:id/github/app/start', (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  if (!githubApp.appEnabled()) return res.status(400).json({ error: 'the GitHub App is not configured' })
  /* authorize first: it finds installations the user already has, so a new
     canvas skips the install screen (see the setup callback) */
  res.json({ url: githubApp.oauthBounceUrl(githubApp.signFindState(c.id, req.user!.id)) })
})

/* "Add repositories on GitHub" from the repo picker: a plain link the
   picker opens in a new tab, straight to the install screen with a state
   for this canvas, so a fresh install on another account returns here too. */
app.get('/api/canvases/:id/github/app/install', (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  if (!githubApp.appEnabled()) return res.status(400).json({ error: 'the GitHub App is not configured' })
  res.redirect(githubApp.installUrl(githubApp.signInstallState(c.id, req.user!.id)))
})

/* GitHub's post-install redirect (the app's callback URL, with "request
   user authorization during installation" on). Verifies the state minted at
   start AND that the OAuth code's user actually owns the installation —
   installation ids are guessable, and without the ownership proof a valid
   state could bind someone else's installation. The same user token lists
   the repos GitHub lets THIS user reach through it (an org installation
   covers more than one member may see); that snapshot is what the pass
   stands for. Then swaps state for the pass and returns to the canvas,
   where the import modal shows the repo picker. */
app.get('/api/github/app/setup', async (req, res) => {
  const rawState = String(req.query.state ?? '')
  const code = String(req.query.code ?? '')
  /* failures land back on the canvas with a visible reason — a silent
     homepage redirect reads as "nothing happened" */
  const fail = (canvasId: string, reason: string) =>
    res.redirect(`/c/${encodeURIComponent(canvasId)}?ghError=${encodeURIComponent(reason)}`)
  const succeed = (canvasId: string, grants: githubApp.InstallationGrant[]) =>
    res.redirect(
      `/c/${encodeURIComponent(canvasId)}?ghInstall=${encodeURIComponent(githubApp.issueInstallPass(canvasId, grants))}`,
    )

  /* return leg of Connect's authorize step: the installations this GitHub
     user already has go straight to the repo picker; none, on to install */
  const find = githubApp.verifyFindState(rawState)
  if (find) {
    if (!code) return fail(find.canvasId, 'GitHub authorization was cancelled — connect again when you’re ready')
    try {
      const grants = await githubApp.userAccess(code)
      if (grants?.length) return succeed(find.canvasId, grants)
      if (grants) return res.redirect(githubApp.installUrl(githubApp.signInstallState(find.canvasId, find.userId)))
    } catch {
      /* fall through to the error redirect */
    }
    return fail(find.canvasId, 'GitHub couldn’t confirm your account — try connecting again')
  }

  /* return leg of the already-installed bounce: the authorize round-trip
     produced the code the configure screen didn't */
  const oauth = githubApp.verifyOauthState(rawState)
  if (oauth) {
    try {
      const grants = await githubApp.userAccess(code, [oauth.installationId])
      if (grants?.length) return succeed(oauth.canvasId, grants)
    } catch {
      /* fall through to the error redirect */
    }
    return fail(oauth.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
  }

  const state = githubApp.verifyInstallState(rawState)
  if (!state) return res.redirect('/')
  const installationId = String(req.query.installation_id ?? '')
  if (!/^\d+$/.test(installationId))
    return fail(state.canvasId, 'GitHub sent no installation back — try connecting again')

  /* app already installed on that account: GitHub showed the configure
     screen and returned WITHOUT an OAuth code — bounce through authorize
     (instant for an already-authorized user) purely to get one */
  if (!code) return res.redirect(githubApp.oauthBounceUrl(githubApp.signOauthState(state.canvasId, installationId)))

  try {
    const grants = await githubApp.userAccess(code, [installationId])
    if (grants?.length) return succeed(state.canvasId, grants)
  } catch {
    /* fall through to the error redirect */
  }
  return fail(state.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
})

app.get('/api/canvases/:id/github/app/repos', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const grants = githubApp.redeemInstallPass(String(req.query.pass ?? ''), c.id)
  if (!grants) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
  res.json(githubApp.listReposAcross(grants))
})

app.delete('/api/canvases/:id/github/:connId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await github.deleteConnection(req.params.id, req.params.connId)))
    return res.status(404).json({ error: 'connection not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/github/:connId/analyze', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  try {
    res.json(await github.analyzeConnection(conn))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'repository analysis failed' })
  }
})

/* one import at a time per repo connection — see the route */
const connectionLocks = new Map<string, Promise<unknown>>()
async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  connectionLocks.set(connectionId, tail)
  try {
    return await run
  } finally {
    if (connectionLocks.get(connectionId) === tail) connectionLocks.delete(connectionId)
  }
}

app.post('/api/canvases/:id/github/:connId/import', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  // The pilot owns this user's routing. Reject before analysis, metering or
  // queueing instead of accepting cards that its canvas-only harness cannot run.
  if (geminiCloudWorkerFor(req.user!.id)) {
    return res.status(409).json({
      error:
        'Repository imports are unavailable while the Gemini cloud pilot is selected. Ask your operator to disable the pilot, then select a provider that supports repository imports.',
    })
  }
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
  /* design-system-only import is the headline flow now — screens optional */
  const designSystem = req.body?.design_system !== false
  const rawScreens = Array.isArray(req.body?.screens) ? (req.body.screens as unknown[]) : []
  if (!rawScreens.length && !designSystem)
    return res.status(400).json({ error: 'pick components or screens, or enable the design-system extraction' })
  try {
    /* the selection is resolved against a manifest computed right now — see
       matchSelection for why the client never dictates paths */
    const { screens, rejected } = rawScreens.length
      ? github.matchSelection((await github.analyzeConnection(conn)).screens, rawScreens)
      : { screens: [], rejected: [] }
    const input = { connectionId: conn.id, repo: conn.repo, screens, designSystem }
    /* plan → gate → queue runs one import at a time per connection, so two
       overlapping imports of the same screens cannot both pass the plan and
       both pay while only one queues */
    const outcome = await withConnectionLock(conn.id, async () => {
      /* nothing new to queue (all rejected, or already on the board) costs nothing */
      if (!actions.planRepoCards(c.id, input).length) return { cards: [] as string[] }
      /* the import is the Doop Agent's work, card by card — same gate as a card
         typed on the board: a free task, or the requester's own model account */
      const gate = await allowance.consumeResidentTask(req.user!.id)
      if (!gate.ok) return { limit: gate }
      const cards = actions.addRepoCards(c.id, input, req.user!.name, req.user!.id)
      return { cards: cards.map((card) => card.id) }
    })
    if (outcome.limit)
      return res.status(403).json({ error: 'resident_limit', used: outcome.limit.used, limit: outcome.limit.limit })
    res.json({ cards: outcome.cards, rejected })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

/* upsert a named design doc; empty markdown deletes it (same permission
   model as rename: any signed-in user with access) */
/* doc history, newest first — '' markdown rows mark deletions */
app.get('/api/canvases/:id/guidelines/:name/history', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  const rows = await persist.listGuidelineVersions(req.params.id, req.params.name.toLowerCase())
  res.json(rows.map((v) => ({ markdown: v.markdown, savedAt: v.savedAt, savedBy: v.savedBy })))
})

/* design tokens (shared/designTokens.ts): the canvas's CSS custom properties.
   `?format=css|tailwind|md` exports them for a codebase; the default is JSON. */
app.get('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  const tokens = store.getTokens(req.params.id)
  const themes = store.getTokenThemes(req.params.id)
  switch (req.query.format) {
    case 'css':
      return res.type('text/css').send(tokensCss(tokens, themes))
    case 'tailwind':
      return res.type('text/css').send(tokensTailwind(tokens, themes))
    case 'md':
      return res.type('text/markdown').send(tokensMarkdown(tokens, themes))
    default:
      return res.json(tokens)
  }
})

/* the token themes (light, dark, …), in display order; a theme that leaves takes its values along */
app.put('/api/canvases/:id/token-themes', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const themes = actions.setTokenThemes(req.params.id, req.body?.themes, userActor(req), req.body?.renames ?? [])
    if (!themes) return res.status(404).json({ error: 'not found' })
    res.json({ themes, tokens: store.getTokens(req.params.id) })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid themes' })
  }
})

app.post('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const inputs = Array.isArray(req.body?.tokens) ? req.body.tokens : [req.body]
  if (inputs.length > 200) return res.status(400).json({ error: 'at most 200 tokens per request' })
  const results = actions.createTokens(req.params.id, inputs, userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  res.json({ results, tokens: store.getTokens(req.params.id) })
})

/* change, rename (newName) or delete (delete: true) one token by name */
app.put('/api/canvases/:id/tokens/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {}
  const edit = { ...body, name: req.params.name }
  const results = actions.setTokens(req.params.id, [edit], userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  const [result] = results
  if (result?.result === 'error') return res.status(400).json({ error: result.message })
  res.json({ result, tokens: store.getTokens(req.params.id) })
})

app.delete('/api/canvases/:id/tokens/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const results = actions.setTokens(req.params.id, [{ name: req.params.name, delete: true }], userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  const [result] = results
  if (result?.result === 'error') return res.status(400).json({ error: result.message })
  res.json({ ok: true, tokens: store.getTokens(req.params.id) })
})

/* the styleguide: the canvas's tokens and its guidelines as one markdown
   document — what a coding agent pulls into a repo as its DESIGN.md */
app.get('/api/canvases/:id/styleguide.md', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const tokens = store.getTokens(req.params.id)
  const themes = store.getTokenThemes(req.params.id)
  const docs = store.getGuidelines(req.params.id)
  const parts = [
    `# ${canvas.name} — styleguide`,
    ...(tokens.length
      ? [
          `## Design tokens\n\nUse these as CSS custom properties (\`var(--name)\`); the Tailwind v4 \`@theme\` block and plain CSS are at \`/api/canvases/${canvas.id}/tokens?format=tailwind|css\`.`,
          tokensMarkdown(tokens, themes),
          '```css\n' + tokensCss(tokens, themes) + '\n```',
        ]
      : []),
    ...docs.map((d) => `## ${actions.guidelineTitle(d)}\n\n${d.markdown}`),
  ]
  res.type('text/markdown').send(parts.join('\n\n') + '\n')
})

app.put('/api/canvases/:id/guidelines/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const { markdown, x, y, title } = req.body ?? {}
  /* no markdown = metadata patch (position/title): content and history untouched */
  if (markdown === undefined) {
    const patch = {
      ...(x !== undefined || y !== undefined ? { x: Number(x), y: Number(y) } : {}),
      ...(typeof title === 'string' ? { title } : {}),
    }
    if (!actions.patchGuideline(req.params.id, req.params.name, patch, actor))
      return res.status(404).json({ error: 'not found' })
    return res.json({ ok: true })
  }
  try {
    const pos = typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
    const doc = actions.setGuideline(
      req.params.id,
      req.params.name,
      String(markdown ?? ''),
      actor,
      pos,
      typeof title === 'string' ? title : undefined,
    )
    if (doc === undefined) return res.status(404).json({ error: 'not found' })
    res.json(doc ? { ok: true, doc } : { ok: true, deleted: true })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid doc' })
  }
})

/* design memory: pin/unpin reference frames, accept/dismiss rule proposals */
app.post('/api/canvases/:id/references', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  try {
    const ref = actions.pinReference(req.params.id, String(req.body?.frameId ?? ''), actor)
    if (!ref) return res.status(404).json({ error: 'canvas or frame not found' })
    res.json(ref)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'pin failed' })
  }
})

app.delete('/api/canvases/:id/references/:refId', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  if (!actions.unpinReference(req.params.id, req.params.refId, actor))
    return res.status(404).json({ error: 'reference not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/proposals/:pid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const proposal = actions.resolveProposal(req.params.id, req.params.pid, !!req.body?.accept, actor)
  if (!proposal) return res.status(404).json({ error: 'proposal not found' })
  res.json(proposal)
})

/* Browser asset uploads (paste / drop): raw image bytes in, permanent /a/ URL out. Same createAsset pipeline as the MCP ticket flow — the bytes are sniffed for the real type and capped at 5 MB. Images only: a pasted or dropped file becomes an <img>, never a stylesheet. express.json ignores the image content-type, so express.raw here sees the untouched stream. */
app.post(
  '/api/canvases/:id/assets',
  express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
  async (req, res) => {
    const c = requireCanvas(req, res, req.params.id, 'edit')
    if (!c) return
    try {
      const asset = await createAsset(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
        canvasId: c.id,
        ownerId: req.user!.id,
        uploadedBy: req.user!.name,
      })
      /* absolute like the MCP flow: frame HTML renders inside sandboxed
         srcdoc iframes where root-relative URLs don't resolve */
      res.json({ url: `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`, mime: asset.mime, size: asset.size })
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
    }
  },
)

/* Replace an uploaded stylesheet's bytes in place (same /a/ URL, next version): raw CSS in, the new version out. The caller needs the edit role on the canvas the asset was uploaded for, or to own the asset. */
app.put(
  '/api/canvases/:id/assets/:assetId',
  express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
  async (req, res) => {
    const c = requireCanvas(req, res, req.params.id, 'edit')
    if (!c) return
    try {
      const replaced = await replaceAsset(req.params.assetId, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
        canvasId: c.id,
        ownerId: req.user!.id,
        uploadedBy: req.user!.name,
      })
      if (!replaced.ok)
        return res.status(replaced.error === 'asset not found' ? 404 : 400).json({ error: replaced.error })
      res.json({
        ...replacementLinks(replaced.asset, replaced.unchanged),
        unchanged: replaced.unchanged,
        mime: replaced.asset.mime,
        size: replaced.asset.size,
        version: replaced.asset.version,
      })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'replace failed' })
    }
  },
)

app.put('/api/canvases/:id/pages', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pages = req.body?.pages
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > 100 ||
    pages.some(
      (p) =>
        !p ||
        typeof p.id !== 'string' ||
        !p.id.trim() ||
        p.id.length > 100 ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 100 ||
        (p.parentId !== undefined && (typeof p.parentId !== 'string' || !p.parentId || p.parentId.length > 100)),
    ) ||
    new Set(pages.map((p) => p.id)).size !== pages.length
  ) {
    return res.status(400).json({ error: 'Provide 1–100 pages with unique IDs and names of up to 100 characters.' })
  }
  const requested: CanvasPageInfo[] = pages.map((p) => ({
    id: p.id,
    name: p.name.trim(),
    ...(p.parentId === undefined ? {} : { parentId: p.parentId }),
  }))
  const treeError = validatePageTree(requested)
  if (treeError) return res.status(400).json({ error: treeError })
  if (!samePages(req.body?.expectedPages, canvasPages(canvas)))
    return res
      .status(409)
      .json({ error: 'Pages changed since you opened them. Please try again.', pages: canvasPages(canvas) })
  const firstId = canvas.pages?.[0]?.id ?? `${canvas.id}:page1`
  if (canvas.frames.some((f) => !pages.some((p) => p.id === (f.pageId ?? firstId)))) {
    return res.status(400).json({ error: 'Move the frames to another page before deleting this page.' })
  }
  const clean = normalizePageTree(requested)
  const actor = userActor(req)
  res.json(actions.setCanvasPages(canvas.id, clean, actor))
})

/* a page's own canvas colour (`#rrggbb`); null puts the theme paper back */
app.put('/api/canvases/:id/pages/:pageId/background', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const color: unknown = req.body?.color
  const background = color === null ? null : normalizePageBackground(color)
  if (color !== null && !background)
    return res.status(400).json({ error: 'color must be a hex colour such as #f5f5f5, or null' })
  if (!canvasPages(canvas).some((p) => p.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  const actor = userActor(req)
  res.json(actions.setPageBackground(canvas.id, req.params.pageId, background, actor))
})

/* the frame a page's prototype flow starts on; null clears it */
app.put('/api/canvases/:id/pages/:pageId/flow-start', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const frameId: unknown = req.body?.frameId
  if (frameId !== null && typeof frameId !== 'string')
    return res.status(400).json({ error: 'frameId must be a string or null' })
  if (!canvasPages(canvas).some((p) => p.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  if (frameId !== null) {
    const frame = canvas.frames.find((f) => f.id === frameId)
    if (!frame) return res.status(400).json({ error: `no frame ${frameId} on this canvas` })
    if (framePageId(canvas, frame) !== req.params.pageId)
      return res.status(400).json({ error: 'the start frame must be on the same page' })
  }
  const actor = userActor(req)
  res.json(actions.setFlowStart(canvas.id, req.params.pageId, frameId, actor))
})

/* Ruler guides, one per request so two people dragging different guides
   never overwrite each other. The id is the client's, which lets undo put
   a removed guide back as itself. */
app.put('/api/canvases/:id/guides/:guideId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const guide = parseGuide(
    req.params.guideId,
    req.body,
    canvasPages(canvas).map((page) => page.id),
  )
  if (typeof guide === 'string') return res.status(400).json({ error: guide })
  const actor = userActor(req)
  try {
    res.json(actions.setGuide(canvas.id, guide, actor))
  } catch (e) {
    if (e instanceof GuideLimitError) return res.status(400).json({ error: e.message })
    throw e
  }
})

app.delete('/api/canvases/:id/guides/:guideId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const actor = userActor(req)
  /* idempotent: a guide a collaborator already removed is just as gone */
  actions.deleteGuide(canvas.id, req.params.guideId, actor)
  res.json({ ok: true })
})

const validSpeakerNotes = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_SPEAKER_NOTES_CHARS

app.post('/api/canvases/:id/pages/:pageId/duplicate', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  if (!canvasPages(canvas).some((page) => page.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  const actor = userActor(req)
  try {
    const copy = await actions.duplicatePage(canvas.id, req.params.pageId, actor)
    if (!copy) return res.status(404).json({ error: 'page not found' })
    res.json({
      page: copy.page,
      pages: copy.pages,
      copiedPages: copy.copiedPages,
      frames: copy.frames,
      notes: copy.notes,
    })
  } catch (e) {
    if (e instanceof PageLimitError || e instanceof GuideLimitError) return res.status(400).json({ error: e.message })
    console.error('[pages] duplicate failed', e)
    res.status(500).json({ error: 'Could not duplicate the page. Please try again.' })
  }
})

app.post('/api/canvases/:id/frames', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const { name, pageId, x, y, width, height, html, slide, speakerNotes, hidden, locked, z, rotation } = req.body ?? {}
  if (pageId !== undefined && !store.getCanvas(req.params.id)?.pages?.some((p) => p.id === pageId))
    return res.status(400).json({ error: 'page not found' })
  if (speakerNotes !== undefined && !validSpeakerNotes(speakerNotes))
    return res.status(400).json({ error: `speakerNotes must be text of up to ${MAX_SPEAKER_NOTES_CHARS} characters` })
  const actor = userActor(req)
  /* `hidden`, `locked` and `z` let undo bring a deleted frame back as it was */
  const frame = actions.createFrame(
    req.params.id,
    {
      name: String(name || 'Frame'),
      pageId,
      x,
      y,
      width,
      height,
      html,
      ...(slide === true ? { slide: true } : {}),
      ...(speakerNotes ? { speakerNotes } : {}),
      hidden: hidden === true,
      locked: locked === true,
      z: Number.isFinite(z) ? z : undefined,
      rotation: normalizeRotation(rotation),
    },
    actor,
  )
  if (!frame) return res.status(404).json({ error: 'canvas not found' })
  res.json(frame)
})

/* the Layers panel's stacking order for several frames at once: all of
   them or none */
app.put('/api/canvases/:id/stack', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const writes: unknown = req.body?.frames
  if (
    !Array.isArray(writes) ||
    writes.length === 0 ||
    writes.length > MAX_STACK_WRITES ||
    !writes.every((w) => typeof w?.id === 'string' && Number.isFinite(w?.z))
  )
    return res.status(400).json({ error: 'frames must be a list of { id, z }' })
  const frames = actions.restackFrames(
    req.params.id,
    writes.map((w: StackWrite) => ({ id: w.id, z: w.z })),
    userActor(req),
  )
  if (!frames) return res.status(404).json({ error: 'frame not found' })
  res.json(frames)
})

app.patch('/api/frames/:id', (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)) return
  const { actor: _ignored, expectedUpdatedAt: _version, ...patch } = req.body ?? {}
  const actor = userActor(req)
  if (
    patch.pageId !== undefined &&
    !store.getCanvas(store.getFrame(req.params.id)!.canvasId)?.pages?.some((p) => p.id === patch.pageId)
  )
    return res.status(400).json({ error: 'page not found' })
  if (patch.slide !== undefined && typeof patch.slide !== 'boolean')
    return res.status(400).json({ error: 'slide must be true or false' })
  if (patch.speakerNotes !== undefined && !validSpeakerNotes(patch.speakerNotes))
    return res.status(400).json({ error: `speakerNotes must be text of up to ${MAX_SPEAKER_NOTES_CHARS} characters` })
  const allowed = ['name', 'pageId', 'x', 'y', 'width', 'height', 'html', 'slide', 'speakerNotes'] as const
  const clean: Record<string, unknown> = {}
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k]
  /* the eye in the Layers panel: anything but a literal true shows the frame */
  if (patch.hidden !== undefined) clean.hidden = patch.hidden === true
  if (patch.locked !== undefined) clean.locked = !!patch.locked
  /* the stacking order the Layers panel sets */
  if (patch.z !== undefined) {
    if (!Number.isFinite(patch.z)) return res.status(400).json({ error: 'z must be a finite number' })
    clean.z = patch.z
  }
  /* a turn about the centre, stored in (-180, 180]; null or 0 straightens */
  if (patch.rotation !== undefined) {
    if (patch.rotation !== null && !Number.isFinite(patch.rotation))
      return res.status(400).json({ error: 'rotation must be a finite number of degrees' })
    clean.rotation = normalizeRotation(patch.rotation)
  }
  const frame = actions.updateFrame(req.params.id, clean, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json(frame)
})

/* Move a frame to another canvas: it keeps its id, history and sticky notes. The edit role is needed on both ends,
   the frame's canvas it leaves and the canvas it joins. Frame HTML loads per canvas, so the route holds both
   canvases (the source through the `/api/frames/:id` loader) until the response closes. */
app.post('/api/frames/:id/move', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const { canvasId, pageId, x, y } = req.body ?? {}
  if (typeof canvasId !== 'string' || !canvasId) return res.status(400).json({ error: 'canvasId is required' })
  if (pageId !== undefined && typeof pageId !== 'string') return res.status(400).json({ error: 'pageId must be text' })
  for (const [key, value] of [
    ['x', x],
    ['y', y],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))
      return res.status(400).json({ error: `${key} must be a finite number` })
  }
  if (!requireCanvas(req, res, canvasId, 'edit')) return
  try {
    await store.load(canvasId)
    res.once('close', store.hold(canvasId))
  } catch (error) {
    console.error('[frame] move could not load the destination canvas', error)
    return res.status(500).json({ error: 'could not open the destination canvas' })
  }
  const actor = userActor(req)
  const result = await actions.moveFrameToCanvas(req.params.id, canvasId, { pageId, x, y }, actor)
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  res.json({ frame: result.frame, notes: result.notes })
})

/* Components. Reads are for anyone who can see the canvas; everything else edits it. */
function componentContext(req: express.Request, canvas: Canvas) {
  return { canvas, actor: userActor(req) }
}

/* The REST bodies, typed like the MCP tools' input (the same zod pieces), so a
   malformed field is a 400 and never reaches the engine; `head` is a library
   pull's alone and is not accepted here. */
const componentCreateBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  props: z.array(propSchema).optional(),
  code: codeSchema.optional(),
  frameId: z.string().optional(),
  element: z.string().optional(),
  autoProps: z.boolean().optional(),
  replaceMatching: z.boolean().optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})
const componentPatchBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  props: z.array(propSchema).optional(),
  code: codeSchema.nullable().optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
  expectedRev: z.number().optional(),
  dryRun: z.boolean().optional(),
})

function componentBody<T>(res: express.Response, schema: z.ZodType<T>, body: unknown): T | undefined {
  const parsed = schema.safeParse(body ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` })
  return undefined
}

function componentRoute(res: express.Response, run: () => unknown) {
  try {
    res.json(run())
  } catch (error) {
    if (error instanceof ComponentError) return res.status(400).json({ error: error.message })
    throw error
  }
}

app.get('/api/canvases/:id/components', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  res.json((canvas.components ?? []).map((def) => componentDetail(canvas, def)))
})

/* other canvases this person can read that hold components: the import picker.
   Importing takes edit, and this walks every canvas the person can read, so a
   viewer gets no such scan */
app.get('/api/canvases/:id/component-libraries', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  res.json(
    workspaces.canvasesFor(req.user!.id).flatMap((meta) => {
      const other = store.getCanvas(meta.id)
      if (!other || other.id === canvas.id || !other.components?.length) return []
      return [{ id: other.id, name: other.name, components: other.components.map((def) => catalogEntry(other, def)) }]
    }),
  )
})

/* parses every frame on the canvas: for the editors who can act on it */
app.get('/api/canvases/:id/component-candidates', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  res.json(findComponentCandidates(canvas))
})

app.post('/api/canvases/:id/components', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const { actor } = componentContext(req, canvas)
  const body = componentBody(res, componentCreateBody, req.body)
  if (!body) return
  componentRoute(res, () => {
    if (typeof body.html === 'string') {
      return {
        component: createComponentFromHtml(
          canvas.id,
          { ...body, html: body.html, props: body.props as never, name: String(body.name ?? '') },
          actor,
        ),
        converted: [],
      }
    }
    const created = createComponentFromElement(
      canvas.id,
      {
        name: String(body.name ?? ''),
        description: body.description,
        props: body.props as never,
        code: body.code,
        frameId: String(body.frameId ?? ''),
        element: String(body.element ?? ''),
        autoProps: body.autoProps,
        replaceMatching: body.replaceMatching === true,
      },
      actor,
    )
    /* what the editor needs to undo this as one step */
    const changed = new Set([String(body.frameId), ...created.converted.map((entry) => entry.frameId)])
    return { ...created, frames: [...changed].flatMap((id) => store.getFrame(id) ?? []) }
  })
})

app.post('/api/canvases/:id/components/import', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const source = String(req.body?.sourceCanvasId ?? '')
  const origin = store.getCanvas(source)
  if (!origin || !roleFor(req, origin)) return res.status(403).json({ error: 'this account cannot read that canvas' })
  componentRoute(res, () => importComponent(canvas.id, source, String(req.body?.component ?? ''), userActor(req)))
})

app.patch('/api/canvases/:id/components/:componentId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const body = componentBody(res, componentPatchBody, req.body)
  if (!body) return
  componentRoute(res, () =>
    updateComponent(canvas.id, req.params.componentId, { ...body, props: body.props as never }, userActor(req)),
  )
})

app.delete('/api/canvases/:id/components/:componentId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () => deleteComponent(canvas.id, req.params.componentId, userActor(req)))
})

app.post('/api/canvases/:id/components/:componentId/restore', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () =>
    restoreComponentVersion(canvas.id, req.params.componentId, Number(req.body?.rev), userActor(req)),
  )
})

app.post('/api/canvases/:id/components/:componentId/sync', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () =>
    syncComponent(canvas.id, req.params.componentId, userActor(req), (id) => {
      const other = store.getCanvas(id)
      return !!other && !!roleFor(req, other)
    }),
  )
})

app.get('/api/canvases/:id/components/:componentId/preview', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const def = findComponent(canvas.id, req.params.componentId)
  if (!def) return res.status(404).json({ error: 'component not found' })
  res.json(previewDocument(canvas.id, def))
})

app.post('/api/frames/:id/instances', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit')
  if (!current) return
  const body = req.body ?? {}
  componentRoute(res, () =>
    insertInstance(
      current.canvasId,
      {
        frameId: current.id,
        component: String(body.component ?? ''),
        props: body.props,
        target: body.target,
        position: body.position,
      },
      userActor(req),
    ),
  )
})

app.patch('/api/frames/:id/instances', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit')
  if (!current) return
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : []
  componentRoute(res, () => changeInstances(current.canvasId, current.id, changes, userActor(req)))
})

app.put('/api/frames/:id/approval', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)
  if (!current) return
  const { status, expectedUpdatedAt } = req.body ?? {}
  if (expectedUpdatedAt === undefined)
    return res.status(400).json({ error: 'expectedUpdatedAt is required to approve the reviewed version' })
  if (status !== 'ready_for_dev' && status !== 'draft')
    return res.status(400).json({ error: 'status must be ready_for_dev or draft' })
  if (status === 'ready_for_dev' && actions.isFrameStreaming(current.id))
    return res.status(409).json({ error: 'Wait for the design to finish before approving it.' })
  res.json(actions.setFrameApproval(current.id, status === 'ready_for_dev', req.user!))
})

app.post('/api/frames/:id/append', (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const { html_chunk, start, done } = req.body ?? {}
  const actor = userActor(req)
  const frame = actions.appendFrameHtml(req.params.id, String(html_chunk ?? ''), actor, {
    start: !!start,
    done: !!done,
  })
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true, htmlBytes: frame.html.length })
})

/* design history: the states a frame had before later edits replaced them, newest first and without HTML; one
   version in full; restore. Needs edit, to read or to restore: an old version can hold content the editors have
   since removed, which a viewer was never shown. */
app.get('/api/frames/:id/versions', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  res.json(await persist.listFrameVersions(req.params.id))
})

app.get('/api/frames/:id/versions/:versionId', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const version = await persist.getFrameVersion(req.params.id, req.params.versionId)
  if (!version) return res.status(404).json({ error: 'version not found' })
  res.json(version)
})

app.post('/api/frames/:id/versions/:versionId/restore', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const restored = await actions.restoreFrameVersion(req.params.id, req.params.versionId, actor)
  if (restored === null) return res.status(404).json({ error: 'version not found' })
  if (!restored) return res.status(404).json({ error: 'frame not found' })
  res.json(restored)
})

app.delete('/api/frames/:id', (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)) return
  const actor = userActor(req)
  const frame = actions.deleteFrame(req.params.id, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true })
})

/* ---- sticky notes ---- */

/* Notes belong to the design: reading them rides on the canvas payload (view),
   but creating, moving, editing and deleting one needs the edit role. */
function requireEditableCanvas(req: express.Request, res: express.Response, canvasId: string) {
  return requireCanvas(req, res, canvasId, 'edit')
}

function sendNoteResult(res: express.Response, result: actions.NoteResult) {
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  res.json(result.note)
}

app.post('/api/canvases/:id/notes', (req, res) => {
  if (!requireEditableCanvas(req, res, req.params.id)) return
  const { actor: _ignored, frameId, pageId, ...fields } = req.body ?? {}
  const actor = userActor(req)
  sendNoteResult(res, actions.createNote(req.params.id, { ...fields, frameId, pageId }, actor))
})

app.patch('/api/notes/:id', (req, res) => {
  const found = store.findNote(req.params.id)
  if (!found) return res.status(404).json({ error: 'note not found' })
  if (!requireEditableCanvas(req, res, found.canvasId)) return
  /* position, size, text and colour only: a note never changes its frame or page */
  const { x, y, width, height, markdown, color } = req.body ?? {}
  const actor = userActor(req)
  sendNoteResult(res, actions.updateNote(req.params.id, { x, y, width, height, markdown, color }, actor))
})

app.delete('/api/notes/:id', (req, res) => {
  const found = store.findNote(req.params.id)
  if (!found) return res.status(404).json({ error: 'note not found' })
  if (!requireEditableCanvas(req, res, found.canvasId)) return
  const actor = userActor(req)
  const result = actions.deleteNote(req.params.id, actor)
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  res.json({ ok: true })
})

app.post('/api/frames/:id/comments', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'comment')
  if (!frame) return
  const canvas = store.getCanvas(frame.canvasId)!
  const { selector, elementId, snippet, text, x, y, elementOrigin } = req.body ?? {}
  /* Asking an agent for something would make it edit frames, so only editors
     may. Anyone else's @agent mention is kept as a plain comment, and they are
     told so — the agent is never queued and no resident task is spent. */
  const notice = agentNotice(String(text ?? ''), roleFor(req, canvas))
  /* a comment that @mentions a resident agent is a new command to the team,
     so it's metered like a card; plain comments and replies stay free */
  if (!notice && mentionedRole(String(text ?? ''))) {
    const gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const mentions = await validMentions(canvas, String(text ?? ''), req.body?.mentions)
  const comment = await actions.addElementComment(
    req.params.id,
    { selector, elementId, snippet, text: String(text ?? ''), x, y, elementOrigin },
    req.user!.name,
    req.user!.id,
    'user',
    { allowAgent: !notice, mentions },
  )
  if (!comment) return res.status(404).json({ error: 'frame not found or empty text' })
  res.json(notice ? { ...comment, notice } : comment)
})

/* the stable id of an element inside a frame — stamped as data-doop-id into
   the frame HTML if it has none yet — for a link that outlives edits around
   it. Anyone who may comment may stamp: the write is an annotation, not a
   design change, so it leaves sign-off alone. */
app.post('/api/frames/:id/element-id', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'comment')
  if (!frame) return
  const selector = typeof req.body?.selector === 'string' ? req.body.selector.trim() : ''
  if (!selector || selector.length > actions.MAX_ELEMENT_SELECTOR_CHARS) {
    return res.status(400).json({ error: 'selector required' })
  }
  const snippet = typeof req.body?.snippet === 'string' ? req.body.snippet.slice(0, 400) : undefined
  const stamped = await actions.ensureElementId(frame.id, selector, req.user!.name, snippet || undefined)
  if (!stamped) return res.status(409).json({ error: 'the element could not be found in the frame right now' })
  res.json({ elementId: stamped.id, frameUpdatedAt: stamped.frame.updatedAt })
})

/* a comment pinned to a point on the canvas (world coordinates on one of its
   pages) rather than to an element — same role, agent-mention and metering rules as an element comment */
app.post('/api/canvases/:id/comments', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'comment')
  if (!canvas) return
  const { pageId, x, y, text } = req.body ?? {}
  if (typeof pageId !== 'string' || !canvasPages(canvas).some((page) => page.id === pageId)) {
    return res.status(400).json({ error: 'page not found' })
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
  const body = String(text ?? '')
  if (!body.trim()) return res.status(400).json({ error: 'empty text' })
  const notice = agentNotice(body, roleFor(req, canvas))
  let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
  if (!notice && mentionedRole(body)) {
    gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const mentions = await validMentions(canvas, body, req.body?.mentions)
  const comment = actions.addCanvasComment(
    canvas.id,
    { pageId, x: Number(x), y: Number(y), text: body },
    req.user!.name,
    req.user!.id,
    'user',
    { allowAgent: !notice, mentions },
  )
  if (!comment) {
    /* the page went away while the meter was being written: give the task
       back — a failed refund is logged, never turned into a 500 */
    if (gate) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[comments] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
    return res.status(409).json({ error: 'page removed meanwhile' })
  }
  res.json(notice ? { ...comment, notice } : comment)
})

app.post('/api/comments/:id/replies', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  const canvas = requireCanvas(req, res, found.canvasId, 'comment')
  if (!canvas) return
  const text = String(req.body?.text ?? '')
  if (!text.trim() || !actions.openThread(req.params.id)) {
    return res.status(404).json({ error: 'thread resolved or empty text' })
  }
  /* same rules as a fresh comment: only an editor's @agent mention queues
     the agent and costs a resident task */
  const notice = agentNotice(text, roleFor(req, canvas))
  let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
  if (!notice && mentionedRole(text)) {
    gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const mentions = await validMentions(canvas, text, req.body?.mentions)
  const reply = actions.replyToComment(req.params.id, text, req.user!.name, req.user!.id, 'user', {
    allowAgent: !notice,
    mentions,
  })
  if (!reply) {
    /* the thread closed while the meter was being written: give the task
       back — a failed refund is logged, never turned into a 500 */
    if (gate) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[comments] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
    return res.status(409).json({ error: 'thread resolved meanwhile' })
  }
  res.json(notice ? { ...reply, notice } : reply)
})

app.post('/api/comments/:id/resolve', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  res.json(actions.resolveComment(req.params.id, req.user!.name))
})

/* drag a thread's pin somewhere else: onto an element, a frame as a whole
   or the canvas. The whole thread moves, and anyone who may comment may move */
app.patch('/api/comments/:id/anchor', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  const { frameId, selector, elementId, snippet, pageId, x, y, elementOrigin } = req.body ?? {}
  let anchor: CommentAnchorInput
  if (typeof frameId === 'string') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
    anchor = {
      frameId,
      ...(typeof selector === 'string' ? { selector } : {}),
      ...(typeof elementId === 'string' ? { elementId } : {}),
      elementOrigin,
      snippet: String(snippet ?? ''),
      x: Number(x),
      y: Number(y),
    }
  } else if (typeof pageId === 'string') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
    anchor = { pageId, x: Number(x), y: Number(y) }
  } else return res.status(400).json({ error: 'frameId or pageId required' })
  const moved = await actions.moveComment(req.params.id, anchor, req.user!.name)
  if (!moved) return res.status(404).json({ error: 'frame or page not found' })
  res.json(moved)
})

app.post('/api/comments/:id/retry', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  res.json(actions.retryComment(req.params.id, req.user!.name))
})

/* Import one page immediately, or discover + import a user-reviewed set of
   same-site pages. Discovery and capture are separate requests on purpose:
   nothing gets added to the canvas until the user confirms the page list. */
const importHits = new Map<string, number[]>()
function takeImportSlot(userId: string): boolean {
  const now = Date.now()
  const hits = (importHits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= 5) return false
  hits.push(now)
  importHits.set(userId, hits)
  return true
}

app.post('/api/canvases/:id/import/discover', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const { discoverSitePages, assertPublicHttpUrl } = await import('./importer.ts')
    const url = String(req.body?.url ?? '')
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    res.json(await discoverSitePages(url))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'page discovery failed' })
  }
})

app.post('/api/canvases/:id/import', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  try {
    const { importPage, importSitePages, assertPublicHttpUrl, isSameSiteUrl, MAX_SITE_PAGES } =
      await import('./importer.ts')
    const requested: string[] | null = Array.isArray(req.body?.urls)
      ? (req.body.urls as unknown[]).map((value) => String(value))
      : null

    if (requested) {
      if (!requested.length) return res.status(400).json({ error: 'select at least one page' })
      if (requested.length > MAX_SITE_PAGES) {
        return res.status(400).json({ error: `a website import is limited to ${MAX_SITE_PAGES} pages` })
      }
      /* Validate the whole batch before consuming a slot or opening Chromium. */
      const validated = requested.map((url) => assertPublicHttpUrl(url))
      const [first, ...rest] = validated
      if (first && rest.some((url) => !isSameSiteUrl(url, first))) {
        return res.status(400).json({ error: 'all selected pages must belong to the same website' })
      }
      const urls = [...new Set(validated.map((url) => url.href))]
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })

      const captures = await importSitePages(urls)
      const actor = userActor(req)
      const frames = []
      const failures: { url: string; error: string }[] = []
      const rightmost = canvas.frames.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
      const startX = canvas.frames.length ? rightmost + 80 : 120
      const columns = 3
      let column = 0
      let y = 120
      let rowHeight = 0

      for (const capture of captures) {
        if (!capture.page) {
          failures.push({ url: capture.url, error: capture.error ?? 'import failed' })
          continue
        }
        const imported = capture.page
        const frame = actions.createFrame(
          canvas.id,
          {
            name: imported.title.slice(0, 80),
            x: startX + column * (imported.width + 80),
            y,
            width: imported.width,
            height: imported.height,
            html: imported.html,
          },
          actor,
        )
        if (!frame) {
          failures.push({ url: capture.url, error: 'canvas not found' })
          continue
        }
        frames.push(frame)
        rowHeight = Math.max(rowHeight, imported.height)
        column++
        if (column === columns) {
          column = 0
          y += rowHeight + 80
          rowHeight = 0
        }
      }
      return res.json({ frames, failures })
    }

    const url = String(req.body?.url ?? '')
    /* Validate before consuming a rate-limit slot — typos shouldn't burn quota. */
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    const imported = await importPage(url)
    const actor = userActor(req)
    const frame = actions.createFrame(
      canvas.id,
      { name: imported.title.slice(0, 80), width: imported.width, height: imported.height, html: imported.html },
      actor,
    )
    if (!frame) return res.status(404).json({ error: 'canvas not found' })
    res.json(frame)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

app.post('/api/canvases/:id/cards', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const title = String(req.body?.title ?? '').trim()
  if (!title) return res.status(400).json({ error: 'empty title' })
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const card = actions.addQueuedCard(
    req.params.id,
    title,
    req.user!.name,
    req.body?.agents,
    req.body?.attachments,
    req.user!.id,
    req.body?.scope,
    req.body?.runner,
  )
  if (!card) return res.status(404).json({ error: 'canvas not found or empty title' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/done', (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const card = actions.completeCard(req.params.canvasId, req.params.id)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/retry', async (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const card = actions.retryCard(req.params.canvasId, req.params.id, req.user!.name)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/stop', (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const card = actions.stopCard(req.params.canvasId, req.params.id, req.user!.name)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/tasks/:id/feedback', async (req, res) => {
  const canvasId = actions.taskCanvasId(req.params.id)
  if (!canvasId) return res.status(404).json({ error: 'task not found' })
  if (!requireCanvas(req, res, canvasId, 'edit')) return
  const text = String(req.body?.text ?? '').trim()
  if (!text) return res.status(400).json({ error: 'empty text' })
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const fb = actions.addTaskFeedback(req.params.id, req.user!.name, text, req.user!.id)
  if (!fb) return res.status(404).json({ error: 'task not found or empty text' })
  res.json(fb)
})

app.post('/api/feedback/:id/retry', async (req, res) => {
  const found = actions.findFeedback(req.params.id)
  if (!found) return res.status(404).json({ error: 'feedback not found' })
  if (!requireCanvas(req, res, found.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  res.json(actions.retryTaskFeedback(req.params.id, req.user!.name))
})

app.get('/api/frames/:id/screenshot.png', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'view')
  if (!frame) return
  try {
    const { renderFrame } = await import('./screenshot.ts')
    const png = await renderFrame(frame, fitExportScale(frame, parseExportScale(req.query.scale) ?? 1))
    res.type('png').send(png)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
})

/* Vector PDF of frames on a canvas, a page per frame: ?frames=<id>,<id>
   picks frames, pages in the order listed, else ?page=<pageId> (default the
   first page) takes every visible frame there, in reading order. A GET so a read-only
   impersonation session can export too. */
app.get('/api/canvases/:id/export.pdf', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const pdf = await import('./pdfExport.ts')
  const frameIds = typeof req.query.frames === 'string' ? req.query.frames.split(',').filter(Boolean) : undefined
  const pageId = typeof req.query.page === 'string' && req.query.page ? req.query.page : undefined
  const selection = pdf.selectPdfFrames(canvas, { frameIds, pageId })
  if (!selection.ok) return res.status(selection.status).json({ error: selection.error })
  if (!pdf.pdfRendererAvailable()) {
    return res.status(503).json({ error: pdf.PDF_UNAVAILABLE_MESSAGE })
  }
  if (!pdf.takePdfExportSlot(req.user!.id)) {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'PDF export rate limit — wait a minute' })
  }
  try {
    const buf = await pdf.renderFramesPdf(selection.frames)
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename="${pdf.pdfFileName(canvas, selection.frames)}"`)
    res.set('Cache-Control', 'no-store')
    return res.send(buf)
  } catch (e) {
    if (e instanceof pdf.PdfRendererUnavailableError) return res.status(503).json({ error: e.message })
    return res.status(500).json({ error: e instanceof Error ? e.message : 'PDF export failed' })
  }
})

/* MCP endpoint — point any MCP-capable AI at http://localhost:PORT/mcp.
   Protected by OAuth: unauthenticated calls get 401 + discovery pointers. */
app.all('/mcp', handleMcpRequest)

/* OAuth discovery metadata at the root, where MCP clients look for it
   (better-auth serves these under /api/auth; we bridge the web-standard
   handlers into Express) */
function bridge(handler: (req: globalThis.Request) => Promise<globalThis.Response>) {
  return async (req: express.Request, res: express.Response) => {
    const out = await handler(new globalThis.Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`))
    res.status(out.status)
    out.headers.forEach((v, k) => res.setHeader(k, v))
    res.send(await out.text())
  }
}
app.get('/.well-known/oauth-authorization-server', (req, res) => bridge(oAuthDiscoveryMetadata(auth))(req, res))
/* The same document under the OpenID Connect name: ChatGPT accepts either,
   but its Enterprise workspace-domain restriction reads only this one (it
   needs the userinfo_endpoint better-auth already lists there). */
app.get('/.well-known/openid-configuration', (req, res) => bridge(oAuthDiscoveryMetadata(auth))(req, res))

/* Protected-resource metadata must name the exact endpoint the CLIENT
   connected to (RFC 9728 §3.3 — strict clients such as Muse reject a `resource`
   that differs from the URL they called, so it is `<origin>/mcp`, never the bare
   origin), while the authorization server stays on the canonical origin. In dev
   the app may be reached via :4300, :4301 (vite port bump) or :4400 — all must
   validate, so the origin is echoed from the request. Both well-known paths
   serve the same document, the shape Linear ships. */
function protectedResourceMetadata(req: express.Request, res: express.Response) {
  res.json({
    resource: `${req.protocol}://${req.get('host')}/mcp`,
    authorization_servers: [env.BETTER_AUTH_URL],
    jwks_uri: `${env.BETTER_AUTH_URL}/api/auth/mcp/jwks`,
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256'],
  })
}
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
/* path-aware variant some clients probe for a resource at /mcp */
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata)

/* robots + minimal sitemap for every deployment; a noindex one lists nothing */
app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(
      NOINDEX
        ? 'User-agent: *\nAllow: /\n'
        : `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /c/\n\nSitemap: ${env.BETTER_AUTH_URL}/sitemap.xml\n`,
    )
})
app.get('/sitemap.xml', (_req, res) => {
  if (NOINDEX) return res.status(404).end()
  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${env.BETTER_AUTH_URL}/</loc></url>\n</urlset>\n`,
    )
})

/* production: serve the built client */
if (env.isProduction) {
  const dist = path.join(process.cwd(), 'dist')
  app.use(compressedBundle(dist))
  app.use(express.static(dist, { setHeaders: immutableAssets }))
  /* a missing bundle or source map is a 404, not the app shell: HTML served
     as a .js or .map breaks module loads and source map resolution */
  app.get('/assets/*', (_req, res) => res.sendStatus(404))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

/* ------------------------------------------------- websocket */

const server = http.createServer(app)
/* permessage-deflate: joining a canvas sends every frame's HTML in one init message (4 MB uncompressed for 77 full-page frames, about 0.75 MB deflated), and every frame edit carries the frame's whole HTML. Small messages (cursors, presence) stay uncompressed, and no context is kept between messages, so a connection holds no compression window. */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
})

/* a guest is anonymous, so its socket is throttled: a cursor flood from one
   would otherwise be fanned out to the whole room */
const GUEST_MESSAGES_PER_SECOND = 120

wss.on('connection', (ws, upgradeReq) => {
  /* the session cookie rides the upgrade request; resolve it once */
  const sessionPromise = auth.api.getSession({ headers: fromNodeHeaders(upgradeReq.headers) }).catch(() => null)
  const cookie = upgradeReq.headers.cookie
  let windowStart = 0
  let windowCount = 0

  ws.on('message', async (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const conn = conns.get(ws)
    if (conn?.guest) {
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        windowCount = 0
      }
      if (++windowCount > GUEST_MESSAGES_PER_SECOND) return
    }

    if (msg.type === 'join') {
      const session = await sessionPromise
      let canvas = store.getCanvas(msg.canvasId)
      let role: CanvasRole | null
      let user: AccessUser | undefined
      let guest = false
      if (!session) {
        /* Signed out: only an anyone-with-the-link canvas admits you, as a
           guest capped at comment. Every other reason looks the same (a
           missing canvas, a private one, a locked one) so nothing leaks. */
        role = canvas ? guestRole(canvas, { unlocked: unlockedByCookie(canvas, cookie) }) : null
        if (!role) {
          ws.close(4401, 'unauthorized')
          return
        }
        guest = true
      } else {
        if (!canvas) {
          /* a typo'd id or a canvas someone just deleted: say so and close,
             instead of leaving the socket open with nothing ever coming back.
             The client used to sit on a blank, unusable canvas UI forever
             waiting for an 'init' that would never arrive. */
          ws.close(4404, 'not found')
          return
        }
        user = {
          id: session.user.id,
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          banned: (session.user as { banned?: boolean | null }).banned,
        }
        /* checked before loading, so a denied join never loads the canvas */
        role = canvasRole(user, canvas, { unlocked: unlockedByCookie(canvas, cookie) })
        if (!role) {
          ws.close(4403, 'no access')
          return
        }
      }
      await store.load(msg.canvasId)
      /* a socket that closed while it waited must not join: its close
         already ran, so it would sit in the room and pin the canvas */
      if (ws.readyState !== WebSocket.OPEN) return
      canvas = store.getCanvas(msg.canvasId)
      if (!canvas) {
        ws.close(4404, 'not found')
        return
      }
      /* and again after: access removed while the canvas loaded must not
         still receive its designs and conversation */
      role = guest
        ? guestRole(canvas, { unlocked: unlockedByCookie(canvas, cookie) })
        : canvasRole(user, canvas, { unlocked: unlockedByCookie(canvas, cookie) })
      if (!role) {
        ws.close(guest ? 4401 : 4403, guest ? 'unauthorized' : 'no access')
        return
      }
      if (!canvas) return // unreachable: both branches above returned for a missing canvas
      const presence: Presence = {
        clientId: msg.clientId,
        ...(session ? { userId: session.user.id, image: avatarUrl(session.user.image) } : {}),
        /* session identity, not whatever the client claims; a guest's chosen
           name always carries the "(guest)" marker so nobody can pass as a member */
        name: session ? session.user.name : (guestDisplayName(msg.name) ?? `Guest${GUEST_MARK}`),
        color: colorFor(msg.clientId),
        kind: 'user',
        activeFrameId: null,
        ...(guest ? { guest: true } : {}),
      }
      const silent = !!session && !!(session.session as { impersonatedBy?: string | null }).impersonatedBy
      const next: Conn = {
        ws,
        canvasId: msg.canvasId,
        userId: session?.user.id,
        presence,
        silent,
        user,
        guest,
        role,
        cookie,
      }
      conns.set(ws, next)
      const restricted = isRestricted(next)
      /* an agent's status line is its task's summary: restricted visitors do not see it */
      const shownPresence = (p: Presence): Presence => (restricted ? restrictedPresence(p) : p)
      const others = room(msg.canvasId)
        .filter((c) => c.ws !== ws && !c.silent)
        .map((c) => shownPresence(c.presence))
      const agents = [...(agentPresences.get(msg.canvasId)?.values() ?? [])].map(shownPresence)
      send(ws, {
        type: 'init',
        canvas: { ...(restricted ? publicCanvasView(canvas, guest) : canvas), role },
        presences: [...others, ...agents],
        activity: restricted ? [] : actions.getActivity(msg.canvasId),
        tasks: restricted ? [] : actions.getTasks(msg.canvasId),
        feedback: restricted ? [] : actions.getFeedback(msg.canvasId),
        comments: actions.getComments(msg.canvasId),
        decisions: restricted ? [] : actions.getDecisions(msg.canvasId),
        proposals: restricted ? [] : actions.getProposals(msg.canvasId),
        selfColor: presence.color,
        serverBuild: BUILD_ID,
        role,
        ...(guest ? { guest: true } : {}),
      })
      const joinClaims = claimsOn(msg.canvasId)
      if (joinClaims.length) {
        const claimsShown = claimsMessage(msg.canvasId, joinClaims)
        send(ws, restricted ? withoutClaimNotes(claimsShown) : claimsShown)
      }
      /* An admin looking at a canvas must not act on it. Announcing presence
         would impersonate the owner in the room; maybePlay would have the
         demo agent perform on an untouched signup canvas; the card kick would
         start the resident agent working. All three are things the owner's
         own visit is supposed to trigger, not a support session. */
      if (silent) return
      broadcast(msg.canvasId, { type: 'presence:join', presence }, presence.clientId)
      /* Only people who can edit set the demo or the agent in motion: a
         reviewer opening the link must not start work on the owner's behalf. */
      if (!roleAtLeast(role, 'edit')) return
      demo.maybePlay(msg.canvasId) // first visit to a fresh signup canvas: the demo agent performs
      /* Start never-attempted cards. Failed/interrupted cards are excluded. */
      if (actions.getTasks(msg.canvasId).some((t) => t.queuedBy && !t.agentName && !t.endedAt)) {
        import('./resident.ts').then((r) => r.onFeedback(msg.canvasId)).catch(() => {})
      }
      return
    }

    if (!conn) return
    if (conn.silent) return // view-as connections receive updates but never emit
    const { canvasId, presence } = conn
    /* view and comment visitors share cursors and viewports; claiming a frame for editing is editor-only and
       dropped silently. A frame drag is editor-only too, but it re-resolves the role itself below and answers a
       refusal with one error, so it passes this gate. */
    if (msg.type !== 'frame:drag' && !roleAtLeast(conn.role, roomMessageNeeds(msg))) return

    switch (msg.type) {
      case 'cursor':
        presence.cursor = { x: msg.x, y: msg.y }
        broadcast(canvasId, { type: 'cursor', clientId: presence.clientId, x: msg.x, y: msg.y }, presence.clientId)
        break
      case 'viewport':
        if (!isPeerViewport(msg.viewport)) break
        presence.viewport = msg.viewport
        broadcast(
          canvasId,
          { type: 'viewport', clientId: presence.clientId, viewport: msg.viewport },
          presence.clientId,
        )
        break
      case 'editing':
        presence.activeFrameId = msg.frameId
        broadcast(canvasId, { type: 'editing', clientId: presence.clientId, frameId: msg.frameId }, presence.clientId)
        break
      case 'frame:drag': {
        /* A live drag moves the frame on everyone's screen, so it takes edit
           access — re-resolved now, not trusted from the join. A refused
           message is answered once to this socket and never broadcast. */
        const canvas = store.getCanvas(canvasId)
        const role = !canvas
          ? null
          : conn.guest
            ? guestRole(canvas, { unlocked: unlockedByCookie(canvas, conn.cookie) })
            : canvasRole(conn.user, canvas, { unlocked: unlockedByCookie(canvas, conn.cookie) })
        if (!roleAtLeast(role, 'edit')) {
          send(ws, { type: 'error', message: 'You can look at this canvas but not change it.' })
          break
        }
        if (store.getFrame(msg.frameId)?.canvasId !== canvasId) break
        broadcast(
          canvasId,
          {
            type: 'frame:drag',
            clientId: presence.clientId,
            frameId: msg.frameId,
            x: msg.x,
            y: msg.y,
            width: msg.width,
            height: msg.height,
            ...(msg.rotation !== undefined ? { rotation: msg.rotation } : {}),
          },
          presence.clientId,
        )
        break
      }
    }
  })

  ws.on('close', () => {
    const conn = conns.get(ws)
    if (!conn) return
    conns.delete(ws)
    if (conn.silent) return // never announced a join, so nothing to leave
    broadcast(conn.canvasId, { type: 'presence:leave', clientId: conn.presence.clientId })
  })
})

server.listen(PORT, () => {
  console.log(`⟡ doop server     http://localhost:${PORT}`)
  /* persisted renders of a frame's old versions are removed in the background */
  startRenderSweep((id) => store.getFrame(id)?.updatedAt)
  /* a saved frame is rendered once it has been quiet for a moment, so its first /i/ request is a stored hit; never started in tests */
  startRenderWarm({ isBusy: actions.isFrameStreaming })
  /* frame HTML is loaded per canvas; a canvas nobody has used for
     CANVAS_IDLE_MS gives it back, unless a room, agent or stream is on it.
     Started here, once the room state it asks about exists. */
  store.setInUse(
    (canvasId) =>
      room(canvasId).length > 0 || (agentPresences.get(canvasId)?.size ?? 0) > 0 || actions.isCanvasStreaming(canvasId),
  )
  setInterval(
    () => {
      const dropped = store.evictIdle(env.CANVAS_IDLE_MS)
      if (dropped) console.log(`[store] dropped the frame HTML of ${dropped} idle canvas(es)`)
    },
    Math.min(60_000, Math.max(1_000, env.CANVAS_IDLE_MS / 2)),
  ).unref()
  /* comments anchored before element ids: stamped now, while serving, so a
     slow or failing row can never keep the server from coming up */
  if (data.legacyCommentSelectors.size > 0) {
    actions
      .backfillElementIds(data.legacyCommentSelectors)
      .then(({ stamped, lost, failed }) =>
        console.log(
          `[comments] element ids: ${stamped} comment(s) re-anchored, ${lost} lost their element, ${failed} left for the next boot`,
        ),
      )
      .catch((err) => console.error('[comments] element id backfill failed:', err))
  }
  /* credentials stored before encryption (or under a rotated-out key) are
     sealed now; reads open either form, so serving need not wait for it */
  if (encryptionConfigured()) {
    resealSecrets(db)
      .then(({ resealed, failed }) => {
        if (resealed || failed)
          console.log(`[secrets] ${resealed} credential(s) sealed, ${failed} left for the next boot`)
      })
      .catch((err) => console.error('[secrets] reseal failed:', err))
  } else {
    console.warn('⟡ secrets           SECRETS_ENCRYPTION_KEYS unset — user credentials are stored unencrypted')
  }
  console.log(`⟡ mcp endpoint      http://localhost:${PORT}/mcp`)
  console.log(`⟡ websocket         ws://localhost:${PORT}/ws`)
  /* The Doop Agent failing silently is the one "why is nothing happening?"
     a self-hoster cannot debug from the UI — board cards and @mentions just
     sit there. Say so at boot, not only when the first card is queued. */
  const tier = serverTierInfo()
  console.log(
    tier.ready
      ? `⟡ doop agent        on — free tier on this server’s ${tier.provider === 'azure' ? 'Azure OpenAI deployment' : 'Anthropic key'}, then each user’s own model account`
      : `⟡ doop agent        no server ${tier.provider === 'azure' ? 'Azure config' : 'key'} — runs only for users who connect their own ChatGPT subscription or OpenAI key (${tier.provider === 'azure' ? 'set the AZURE_OPENAI_* vars' : 'set ANTHROPIC_API_KEY'} for a free tier; agents connected over MCP work regardless)`,
  )
  console.log(
    serverImageGenEnabled()
      ? '⟡ image generation  on — each user’s connected ChatGPT/OpenAI account, else this server’s OPENAI_API_KEY'
      : '⟡ image generation  on for users with a connected ChatGPT/OpenAI account only (set OPENAI_API_KEY to cover everyone else)',
  )
  /* automations fire from here: one tick a minute over the due rows */
  startScheduler()
  startMcpTokenPrune()
  for (const extension of extensions) extension.startWorker?.()
})
