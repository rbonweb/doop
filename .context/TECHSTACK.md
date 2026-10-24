# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.9 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
  `bun run typecheck` uses `tsgo` (`@typescript/native-preview`, the TypeScript 7 Go compiler) for
  speed; the JS `typescript` package serves editors and the ESLint parser.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step, both in dev
  (`tsx watch`) and prod (`NODE_ENV=production tsx server/index.ts`).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell.

## 2. Core Frameworks and Libraries

- Express 4.19.2 - HTTP server framework in `server/`.
- React 18.3.1 - UI framework in `src/`.
- Zustand 4.5.4 - client-side state management.
- Element links use `/c/<canvasId>?frame=<frameId>&selector=<encoded CSS selector>`.
  `src/lib/elementLink.ts` owns copying from the element toolbar and Layers menu;
  `Stage.tsx` focuses its page and frame; `FrameView.tsx` resolves the selector in
  the ready iframe, including script-created elements, and falls back to frame
  details if it no longer resolves. Browser regressions in
  `tests/pageCanvasBrowser.test.ts` cover initial loading, cross-page links,
  clipboard round trips, history and script-created or script-removed elements.
- Radix UI primitives (`@radix-ui/react-*`, ^1.x-2.x) + shadcn 4.19.0 - accessible UI primitives
  generated into `src/components/ui`.
- `@anthropic-ai/sdk` 0.115.0 and `@modelcontextprotocol/sdk` 1.12.0 - power the built-in Doop
  Agent and the MCP server that lets external agents (e.g. Claude Code) design on a canvas.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - primary database.
- drizzle-orm 0.45.2 + drizzle-kit - schema in `server/db/schema.ts` and
  `server/db/auth-schema.ts`; migrations generated via `npx drizzle-kit generate` into
  `server/db/migrations`, applied at boot by `server/db/index.ts` (never by drizzle-kit itself).
- `@electric-sql/pglite` 0.5.4 - embedded Postgres so `bun run dev` works with zero external
  services.
- `pg` 8.22.0 - Postgres driver for the real-database path.

## 4. Canvas Drawing

- Canvas zoom: the camera runs from 8% to 800% (`MAX_ZOOM` in `src/lib/fit.ts`, mirrored by `FOLLOW_MAX_ZOOM`). `Stage.tsx` lays the `.world` out at CSS zoom 1 under a `translate(x, y) scale(zoom)` transform, so a design pixel is a screen pixel divided by the zoom, and `src/lib/cameraLayer.ts` promotes that layer to its own compositor layer only while the camera moves and demotes it once the zoom has drifted, so a pan never re-rasterizes the frame iframes and a settled view is rendered crisp at its own scale. There is no per-frame counter-zoom. From 300% a 1px pixel grid fades in over the frames (full at 500%). Frame names live in a screen-space layer (`FrameLabelLayer`), placed from `--vx`/`--vy`/`--zoom`, so they keep size, gap and crisp text at every zoom.
- `src/lib/tools.ts` defines the tool rail's tools (select, hand, frame, rectangle, ellipse, pen, text, comment) and their keys; every key is registered in the one shortcut registry (`src/lib/shortcuts.ts`, `src/lib/canvasShortcuts.ts`), which also drives the `?` help. `Stage.tsx` delegates drawing
  gestures and world-space previews to `CanvasDrawing.tsx`; Space/middle-button panning takes
  precedence over drawing.
- `src/lib/drawing.ts` creates rectangles, circles, straight and cubic Bézier SVG paths, text and empty
  frames through the existing frame API. Drawing inside a frame appends a positioned HTML/SVG
  layer. Standalone elements use frame persistence with a `data-doop-canvas-element` body marker
  for transparent canvas chrome; no separate shape schema or protocol is required.
- The pen snaps to the nearest anchor on its unfinished path within eight screen pixels,
  highlights the target, and previews a closed curve when approaching the first anchor.
  Alt bypasses snapping. Double-clicking a native path opens `PathEditor.tsx`: anchors and
  Bézier handles can be dragged, and points can switch between corners and curves or be deleted.
  Drawing and editing use 0.75px guide strokes, 5px anchor markers and 4px handle markers at every
  zoom. Invisible 18px editing targets keep the smaller markers easy to grab.
  Each completed edit is one undo step. Alt moves a handle independently; Shift constrains
  its angle. `pathEditing.ts` reads existing line/cubic SVGs, preserves their affine transforms,
  resizes standalone bounds, and refuses to overwrite a concurrently changed path. The editor
  overlays the world canvas while the iframe hides the original through a transient marker.
  It refreshes geometry from the latest store state after saves, undo/redo, and remote changes,
  so an undo issued while a save finishes cannot leave stale anchors in the editor.
  Selecting an anchor or handle does not edit it until the pointer moves two screen pixels.
  Path saves send `expectedUpdatedAt` to the frame PATCH route. The server checks it synchronously
  before writing and returns HTTP 409 with the current frame on a conflict; the editor reloads
  that version without recording an undo step. Frame timestamps advance monotonically, even
  for multiple writes in the same millisecond, so concurrent saves cannot share a version.
  Delayed HTTP save responses cannot replace a newer frame received through the room.
