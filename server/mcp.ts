import { env } from './env.ts'
import { canvasPages, normalizePageTree, samePages, validatePageTree } from '../shared/pages.ts'
import { MAX_NOTE_CHARS, NOTE_COLORS, noteExcerpt } from '../shared/notes.ts'
import { MAX_SPEAKER_NOTES_CHARS } from '../shared/slides.ts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as persist from './db/persist.ts'
import { canComment, canEdit, canView, type AccessUser } from './access.ts'
import { AGENT_REQUEST_NOTICE } from '../shared/types.ts'
import { isAgentKeySecret, verifyAgentKey } from './agentKeys.ts'
import * as workspaces from './workspaces.ts'
import { auth, getAccessProfile, getUserName, isBanned } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import { renderFrame } from './screenshot.ts'
import { primeImage } from './previews.ts'
import { DOOP_GUIDE, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import * as imageSearch from './imageSearch.ts'
import * as imageGen from './imageGen.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { normalizeImportUrl } from './importer.ts'
import { extensions, type McpToolHelpers } from './extensions.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { mentionedRole } from '../shared/agents.ts'
import * as allowance from './allowance.ts'
import { previewOf, previewToolMeta, registerFramePreview, type CanvasPreview } from './chatgptApp.ts'

const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases contain frames — artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) once before using other Doop tools. Call it again if a long conversation may have compressed or dropped the guide text.

- Context first: call get_canvas before adding or editing frames.
- Element links: /c/<canvas_id>?frame=<frame_id>&selector=<URL-encoded CSS selector> identifies a specific element. Decode selector, read get_canvas and get_frame, and locate that element in the frame HTML before applying the feedback. If it no longer matches, ask for an updated reference.
- Identity: pick an agent_name and reuse the SAME name on every call — your presence and edits are attributed live.
- Narrate: call set_status with a one-line summary when you start a task and whenever your focus shifts — people watching the canvas see it live next to your name.
- Creating: create_frame, then stream the design with append_frame_html one complete section at a time (~1–4 KB chunks; start=true on the first, done=true on the last). Each chunk renders the moment it arrives — viewers watch you work.
- Show the work first: before research or long generation, create the frames the work will land in, named for their content, and call set_status.
- Review: after every create or significant edit you MUST call get_frame_screenshot and fix what looks wrong before moving on. Review on a budget: one inspection round, one batch of fixes, at most one confirmation screenshot (the cap never applies to broken function, unreadable contrast or missing states).
- Fork, don't overwrite: put a new idea for a reviewed or approved frame in a variant frame beside it, never over the original. list_frame_versions and restore_frame_version roll back your own mistakes.
- Ask and report: pin questions to the element with add_comment and never resolve your own; lead your reply with the decisions you need and end it with /c/<canvasId>?frame=<frameId> for each changed frame.
- Small edits: edit_frame_html (exact find/replace — the change morphs into the rendered frame in place). Full redesigns: set_frame_html or a new stream. Rename/move/resize: update_frame.
- History: every replace and stream files the design it overwrote. list_frame_versions shows a frame's earlier states; restore_frame_version brings one back (HTML and size) when a human asks for the previous version or your rework turned out worse.
- Images: real imagery makes designs. search_images finds stock photos (you SEE thumbnails and pick), search_icons finds 200k+ UI icons as hotlinkable SVGs, search_logos finds real company logos by brand name or domain — call it once per brand BEFORE writing any logo wall, integration row, press bar or testimonial, and never ship a placeholder tile, "LOGO" text or an invented wordmark in its place, list_backgrounds shows a page of curated hero/section/bento backgrounds (glows, grainy meshes, aurora, painterly scenes) as thumbnails — browse it when a section wants atmosphere rather than defaulting to a flat CSS gradient, judge by eye whether one fits the frame, and draw your own when none does, upload_asset stores your own file (remote file → source_url; local file → local_file=true, returns a curl command) and returns a permanent URL. generate_image makes a new image from a prompt (a full-bleed hero background in the frame's exact palette, illustration, a product render, brand-specific hero art that stock cannot supply) and stores it as a permanent asset — reach for it when search_images cannot deliver the exact visual, or when the human asks for a generated image; it costs the human money or quota, so one considered prompt beats five drafts. Never inline images as data: URIs.
- Websites: when a request names an existing site or URL — a redesign of it, or "like acme.com" — call import_webpage FIRST so an editable HTML snapshot lands on the canvas. Leave that source frame unchanged and design in a separate frame. view_website is only for read-only inspection when the page should not be added. If Doop cannot capture the site, do not retry with view_website because it uses the same capture path. Use your own browser or web tool and work only from content you actually observe; if that is unavailable, ask the user for screenshots or an HTML export rather than inventing content.
${extensionGuideLines()}- Feedback: humans reply to your tasks; their notes arrive inside your tool results as HUMAN FEEDBACK blocks — address them before continuing.
- Comments: call get_comments to read comments and replies on a canvas — pinned to an element inside a frame, or to a point on the canvas (pageId, x, y) — optionally filtered by frame; add_comment starts a new thread pinned to an element (by quote or selector) or, with page_id, x and y and no frame_id, to a point on the canvas; reply_to_comment answers a thread and resolve_comment closes it. Reading does not claim feedback or comments. A reply that @mentions a resident role is metered like a comment left in the browser.
- Guidelines: canvases can carry named style guides (brand rules, style recipes). get_canvas lists them with one-line summaries — read the relevant ones with get_guidelines BEFORE designing and follow them.
- Memory: canvases can also carry pinned style references — exemplar designs humans marked as "more like this". get_canvas lists them; read the relevant one with get_reference and match its look. When your human gives you design feedback in conversation and you address it, record it with save_decision so the canvas remembers their taste.`

function extensionGuideLines(): string {
  const lines = extensions.flatMap((extension) => extension.mcpGuideLines ?? [])
  return lines.length ? lines.join('\n') + '\n' : ''
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

/** Result payload plus a workflow nudge the agent reads at its decision point. */
function textWithNudge(data: unknown, nudge: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      { type: 'text' as const, text: nudge },
    ],
  }
}

const REVIEW_NUDGE =
  'You have not seen this design yet. Call get_frame_screenshot on it now, judge it against the review checkpoints (fit, spacing, hierarchy, contrast, alignment, realism), and fix any issues before moving on.'

import type { Actor, Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'

/** Reaches agents whose session predates set_status (or who skipped the guide). */
function withStatusNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  if (actions.hasAnnouncedTask(canvasId, actor)) return result
  result.content.push({
    type: 'text' as const,
    text: 'You have not announced what you are working on. Call set_status with a one-line, present-tense summary (e.g. "Designing a pricing page, dark editorial style") — it shows live next to your name and builds your task history in the panel. Update it when your focus shifts; clear it with "" when done.',
  })
  return result
}

/** Tells an agent its markup arrived escaped — actions.ts already decoded it. */
function withEscapeNote<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  sent: string,
): T {
  if (looksEscapedHtml(sent)) result.content.push({ type: 'text' as const, text: ESCAPED_HTML_NOTE })
  return result
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

/** Reaches agents that start designing without having read the canvas's style guides. */
function withGuidelinesNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const docs = store.getGuidelines(canvasId)
  if (docs.length === 0 || actions.hasSeenGuidelines(canvasId, actor.name)) return result
  result.content.push({
    type: 'text' as const,
    text: `This canvas has style guides you have not read: ${docs.map((d) => d.name).join(', ')}. Call get_guidelines({ canvas_id, name }) for each relevant one NOW and make your design follow them.`,
  })
  return result
}

/** Append any undelivered human feedback for this agent to a tool result.
 *  MCP is pull-based, so this is the channel through which humans steer agents. */
function deliverFeedback<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const pending = actions.takeFeedbackFor(canvasId, actor.name)
  if (pending.length === 0) return result
  const tasks = actions.getTasks(canvasId)
  const lines = pending.map((f) => {
    const task = tasks.find((t) => t.id === f.taskId)
    const mine = task && task.agentName === actor.name
    const about = task ? ` (about ${mine ? 'your' : `${task.agentName}’s`} work: “${task.status}”)` : ''
    return `- ${f.from}${about}: ${f.text}`
  })
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${lines.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (get_canvas / get_frame), make the change, and review with get_frame_screenshot. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`,
  })
  return result
}

/** Attaches the data behind the ChatGPT preview card (server/chatgptApp.ts):
 *  the frames a tool touched, as `structuredContent`. Clients without a
 *  component host ignore it; the model keeps reading `content` as before. */
function withPreview<T extends { content: unknown[] }>(
  result: T,
  canvasId: string,
  frames: Frame[],
): T & { structuredContent: CanvasPreview } {
  const canvas = store.getCanvas(canvasId)
  return { ...result, structuredContent: previewOf({ id: canvasId, name: canvas?.name ?? '' }, frames) }
}

/* Per-connecting-user rate limits, each overridable by environment variable
   for self-hosted instances that want a looser cap (see .env.example). The
   defaults are the conservative values that suit the hosted service. */
