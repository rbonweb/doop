# Agent speed: tools that let agents design instead of working around Doop

Status: proposal, nothing built. Written 2026-11-12 against `main` at `1f0d139` (v0.14.0-fork.1). Every item adds new MCP tools or optional parameters; nothing is removed or renamed.

## Why

A team of agents designed 8 marketing pages (about 60 frames of 100-140 KB, desktop 1440 and phone 390) on one canvas in a day. Most of their time went to working around the tools: re-uploading renders by hand after 429s, re-typing HTML to copy a frame, pulling whole documents to change one heading, cutting screenshots up to check one section, grepping frames one by one, placing frames by hand and overwriting each other's edits.

## Baseline (measured)

Local throwaway server on an M3 Max with headless Chrome 156, loopback only, N=5, a 134 KB marketing page. Raw results and scripts: `/tmp/agent-speed/measure/` (not committed). Production adds a network round trip to every call, so call counts and bytes matter more there than these numbers show.

| Call                                      | Median      | Max         | Response                                                         |
| ----------------------------------------- | ----------- | ----------- | ---------------------------------------------------------------- |
| `create_frame` + 37 × `append_frame_html` | 122 ms      | 137 ms      | 17 KB total                                                      |
| `set_frame_html` (134 KB)                 | 10 ms       | 14 ms       | 2.2 KB                                                           |
| `edit_frame_html` (one heading)           | 7 ms        | 15 ms       | 2.2 KB                                                           |
| `get_frame`                               | 2 ms        | 3 ms        | 144 KB (the whole HTML)                                          |
| `get_canvas` (20 frames)                  | 4 ms        | 4 ms        | 19.8 KB (the JSON twice: 9.5 KB text + 9.0 KB structuredContent) |
| `get_frame_screenshot` 1440 × 4000, 1x    | 1209 ms     | 1243 ms     | 1.09 MB base64 PNG                                               |
| `get_frame_screenshot` 1440 × 4000, 2x    | 1600 ms     | 1617 ms     | 2.5 MB                                                           |
| `get_frame_screenshot` 390 phone, 1x      | 1131 ms     | 1175 ms     | 556 KB                                                           |
| `export_frame` png                        | 3 ms        | 6 ms        | 465 B (a URL; renders nothing)                                   |
| `GET /i/<id>.png` cold / warm             | 1220 / 1 ms | 1232 / 2 ms | 819 KB                                                           |
| `GET /i/<id>.png?scale=2` cold / warm     | 1614 / 3 ms | 1659 / 5 ms | 1.9 MB                                                           |
| `tools/list` (67 tools)                   |             |             | 91.9 KB                                                          |

What the numbers say:

- Every call that does not render takes 2-15 ms. The server is not the bottleneck; renders, round trips and context size are.
- A render costs 1.1-1.6 s (`server/screenshot.ts`: a fresh browser context and page per render, `setContent` up to 8 s, a settle of up to 4 s, every `/a/` image fetched again because a fresh context has no cache).
- 429s come from one place: the `/i/` render budget, 12 renders per IP per rolling minute (`consumeRenderBudget`, `server/previews.ts:129-136`; `PREVIEW_RENDERS_PER_MIN`, `server/env.ts:280`; `Retry-After: 60`, `server/index.ts:592-594`). A signed-in browser session skips it; an agent's `dpk_` bearer counts as anonymous. Measured: request 13 got the 429 after 2.9 s sequential, and 7 of 20 failed at 10 concurrent. Frames that embed another frame's `/i/` image load it from a sandboxed iframe with no session, so they hit the same budget. `get_frame_screenshot` itself is not limited.
- Renders are cached only in memory (5 min, 200 entries, keyed by frame, format, scale and `updatedAt`, `server/previews.ts:25-27`). Full renders are never persisted, nothing renders at save time, and `/i/` sends `Cache-Control: public, max-age=60` with no ETag or 304.
- A full-height screenshot of a 1440 × 4000 page reaches the agent downscaled to about 1568 px on the long side, so a 900 px section ends up about 350 px tall: too small to judge, which is why agents cut screenshots up.
- Every write returns about 2 KB, mostly the same review reminder. `get_guide` returns the whole 43 KB guide whatever topic is asked (`server/mcp.ts:539`).
- No tool copies a frame, edits part of a frame, searches across frames or runs several operations at once. Writes are last-write-wins: `expectedUpdatedAt` exists only on the human PATCH route, and two agents' `set_frame_html` calls overwrite each other silently.

