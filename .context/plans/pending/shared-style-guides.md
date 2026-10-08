# Shared style guides

Status: pending, not started. Nothing here is built yet.
Visual walkthrough (diagram, mockups): https://claude.ai/artifact/VidQkXnoNQSa12TUSGbXsC

## Problem

Style guides (`guidelines`, shown as Memory → Rules) belong to one canvas. A new canvas starts
with none, so a team copies its brand rules and component snippets onto every canvas by hand, and
an edit on one canvas never reaches the others. A team that keeps one design system per brand has
nowhere to keep it once.

## Decisions

These are the defaults this plan is written for. Confirm or change them before starting.

1. **Who edits shared guides:** workspace owners and admins. Every member reads them.
   (Alternative: every member edits.)
2. **Canvases outside a workspace:** the owner's personal space gets shared guides too, edited in
   Settings, read by every canvas the owner keeps there. (Alternative: workspaces only; drop
   every "personal" item below.)
3. **Guides for the whole instance, set from Admin:** not in this plan. One workspace per brand
   covers it.

## Shape

- **Space.** Every canvas has exactly one space: its workspace (`canvases.workspace_id`), or,
  when that is null, its owner's personal space. A canvas with no owner (an unclaimed demo) has no
  space and no shared guides. One helper decides it: `spaceOf(canvas)` returns
  `{ kind: 'workspace', id }`, `{ kind: 'personal', userId }` or `undefined`, and the stored key is
  `ws:<workspaceId>` or `user:<userId>`.
- **Shared guide.** The same `GuidelineDoc` shape canvases use (`name` slug, `title`, `markdown`,
  `updatedAt`, `updatedBy`), stored per space instead of per canvas, with the same limits:
  `MAX_GUIDELINE_CHARS`, `MAX_GUIDELINE_DOCS`, `GUIDELINE_NAME_RE` and `MAX_GUIDELINE_TITLE_CHARS`
  in `server/actions.ts`. No `x`/`y`: a shared guide is not a card on any canvas.
- **Effective list.** What a canvas uses is its own guides plus its space's shared guides, where
  a canvas guide with the same `name` replaces the shared one on that canvas only. Each entry
  says where it came from: `from: 'canvas' | 'workspace' | 'personal'`, and a canvas guide that
  replaces a shared one carries `replaces: 'workspace' | 'personal'`. One function builds it
  (`effectiveGuidelines(canvasId)` in `server/actions.ts`), and every reader an agent depends on
  goes through it. The ones that edit a canvas guide (`setGuideline`, `patchGuideline`, the canvas
  routes) keep using the canvas's own list.