- Saves are serialized, tracked by undo/redo, and scoped to the originating canvas/page. Each
  completed gesture has its own undo entry. The Layers panel shows the drawing's `data-name`.
  Completed saves survive navigation; unfinished drafts are cancelled. Drawing shortcuts leave
  native fields and rich-text editors alone, except for the drawing textarea's save/cancel keys.
- `DrawingMove.tsx` renders an unclipped drag preview and highlights the destination frame.
  The iframe runtime hit-tests the pointer in browser paint order and measures CSS layout
  size separately from transformed bounds. Pending pointer events are buffered until its
  reply, so fast drags and cancellation remain reliable. `src/lib/drawingMove.ts` preserves markup and translates coordinates when
  moving drawings into, between, and out of frames. Transfers save the destination before
  removing the source and use one undo entry; a failed prerequisite leaves the original intact.
  Rollback keeps a detached copy if its content, name, geometry, page, or flags changed after creation.
- A selected element inside a frame is dressed the way Paper draws a selection: a one-pixel
  outline, a square grip in each corner, grabbable unmarked edges, and a `W × H` badge underneath
  (`ElementResizeHandles.tsx`; geometry in `src/lib/elementResize.ts`). A drag opens the runtime's
  style gesture (`styleGesture` begin / commit / cancel in `frameBridge.ts`), previews inline
  `width` / `height` in the live document on every move and commits once on release as a discrete
  undo step, the same properties the Design panel's Size fields write. Pulling a west or north
  side outward still grows the box (flow layout places the element; the drag changes its size,
  never its place). Deltas are measured from the computed size, so a content-box element keeps
  its padding, divided by the element's render scale, and re-anchored while a pinch owns the
  finger. Shift keeps the aspect ratio (letting go puts the other axis back); Esc, or the grips
  leaving mid-drag, cancels. The runtime's hit info carries `sizable` and `locked`, so inline
  text runs, rotated or skewed elements, locked layers, locked frames and the Comment tool get no
  grips. `tests/elementResize.test.ts` covers the geometry and `tests/elementResizeBrowser.test.ts`
  drags the grips in Chromium.
- `tests/drawing.test.ts` covers geometry, serialization and persistence; `drawingBrowser.test.ts`
  exercises the toolbar and gestures in Chromium, including Bézier paths, frame transfers,
  cancellation, mobile input, and coexistence with canvas comment pins and reply fields.
  `tests/drawingMove.test.ts` covers transfer persistence, locks, failed saves and rollbacks,
  creation queued with transfers, and undo/redo. Browser regressions cover transformed shapes,
  stacking contexts, covered shapes, and delayed hit-test replies.

## 5. Security and Secrets

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft /
  Apple sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` / `APPLE_*` client pairs; the iOS app
  signs in with Apple natively against `APPLE_APP_BUNDLE_IDENTIFIER`). Configuration and secrets
  (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, provider client IDs/secrets) come from the
  environment (`.env`, documented in `.env.example`); never committed.

## 6. Build and Dependency Management

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 8 (Rolldown-based) - frontend build tool (`vite build`), with `@vitejs/plugin-react` 6.

## 7. Testing Stack

- Vitest 5 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.

## 8. CI/CD and Delivery

- GitHub Actions:
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint` + `format:check` + `doc-lint`, `build`
    and `test` (four vitest shards) as parallel jobs on push to `main` and on PRs, cancelling
    superseded PR runs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/cla.yml` - CLA check (this is an AGPL-3.0 project with CLA-based
    contribution).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and DMG
    release (tag `desktop-v*`, universal macOS build, optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.
- Deck PDF export (`server/deckPdf.ts`, route in `server/deckRoutes.ts`) renders a page's slide frames through the same `puppeteer-core` Chromium as screenshots, one PDF page per slide at the slide's own size, behind the canvas view gate and a per-account rate limit.
- Response compression is done by the app, not a proxy: `server/compression.ts` serves the hashed bundle and svg/css assets as brotli or gzip, and the canvas WebSocket uses permessage-deflate.

## 10. Frontend Stack

- React 18.3.1 + Vite 8 - SPA, entry at `index.html`.
- Frame iframes mount progressively, nearest the viewport first, and only near the viewport (`src/lib/frameMounting.ts`); a moving camera freezes the set, which is re-evaluated once when the viewport has been still for a moment, so frames never mount mid-gesture; every frame document renders on the app's own main thread.
- The Layers panel mounts only the rows in view (`src/lib/rowWindow.ts`) and defers search with `useDeferredValue`, so a search on a large canvas stays responsive.
- Frames sleep at rest (`src/lib/frameSleep.ts`): while the camera moves or a frame is beyond the near margin, its CSS animations, Web Animations and playing videos are paused through `doop:sleep`; selected, edited, hovered and agent-worked frames and present mode never sleep, and `?awake=1` turns it off.
- The canvas composites GPU-safely: `src/lib/cameraLayer.ts` promotes the world layer only while the camera moves and demotes it only when the zoom drifted (a pan never re-rasterizes the frame iframes), floating UI uses the `chrome-layer` utility (`src/styles.css`) so it keeps one permanent backing store, and frames far outside the view carry `content-visibility: auto` so a large canvas keeps a bounded set of live iframe layers.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `.context/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.
- Home (`src/pages/Home.tsx`, `src/components/HomeHero.tsx`): a 12.5px rail (canvases, workspaces,
  explore, resources, agents, an Ask Doop pill bound to ⌘/), Import + New canvas in the top bar, and
  a hero over the brand's gradient wave: the hopping Disc-D, a greeting, a strip of suggestion chips
  (the "on" chip wears the drifting colour beam from `src/styles.css`) and a composer. A prompt makes
  a canvas named after it (`src/lib/homePrompt.ts`), queues it as the first board card asking for N
  drafts, and opens the canvas; a card that cannot queue rides along as the canvas composer's draft.
  Import makes a canvas and opens it with `?import=1`, which `CanvasPage` turns into the import
  picker. `GET /api/canvases` adds `people` (owner, then members) for the tiles' avatar stacks.
  The rail is `src/components/AppRail.tsx`, mounted by Home, Automations, Integrations, Community,
  Workspace and Admin alike (a page's own group, such as a workspace's panes, goes in as children;
  Settings draws its own rail from the same `ui/dash.tsx` parts); it owns
  the ⌘K search palette (`CanvasSearchModal.tsx`), the connect-an-agent modal, the collapsed
  narrow state (remembered in `localStorage` under `doop-rail`) and the account face at the bottom.
  From another page the rail sends scope picks home as `/?scope=` and new workspaces as
  `/?workspace=new`.