Research notes behind this plan: `/tmp/agent-speed/r1-mcp-tools.md` (every tool), `r2-render.md` (render, cache, limits, assets), `r3-storage.md` (write path, concurrency, reusable code), `r4-docs.md` (library versions: puppeteer-core 25.9.0 supports `clip` and `type: 'webp'`; sharp 0.34.3 crops and writes WebP; `@modelcontextprotocol/sdk` 1.30.0 supports `outputSchema` and image content; parse5 gives source offsets per element).

## How time saved is estimated

Against the real project (8 pages, about 60 frames). An agent turn (one tool call plus the model's reply) costs 5-20 s in practice, against 2-15 ms of server time, so the saving is counted in turns and context, with the measured render cost and the 60 s `Retry-After` added where they apply.

## P1: the biggest savers

### 1. Fast, cached, croppable renders on `/i/`

Change:

- Count a request as authenticated for the render budget when it carries an agent bearer (`dpk_` or MCP OAuth token) with view access to the frame's canvas, as a session already does. Raise the anonymous budget only through the existing env var.
- Accept `?format=webp|png|jpg`, `q` (1-100), `width` (downscale, never enlarge), and a crop in design px (`x`, `y`, `w`, `h`), alongside the existing `scale`. The crop uses puppeteer's `clip`, so a 900 px section of a 4000 px page renders only that region; WebP is encoded by Chromium directly or by sharp.
- Persist each render in byte storage keyed by frame id, content stamp and the normalized parameters, and serve it with a strong `ETag` and `304`. A URL that names the version (`?v=<updatedAt>`, which `export_frame` and the new tools add) is `Cache-Control: public, max-age=31536000, immutable`; a bare URL stays `max-age=60` but revalidates for free.
- Keep one warm, isolated browser context per worker and cache `/a/` responses in it (they are immutable), so a render stops fetching every image again. Optional: pre-render at save time (question 2).

Files: `server/previews.ts`, `server/index.ts` (the `/i/` route), `server/screenshot.ts`, `server/thumbs.ts`, `server/storage.ts`, `server/env.ts`, `shared/exportScale.ts`, `server/mcp.ts` (`export_frame` returns versioned URLs).

Compatibility: every existing `/i/` URL keeps working and returns the same image; the new parameters are optional; anonymous requests keep the budget.

Risks: storage growth (bounded by keeping the latest version per frame and parameter set, swept like thumbs); a crop must clamp to the frame; a warm context could leak state between frames (a fresh page per render stays, only the context and asset cache are shared).

Time saved: removes the curl, crop, cwebp, upload and URL-swap cycle (about 5 turns and 1-3 minutes per image) and every 60 s 429 wait. A warm repeat costs 1-3 ms instead of 1.2-1.6 s. For the project: dozens of store screenshots, roughly 1-2 hours of agent time.

Build: 1 day.

### 2. `snapshot_frame`: a frame region straight to a permanent asset

Change: a new MCP tool that renders a whole frame, a region (`x`, `y`, `w`, `h`) or an element (`element_id` or selector) to a WebP (or PNG/JPG) `/a/` asset and returns its URL, size and bytes. The asset records where it came from: source frame, region or element, the frame version it was taken from, the time and the agent. New nullable columns on `assets` (one additive, idempotent migration).

Files: `server/mcp.ts`, new `server/snapshots.ts`, `server/assets.ts`, `server/screenshot.ts`, `server/db/schema.ts` and a new migration, `server/resident.ts` (same tool for the built-in agent).

Compatibility: new tool; existing assets get null provenance.

Risks: cross-canvas use (a snapshot of canvas A used on canvas B is just an image URL, as uploads are today); asset count growth (snapshots are ordinary assets, swept when no frame references them).

Time saved: one call instead of render, download, crop, convert, upload (5-6 turns per picture), and auditors read the source instead of judging by eye.

Build: half a day after item 1.

### 3. `duplicate_frames`: copy frames byte for byte

Change: a new MCP tool taking a list of `{ frame_id, name?, page_id?, x?, y? }` (up to 50). Each copy gets a new frame id and the source's HTML byte for byte; element ids (`data-doop-id`) are kept, since they are unique per frame and keeping them keeps section labels and links meaningful. Without a position, copies are placed by the layout rule from item 8 (to the right of the source by default). Comments, versions and approval are not copied; slides and speaker notes are.

Files: `server/actions.ts` (reuses the frame copy inside `store.copyPage`), `server/mcp.ts`, `server/pageTools.ts`, `server/resident.ts`, tests.

Compatibility: new tool.

Risks: frames that use components from their canvas stay on the same canvas (copying to another canvas is out of scope, as `move_frame` refuses it today).

Time saved: re-typing a 140 KB frame took several turns, cost about 36k tokens each way, and sometimes came out a byte off. Now one call per batch.

Build: half a day.

### 4. Section-level reading and editing

Change:

- `get_frame` gains `mode: 'outline'`: each section's element id, tag, label (`data-doop-label`, else its first heading), byte size and the first 120 characters of visible text, plus the frame's `<style>` block sizes, without the HTML. With `measure: true` it adds each section's rendered height (one render, see item 5).
- New `get_section(frame_id, target)` returns one element's outer HTML; `replace_section(frame_id, target, html)` swaps it.
- New `patch_frame(frame_id, ops[])`, with ops `set_text`, `set_attr`, `remove_attr`, `set_style` (merges into the inline `style`), `insert_before`, `insert_after`, `remove`. Each op names its `target`; all ops land as one write, one version and one undo step, or none if any target is missing.
- A target is `{ element_id }`, `{ label }` or `{ selector }`. Element ids and labels resolve with the existing parse5 source-offset code (`server/elementIds.ts`). General CSS selectors use `css-select` over `parse5-htmlparser2-tree-adapter` (two small, widely used packages; new dependencies).
- Edits splice by source offset, so nothing outside the target is re-serialized, exactly as element-id stamping already does.

Files: new `server/sectionEdits.ts`, `server/elementIds.ts`, `server/mcp.ts`, `server/actions.ts` (one `updateFrame` per call), `server/resident.ts`, `server/guide.ts`.

Compatibility: `get_frame` without `mode` is unchanged; `edit_frame_html` and `set_frame_html` stay.

Risks: a selector matching several elements (refused unless `all: true`); a target inside a component instance (refused with a pointer to `update_component`); invalid HTML in a replacement (parsed and refused before writing).

Time saved: reading a 140 KB page to change one heading costs about 36k tokens in and the same out; an outline is 2-5 KB and a patch a few hundred bytes. Drafting pages locally and pushing them whole stops being necessary. For the project: hundreds of edits, roughly 2-3 hours and most of the context budget.

Build: 1.5 days.

### 5. `measure_frame` and `lint_frame`

Change:

- `measure_frame(frame_id, { width?, targets? })` loads the frame in the server's Chromium at the given viewport width with the height left to the content. For each target (default: every section) it returns the box, its height, the line count of each text block (from `Range.getClientRects`, grouped by line), whether text overflows or is clipped, the colours in use, and the WCAG contrast ratio of each text colour against its background.
- `lint_frame(frame_id, rules)` runs the same measurement against rules passed in: `max_section_height`, `max_heading_lines`, `max_text_lines` (by selector), `allowed_colors`, `banned_words`, `no_overflow`, `min_contrast`. It returns a pass/fail list with the offending element ids.
- Both read only and count against the existing per-user MCP render limit.

Files: new `server/measure.ts` (built on `inspectFrame` / `loadFramePage` in `server/screenshot.ts`), `server/mcp.ts`, `server/resident.ts`, `server/guide.ts`.

Compatibility: new tools.

Risks: frame scripts run during measurement as they do for screenshots (same sandbox and request guard); fonts must settle first (the existing settle step).

Time saved: replaces cutting screenshots up and guessing with one call per frame. Checking "every section fits 900 px, headings at most 2 lines" across 60 frames goes from about 4-6 turns per frame to one.

Build: 1 day.

## P2

### 6. Screenshots that show what matters

Change: `get_frame_screenshot` gains optional `target` (element id, label or selector), `region`, `format: 'webp'`, and `actions` (a short list of `click`, `hover`, `type`, `wait_for` on selectors, run before the capture, at most 10 steps and 5 s). A new `compare_frames(items[], { layout: 'row' | 'grid', labels })` renders several frames or sections and joins them side by side with labels (sharp `join`).

Files: `server/screenshot.ts`, `server/mcp.ts`, new `server/composite.ts`.

Compatibility: optional parameters and a new tool.

Risks: `actions` run page scripts in the server's Chromium (same sandbox and request guard as today, bounded steps and time).

Time saved: interactive states (tabs, toggles, drawers) become visible, a section is judged at full scale, and "do concepts A and C look different" is one image instead of two downscaled ones.

Build: 1 day.

### 7. Search and bulk work

Change: `find_frames({ page_id?, name?, text?, html?, image_src? })` searches the canvas on the server (names, visible text, raw HTML, image sources) and returns frame ids with short match snippets. `delete_frames(frame_ids, { dry_run })`. `replace_in_frames({ find, replace, regex?, scope: 'text' | 'html', frame_ids? | page_id?, dry_run })` reports every match per frame on a dry run and writes one version per changed frame otherwise. Locked frames are reported, never changed.

Files: new `server/frameSearch.ts`, `server/mcp.ts`, `server/actions.ts`, `server/resident.ts`.

Compatibility: new tools.

Risks: a canvas's HTML must be loaded (the tools load and hold it like every other entry point); a bad replace across many frames (dry run first, and every change is a restorable version).

Time saved: "find every frame showing the banned store" was a separate agent calling `get_frame` 60 times; deleting a dropped concept took eight agents. Each becomes one call.

Build: 1 day.

### 8. Canvas layout helpers

Change: `arrange_frames({ frame_ids | page_id, rows: [{ match: { min_width?, max_width?, name? }, order? }], gap, origin })`, which by default puts desktops in one row and phones in the next with a 300 px gap, as one undo step; `check_layout(page_id, { min_gap })` reports overlaps and gaps below the minimum between frames and notes. The pure geometry in `src/lib/actions/arrange.ts` and `shared/readingOrder.ts` moves to `shared/` so the server can use it.

Files: `shared/arrange.ts` (moved), `src/lib/actions/arrange.ts` (re-export), `server/mcp.ts`, `server/pageTools.ts`, `server/resident.ts`.

Compatibility: new tools; `update_frame` keeps moving frames between pages.

Risks: notes attached to frames must move with them (they are positioned relative to their frame already).

Time saved: agents stop computing coordinates, and overlaps are caught by a call instead of by the owner.

Build: half a day.

### 9. Concurrency: claims and version checks

Change: every write tool gains optional `expected_version` (the frame's `updatedAt`, which every read returns); a mismatch is refused with the current version and who wrote it, instead of overwriting. New `claim_frames(frame_ids, minutes, note)` and `release_frames`; claims show in `get_canvas`, in presence and as a badge on the frame. See question 3 for whether a claim warns or blocks.

Files: `server/actions.ts`, `server/store.ts`, `server/mcp.ts`, `server/index.ts` (room broadcast), `shared/types.ts`, `src/components/FrameView.tsx` (badge), `server/resident.ts`.

Compatibility: writes without `expected_version` behave as today.

Risks: a forgotten claim (claims expire after their minutes, at most 60).

Time saved: lost edits stop happening silently; the redo cost of each collision (re-reading and re-applying a page) goes away.

Build: 1 day.

## P3

### 10. `compose_frame`: a final page from labelled sections

Change: `compose_frame({ name, page_id, width, sections: [{ frame_id, target }] })` builds a new frame from sections of several frames in order (for example A1, C2, E3). Each section brings the CSS it needs: the rules that match it, their keyframes, font faces and custom properties, scoped to that section so rules from different source frames cannot collide (server-side, on `server/componentCss.ts`, the CSSOM-free half of the client's `styleCarry`). Font and token blocks are rebuilt by the normal write path.

Files: new `server/compose.ts`, `server/componentCss.ts`, `server/mcp.ts`, `server/resident.ts`.

Risks: CSS that depends on the source page's structure (a `body > section:nth-child(3)` rule) cannot be carried faithfully; the tool reports such rules instead of guessing.

Time saved: the final page stops being hand-assembled from copied HTML.

Build: 1.5 days.

### 11. Image metadata

Change: `upload_asset` gains optional `source` (`{ kind: 'store' | 'frame' | 'url', name?, url?, frame_id?, region? }`) and `tags`; snapshots fill it automatically (item 2). `get_frame` lists every image the frame uses with its asset id, size, source and tags; `list_assets(canvas_id, { tag?, source? })` finds them.

Files: `server/assets.ts`, the item 2 migration, `server/mcp.ts`, `server/actions.ts` (frame summaries).

Time saved: picture audits read the source instead of judging by eye.

Build: half a day (with item 2's migration).

### 12. Lighter responses

Change:

- `get_canvas` gains `limit`, `cursor` and `fields` (it already takes `page_id`) and lists the hosted-font roster once instead of twice.
- `get_guide` gains `section` and lists its sections; the full guide stays the default.
- Write tools send the review reminder once per frame per session instead of on every write (about 2 KB per write today).
- The text block of a read keeps the payload only when the client is not known to read `structuredContent` (see question 4).
- Errors say what happened: deleting a note removed with its frame says so, not "not accessible".

Files: `server/mcp.ts`, `server/guide.ts`, `server/actions.ts` (note tombstones).

Compatibility: defaults unchanged except the reminder frequency and the error wording.

Build: 1 day.

### 13. `run_batch`: many operations, one round trip

Change: `run_batch({ ops: [{ tool, args }], stop_on_error })`, up to 50 operations of the write and read tools above, run in order through the same handlers, so every access check, limit and version check applies to each one. Returns one result per op.

Files: `server/mcp.ts` (handlers already registered through `registerTool`; the batch calls them by name), `server/toolLoads.ts`.

Risks: a batch must not dodge rate limits (each op counts); nested batches are refused.

Time saved: on a remote server every round trip costs network latency plus a model turn; 20 small fixes become one call.

Build: half a day.

## Delivery

- Each approved item is its own branch from `main` in its own worktree, with a test against a running local instance (the measurement harness in `/tmp/agent-speed/measure/` becomes `scripts/measure-agent-tools.ts`) and the baseline table re-run for that item.
- The agent guide (`get_guide`, topic `doop-instructions`, `server/guide.ts`) gets a section per new tool, and the resident agent gets the same tools under the same names (`tests/agentToolParity.test.ts`).
- Nothing is pushed, deployed or run against production data without the owner's word.

Suggested order: 1 and 3 (a day and a half, the biggest unblockers), then 4 and 5, then 2 and 9, then the rest.

## Questions for the owner

1. Which items to build, and in which order.
2. Render at save time: cache on first request only (cheapest), or pre-render every saved frame in the background (renders ready when an agent asks, at the cost of server CPU on every save)?
3. Claims: advisory (other agents are warned and can still write) or enforced (writes by others are refused until the claim expires)? Version checks refuse stale writes either way.
4. Duplicate payloads: keep sending the JSON in both the text block and `structuredContent` (works for every client), or send a short text summary to clients known to read `structuredContent` (Claude Code), halving every read?