- **Who edits.** Workspace space: `workspaces.hasRole(id, userId, 'admin')`. Personal space: the
  user themselves. Reading: anyone who can open a canvas in that space reads its shared guides,
  through the canvas (a person invited to one personal canvas reads the owner's personal guides on
  that canvas, and cannot open the owner's Settings list).
- **Agents.** MCP `get_canvas`, `list_guidelines`, `get_guidelines`, the unread-guides nudge
  (`withGuidelinesNudge`), `list_canvases`' `guidelinesCount`, the built-in Doop Agent's system
  prompt (`server/resident.ts`, the "Canvas design guidelines" block) and the distiller's context
  (`server/distill.ts`) all read the effective list. `set_guidelines` takes
  `scope: 'canvas' | 'shared'` (default `'canvas'`); `'shared'` writes the canvas's space and is
  refused unless the agent's human may edit it. Agent keys and OAuth sessions act as their owner,
  so the same check covers both.
- **Unread nudge.** A shared edit must reach agents that already read the old version. Today
  `guidelinesSeen` holds `canvasId:agentName`. Change it to remember the newest `updatedAt` the
  agent has read on that canvas, and nudge when any effective guide is newer. That also fixes the
  same gap for canvas guides.
- **Live updates.** A shared change is broadcast to every open room whose canvas is in that space,
  as a new message `{ type: 'sharedGuidelines', name, doc | null, actor }`. It is not written to
  each canvas's activity feed (one edit would flood every canvas). The workspace page and Settings
  re-read on save.
- **History.** Every save keeps a version, capped like canvas guides (`MAX_GUIDELINE_VERSIONS` in
  `server/db/persist.ts`). An empty markdown marks a deletion. Restore = save an old version again.
- **Promote.** "Share with workspace" (or "with your guides" for personal) on a canvas guide
  copies it to the space and deletes the canvas copy, in one action. Refused when the space
  already has a guide of that name, with a message saying so.
- **Memory suggestions.** Accepting a distiller proposal today writes the canvas guide
  (`resolveProposal`). Add an optional target: `{ accept: true, to: 'shared' }` writes the shared
  guide instead, with the same edit check. The proposal card offers both only to someone who may
  edit the space.
- **Moving a canvas** (`PUT /api/canvases/:id/workspace`, `store.setWorkspace`). The effective
  list follows the new space with no copying. After the move, send the room the new space's shared
  guides so open tabs redraw.
- **Copying a canvas** (`store.duplicateCanvas`, used by `/api/canvases/:id/duplicate` and
  `server/community.ts`). When the copy lands in a different space from the source, add the
  source's shared guides it was using (not the replaced ones) to the copy as canvas guides,
  stopping at `MAX_GUIDELINE_DOCS`, so it keeps its look. A copy in the same space adds nothing.
- **Deleting a workspace** (`deleteWorkspace`) detaches every canvas to its owner. Before that,
  add the workspace's shared guides to each canvas as canvas guides (same rule as a copy), then
  delete the shared rows and their history. Nothing loses its look.

## Data

One additive migration, generated with `npx drizzle-kit generate` (lands as the next number after
`0025_live_activities`), applied at boot as usual. Existing `guidelines` rows are untouched.

- `shared_guidelines`: `space_id text`, `name text`, `title text null`, `markdown text`,
  `updated_at bigint`, `updated_by text`; primary key `(space_id, name)`.
- `shared_guideline_versions`: `id text pk`, `space_id`, `name`, `markdown`, `saved_at`,
  `saved_by`; index on `(space_id, name)`.

Hydrated into memory at boot with the rest (`server/db/persist.ts` load path), held by the store
as `Map<spaceKey, GuidelineDoc[]>` with `getSharedGuidelines`, `setSharedGuideline`,
`deleteSharedGuideline`, written through the same way canvas guides are (`saveGuideline` and
friends). Deleting a canvas does not touch shared rows.

## API

- `GET /api/workspaces/:id/guidelines`: member. Each guide with how many canvases in the
  workspace use it and how many replace it.
- `PUT /api/workspaces/:id/guidelines/:name` with `{ markdown, title? }`: admin+. Empty markdown
  deletes. Same validation errors as the canvas route.
- `GET /api/workspaces/:id/guidelines/:name/history`: member.
- `GET /api/me/guidelines`, `PUT /api/me/guidelines/:name`, `GET /api/me/guidelines/:name/history`:
  the personal space.
- `POST /api/canvases/:id/guidelines/:name/share`: promote, with the space's edit check.
- `POST /api/canvases/:id/proposals/:pid` gains optional `to: 'shared'`.
- The canvas payload (the HTTP read and the room's hydrate message in `server/index.ts`) gains
  `shared: { space: { kind, id?, name }, docs: GuidelineDoc[], canEdit: boolean }`. `canEdit` is
  for the viewer, so the client can show or hide the edit links.

Workspace routes live with the rest in `server/workspaces.ts` and use `requireWorkspace(req, res,
id, 'admin')` for writes.

## Client

- `src/lib/api.ts` and `shared/types.ts`: the routes and types above, plus the
  `sharedGuidelines` socket message in `src/lib/ws.ts` and its store setter in
  `src/lib/store.ts`.
- `src/components/MemoryPanel.tsx`, Rules: a "Shared from <workspace>" group (or "Your guides")
  above "This canvas". A replaced shared guide is struck through with a "Replaced here" chip; the
  canvas guide replacing it carries "Overrides shared". Opening a shared guide shows it read-only
  with an "Edit in workspace" link when `canEdit`. A canvas guide's modal gets "Share with
  workspace" when `canEdit`. Proposal cards offer "Add to shared rules" beside "Add to rules" when
  `canEdit`.
- `src/pages/Workspace.tsx`: a fourth pane, `'guides'`, labelled Style guides (People, Style
  guides, Billing, General). A list with each guide's version, canvases using it and last edit,
  "+ New guide" for admins, and the same editor and history modal the canvas uses, reused from
  `MemoryPanel.tsx` rather than copied.
- `src/pages/Settings.tsx`: a Style guides section for the personal space, same components.
- Follow `.context/DESIGN.md` and the existing `src/components/ui` primitives; no new colours.

## Out of scope

- Linked components (frames that update when an original changes). Frames stay independent HTML.
- Instance-wide guides set from Admin (decision 3).
- Rewriting existing frames when a guide changes. An agent does that when asked.
- Gemini cloud workers (`server/geminiCloudMcp.ts`): check whether its run-scoped tools read
  guidelines. If they do, route them through `effectiveGuidelines` too; if not, leave them.

## Tasks

Test-first: write each test, watch it fail, then build. Tests start their own server with
`startServer(port, env)` from `tests/harness.ts`; pick ports nothing else uses (`grep -rn
startServer tests`; 4961 to 4969 were free when this was written, and 4977 is already contended).

1. **Space and storage.** Test: a shared guide saved for a workspace survives a restart and is
   listed by `GET /api/workspaces/:id/guidelines`; a member gets 403 on PUT, an admin 200; a
   non-member 404. Build: schema, migration, persist, store, `spaceOf`, workspace routes.
2. **Effective list.** Test: a canvas in the workspace reads the shared guides with
   `from: 'workspace'`; a canvas guide of the same name replaces it there only, with
   `replaces: 'workspace'`; another canvas still reads the shared one. Build:
   `effectiveGuidelines`, the canvas payload's `shared`.
3. **Agents.** Test (`tests/mcp-tools.test.ts` style): `get_canvas` and `list_guidelines` list
   shared guides with `from`; `get_guidelines` reads one; `set_guidelines` with `scope: 'shared'`
   works for an admin's agent and is refused for a member's; the nudge fires again after a shared
   edit the agent has not read. Build: the MCP changes, the `guidelinesSeen` change, `resident.ts`,
   `distill.ts`, and the text in `server/guide.ts` that tells agents about guidelines.
4. **Live updates.** Test: a socket joined to a workspace canvas receives `sharedGuidelines`
   when an admin saves; a socket on a canvas in another space does not. Build: the broadcast.
5. **Move, copy, delete.** Test: moving a canvas switches its shared guides; copying into a
   personal space adds the used shared guides as canvas guides and copying within the workspace
   adds none; deleting a workspace leaves each detached canvas with the guides as its own. Build:
   the three hooks.
6. **Promote and proposals.** Test: promoting moves a canvas guide to the space and refuses a name
   the space already has; accepting a proposal with `to: 'shared'` writes the shared guide and is
   refused without the edit right. Build: the route and the `resolveProposal` option.
7. **Personal space** (only if decision 2 stands). Test: `/api/me/guidelines` round-trips; the
   owner's personal canvases read them; a collaborator on one of those canvases reads them there
   and gets 404 on `/api/me/guidelines` for someone else. Build: the routes and the Settings
   section.
8. **UI.** Memory panel groups and chips, the Workspace pane, Settings. Check light and dark, and
   the Workspace pane at phone width.
9. **Docs.** `README.md` "Design memory" bullet, `server/guide.ts` agent text,
   `.context/specs/` (write the shipped spec, `shared-style-guides.md`, and list it in
   `.context/specs/INDEX.md`), then move this file out of `pending/` and update
   `.context/plans/INDEX.md`.

## Done when

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build` and `bun run test`
  pass (the known 4977 port collision aside).
- On a running instance: an admin writes a Components guide on the workspace page; a second
  canvas in the workspace shows it in Memory without a reload; Claude Code over MCP lists it with
  `from: "workspace"` on both canvases; a canvas guide named `components` replaces it on one
  canvas only.
- Commits are authored and committed as Rohit Bhadani <bhadanirohit1@gmail.com>, with no Claude
  co-author or session lines, and land on `main` of `rbonweb/doop` (each push to `main` that
  passes CI becomes a release).

## Prompt to start it

Paste this into Claude Code in a checkout of `rbonweb/doop`:

> Build the pending plan in `.context/plans/pending/shared-style-guides.md`. Read it, and
> `.context/INDEX.md`, before writing code. Use the decisions as written unless I say otherwise
> here: [keep the defaults / change: ...]. Work test-first through the Tasks in order, run the
> checks in "Done when", then commit as Rohit Bhadani <bhadanirohit1@gmail.com> with no Claude
> co-author or session lines, and push to `main`.