const uploadHits = new Map<string, number[]>()
const UPLOADS_PER_MIN = env.MCP_UPLOADS_PER_MIN

/* photo search burns the shared Pexels quota (200 req/hour on the free tier) */
const searchHits = new Map<string, number[]>()
const SEARCHES_PER_MIN = env.MCP_SEARCHES_PER_MIN

/* generation spends the payer's subscription quota or money — keep a burst
   of retries from draining it */
const generateHits = new Map<string, number[]>()
const GENERATIONS_PER_MIN = env.MCP_GENERATIONS_PER_MIN

/* importing writes a potentially large HTML frame, so keep it at the same
   conservative per-user rate as the browser UI's import endpoint */
const importHits = new Map<string, number[]>()
const IMPORTS_PER_MIN = env.MCP_IMPORTS_PER_MIN

const agentName = z
  .string()
  .describe(
    'Your display name, shown live to everyone on the canvas (e.g. "Claude", "Codex"). Reuse the SAME name on every call so your work is attributed consistently.',
  )

/** Pages cross the MCP boundary as `parent_id` (snake_case like every other agent-facing field). */
function toMcpPage(page: CanvasPageInfo): { id: string; name: string; parent_id?: string } {
  return page.parentId === undefined
    ? { id: page.id, name: page.name }
    : { id: page.id, name: page.name, parent_id: page.parentId }
}

function fromMcpPage(page: { id: string; name: string; parent_id?: string | undefined }): CanvasPageInfo {
  return page.parent_id === undefined
    ? { id: page.id, name: page.name }
    : { id: page.id, name: page.name, parentId: page.parent_id }
}

function frameSummary(f: {
  pageId?: string
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  updatedAt: number
  updatedBy: string
  html: string
  demo?: boolean
  slide?: boolean
  hidden?: boolean
  locked?: boolean
}) {
  return {
    id: f.id,
    pageId: f.pageId,
    name: f.name,
    ...(f.demo ? { demo: true } : {}),
    ...(f.slide ? { slide: true } : {}),
    ...(f.hidden ? { hidden: true } : {}),
    ...(f.locked ? { locked: true } : {}),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    updatedAt: new Date(f.updatedAt).toISOString(),
    updatedBy: f.updatedBy,
    htmlBytes: f.html.length,
    /* public render of the CURRENT design — downloadable/hotlinkable
       (append &download, or .jpg?quality=90 for JPEG) */
    image_url: `${env.BETTER_AUTH_URL}/i/${f.id}.png?scale=2`,
  }
}

const NOTE_EXCERPT_CHARS = 400