## 11. Developer Experience Tooling

- oxlint 1.x + oxlint-tsgolint (type-aware rules) - lint, config in `.oxlintrc.json`; ESLint 10 with
  the typescript-eslint parser runs only the `process.env` ban in `eslint.config.js`.
- Prettier 3.9.6 - formatting (no semicolons, single quotes, printWidth 120), config in
  `.prettierrc.json`.
- Husky 9.1.7 + lint-staged 17.3.0 - pre-commit hook runs `lint-staged` (`.husky/pre-commit`).
- commitlint 21.2.2 (`@commitlint/config-conventional`) - conventional commit / PR title linting,
  config in `commitlint.config.js`.

## OSS integration scope

The integration registries currently register Linear only. Canvas imports offer websites, live-app
sync and GitHub repositories; frame exports offer PNG/JPG with progress feedback and desktop saving.
Figma, Canva and PSD are deferred. Migration 0019 is reserved for the deferred Figma integration;
the OSS journal skips it while retaining the shared migration tags and timestamps for 0020–0022.
Gemini cloud workers remain an operator-managed, opt-in pilot; see `docs/gemini-cloud-pilot.md`.

## 12. Fork features

- Sharing and roles: `server/access.ts` resolves one role per person per canvas (`owner > edit > comment > view`, or no access) and every REST route, WebSocket message and MCP tool gates through it; `src/lib/role.ts` (`useCanEdit()`, `useCanComment()`) only decides what the UI offers. Share links, password links (`server/linkAccess.ts`), domain grants, access requests and guest comments live in `server/sharing.ts`; see `docs/sharing.md`.
- Review marks: `shared/marks.ts` computes a teal "new" mark (a frame changed by someone else since you last saw it, judged by its content stamp so renames and moves do not count) and an orange "ask" mark (an agent replied in a thread you are in), per frame and rolled up per page. `server/seenRoutes.ts` stores what each person has seen; `MarkDot` and `MarksChip` draw it; comments with no `frameId` never mark.
- Slides and present mode: a frame with `slide` set plays as a 1280x720 deck (`shared/slides.ts`), others as a prototype walked in reading order (`src/lib/present.ts`, `PresentMode.tsx`); `PresenterView.tsx` shows speaker notes, the next slide and a timer, synced across windows by `src/lib/presenterSync.ts`. Hidden frames are skipped. See `docs/presenting.md`; the deck PDF is in section 9.
- Nested pages: a page carries a `parentId` (two levels, `shared/pages.ts`); `PagesPanel.tsx` renders the tree with collapse, drag-to-nest and keyboard navigation, and `set_canvas_pages` takes `parent_id`.
- Sticky notes: markdown notes beside a frame or free on a page (`shared/notes.ts`, `StickyNote.tsx`, `NotesSection` in the Layers panel), in six named colours, linked to frames with `goto:<frame id>`.
- Frame versions carry an extra `name` and `reason` (agent, human or restore) on top of the burst history, and reading or restoring needs the edit role.
- Self-update: `server/selfUpdate.ts` reads the latest GitHub release and, when an admin presses Update now on the Admin page (`VersionCard.tsx`), leaves a request for the host's updater to pull the matching container image.
- Instance controls on the Admin page: invite links and invite-only sign-up (`InvitesCard.tsx`, `server/instanceSettings.ts`) and the model names agents run on (`ModelsCard.tsx`).