function noteSummary(n: {
  id: string
  frameId?: string
  pageId?: string
  x: number
  y: number
  width: number
  height: number
  color: string
  markdown: string
  createdBy: string
  updatedAt: number
}) {
  return {
    id: n.id,
    ...(n.frameId ? { frame_id: n.frameId } : {}),
    ...(n.pageId ? { page_id: n.pageId } : {}),
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    color: n.color,
    text: noteExcerpt(n.markdown, NOTE_EXCERPT_CHARS),
    ...(n.markdown.length > NOTE_EXCERPT_CHARS ? { chars: n.markdown.length } : {}),
    createdBy: n.createdBy,
    updatedAt: new Date(n.updatedAt).toISOString(),
  }
}

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. */
export function buildMcpServer(
  owner?: string,
  ownerId?: string,
  profile?: { email?: string | null; emailVerified?: boolean | null },
): McpServer {
  const actorFrom = (agent_name?: string) =>
    actions.resolveActor({ name: agent_name, kind: 'agent', owner, userId: ownerId })
  /* Canvas access for agents mirrors the web UI: the OAuth user (or agent key
     owner) runs through the same role resolver as browser sessions, so an
     agent can do exactly what its human can. Every tool that takes a canvas or
     frame id resolves it through these, naming the least role it needs: view
     for reads, comment for the comment tools, edit for everything that
     changes the canvas. A password link never admits an agent — there is no
     cookie to present. */
  const who: AccessUser | undefined = ownerId
    ? { id: ownerId, email: profile?.email, emailVerified: profile?.emailVerified }
    : undefined
  type Need = 'view' | 'comment' | 'edit'
  const allows = (c: Canvas, need: Need) =>
    need === 'edit' ? canEdit(who, c) : need === 'comment' ? canComment(who, c) : canView(who, c)
  const canvasFor = (canvasId: string, need: Need = 'view') => {
    const c = store.getCanvas(canvasId)
    return c && allows(c, need) ? c : undefined
  }
  const frameFor = (frameId: string, need: Need = 'view') => {
    const f = store.getFrame(frameId)
    if (!f) return undefined
    return canvasFor(f.canvasId, need) ? f : undefined
  }
  /* an account that can see the canvas but not do this much is told so, rather than "not found" */
  const tooLow = (canvasId: string, need: Need) => {
    const c = store.getCanvas(canvasId)
    return c && need !== 'view' && canView(who, c)
      ? err(
          `this account can ${canComment(who, c) ? 'view and comment on' : 'only view'} canvas ${canvasId}; this tool needs ${need} access`,
        )
      : undefined
  }
  const noCanvas = (id: string, need: Need = 'view') =>
    tooLow(id, need) ?? err(`no canvas with id ${id} accessible to this account`)
  const noFrame = (id: string, need: Need = 'view') => {
    const f = store.getFrame(id)
    return (f && tooLow(f.canvasId, need)) ?? err(`no frame with id ${id} accessible to this account`)
  }
  /* Human feedback is addressed to agents that edit; one that cannot edit the
     canvas must not claim it, so only an editor's results carry it. */
  const withFeedback = <T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
    result: T,
    canvasId: string,
    actor?: Actor,
  ): T => (canvasFor(canvasId, 'edit') ? deliverFeedback(result, canvasId, actor) : result)
  const noComment = (id: string) => err(`no comment with id ${id} on this canvas`)
  /* Reads count as arrival: presence (and with it every "your agent is
     connected" confirmation in the UI) must appear on an agent's FIRST
     canvas-scoped call, not only once it mutates something. */
  const arrive = (canvasId: string, agent_name?: string) => {
    if (agent_name) actions.heartbeatAgent(canvasId, actorFrom(agent_name))
  }
  const server = new McpServer({ name: 'doop-canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  registerFramePreview(server)

  server.registerTool(
    'get_guide',
    {
      title: 'Read the Doop agent guide',
      description:
        'Read the Doop agent guide: mandatory review checkpoints, the streaming workflow, frame sizing, design-quality doctrine, and multiplayer etiquette. Call with topic "doop-instructions" ONCE before using other Doop tools; call again if a long conversation may have compressed earlier context.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).describe('Guide topic to load'),
      },
    },
    async () => text(DOOP_GUIDE),
  )

  server.registerTool(
    'search_inspiration',
    {
      title: 'Search design inspiration',
      description:
        'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z
          .string()
          .describe('Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const results = await searchInspiration(query, count ?? 4)
        if (results.length === 0)
          return text({ ok: true, results: [], note: `No inspiration for "${query}" — try a broader category.` })
        const thumbs = await Promise.all(results.map((r) => imageSearch.fetchThumb(r.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: describeInspiration(r, i) })
        })
        content.push({ type: 'text' as const, text: INSPIRATION_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  server.registerTool(
    'list_canvases',
    {
      title: 'List canvases',
      description:
        "List the connected user's design canvases with their ids, names and frame counts — personal ones, ones shared with them, and every canvas in their workspaces (workspace_id / workspace_name set).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    /* '' matches no ownerId: a session without a user sees nothing */
    async () =>
      text(
        workspaces.canvasesFor(ownerId ?? '').map((m) => ({
          ...m,
          ...(m.workspaceId
            ? { workspace_id: m.workspaceId, workspace_name: workspaces.getWorkspace(m.workspaceId)?.name }
            : {}),
          /* count what get_canvas will actually return — demo frames are hidden from agents */
          frameCount: store.getCanvas(m.id)?.frames.filter((f) => !f.demo).length ?? m.frameCount,
          guidelinesCount: store.getGuidelines(m.id).length,
        })),
      ),
  )

  /* ChatGPT shows this when several Doop accounts are connected — the
     `openai/profile` flag marks it as the one that tells them apart. */
  server.registerTool(
    'get_profile',
    {
      title: 'Get the connected account',
      description:
        'Return the Doop account this connection is signed in as (stable id and display name). Read-only; use it to confirm whose canvases you are working on.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'openai/profile': true },
      inputSchema: {},
      outputSchema: { id: z.string(), name: z.string() },
    },
    async () => {
      if (!ownerId) return err('this connection is not signed in to a Doop account')
      const profile = { id: ownerId, name: owner ?? '' }
      return { content: [{ type: 'text' as const, text: JSON.stringify(profile) }], structuredContent: profile }
    },
  )

  server.registerTool(
    'create_canvas',
    {
      title: 'Create a canvas',
      description:
        'Create a new design canvas. Returns the canvas id, which is part of the shareable URL (/c/<id>). Pass workspace_id (from list_canvases) to create it inside a shared workspace so every member can open it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        name: z.string().describe('Canvas name'),
        workspace_id: z.string().optional().describe('Create inside this shared workspace'),
        agent_name: agentName.optional(),
      },
    },
    async ({ name, workspace_id }) => {
      if (workspace_id) {
        const ws = workspaces.getWorkspace(workspace_id)
        if (!ws || !workspaces.isWorkspaceMember(ws.id, ownerId)) return err(`no workspace with id ${workspace_id}`)
        if (!workspaces.isActive(ws))
          return err(`workspace "${ws.name}" needs a Team plan before canvases can be added`)
      }
      /* owned by the connecting user — an ownerless canvas would be invisible
         on every dashboard (and was once visible on all of them) */
      const canvas = store.createCanvas(name, ownerId, workspace_id)
      return text({ id: canvas.id, name: canvas.name, url: `/c/${canvas.id}` })
    },
  )

  server.registerTool(
    'get_canvas',
    {
      title: 'Get a canvas and its frames',
      _meta: previewToolMeta('Reading the canvas…', 'Canvas loaded'),
      description:
        'Get a canvas: its name, its pages (a nested page carries parent_id, the page it sits under; parents are listed before their subpages) and every frame with position, size and metadata (not the HTML — use get_frame for that). Use this to see the current layout before adding or editing frames. Pass your agent_name so any human feedback waiting for you is delivered with the result.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const docs = store.getGuidelines(canvas_id)
      const refs = store.getReferences(canvas_id)
      /* design-synced canvases carry a flow map: real user navigation between
         the synced screens — context a redesign must respect */
      const flow = describeSyncFlow(await getSyncFlow(c), c.frames)
      const notes = [
        ...(flow.length
          ? [
              'This canvas is synced from a live app and `flow` shows how its screens connect — including how often real users take each path. Do not bury or weaken elements that carry heavy navigation.',
            ]
          : []),
        ...(docs.length
          ? [
              'This canvas has style guides. Call get_guidelines for each relevant one BEFORE designing — every frame must follow them.',
            ]
          : []),
        ...(refs.length
          ? [
              'This canvas has pinned style references — exemplar designs humans marked as "more like this". Call get_reference on the relevant one and match its look (palette, type, spacing) in what you design.',
            ]
          : []),
      ]
      return withPreview(
        withFeedback(
          text({
            id: c.id,
            name: c.name,
            pages: c.pages?.map(toMcpPage),
            /* demo frames (the Doop welcome show, seeded examples) are product
             content, not user work — hidden so agents never mistake them for
             the canvas's established style */
            frames: c.frames.filter((f) => !f.demo).map(frameSummary),
            ...(c.notes?.length ? { notes: c.notes.map(noteSummary) } : {}),
            guidelines: docs.map((d) => ({
              name: d.name,
              title: actions.guidelineTitle(d),
              summary: actions.guidelineSummary(d),
              bytes: d.markdown.length,
            })),
            references: refs.map((r) => ({
              id: r.id,
              title: r.title,
              size: `${Math.round(r.width)}x${Math.round(r.height)}`,
              htmlBytes: r.html.length,
              pinnedBy: r.pinnedBy,
            })),
            ...(flow.length ? { flow } : {}),
            ...(notes.length ? { note: notes.join(' ') } : {}),
          }),
          canvas_id,
          agent_name ? actorFrom(agent_name) : undefined,
        ),
        canvas_id,
        c.frames.filter((f) => !f.demo),
      )
    },
  )

  server.registerTool(
    'list_guidelines',
    {
      title: 'List style guides',
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      const docs = store.getGuidelines(canvas_id)
      if (docs.length === 0)
        return text({
          guidelines: [],
          note: 'No style guides on this canvas yet. Set one with set_guidelines when a human hands you brand or style rules.',
        })
      return withFeedback(
        text({
          guidelines: docs.map((d) => ({
            name: d.name,
            title: actions.guidelineTitle(d),
            summary: actions.guidelineSummary(d),
            bytes: d.markdown.length,
            updatedAt: new Date(d.updatedAt).toISOString(),
            updatedBy: d.updatedBy,
          })),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_guidelines',
    {
      title: 'Read a style guide',
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc name from get_canvas / list_guidelines, e.g. "feature-image"'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const doc = store.getGuidelines(canvas_id).find((d) => d.name === name.trim().toLowerCase())
      if (!doc) {
        const names = store.getGuidelines(canvas_id).map((d) => d.name)
        return err(
          names.length
            ? `no style guide named “${name}” — this canvas has: ${names.join(', ')}`
            : `no style guides on this canvas yet`,
        )
      }
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      return withFeedback(text(doc.markdown), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  server.registerTool(
    'set_guidelines',
    {
      title: 'Create or replace a style guide',
      description:
        "Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font <link>s, ready-to-paste <style> blocks, logo asset URLs (upload files with upload_asset first and reference the returned URLs), layout recipes, do/don't lists.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc slug, e.g. "feature-image" (a-z, 0-9, hyphens)'),
        markdown: z
          .string()
          .max(actions.MAX_GUIDELINE_CHARS)
          .describe('Full replacement markdown for this doc; empty string deletes it'),
        title: z
          .string()
          .max(actions.MAX_GUIDELINE_TITLE_CHARS)
          .optional()
          .describe('Pretty display name shown to humans, e.g. "Featured Images"; omit to keep the current one'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, markdown, title, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const actor = actorFrom(agent_name)
      try {
        const doc = actions.setGuideline(canvas_id, name, markdown, actor, undefined, title)
        actions.markGuidelinesSeen(canvas_id, actor.name)
        return withFeedback(
          text(
            doc
              ? { ok: true, name: doc.name, title: actions.guidelineTitle(doc), bytes: doc.markdown.length }
              : { ok: true, deleted: true },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid guideline doc')
      }
    },
  )

  server.registerTool(
    'get_reference',
    {
      title: 'Read a pinned style reference',
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const ref = store.getReferences(canvas_id).find((r) => r.id === reference_id)
      if (!ref) {
        const ids = store.getReferences(canvas_id).map((r) => `${r.id} (“${r.title}”)`)
        return err(
          ids.length
            ? `no reference with id ${reference_id} — this canvas has: ${ids.join(', ')}`
            : 'no style references pinned on this canvas yet',
        )
      }
      return withFeedback(
        text({
          id: ref.id,
          title: ref.title,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          html: ref.html,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'save_decision',
    {
      title: 'Save a design decision',
      description:
        'Record a design decision your human made while talking to YOU — style feedback you carried out ("rounder corners", "less purple, more white and blue", "stop using italic serif"). Doop\'s UI feedback is captured automatically, but you are the only one who hears your own conversation, so report it with this tool AFTER you have addressed it. It lands in the canvas\'s Memory; recurring preferences become suggested style rules. Record design taste only — not one-off content edits like typo fixes or copy changes.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        decision: z
          .string()
          .max(actions.MAX_DECISION_CHARS)
          .describe('The feedback in the human\'s own words, e.g. "make it less claude-esque, more white and blue"'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, decision, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const actor = actorFrom(agent_name)
      try {
        const saved = actions.recordChatDecision(canvas_id, decision, actor)
        if (saved === undefined) return err(`no canvas with id ${canvas_id}`)
        return withFeedback(
          text(
            saved
              ? { ok: true, note: 'Saved to the canvas Memory. Recurring preferences become suggested style rules.' }
              : { ok: true, note: 'Already in Memory — this exact decision was recorded before.' },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid decision')
      }
    },
  )

  server.registerTool(
    'set_status',
    {
      title: 'Set your live status',
      description:
        'Broadcast a one-line status of what you are working on right now — everyone viewing the canvas sees it live next to your name (e.g. "Sketching a mobile onboarding flow", "Fixing contrast on the pricing table"). Set it when you START a task, update it whenever your focus shifts to something new, and clear it with an empty string when you are done. Keep it under ~80 characters, present tense, specific.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        status: z
          .string()
          .max(140)
          .describe('What you are working on, one line, present tense. Empty string clears your status.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      actions.setAgentStatus(canvas_id, actorFrom(agent_name), status)
      return withFeedback(text({ ok: true, status: status.trim() || null }), canvas_id, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'get_comments',
    {
      title: 'Read comments',
      description:
        'Read comments and replies on a canvas, newest first, including author, text, parentId thread links, and claim/failure/resolution metadata. An element comment carries its frameId, CSS selector, HTML snippet and the element anchor (its tag, id, aria hints and a `quote` of the text it shows — use it to find the element in the frame HTML if the selector no longer matches); a canvas comment is pinned to a point on the canvas instead and carries pageId, x and y (world coordinates) with no frame. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive. Reading does not claim feedback or comments, or mark them resolved.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z
          .string()
          .optional()
          .describe(
            'Only element comments on this frame (canvas comments are left out); it must belong to the canvas.',
          ),
        include_resolved: z.boolean().default(true).describe('Include resolved comments and replies. Default true.'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, frame_id, include_resolved, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (frame_id !== undefined) {
        const frame = frameFor(frame_id)
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      }
      arrive(canvas_id, agent_name)
      const comments = actions
        .getComments(canvas_id)
        .filter((comment) => frame_id === undefined || comment.frameId === frame_id)
        .filter((comment) => include_resolved || comment.resolvedAt === undefined)
      // Deliberately omit withFeedback: inspecting comments must not claim work.
      return text(comments)
    },
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment',
      description:
        'Start a new comment thread to ask a question or leave a note for the people on the canvas. Two places to pin it. On an element: pass frame_id and identify the element by `quote` (a short piece of the text it shows, e.g. the button label or heading — the pin finds the element by that text even after the frame is edited) and/or `selector` (a CSS selector in the frame); at least one is required, and the thread appears as a pin on the frame. On the canvas itself: omit frame_id and pass page_id with world coordinates x and y (the spot on that page, e.g. a gap between frames or where something should go). Read answers with get_comments and continue with reply_to_comment. If the text @mentions a resident role (e.g. "@Doop"), it counts as a new resident task against the account’s meter, exactly like a comment left in the browser.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z
          .string()
          .optional()
          .describe('The frame to pin an element comment on; it must belong to the canvas. Omit for a canvas comment.'),
        quote: z
          .string()
          .max(200)
          .optional()
          .describe('Text shown by the element to pin to, copied from the frame (first ~60 characters are matched)'),
        selector: z
          .string()
          .max(actions.MAX_SELECTOR_LENGTH)
          .optional()
          .describe('CSS selector of the element in the frame, e.g. ".hero > h1"'),
        page_id: z.string().optional().describe('Canvas comment: the page to pin on (from get_canvas)'),
        x: z.number().optional().describe('Canvas comment: x in world coordinates on the page'),
        y: z.number().optional().describe('Canvas comment: y in world coordinates on the page'),
        text: z.string().describe('The comment. Trimmed; empty comments are rejected.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, frame_id, quote, selector, page_id, x, y, text: body, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'comment')
      if (!canvas) return noCanvas(canvas_id, 'comment')
      const cleanQuote = quote?.replace(/\s+/g, ' ').trim()
      const cleanSelector = selector?.trim()
      if (frame_id !== undefined) {
        if (page_id !== undefined || x !== undefined || y !== undefined)
          return err('pass either frame_id (an element comment) or page_id with x and y (a canvas comment), not both')
        const frame = frameFor(frame_id, 'comment')
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id, 'comment')
        if (!cleanQuote && !cleanSelector) return err('add_comment needs a quote or a selector to pin the comment to')
      } else {
        if (cleanQuote || cleanSelector)
          return err(
            'a quote or selector pins to an element: pass the frame_id it is in, or drop them and use page_id, x and y',
          )
        if (page_id === undefined || x === undefined || y === undefined)
          return err('add_comment needs either a frame_id with a quote or selector, or page_id with x and y')
        if (!canvasPages(canvas).some((page) => page.id === page_id))
          return err(`no page with id ${page_id} on this canvas — call get_canvas`)
      }
      if (!body.trim()) return err('empty text')
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      /* same meter rule as a reply: only an @mention of a resident agent costs a task */
      let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
      /* asking an agent to change the canvas takes edit access; below that the
         comment is kept as plain text, exactly as in the browser */
      const mayAskAgents = !!canvasFor(canvas_id, 'edit')
      if (mayAskAgents && mentionedRole(body) && ownerId) {
        gate = await allowance.consumeResidentTask(ownerId)
        if (!gate.ok)
          return err(
            `resident task limit reached (${gate.used}/${gate.limit}) — connect a model account or retry later`,
          )
      }
      const options = mayAskAgents ? {} : { allowAgent: false }
      const comment =
        frame_id !== undefined
          ? actions.addElementComment(
              frame_id,
              {
                selector: cleanSelector ?? '',
                snippet: '',
                text: body,
                /* with only a quote the tag is unknown: resolution falls through to finding the text */
                anchor: cleanQuote ? { v: 1, tag: '', quote: cleanQuote, fx: 0.5, fy: 0.5 } : undefined,
              },
              actor.name,
              ownerId,
              'agent',
              options,
            )
          : actions.addCanvasComment(
              canvas_id,
              { pageId: page_id!, x: x!, y: y!, text: body },
              actor.name,
              ownerId,
              'agent',
              options,
            )
      if (!comment) {
        if (gate && ownerId) {
          await allowance
            .refundResidentTask(gate, ownerId)
            .catch((e) => console.error(`[mcp] could not refund a resident task for ${ownerId}:`, e))
        }
        return err('could not add the comment')
      }
      const result = text(comment)
      if (!mayAskAgents && mentionedRole(body))
        result.content.push({ type: 'text' as const, text: AGENT_REQUEST_NOTICE })
      return withFeedback(result, canvas_id, actor)
    },
  )

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a comment',
      description:
        'Reply inside a comment thread on a canvas. The reply inherits the root comment’s anchor (its element, or its point on the canvas), so an @mention in it gives the resident agent the same anchor the conversation is about. Writing does not resolve the thread — read the request with get_comments, make the change, then close it with resolve_comment. If the text @mentions a resident role (e.g. "@Doop"), it counts as a new resident task against the account’s meter, exactly like a comment left in the browser.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or any reply in the thread (from get_comments)'),
        text: z.string().describe('The reply text. Trimmed; empty replies are rejected.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, text: body, agent_name }) => {
      if (!canvasFor(canvas_id, 'comment')) return noCanvas(canvas_id, 'comment')
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      if (!body.trim() || !actions.openThread(comment_id)) return err('thread resolved or empty text')
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      /* A reply that @mentions a resident agent is a new command to the team,
         metered like a card; plain replies stay free. Mirrors the REST reply
         route so the meter is spent exactly once either way. */
      let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
      /* asking an agent to change the canvas takes edit access; below that the
         reply is kept as plain text, exactly as in the browser */
      const mayAskAgents = !!canvasFor(canvas_id, 'edit')
      if (mayAskAgents && mentionedRole(body) && ownerId) {
        gate = await allowance.consumeResidentTask(ownerId)
        if (!gate.ok)
          return err(
            `resident task limit reached (${gate.used}/${gate.limit}) — connect a model account or retry later`,
          )
      }
      /* attributed to the agent, billed to the connecting user: the resident
         picks whose model account pays from the requester id, and without one
         it falls back to the canvas owner's — wrong on a shared canvas */
      const reply = mayAskAgents
        ? actions.replyToComment(comment_id, body, actor.name, ownerId, 'agent')
        : actions.replyToComment(comment_id, body, actor.name, ownerId, 'agent', { allowAgent: false })
      if (!reply) {
        /* the thread closed while the meter was being written: give the task back */
        if (gate && ownerId) {
          await allowance
            .refundResidentTask(gate, ownerId)
            .catch((e) => console.error(`[mcp] could not refund a resident task for ${ownerId}:`, e))
        }
        return err('thread resolved meanwhile')
      }
      const held = !mayAskAgents && mentionedRole(body)
      const result = text(reply)
      if (held) result.content.push({ type: 'text' as const, text: AGENT_REQUEST_NOTICE })
      return withFeedback(result, canvas_id, actor)
    },
  )

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve a comment',
      description:
        'Resolve a comment thread on a canvas, marking the request addressed. Resolving a root comment closes its whole thread; resolving a reply closes only that reply. When the thread was an @mention of a resident agent, resolving it also records the exchange as a design decision in the canvas Memory (plain human-to-human notes are not). Like every mutating tool, the result also carries any pending task feedback addressed to you; get_feedback is for polling it on its own.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or a reply (from get_comments)'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'comment')) return noCanvas(canvas_id, 'comment')
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      const alreadyResolved = found.resolvedAt !== undefined
      const resolved = actions.resolveComment(comment_id, actor.name)
      if (!resolved) return noComment(comment_id)
      return withFeedback(
        text({
          ok: true,
          id: resolved.id,
          alreadyResolved,
          resolvedBy: resolved.resolvedBy,
          resolvedAt: resolved.resolvedAt ? new Date(resolved.resolvedAt).toISOString() : undefined,
        }),
        canvas_id,
        actor,
      )
    },
  )

  server.registerTool(
    'get_feedback',
    {
      title: 'Claim open human feedback',
      description:
        'Fetch and claim any open human feedback requests on a canvas. Feedback normally arrives automatically inside your other tool results, so you rarely need this — use it when you are specifically checking for feedback, e.g. an agent whose job is to poll the canvas every few minutes and address whatever humans have requested. Claiming assigns the requests to you: address each one, then review with get_frame_screenshot.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const fbs = actions.takeFeedbackFor(canvas_id, actorFrom(agent_name).name)
      if (fbs.length === 0) return text({ feedback: [], note: 'No open feedback requests right now.' })
      const tasks = actions.getTasks(canvas_id)
      return text({
        feedback: fbs.map((f) => {
          const task = tasks.find((t) => t.id === f.taskId)
          return {
            from: f.from,
            text: f.text,
            about: task ? `${task.agentName}: “${task.status}”` : undefined,
            at: new Date(f.at).toISOString(),
          }
        }),
        note: "These requests are now assigned to you. Address each one (a human request overrides the don't-touch-others'-frames etiquette), review with get_frame_screenshot, and update your set_status.",
      })
    },
  )

  server.registerTool(
    'set_canvas_pages',
    {
      title: 'Set canvas pages',
      description:
        'Create, rename, reorder, nest or delete canvas pages. Send the complete ordered page list with stable IDs (read get_canvas first). Nest a page under another with parent_id (the parent page id; omit for a top-level page). Pages nest at most 2 levels deep (3 levels in total), a parent page is a normal page that can hold its own frames, and children appear in list order under their parent, so list each parent before its subpages. Deleting a page that has subpages requires re-pointing them (change their parent_id) first. A page containing frames cannot be deleted: move its frames with update_frame first.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        expectedPages: z
          .array(z.object({ id: z.string(), name: z.string(), parent_id: z.string().optional() }))
          .describe('Exact ordered pages returned by get_canvas; protects collaborators from overwritten changes'),
        pages: z
          .array(
            z.object({
              id: z.string().trim().min(1).max(100),
              name: z.string().trim().min(1).max(100),
              parent_id: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .optional()
                .describe('Id of the page this one is nested under; omit for a top-level page'),
            }),
          )
          .min(1)
          .max(100),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, pages: requested, expectedPages, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return noCanvas(canvas_id, 'edit')
      if (!samePages(expectedPages.map(fromMcpPage), canvasPages(canvas)))
        return err('Pages changed. Read get_canvas again before saving.')
      const treeError = validatePageTree(requested.map(fromMcpPage))
      if (treeError) return err(treeError)
      const pages = normalizePageTree(requested.map(fromMcpPage))
      const firstId = canvas.pages?.[0]?.id ?? `${canvas.id}:page1`
      if (canvas.frames.some((f) => !pages.some((p) => p.id === (f.pageId ?? firstId))))
        return err('Move frames before deleting their page')
      const actor = actorFrom(agent_name)
      actions.setCanvasPages(canvas_id, pages, actor)
      return text({ ok: true, pages: pages.map(toMcpPage) })
    },
  )

  server.registerTool(
    'create_frame',
    {
      title: 'Create a frame',
      /* no preview card: in the streaming flow the frame is empty here, and
         a card that shows a blank artboard never updates (append_frame_html
         has no card either). The review screenshot after the stream is the
         first card the person sees. */
      description:
        'Create a new frame on a canvas with an HTML design. A frame is a rectangular artboard that renders a full HTML document (inline <style> and <script> allowed, no external network access needed). If x/y are omitted the frame is auto-placed to the right of existing frames. Everyone viewing the canvas sees it appear live.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        pageId: z.string().optional().describe('Target page ID from get_canvas; defaults to the first page'),
        name: z.string().describe('Frame title, e.g. "Landing hero" or "Pricing card"'),
        html: z
          .string()
          .describe(
            'Complete HTML for the frame body (a full document or a fragment; it is rendered in a sandboxed iframe).',
          ),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional().describe('Default 640 (1280 for a slide)'),
        height: z.number().optional().describe('Default 480 (720 for a slide)'),
        slide: z
          .boolean()
          .optional()
          .describe(
            'Make this frame a slide: the slides of a page play as a deck in present mode. Defaults to 1280×720.',
          ),
        speaker_notes: z
          .string()
          .max(MAX_SPEAKER_NOTES_CHARS)
          .optional()
          .describe('Presenter notes for a slide (markdown); shown in the presenter view, never on the slide.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, pageId, name, html, x, y, width, height, slide, speaker_notes, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const frame = actions.createFrame(
        canvas_id,
        { name, pageId, html, x, y, width, height, slide, speakerNotes: speaker_notes },
        actorFrom(agent_name),
      )
      if (!frame) return noCanvas(canvas_id, 'edit')
      const result = withEscapeNote(
        frame.html.length > 0
          ? textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE)
          : text({ ok: true, frame: frameSummary(frame) }),
        html,
      )
      return withGuidelinesNudge(
        withStatusNudge(withFeedback(result, canvas_id, actorFrom(agent_name)), canvas_id, actorFrom(agent_name)),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'get_frame',
    {
      title: 'Get a frame and its HTML',
      description: 'Get a frame including its full HTML content.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      return withFeedback(
        text({ ...frameSummary(f), ...(f.speakerNotes ? { speaker_notes: f.speakerNotes } : {}), html: f.html }),
        f.canvasId,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'set_frame_html',
    {
      title: 'Replace a frame’s HTML',
      _meta: previewToolMeta('Redesigning the frame…', 'Frame redesigned'),
      description:
        'Replace the HTML design of a frame in one shot. The change renders live for everyone viewing the canvas. For new or heavily reworked designs, prefer append_frame_html so viewers can watch the design stream in.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { frame_id: z.string(), html: z.string(), agent_name: agentName },
    },
    async ({ frame_id, html, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id, 'edit')
      const frame = actions.updateFrame(frame_id, { html }, actorFrom(agent_name), { replace: true })
      if (!frame) return noFrame(frame_id)
      return withPreview(
        withGuidelinesNudge(
          withStatusNudge(
            withFeedback(
              withEscapeNote(textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
              frame.canvasId,
              actorFrom(agent_name),
            ),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'export_frame',
    {
      title: 'Export frame as image',
      description:
        "Get public image URLs (PNG/JPG) rendering the frame's CURRENT design — for publishing it elsewhere: download the URL and upload to a CMS media library, social post, or use directly as og:image. The URL re-renders when the frame changes.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        format: z.enum(['png', 'jpg']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
      },
    },
    async ({ frame_id, format, quality }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      return text({
        image_url: `${env.BETTER_AUTH_URL}/i/${frame_id}.${ext}?scale=2${q}`,
        download_url: `${env.BETTER_AUTH_URL}/i/${frame_id}.${ext}?scale=2${q}&download`,
        width: f.width * 2,
        height: f.height * 2,
        note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
      })
    },
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload an image or stylesheet asset',
      description:
        'Upload an image (png/jpg/webp/gif/svg) or a CSS stylesheet (.css), max 5 MB, and get back a permanent public URL to reference in frame HTML: <img src> or a CSS background for an image, <link rel="stylesheet" href> in the <head> for a stylesheet — use this instead of inlining data: URIs, and upload a shared theme stylesheet once instead of pasting the same large <style> block into every frame. Pick ONE input by where the file lives: (1) remote — pass source_url and the server fetches it; (2) LOCAL FILE — pass local_file=true to receive a one-time upload URL and a ready-to-run curl command, run it in your shell, and the curl response JSON contains the permanent url. (3) data — base64, LAST RESORT for tiny files (under ~100 KB) when you cannot run shell commands; larger base64 payloads are slow and corrupt easily.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        source_url: z.string().optional().describe('Public http(s) URL to fetch the file from (remote files)'),
        local_file: z
          .boolean()
          .optional()
          .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
        data: z
          .string()
          .optional()
          .describe('The file as base64 (raw base64 or a data: URL). Last resort, tiny files only.'),
        canvas_id: z.string().describe('The canvas this asset belongs to'),
        agent_name: agentName,
      },
    },
    async ({ data, source_url, local_file, canvas_id, agent_name }) => {
      const provided = [data, source_url, local_file].filter(Boolean).length
      if (provided !== 1)
        return err(
          'provide exactly one of: source_url (remote file), local_file=true (local file — returns a curl command), or data (small base64)',
        )
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (uploadHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= UPLOADS_PER_MIN) return err('upload rate limit — wait a minute')
      hits.push(now)
      uploadHits.set(limitKey, hits)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: agent_name,
        })
        const upload_url = `${env.BETTER_AUTH_URL}/u/${token}`
        return withFeedback(
          text({
            ok: true,
            upload_url,
            command: `curl -sS -T "<path-to-your-file>" ${upload_url}`,
            expires_at: new Date(expiresAt).toISOString(),
            note: 'One-time upload URL (single use, 15 min). Run the curl command in your shell with your real file path — its JSON response contains the permanent public url to use in frame HTML. Request a fresh ticket for each file.',
          }),
          canvas_id,
          actorFrom(agent_name),
        )
      }
      try {
        const buf = data
          ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
          : await assets.fetchRemote(source_url!)
        const asset = await assets.createAsset(
          buf,
          { canvasId: canvas_id, ownerId, uploadedBy: agent_name },
          { stylesheets: true },
        )
        const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
        const result = text({
          ok: true,
          url,
          mime: asset.mime,
          size_bytes: asset.size,
          usage: assets.assetUsage(asset.mime, url),
          note: 'Permanent public URL — safe to reference in any frame on any canvas.',
        })
        return withFeedback(result, canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image with AI',
      description:
        "Generate an image from a text prompt and store it as a permanent asset on this origin — returns the URL to embed plus a preview you can look at. Use it for visuals stock search cannot supply: brand-specific illustration, a product render, a mascot, abstract hero art in the frame's exact palette. Prefer search_images for ordinary photography. It runs on the connecting human's connected ChatGPT subscription or OpenAI key (else the server's key) and costs them quota or money, so write ONE considered prompt: subject, style, composition, palette hexes, lighting, what to leave out. Generation takes 20–60 seconds. ONLY generate when the design genuinely needs it or the human asked.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        prompt: z.string().describe('What to draw: subject, style, composition, palette, lighting, mood'),
        aspect: z
          .enum(imageGen.IMAGE_ASPECTS)
          .optional()
          .describe('square 1024×1024 (default), landscape 1536×1024, portrait 1024×1536 — match the slot'),
        quality: z.enum(imageGen.IMAGE_QUALITIES).optional().describe('low is fast and cheap; default medium'),
        canvas_id: z.string().describe('The canvas this image belongs to'),
        agent_name: agentName,
      },
    },
    async ({ prompt, aspect, quality, canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (generateHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= GENERATIONS_PER_MIN) return err('image generation rate limit — wait a minute')
      hits.push(now)
      generateHits.set(limitKey, hits)
      try {
        const image = await imageGen.generateImage(ownerId, { prompt, aspect, quality })
        const asset = await assets.createAsset(image.buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
        const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
        capture(ownerId ?? agent_name, 'image_generated', {
          canvas_id,
          aspect,
          quality,
          billed_to: image.billedTo,
        })
        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  url,
                  width: image.width,
                  height: image.height,
                  mime: asset.mime,
                  size_bytes: asset.size,
                  billed_to: image.billedTo,
                  usage: `<img src="${url}" alt="" style="object-fit: cover">`,
                },
                null,
                2,
              ),
            },
            { type: 'image' as const, data: image.preview.data, mimeType: image.preview.mime },
            {
              type: 'text' as const,
              text: 'Preview above — judge it before embedding. If it misses, refine the prompt (say what was wrong) rather than regenerating blind. The URL is permanent and safe to reference in any frame.',
            },
          ],
        }
        return withFeedback(result, canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'image generation failed')
      }
    },
  )

  server.registerTool(
    'search_images',
    {
      title: 'Search stock photos',
      description:
        'Search free stock photography (Pexels) and get back candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame\'s mood, palette and crop. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the returned image_url directly in frame HTML (hotlinking is fine and license-safe), or pass it to upload_asset source_url for a permanent copy on this origin. Always write a real alt text.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('Scene-level description of the photo you want'),
        orientation: z
          .enum(['landscape', 'portrait', 'square'])
          .optional()
          .describe('Match the slot the photo will fill'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, orientation, count, canvas_id, agent_name }) => {
      if (!imageSearch.photoSearchEnabled())
        return err(
          'photo search is not configured on this server (PEXELS_API_KEY is not set) — draw the visual as inline SVG/CSS instead, or ask your human for an image to upload',
        )
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const photos = await imageSearch.searchPhotos(query, { orientation, count })
        if (photos.length === 0)
          return text({ ok: true, photos: [], note: `No results for "${query}" — try a broader or more visual query.` })
        const thumbs = await Promise.all(photos.map((p) => imageSearch.fetchThumb(p.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${photos.length} photo(s) for "${query}" — thumbnails below, pick by number:`,
          },
        ]
        photos.forEach((p, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({
            type: 'text' as const,
            text: `#${i + 1}${p.alt ? ` — ${p.alt}` : ''} (${p.width}×${p.height}, avg ${p.avg_color}, by ${p.photographer})\nimage_url: ${p.image_url}`,
          })
        })
        content.push({
          type: 'text' as const,
          text: 'Embed the chosen image_url directly (<img src> or CSS background, object-fit: cover), or upload_asset with source_url for a permanent copy. Pexels license: free to use and modify, no attribution required.',
        })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'photo search failed')
      }
    },
  )

  server.registerTool(
    'list_backgrounds',
    {
      title: 'List backgrounds',
      description:
        'Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — as a page of thumbnails you look at, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim. Reach for it when a hero or full-bleed section wants atmosphere, depth or a focal glow; a quiet typographic design can stay flat, but a default two-stop gradient is rarely right. Filter by tone (light/dark — match your copy color), slot and style; an optional query ("warm sunset", "dark teal") only reorders. Then decide like a designer: does one of these genuinely fit the frame\'s style and palette? If yes, use it and put the copy in its text_zone. If not, call again with a different filter, or draw the background yourself.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Mood / palette words to put first, e.g. "warm sunset glow" — reorders, never filters'),
        tone: z
          .enum(backgrounds.BACKGROUND_TONES)
          .optional()
          .describe('light = dark copy on it, dark = light copy on it'),
        style: z.enum(backgrounds.BACKGROUND_STYLES).optional().describe('Restrict to one look'),
        slot: z
          .enum(backgrounds.BACKGROUND_SLOTS)
          .optional()
          .describe('Where it goes: hero, section band, or card/bento tile'),
        count: z.number().min(1).max(24).optional().describe('Thumbnails to return, default 12'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, tone, style, slot, count, canvas_id, agent_name }) => {
      if (!backgrounds.backgroundsEnabled())
        return err(
          'the background library is empty on this server — draw the background as CSS (layered radial-gradients with a grain overlay) instead',
        )
      try {
        const listing = backgrounds.browseBackgrounds({ query, tone, style, slot, count }, env.BETTER_AUTH_URL)
        const { results } = listing
        if (results.length === 0)
          return text({
            ok: true,
            backgrounds: [],
            note: 'No backgrounds match the tone/style/slot filters you set — drop one and call again.',
          })
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: backgrounds.listHeadline(listing, query) }]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: backgrounds.describeBackground(r, i) })
        })
        content.push({ type: 'text' as const, text: backgrounds.BACKGROUND_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'background search failed')
      }
    },
  )

  server.registerTool(
    'search_icons',
    {
      title: 'Search icons',
      description:
        'Search 200,000+ open-source UI icons (Iconify: Material, Lucide, Tabler, Phosphor, …) and get hotlinkable SVG URLs for frame HTML. Search one concept per call ("shopping cart", "arrow right") — multi-concept queries return nothing; call once per icon. Results are semantically named ids — pick by name. For company/brand logos use search_logos instead.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('A single icon concept, e.g. "light bulb"'),
        limit: z.number().min(1).max(48).optional().describe('Max results, default 24'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, limit, canvas_id, agent_name }) => {
      try {
        const icons = await imageSearch.searchIcons(query, { limit })
        const result = text({
          ok: true,
          icons,
          ...(icons.length === 0 ? { note: `No results for "${query}" — try a synonym or broader concept.` } : {}),
          usage: imageSearch.ICON_USAGE_NOTE,
        })
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'icon search failed')
      }
    },
  )

  server.registerTool(
    'search_logos',
    {
      title: 'Search company logos',
      description:
        'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (a thumbnail is included when possible so you can confirm the brand), plus open-source vector marks (SVG) for well-known brands. One company per call — for a logo wall, call once per brand. The exact domain ("acme.io") resolves far more reliably than a name ("Acme"). Use for customer-logo walls, "works with" integration rows, testimonial cards, press bars. Mind each result\'s size guidance: favicon-sourced logos are small rasters — never scale them up.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('A single company name or domain, e.g. "vercel.com"'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const { brands, vector } = await imageSearch.lookupLogos(query, count)
        if (brands.length === 0 && vector.length === 0)
          return text({
            ok: true,
            logos: [],
            note: `No logo found for "${query}" — retry with the company's exact domain (e.g. "acme.io"). If that also fails, search a different real brand instead of drawing a placeholder, or ask your human for a logo file to upload_asset.`,
          })
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: `Logo results for "${query}":` }]
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
            content.push({
              type: 'text' as const,
              text: `#${i + 1} — ${b.name} (${b.domain})\nlogo_url: ${b.logo_url}`,
            })
          })
        }
        if (vector.length > 0) {
          content.push({
            type: 'text' as const,
            text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
          })
        }
        content.push({ type: 'text' as const, text: imageSearch.LOGO_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'logo search failed')
      }
    },
  )

  server.registerTool(
    'view_website',
    {
      title: 'View a website',
      description:
        'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use it to study real copy, structure and branding. When the page should appear on the canvas as an editable source frame, use import_webpage instead.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        agent_name: agentName,
      },
    },
    async ({ url, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const site = await viewWebsite(url)
        const result = {
          content: [
            { type: 'image' as const, data: site.screenshot.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text:
                `${site.title || site.finalUrl} — ${site.finalUrl}` +
                (site.description ? `\nMeta description: ${site.description}` : '') +
                (site.shotCropped
                  ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                  : '') +
                `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}`,
            },
          ],
        }
        return result
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'website view failed'),
        )
      }
    },
  )

  server.registerTool(
    'import_webpage',
    {
      title: 'Import an editable webpage',
      _meta: previewToolMeta('Importing the webpage…', 'Webpage imported'),
      description:
        'Import ONE public webpage into a canvas as an editable HTML snapshot. The rendered DOM is captured, scripts/iframes are removed, stylesheets are inlined, and the resulting source frame appears on the canvas for comparison or editing. Use this when a referenced or redesign-target page should be visible to everyone; leave the imported source frame unchanged and make the new design in a separate frame. For inspection without changing the canvas, use view_website.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        canvas_id: z.string().describe('Canvas that should receive the imported source frame'),
        agent_name: agentName,
      },
    },
    async ({ url, canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeImportUrl(url).href
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid webpage URL')
      }
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (importHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return err('webpage import rate limit — wait a minute')
      hits.push(now)
      importHits.set(limitKey, hits)
      try {
        const actor = actorFrom(agent_name)
        const { imported, frame } = await createImportedWebpageFrame({
          canvasId: canvas_id,
          url: normalizedUrl,
          actor,
          includePreview: true,
        })
        if (!frame) return noCanvas(canvas_id, 'edit')

        const preview = imported.preview
        const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
        if (preview) {
          content.push({ type: 'image', data: preview.screenshot.toString('base64'), mimeType: 'image/jpeg' })
        }
        content.push({
          type: 'text',
          text:
            JSON.stringify(
              {
                ok: true,
                frame: frameSummary(frame),
                source_url: preview?.finalUrl ?? normalizedUrl,
                snapshot: 'editable HTML; scripts, iframes and noscript content removed; linked stylesheets inlined',
              },
              null,
              2,
            ) +
            (preview?.description ? `\nMeta description: ${preview.description}` : '') +
            (preview?.shotCropped
              ? `\nThe source page is ${preview.pageHeight}px tall; the preview shows its top 4000px.`
              : '') +
            (preview ? `\n\nVisible source text${preview.textTruncated ? ' (truncated)' : ''}:\n${preview.text}` : '') +
            '\n\nThe editable snapshot is now on the canvas. If it is source material for a separate design, leave it unchanged; if the import itself is the requested deliverable, it is ready to use or edit.',
        })
        const result = { content }
        return withPreview(withStatusNudge(withFeedback(result, canvas_id, actor), canvas_id, actor), canvas_id, [
          frame,
        ])
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'webpage import failed'),
        )
      }
    },
  )

  /* extension tools get the same
     per-session helpers the built-in tools close over */
  const extensionHelpers: McpToolHelpers = {
    ownerId,
    agentName,
    actorFrom,
    canvasFor,
    noCanvas,
    err,
    text,
    textWithNudge,
    withFeedback,
    withStatusNudge,
    frameSummary,
    takeImportSlot: (key) => {
      const now = Date.now()
      const hits = (importHits.get(key) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return false
      hits.push(now)
      importHits.set(key, hits)
      return true
    },
  }
  for (const extension of extensions) extension.registerMcpTools?.(server, extensionHelpers)

  server.registerTool(
    'get_frame_screenshot',
    {
      title: 'Screenshot a frame',
      _meta: previewToolMeta('Rendering the frame…', 'Frame rendered'),
      description:
        'Render a frame and return a PNG screenshot of it — this is how you SEE your design. Always review your work with this after creating or updating a frame, then fix what looks wrong (spacing, overflow, contrast, alignment) and check again. Iterate until it actually looks good, not just until the HTML seems right.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        scale: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Device scale factor: 1 (default) or 2 for a retina-resolution image'),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, scale, agent_name }) => {
      const live = frameFor(frame_id)
      if (!live) return noFrame(frame_id)
      arrive(live.canvasId, agent_name)
      /* a snapshot: an edit landing while Chromium renders must not stamp
         this older image with its newer updatedAt, or the cache would serve
         it as current for the next five minutes */
      const f = { ...live }
      try {
        const png = await renderFrame(f, scale ?? 1)
        /* the ChatGPT card loads this exact image next — serve it from cache */
        primeImage(f, scale ?? 1, png)
        return withPreview(
          withFeedback(
            {
              content: [
                { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: `Screenshot of “${f.name}” (${f.width}×${f.height}@${scale ?? 1}x, html ${f.html.length} bytes)`,
                },
              ],
            },
            f.canvasId,
            agent_name ? actorFrom(agent_name) : undefined,
          ),
          f.canvasId,
          [f],
        )
      } catch (e) {
        return err(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'append_frame_html',
    {
      title: 'Stream HTML into a frame',
      description:
        'Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live. Prefer this over set_frame_html when creating or reworking a whole design. Send the HTML in document order, ONE complete section per call (head+styles first, then the hero, then each following section), roughly 1–4 KB per chunk. Set start=true on the FIRST chunk (replaces any existing content and shows a live "designing…" badge) and done=true on the LAST chunk. End chunks at element boundaries — partial HTML is healed, but a complete section paints cleanly.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        html_chunk: z
          .string()
          .describe('The next piece of HTML, appended to what has been sent so far. Raw markup — never escaped.'),
        start: z.boolean().optional().describe('true on the first chunk — clears the frame and starts the live stream'),
        done: z.boolean().optional().describe('true on the final chunk — ends the live stream'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html_chunk, start, done, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id, 'edit')
      const frame = actions.appendFrameHtml(frame_id, html_chunk, actorFrom(agent_name), { start, done })
      if (!frame) return noFrame(frame_id)
      const result = done
        ? textWithNudge(
            { ok: true, streaming: false, htmlBytes: frame.html.length },
            `Stream complete. ${REVIEW_NUDGE}`,
          )
        : text({ ok: true, streaming: true, htmlBytes: frame.html.length })
      /* nudge only on the first chunk — mid-stream results should stay lean.
         The escape check rides along: the opening chunk decides the stream. */
      const nudged = start
        ? withGuidelinesNudge(withEscapeNote(result, html_chunk), frame.canvasId, actorFrom(agent_name))
        : result
      return withStatusNudge(
        withFeedback(nudged, frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'edit_frame_html',
    {
      title: 'Edit a frame’s HTML in place',
      _meta: previewToolMeta('Editing the frame…', 'Frame edited'),
      description:
        'Make a targeted edit to a frame: exact find-and-replace in its HTML. Use this for small tweaks (copy, a color, spacing, one element) instead of resending the whole document — the change morphs into the rendered frame in place. old_str must appear EXACTLY ONCE in the current HTML (call get_frame first if unsure); include enough surrounding context to make it unique.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        old_str: z.string().describe('Exact text to find in the frame HTML — must occur exactly once'),
        new_str: z.string().describe('Replacement text'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, agent_name }) => {
      const f = frameFor(frame_id, 'edit')
      if (!f) return noFrame(frame_id, 'edit')
      const count = f.html.split(old_str).length - 1
      if (count === 0) return err('old_str not found in the frame HTML. Call get_frame to see the current content.')
      if (count > 1)
        return err(`old_str occurs ${count} times — include more surrounding context so it matches exactly once.`)
      const frame = actions.updateFrame(frame_id, { html: f.html.replace(old_str, new_str) }, actorFrom(agent_name))!
      return withPreview(
        withStatusNudge(
          withFeedback(
            textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'update_frame',
    {
      title: 'Rename, move or resize a frame',
      _meta: previewToolMeta('Updating the frame…', 'Frame updated'),
      description:
        'Update frame metadata: rename it, move/resize it, move it to another page using pageId, make it a slide (slide) or set its presenter notes (speaker_notes; an empty string clears them). Set locked to true to lock the frame on the canvas (humans cannot select, move, resize or delete it from the stage until it is unlocked) or false to unlock it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        pageId: z.string().optional(),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        slide: z.boolean().optional().describe('true makes the frame a slide, false makes it an ordinary frame again'),
        speaker_notes: z.string().max(MAX_SPEAKER_NOTES_CHARS).optional(),
        locked: z.boolean().optional(),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, speaker_notes, ...rest }) => {
      const patch = { ...rest, ...(speaker_notes === undefined ? {} : { speakerNotes: speaker_notes }) }
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (!Object.keys(clean).length) return err('nothing to update')
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id, 'edit')
      const frame = actions.updateFrame(frame_id, clean, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withPreview(
        withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'list_frame_versions',
    {
      title: 'List a frame’s version history',
      description:
        'List the earlier states of a frame, newest first: every design a replace, stream or restore overwrote, with who authored it, when, the frame name in that state and the reason it was filed (agent or human edit, or the state a restore replaced). HTML is not included — restore_frame_version brings a state back, get_frame shows the current one.',
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id, 'edit')
      if (!f) return noFrame(frame_id, 'edit')
      arrive(f.canvasId, agent_name)
      const versions = await persist.listFrameVersions(frame_id)
      return text({
        frame: frameSummary(f),
        versions: versions.map((v) => ({
          id: v.id,
          savedBy: v.savedBy,
          savedByKind: v.savedByKind,
          savedAt: new Date(v.savedAt).toISOString(),
          ...(v.name === undefined ? {} : { name: v.name }),
          ...(v.reason === undefined ? {} : { reason: v.reason }),
          width: v.width,
          height: v.height,
          htmlBytes: v.htmlBytes,
        })),
      })
    },
  )

  server.registerTool(
    'restore_frame_version',
    {
      title: 'Restore an earlier version of a frame',
      description:
        'Put a frame back to one of its earlier states (from list_frame_versions): its HTML and size are restored, and its name when the version recorded one; position stays. The design being replaced is filed as a version first, so a restore can itself be undone. Use it when a human asks for the previous version, or when your own rework turned out worse than what was there.',
      inputSchema: { frame_id: z.string(), version_id: z.string(), agent_name: agentName },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ frame_id, version_id, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id, 'edit')
      const restored = await actions.restoreFrameVersion(frame_id, version_id, actorFrom(agent_name))
      if (restored === null) return err(`no version ${version_id} on frame ${frame_id} — call list_frame_versions`)
      if (!restored) return noFrame(frame_id)
      return withStatusNudge(
        withFeedback(
          textWithNudge({ ok: true, frame: frameSummary(restored.frame) }, REVIEW_NUDGE),
          restored.frame.canvasId,
          actorFrom(agent_name),
        ),
        restored.frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'delete_frame',
    {
      title: 'Delete a frame',
      description: 'Delete a frame from its canvas.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { frame_id: z.string(), agent_name: agentName },
    },
    async ({ frame_id, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id, 'edit')
      const frame = actions.deleteFrame(frame_id, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, deleted: frame.name })
    },
  )

  server.registerTool(
    'create_note',
    {
      title: 'Pin a sticky note',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        'Pin a sticky note (markdown) to the canvas. Pass frame_id to attach it beside a frame — it lands to the left of the frame, level with its top, and travels with the frame when someone moves it. Omit frame_id for a free-floating note (set x/y, or it is placed near the origin). Use notes to explain the intent of a frame, how variants differ, or an open question. A question that needs a decision should still be a comment. Link to a frame from the text with [label](goto:<frame_id>).',
      inputSchema: {
        canvas_id: z.string(),
        text: z.string().describe(`Markdown, at most ${MAX_NOTE_CHARS} characters`),
        frame_id: z.string().optional().describe('Attach the note to this frame'),
        page_id: z
          .string()
          .optional()
          .describe("Page for a free-floating note (attached notes use their frame's page)"),
        color: z.enum(NOTE_COLORS).optional().describe('Default yellow'),
        x: z.number().optional(),
        y: z.number().optional(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, text: markdown, frame_id, page_id, color, x, y, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id, 'edit')
      const actor = actorFrom(agent_name)
      const result = actions.createNote(canvas_id, { markdown, frameId: frame_id, pageId: page_id, color, x, y }, actor)
      if (!result.ok) return err(result.error)
      return withFeedback(text({ ok: true, note: noteSummary(result.note) }), canvas_id, actor)
    },
  )

  server.registerTool(
    'update_note',
    {
      title: 'Edit a sticky note',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Change a sticky note: rewrite its text, recolour it, move it or resize it. Only the fields you pass change.',
      inputSchema: {
        note_id: z.string(),
        text: z.string().optional().describe(`Replacement markdown, at most ${MAX_NOTE_CHARS} characters`),
        color: z.enum(NOTE_COLORS).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        agent_name: agentName,
      },
    },
    async ({ note_id, text: markdown, agent_name, ...rest }) => {
      const found = store.findNote(note_id)
      if (!found || !canvasFor(found.canvasId, 'edit'))
        return (found && tooLow(found.canvasId, 'edit')) ?? err(`no note with id ${note_id} accessible to this account`)
      const patch = Object.fromEntries(Object.entries({ markdown, ...rest }).filter(([, v]) => v !== undefined))
      if (!Object.keys(patch).length) return err('nothing to update')
      const actor = actorFrom(agent_name)
      const result = actions.updateNote(note_id, patch, actor)
      if (!result.ok) return err(result.error)
      return withFeedback(text({ ok: true, note: noteSummary(result.note) }), found.canvasId, actor)
    },
  )

  server.registerTool(
    'delete_note',
    {
      title: 'Delete a sticky note',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: 'Remove a sticky note from its canvas.',
      inputSchema: { note_id: z.string(), agent_name: agentName },
    },
    async ({ note_id, agent_name }) => {
      const found = store.findNote(note_id)
      if (!found || !canvasFor(found.canvasId, 'edit'))
        return (found && tooLow(found.canvasId, 'edit')) ?? err(`no note with id ${note_id} accessible to this account`)
      const result = actions.deleteNote(note_id, actorFrom(agent_name))
      if (!result.ok) return err(result.error)
      return text({ ok: true })
    },
  )

  return server
}

/** Stateless streamable-HTTP MCP endpoint. */
/* what the protected-resource document advertises; ChatGPT requests exactly these */
const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access']

const ANONYMOUS_METHODS = new Set(['ping', 'resources/list', 'resources/read'])

/** True for a single JSON-RPC message that only reads static server metadata. */
export function isAnonymousDiscovery(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const method = (body as { method?: unknown }).method
  return typeof method === 'string' && ANONYMOUS_METHODS.has(method)
}

export async function handleMcpRequest(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
      id: null,
    })
    return
  }
  /* Two ways in, one identity. An agent key (`Authorization: Bearer dpk_…`,
     minted in Settings) is the headless path — Mastra, n8n, CI — where the
     OAuth browser dance has nobody to dance it. It resolves to its owner on
     every request, so revocation and bans bite immediately; a recognised but
     invalid key gets a 401 WITHOUT the WWW-Authenticate pointer, because
     sending a headless client into OAuth discovery helps nobody. Everything
     else falls through to the OAuth gate below. */
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  let session: { userId?: string | null } | null
  if (bearer && isAgentKeySecret(bearer)) {
    session = await verifyAgentKey(bearer)
    if (!session) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: unknown or revoked agent key' },
        id: null,
      })
      return
    }
  } else {
    /* OAuth gate: the 401 + WWW-Authenticate header is what triggers the
       browser approval flow in MCP clients (RFC 9728 discovery). */
    session = await auth.api.getMcpSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  }
  /* ChatGPT re-fetches a rendered card's component template (resources/read)
     without a usable token — after a token rotation, or when an old chat is
     reopened — so gating discovery would strand every card ever rendered.
     The template is static and the resource list carries no user data, so
     those two (and ping) answer anonymously; tools stay behind the gate. */
  const anonymous = !session && isAnonymousDiscovery(req.body)
  if (!session && !anonymous) {
    const origin = `${req.protocol}://${req.get('host')}`
    /* RFC 6750 §3.1: no error attribute when no token was presented; with a
       token that did not validate, invalid_token tells ChatGPT to re-link
       rather than retry. Both the header and `_meta` carry the challenge —
       ChatGPT offers Connect only when it finds it in both. */
    const challenge = [
      'Bearer realm="doop"',
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      `scope="${MCP_SCOPES.join(' ')}"`,
      ...(bearer ? ['error="invalid_token"', 'error_description="The access token is expired or not valid"'] : []),
    ].join(', ')
    res
      .status(401)
      .set('WWW-Authenticate', challenge)
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: this MCP server requires OAuth' },
        id: null,
        _meta: { 'mcp/www_authenticate': [challenge] },
      })
    return
  }
  /* banning revokes browser sessions, but an already-issued MCP token keeps
     validating until it expires — refuse it here so a ban is total */
  if (session?.userId && (await isBanned(session.userId))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'This account has been disabled on this server.' },
      id: null,
    })
    return
  }
  /* A custom (bring-your-own) agent talking to us is the behavior we want to
     grow — instrument it. `initialize` marks a fresh client session (and is
     the only message carrying the client's name); tool calls mark actual use,
     throttled because one design task is dozens of calls. */
  if (session?.userId) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body]
    for (const msg of msgs) {
      if (msg?.method === 'initialize') {
        capture(session.userId, 'custom_agent_connected', {
          agent_client: msg.params?.clientInfo?.name,
          agent_client_version: msg.params?.clientInfo?.version,
        })
      } else if (msg?.method === 'tools/call') {
        captureThrottled(session.userId, 'custom_agent_used', { first_tool: msg.params?.name })
      }
    }
  }
  const owner = session?.userId ? await getUserName(session.userId) : undefined
  const profile = session?.userId ? await getAccessProfile(session.userId) : undefined
  const server = buildMcpServer(owner, session?.userId ?? undefined, profile)
  /* Stateless, and plain JSON rather than an SSE stream per response: no
     tool here sends notifications mid-call, so a stream carries nothing a
     JSON body does not, and JSON is what every client — including ChatGPT's
     narrower template-fetch path, whose Accept the SDK would otherwise
     refuse with 406 — can read. The header is normalised to match. */
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  req.headers.accept = 'application/json, text/event-stream'
  res.on('close', () => {
    /* the client is gone; there is nobody left to report a close failure to */
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('mcp error', e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
}
