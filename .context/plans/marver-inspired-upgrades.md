# Marver-inspired upgrades

Status: built in the feat/marver-upgrades PR.

Source: a feature-by-feature comparison with [Marver](https://github.com/TNEP4/marver) (v0.24.0, Apache-2.0), an agent-native design canvas. Marver renders TSX files from a local repo; doop renders HTML frames stored in Postgres and talks to agents over MCP. The eight items below are the Marver ideas that fit doop's architecture. Marver file paths are cited so the implementer can read the original; read them for the idea only and write doop's own code.

## Shipping

- Everything ships in **one PR**, on one branch (`feat/marver-upgrades`), against this repo's `main`.
- The PR title is the squash commit subject and must pass commitlint. Suggested title: `feat: robust comment anchors, review marks, prototypes and slides, frame history, sharing roles`.
- Commit order inside the branch, so each step builds on the last: 8 → 4 → 1 → 2 → 6 → 3 → 7 → 5. The guide (5) goes last so it documents what actually shipped.
- Gates before opening the PR: `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run test`. Then the manual checks listed under each item, in `bun run dev`.
- **Release:** after the PR merges, release-please updates its "chore(main): release x.y.z" PR (see `.context/RELEASE.md`). Merge that PR; it creates the `vX.Y.Z` tag and the GitHub Release. Nothing in `desktop/` changes, so no `desktop-v*` tag is needed.

## Migrations

Generate each with `npx drizzle-kit generate` into `server/db/migrations`. The newest migration today is `0027`, so these start at `0028`. Migration 0019 stays reserved (see `.context/TECHSTACK.md`).

| Migration              | Item | Change                                                                                                          |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `0028_comment_anchors` | 1, 2 | `comments.anchor` jsonb null, `comments.from_kind` text null                                                    |
| `0029_frame_seen`      | 2    | tables `frame_seen`, `canvas_visits`; `frames.updated_by_user_id` text null, `frames.updated_by_kind` text null |
| `0030_frame_slide`     | 3    | `frames.slide` boolean null                                                                                     |
| `0031_frame_versions`  | 6    | table `frame_versions`                                                                                          |
| `0032_sharing_roles`   | 7    | `canvas_members.role`, `comments.mentions`, tables `canvas_domain_grants`, `canvas_access_requests`             |

Every new column is nullable or defaulted, so the iOS app (`ios/`) and older clients keep working. The iOS app gets no changes in this PR.

---

## 1. Comment pins that survive edits

**Problem.** A comment stores only a CSS path (`comments.selector`, built by `cssPath` in `src/lib/frameRuntime.ts:310`) and a 400-char `snippet`. `doop:locate` (`frameRuntime.ts:500`) runs `document.querySelector(selector)` with no fallback. When an agent edit shifts the DOM, the selector misses or hits the wrong element, and the pin silently disappears or moves to an unrelated element.

**Marver reference.** `src/client/frame-host/inspect.js` (`anchorBundle`, `resolveAnchor`, `match`), `src/client/shell/Comments.tsx` (orphan pins, re-measure).

**Data.**

- New `CommentAnchor` type in `shared/types.ts`, stored in `comments.anchor` (jsonb, null on old rows):

  ```ts
  interface CommentAnchor {
    v: 1
    tag: string // lower-case tag name
    id?: string // element id, if any
    testId?: string // data-testid, if any
    role?: string // role attribute
    ariaLabel?: string
    quote?: string // whitespace-normalised textContent, first 200 chars
    fx: number // click x inside the element, 0..1
    fy: number // click y inside the element, 0..1
  }
  ```

- Keep `selector` and `snippet` exactly as today. `selector` stays the first thing tried, and rows without `anchor` behave as they do now.
- Add `ElementComment.anchor?: CommentAnchor`.

**Capture.** Where the runtime builds `selector: cssPath(el)` (`frameRuntime.ts:334`), also build the anchor from the same element and the click point. Replies keep inheriting the root's anchor (`replyToComment` passes the root's fields through `postComment`).

**Resolve.** Put the matching logic in a pure module, `shared/commentAnchor.ts`, so it can be unit-tested. The runtime inlines it, either by importing it into the bootstrap build or by embedding `fn.toString()`, which is how Marver keeps one copy of the code. `doop:locate` now carries `{ selector, anchor }` and resolves in this order:

1. `querySelector(selector)`. Accept the element only if `matches(el, anchor)` passes: the tags are equal; `role`, `ariaLabel` and `testId` are equal when stored; and when `quote` is stored, the element's normalised text starts with the first 60 chars of the quote or contains a 40-char slice of it.
2. `[data-testid="…"]`, then `matches`.
3. `#id`, then `matches`.
4. Every element with the stored tag, in document order; the first one that `matches` wins.
5. Quote only (no usable tag match): walk the text nodes for the quote and take the innermost element that holds it.

The reply is `doop:located { reqId, rect, how, selector }`, where `how` is `'path' | 'testid' | 'id' | 'scan' | 'text' | null` and `selector` is the found element's current CSS path.

**Self-heal.** When `how` is not `'path'`, the client sends the new selector to the server (`PATCH /api/comments/:id/anchor { selector }`). The server checks canvas access, updates `selector` on the root and its replies, and broadcasts the change. The stored `anchor` is not rewritten. After this, the next load is a fast path hit, and `get_comments` shows agents the current selector.

**Pin placement.** Place the pin at `rect.x + fx * rect.width`, `rect.y + fy * rect.height`, not at the element's corner. Rows without an anchor keep today's placement.

**Orphans.** When resolution fails, the pin no longer disappears. It parks at the frame's top-right corner with a dashed border, and its tooltip reads "The element this was on changed". The thread still opens, replies and resolves normally.

**New MCP tool `add_comment`.** Item 5 tells agents to pin questions on frames, which needs a way to start a thread. The tool takes `{ canvas_id, frame_id, quote?, selector?, text, agent_name }`.

- It requires `quote` or `selector`.
- The server builds an anchor with `quote` set and the tag left empty. Resolution then falls through to step 5.
- `from_kind` is `'agent'` (see item 2).

**Tests** (`tests/commentAnchor.test.ts`, with happy-dom as in `tests/frameRuntimeMorph.test.ts`):

- The path hits when the DOM is unchanged.
- The path is rejected when the element at the path has different text.
- The testid, id and tag-scan fallbacks each recover the right element after a sibling is inserted before the target.
- A quote-only anchor finds the innermost element.
- A rejected match returns null.
- Route test: the self-heal PATCH needs canvas access.

**Manual check.** Comment on a button. Ask an agent to insert a section above it. The pin stays on the button. Then delete the button; the pin parks as an orphan.

---

## 2. "New" and "Needs you" marks, and the `u` key

**Problem.** Agents edit constantly and a canvas can hold dozens of frames, but nothing tells a returning person what changed since they last looked, or which threads are waiting on them. Today the only unread signals are the chat count and the agents-working count in `src/components/SideRail.tsx`.

**Marver reference.** `src/shared/marks.ts`, `src/server/marks.ts`, `src/client/shell/marks-ui.tsx`, and docs/boards-and-folders.md ("what is new, what needs you").

**Data.**

- `frame_seen (user_id, canvas_id, frame_id, seen_updated_at bigint)`, PK `(user_id, frame_id)`, index on `(user_id, canvas_id)`. `seen_updated_at` is the frame's `updatedAt` at the moment the user saw it, not a clock time, so clock skew cannot hide a change.
- `canvas_visits (user_id, canvas_id, baseline_at bigint)`, PK `(user_id, canvas_id)`. Written on a user's first open of a canvas, with `baseline_at = now`. Everything that existed before the first visit therefore counts as seen.
- `comments.from_kind` (`'user' | 'agent'`, null = user on old rows). `postComment` already receives `kind: ActorKind` (`server/actions.ts`, `replyToComment`); store it. Add `ElementComment.fromKind?: ActorKind`.

**Rules** (pure functions in `shared/marks.ts`):

- **New (blue).** The frame was last changed by someone other than the viewer, and `frame.updatedAt > max(seen_updated_at ?? 0, baseline_at)`.
  - `frames.updatedBy` is `actor.name` (`server/actions.ts`, `store.updateFrame(frameId, patch, actor.name)`), a display name that two people can share. So `0029` also adds `frames.updated_by_user_id` and `frames.updated_by_kind` (`'user' | 'agent'`), both text and null.
  - The store sets both on every frame write, from the actor's account and kind. An agent writes with the id of the account its key or session belongs to.
  - The "new" rule compares that id. Frames with a null id fall back to comparing `updatedBy` with the viewer's name.
  - An agent's edit made with the viewer's own key still counts as new. The viewer did not make the edit by hand, so treat it as new when `updated_by_kind` is `'agent'`.
- **Needs you (orange).** The frame has an open, unresolved root thread, the latest message in it is `fromKind === 'agent'`, and the viewer is involved. Involved means one of: the viewer wrote the root, the viewer replied in the thread, the viewer was @mentioned in it (item 7), or the viewer owns the canvas.
- Once the viewer replies, the latest message is theirs and the mark clears.

**Seen when.** A frame counts as seen when any of these happens:

- it is selected;
- it is entered (double-click);
- it is opened by a deep link;
- it is at least 50% inside the viewport for 2 s at zoom ≥ 0.5.

The client batches seen updates, debounced by 1 s, into `POST /api/canvases/:id/seen { frames: { [frameId]: updatedAt } }`. The server keeps the max per frame. `GET /api/canvases/:id/seen` returns the map plus `baseline_at`, and the canvas fetches it on load.

**UI.**

- A blue or orange dot sits on the frame's title bar (`src/components/FrameView.tsx`) and on its row in `src/components/LayersPanel.tsx`.
- A page tab in `src/components/PagesPanel.tsx` shows a dot when any frame on that page is marked.
- Orange beats blue on the same frame.
- **`u` key** (registered through item 4's registry): fly to the next "needs you" frame after the current selection in reading order (item 3's `readingOrder`), across pages. When none is left, fly to the next "new" frame. When neither is left, show the toast "You're all caught up". Flying to a frame marks it seen.

**Tests.**

- `shared/marks.ts` unit tests:
  - the baseline hides pre-existing frames;
  - the viewer's own edit is never "new";
  - an agent reply on the viewer's thread is "needs you", and the viewer's reply clears it;
  - a resolved thread is ignored.
- Route tests: seen writes keep the max; the user must have canvas access.

**Manual check.** Open a canvas. Have an agent edit two frames, then reload: both are blue, and `u` visits them. Reply to an agent's question: its orange dot clears.

---

## 3. Prototype links, a real present mode, and slides

**Problem.** `src/components/PresentMode.tsx` shows one frame and nothing else. Flow connectors (`src/components/FlowOverlay.tsx`) exist only for design-synced frames and cannot be clicked. There is no way to walk a flow or present a deck.

**Marver reference.** `src/client/shell/Play.tsx`, `src/client/stage/main.tsx`, `src/client/shell/play-order.ts`, `src/client/shell/goto.ts`, docs/slides.md, templates/instructions/slides.md.

### Links

- **Attribute.** Any element in frame HTML can carry `data-goto="<frameId>"`. A frame name also works as a fallback: a case-insensitive exact match on the same canvas, where the first frame in reading order wins. The guide tells agents to use ids, which `create_frame` returns.
- **Runtime.** In `frameRuntime.ts`, clicking an element that has a `[data-goto]` ancestor posts `doop:goto { target }` to the parent. This happens only while presenting (the parent sends `doop:mode { present: true }`). On the canvas, links are inert so that clicking an element still selects it. ⌥-click is the exception: it follows the link by flying to the target frame (`requestFlyTo` in `src/lib/store.ts`).
- **Canvas overlay.** Extend `FlowOverlay.tsx` to also draw arrows for `data-goto` links on the current page.
  - Scan each frame's HTML on the server with a cheap regex for `data-goto="…"`.
  - Cache the result per frame `updatedAt`.
  - Arrows are drawn only for the selected frames, or for all frames when the selection is empty and the overlay toggle is on.

### Present mode

- **Order.** `readingOrder(frames)` lives in `shared/readingOrder.ts`, as a pure function. It bands the frames on a page into rows: two frames share a row when their vertical overlap is at least half the shorter frame's height. Rows are sorted top to bottom, and frames within a row left to right.
- **Opening.** `p` opens present mode on the selected frame, or on the first frame of the page when nothing is selected. "Present" in the frame context menu does the same.
- **Navigation.**
  - `→` and `←` step through the reading order.
  - `doop:goto` jumps to its target and pushes the current frame onto a history stack.
  - `Backspace` pops the stack.
  - `Esc` exits.
  - A small toolbar shows the frame name, `n / N`, prev and next buttons, and exit. The toolbar auto-hides after 2 s without mouse movement.
- **One iframe.** Keep one iframe and swap content in place: post `doop:html { html, transition: true }`. The runtime already morphs the DOM in place, so a view transition works inside it. When `transition` is set, the runtime wraps the morph in `document.startViewTransition`. Elements that share a `view-transition-name` in both frames then morph between them. Without view-transition support, the swap uses a 250 ms opacity crossfade.
- **Size changes.** Each frame is scaled to fit the viewport using its own `width` and `height`, which the existing letterbox code already does.

### Slides

- **Flag.** Add `frames.slide` (boolean, null = false) and `Frame.slide?: boolean`. `create_frame` and `update_frame` take `slide`. A slide created without a size defaults to 1280×720.
- **Canvas.** A slide frame shows a "Slide" badge in its title bar. Layers shows its deck number.
- **Slides mode.** When the presented frame is a slide, present mode runs as a deck over the slides on that page, in reading order:
  - `Space`, a click, and `→` advance.
  - The stage is the slide's own size, scaled to fit the screen and never reflowed.
  - The runtime sets `data-sl-play` on `<html>` for the whole show.
  - It removes `data-sl-entered` inside the view-transition update callback, and sets it again when `transition.finished` resolves. The agent's own CSS can then key entrance animations to `[data-sl-entered]`, and they run each time a slide arrives.
- **Not in this PR:** speaker notes, PDF export of a deck, and per-slide build steps.

**Tests.**

- `readingOrder`: rows, ties and overlaps.
- `data-goto` resolution: by id, by name, and missing.
- The runtime posts `doop:goto` only in present mode.
- The runtime toggles `data-sl-entered` around a swap (happy-dom: stub `startViewTransition`).
- Migration and MCP: `slide` round-trips through `create_frame`, `get_frame` and `update_frame`.

**Manual check.** Ask an agent for a three-screen signup flow with `data-goto` buttons. Present it and click through, then press `Backspace` to go back. Ask for a five-slide deck with `slide: true`, and play it with Space.

---

## 4. Keyboard pack

**Problem.** Shortcut handling is spread across `src/pages/CanvasPage.tsx` (around L165), `src/components/Stage.tsx`, `src/components/FrameView.tsx` and `src/components/LayersPanel.tsx`. `src/lib/keys.ts` only exports `MOD_KEY`. Common canvas actions have no key at all: select all, fit selection, copying an image, device sizes, tidying.

**Marver reference.** `src/client/shell/App.tsx` (~L748, device digits), `src/client/shell/tidy.ts`, `src/client/frame-host/inspect.js` (laser), `copyFrameImage` in `src/client/shell/store.ts`.

**Registry.**

- New file `src/lib/shortcuts.ts`. It holds one table of `{ key, mods, when, run }` entries and installs one window `keydown` listener.
- Plain-letter keys never fire while focus is in an `input`, a `textarea`, a `select`, or a `[contenteditable]` element. Key events from inside frame iframes never reach the window, so editing text in a frame is safe.
- Move the existing CanvasPage shortcuts into the table without changing what they do: Delete/Backspace, Esc, ⌘Z, ⌘⇧Z/⌘Y, ⌘C, ⌘V, ⌘D. The Stage zoom keys (⌘0, ⌘=, ⌘-) move too.

**New keys.**

| Key             | Action                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| `⌘A`            | Select every frame on the current page                                           |
| `⇧1`            | Fit all frames on the page (existing `fit` in `Stage.tsx:249`)                   |
| `⇧2`            | Fit the selection (new `fitSelection`, the same math over the selected boxes)    |
| `⇧0`            | Zoom to 100% (the same as ⌘0)                                                    |
| `i` / `⇧I`      | Copy the selected frame to the clipboard as a PNG at 2x / 4x                     |
| `l`             | Toggle laser mode                                                                |
| `c`             | Toggle comment mode                                                              |
| `t`             | Tidy the selection, or the whole page                                            |
| `1` `2` `3` `4` | Device sizes: mobile 390×844, tablet 834×1194, laptop 1280×800, desktop 1440×900 |
| `0`             | Restore the sizes and positions from before the first device key                 |
| `p`             | Present (item 3)                                                                 |
| `u`             | Next frame that needs you, then the next new one (item 2)                        |

**Copy as image.**

- Call `navigator.clipboard.write([new ClipboardItem({ 'image/png': fetch(url).then((r) => r.blob()) })])` with `url = /i/<frameId>.png?scale=2`. Passing the promise, rather than a finished blob, keeps the user gesture valid in Safari and WebKit while the server renders.
- `/i/:id.:ext` (`server/index.ts:344`) accepts only scale 1 or 2 today. Allow `4`, clamped so neither side exceeds Chrome's 16384 px limit.
- On success, show a toast. On failure, the toast says the clipboard was refused.
- Check that this works in the Tauri desktop shell (WKWebView).

**Laser mode.** The parent posts `doop:laser { on }` to every mounted frame. The runtime injects one `<style id="doop-laser">`:

- For depths 1 to 12, `body > * > …` sets `--doop-hue: calc(<depth mod 6> * 60)` and `outline: 1px solid hsl(var(--doop-hue) 80% 55%)`.
- The hovered element gets a 2 px outline and an 8% tint.
- A floating label near the cursor reads `tag · "first 40 chars"`. It flips above the cursor near the bottom edge, and shifts left near the right edge.
- Clicking copies `<frame name> · <cssPath>` to the clipboard, and the frame's title bar flashes "Element path copied".
- `Esc` leaves laser mode.

**Comment mode.** `c` sets a store flag. The next click on an element in any frame opens the comment composer on that element, the same flow as the element toolbar's "💬 Comment" button in `FrameView.tsx` (~L877). The cursor changes while the mode is on, and `Esc` cancels it.

**Device sizes and tidy.**

- The device presets live in `shared/devices.ts`.
- A digit key applies its preset to the selection, or to every frame on the page when nothing is selected. It then tidies and fits.
- The first device key pressed on a page snapshots every affected frame's `{ x, y, width, height }` in the client. `0` restores that snapshot exactly, without tidying, and clears it.
- Each key press is one undo entry (`src/lib/history.ts`). Changes go through the normal frame update path, so other people see them live.
- While a frame is being resized, its width snaps to any preset width within 12 px (`FrameView.tsx` resize handler, `src/lib/snap.ts`).
- **`tidyLayout(frames)`** in `shared/tidy.ts` is a pure function. It lays frames out in `readingOrder` rows, starting from the top-left of the current bounding box. The horizontal gutter is `max(140, 0.12 × widest frame)` and the vertical gutter is `max(96, 0.16 × tallest frame)`. The result is one undo entry.

**Tests.**

- The registry ignores keys typed in inputs, and plain keys don't fire with modifiers held.
- `tidyLayout` positions.
- A device preset then `0` restores positions and sizes exactly.
- `fitSelection` math.
- `/i/:id.png?scale=4` is accepted and clamped.

---

## 5. Agent guide upgrade and resident hardening

**Problem.** `server/guide.ts` (`DOOP_GUIDE`) teaches streaming, review screenshots and quality. It has no bounded review loop and no "show the work first" step, and it says nothing about variants, prototypes, decks, leaving questions on frames, or ending with a link. Separately, `server/resident.ts` interpolates human comment text straight into the model prompt (around L389: `comment: "${c.text}"`). `server/linear/extension.ts` and `server/importer.ts` already label outside content as untrusted.

**Marver reference.** templates/AGENTS-studio.md, and templates/instructions/{discover, wireframe, brand, craft, iterate, review, slides}.md.

**Guide changes in `server/guide.ts`.** Edit the existing sections where they overlap; don't duplicate them.

- **Show the work first.** Before research or long generation, create the frames the work will land in, named for what they will hold, and call `set_status`. Humans see where the work is going within seconds.
- **Discovery** (extends `DESIGN_BRIEF`):
  - Read the canvas, its guides and references before asking anything.
  - Ask at most 5 questions, in one message.
  - When no human is answering, decide yourself and write each assumption into the brief marked `UNCONFIRMED`.
- **Fork, don't overwrite.** For a frame a human has reviewed or approved, put a new idea in a variant frame next to it, named `<name> — B (<the idea>)`, rather than rewriting the original. Version history (item 6) makes overwrites recoverable, but side-by-side variants are how people compare. Retire losing variants by renaming them `Retired: <why>`, or delete them when asked. Align this with the existing "Redesigns — audit first, then two drafts" section.
- **Look sideways.** After fixing a defect, check sibling frames for the same defect.
- **Review, with a budget.** One inspection round, one batch of fixes, then at most one confirmation screenshot. The cap applies to polish only, never to broken function, unreadable contrast, or missing states. Check:
  - every state (empty, loading, error);
  - every width the frame claims to support;
  - both themes, if the design has two;
  - every string, read as a user would read it;
  - every `data-goto` link, which must lead somewhere.
- **Honest reporting.**
  - Verify against the rendered frame (`get_frame_screenshot`), never against the HTML alone.
  - Say what you did not check.
  - List defects you deferred.
  - Say so when you think the concept itself is wrong.
- **Questions go on the frame.** When you need a decision, use `add_comment` (item 1) on the element in question. Never resolve your own question; the human resolves it. These threads drive the "needs you" mark (item 2).
- **End with the link.** Finish every reply with `/c/<canvasId>?frame=<frameId>` for the frames you changed. Lead with the one or two decisions you need from the human.
- **Prototypes** (new section; needs item 3):
  - Link screens with `data-goto="<frameId>"`.
  - Give shared elements the same `view-transition-name` on both frames so they morph.
  - Every interactive element in a flow must lead somewhere or be clearly disabled.
- **Decks** (new section; needs item 3):
  - `slide: true`, 1280×720 by default.
  - Build a deck kit first: a master layout, tones as CSS-variable swaps, the brand's type, one accent.
  - Write the answer in one paragraph, then a slide list of sentences that tells the argument on its own. Put every slide on the canvas early, as its sentence.
  - One idea per slide, and the headline is a full sentence.
  - Use space instead of boxes. Use real images, and use them big.
  - Numbers must be honest.
  - Entrance animations key off `[data-sl-entered]`; whole-show styling keys off `[data-sl-play]`.
  - Review the deck by reading only the headlines in order (a cold read), then by looking at all slides at once and squinting.
- **Version history** (needs item 6): `list_frame_versions` and `restore_frame_version` let an agent roll back its own mistake. Restore, don't rebuild from memory.

**Resident hardening in `server/resident.ts`.** Every place the prompt includes human-written text gets the same treatment: comment text and snippets, thread replies, chat messages, and task feedback.

- Strip control characters and ANSI escape sequences.
- Cap each comment or message at 4096 chars, and mark any cut with `[truncated]`.
- Wrap each item in a fenced block, introduced with the same wording `server/linear/extension.ts` uses for untrusted content (data, not instructions).

Put the sanitiser in one helper, e.g. `untrustedBlock(label, text)` in `server/promptSafety.ts`, and reuse it in Linear and the importer if their wording can be shared.

**Tests.**

- `untrustedBlock` strips control characters and ANSI, caps length, and fences the text.
- `resident.ts` prompt builders use it, checked with a snapshot of a built prompt that contains a hostile comment.
- If a test pins the guide's sections, extend it.

---

## 6. Frame version history

**Problem.** Frames have no server-side history. Undo is a per-client stack of 100 entries (`src/lib/history.ts`) and is lost on reload. It also cannot undo another person's or an agent's edit. `guideline_versions` already shows the pattern this item reuses (`server/db/persist.ts:171`, `MAX_GUIDELINE_VERSIONS = 50`).

**Data.** `frame_versions (id, frame_id, canvas_id, name, html, width, height, saved_at bigint, saved_by text, reason text)`, indexed on `(frame_id, saved_at)`.

- `reason` is one of `'agent' | 'human' | 'restore'`.
- The cap is `MAX_FRAME_VERSIONS = 50` per frame, trimmed at write time the same way guideline versions are.
- Versions are deleted with their frame.
- Copying a canvas does not copy versions.

**When to snapshot.** A snapshot saves the frame's state **before** a change. It is taken through `snapshotFrame(frame, actor, reason)` in the action layer (`server/actions.ts`), before:

- `set_frame_html` / `setFrameHtml`;
- `edit_frame_html`;
- `append_frame_html` with `start: true`, before the frame is cleared;
- a human HTML edit (inline text edit, style panel);
- a restore.

Skip the snapshot when either is true:

- the HTML equals the latest version's HTML;
- the same actor saved a snapshot of this frame less than 2 minutes ago. Track this in memory with `Map<frameId, { at, by }>`, so a burst of edits by one actor becomes one version.

Streaming chunks never snapshot; only the start of a stream does.

**API.**

- `GET /api/frames/:id/versions` returns `{ id, savedAt, savedBy, reason, width, height }[]`, without HTML.
- `GET /api/frames/:id/versions/:versionId` returns the full version.
- `POST /api/frames/:id/versions/:versionId/restore`:
  - snapshots the current state with `reason: 'restore'`;
  - applies the version's `html`, `width`, `height` and `name` through the normal update path, so it broadcasts and lands in undo;
  - logs the activity line `restored <frame name> to the version from <time>`.
- All three routes need edit access. That is canvas access today, and the edit role once item 7 lands.

**MCP.**

- `list_frame_versions { frame_id }` returns the same list as the GET route.
- `restore_frame_version { frame_id, version_id, agent_name }` restores a version.

**UI.**

- "Version history…" in `src/components/FrameContextMenu.tsx` opens a side panel. It lists versions by relative time, author and reason.
- Selecting a version previews it in a sandboxed iframe running `FRAME_BOOTSTRAP`, the way `PresentMode` does.
- A "Restore this version" button restores it.

**Tests.**

- The cap trims to 50.
- Snapshots are coalesced within 2 minutes per actor.
- No snapshot is taken when the HTML is unchanged.
- A stream start snapshots once.
- Restore snapshots first, then applies the version.
- Routes and MCP refuse a caller without access.

**Manual check.** Ask an agent to redesign a frame. Open "Version history", preview the previous version, and restore it. The canvas updates live in a second tab.

---

## 7. View-only and comment-only sharing, domain sharing, access requests, people @mentions

**Problem.** `canvases.link_access` is `'edit' | 'none'` (`server/db/schema.ts:54`). `canAccessCanvas` (`server/access.ts:27`) is a single yes/no, so everyone who can open a canvas can edit it. A client cannot be given a review link without also getting edit rights. A whole company domain cannot be invited. A refused visitor has no way to ask for access. @mentions only reach agent roles (`shared/agents.ts`, `mentionedRoles`). The comment-notifications spec (`.context/specs/comment-notifications.md`) lists people @mentions as a non-goal, pending a picker and a parser; this item builds both.

**Marver reference.** `src/server/share.ts` (`resolveAccess`), docs/sharing.md, `src/server/notify.ts` (mention mail and throttling).

**Roles.** The roles are `'owner' > 'edit' > 'comment' > 'view'`.

- `view` can open the canvas, see frames, comments and presence, follow people, present, and export images.
- `comment` adds creating, replying to and resolving comments.
- `edit` is everything that exists today.

**Data.**

- `canvases.link_access` becomes `'none' | 'view' | 'comment' | 'edit'`. Existing values stay valid.
- `canvas_members.role` is text, not null, default `'edit'`, so existing members keep edit.
- `canvas_domain_grants (canvas_id, domain, role, added_by, added_at)` has PK `(canvas_id, domain)`. `domain` is lower-case with no `@`.
- `canvas_access_requests (canvas_id, user_id, message, at, status)` has PK `(canvas_id, user_id)`.
  - `status` is `'pending' | 'declined'`.
  - Approving a request deletes the row and adds a member.
  - Pending rows expire after 30 days.
- `comments.mentions` is text: comma-joined user ids, in the order they were typed.

**One resolver.** `canvasRole(user, canvas): Role | null` in `server/access.ts` replaces the yes/no logic. It evaluates in order:

1. A banned user gets null.
2. The owner gets `'owner'`.
3. Admin "view as" stays read-only, as it is today.
4. For everyone else, the highest of these wins:
   - workspace membership (`'edit'`, as today);
   - the member row's role;
   - a domain grant that matches the user's email domain, used only when better-auth reports `emailVerified`;
   - the link access floor, which still requires a signed-in account (no anonymous access in this PR).

Helpers built on the resolver: `canView`, `canComment`, `canEdit`, and the existing `canManageCanvas`, which stays owner/admin only. `canAccessCanvas` becomes `canView` and keeps its name as an alias so the change stays small. `hasDurableCanvasAccess` follows the same resolver.

**Enforcement.** Audit every entry point and gate it on the right helper:

- **REST routes in `server/index.ts`.** Frame, page, guideline and memory writes need edit. Comment create, reply and resolve need comment. Reads need view.
- **WebSocket messages.** Frame edits need edit, comment messages need comment, and cursor and presence messages need view. A refused message gets one error reply to that socket and is not broadcast.
- **MCP tools in `server/mcp.ts`.**
  - `get_*`, `list_*`, `export_frame` and `get_frame_screenshot` need view.
  - `reply_to_comment`, `resolve_comment` and `add_comment` need comment.
  - Everything else that writes needs edit.
  - An agent acts as its key's or session's owner, so the same check covers it.
- **Resident agents.** An agent @mention in a comment from a `comment` role user does not queue agent work, because the agent would edit frames. The comment is stored as a normal comment, and the author sees a toast: "Only editors can ask agents to make changes."

**Access requests.**

- The "no access" page offers a "Request access" form with an optional message.
- The owner, and members with edit who can manage sharing, get an email (`server/mailer.ts`) and a live toast if they are online.
- `ShareModal` lists pending requests with Approve (pick a role) and Decline. Declines are silent to the requester.
- Requests are rate-limited to one pending row per user per canvas.

**People @mentions.**

- In the comment composer, `@` opens a picker of people who can view the canvas: the owner, members, workspace members, and people who have already written in its threads. Agent roles stay in the same picker, as today.
- The server re-checks that every mentioned id can view the canvas, and silently drops any that cannot.
- A mention adds that person to the thread's recipients in `server/commentNotifications.ts`, even if they never wrote in it. Their opt-out is still respected.
- A mentioned person who is online sees the pin pulse and a toast.
- Mentioning someone makes the thread count as involving them for item 2's "needs you".
- Update the non-goal in `.context/specs/comment-notifications.md`.

**UI.**

- `src/components/ShareModal.tsx` gets four sections:
  - a link-access select: No access / Can view / Can comment / Can edit;
  - the member list, with a role select per person;
  - domain grants (`@acme.com` with a role);
  - pending requests.
- People below edit get the read-only canvas that admin "view as" already uses: no toolbar, inspector, drag, resize, prompt bar or delete. Comment users keep comment mode and the composer.
- A badge in the header reads "View only" or "Can comment".

**Tests.**

- A resolver table test covers each source alone, the highest of several winning, a banned user, an unverified email with a domain grant, and the link floor with no session.
- Route tests: a view user is refused a frame write, a comment user is refused a frame write but allowed a reply, and an edit user is allowed both.
- A WebSocket refusal is not broadcast.
- MCP: `set_frame_html` is refused for a comment-only owner of an agent key.
- Mentions of a person without access are dropped.
- Approving an access request adds the member with the chosen role.

**Manual check.** Share a link as "Can comment" and open it as a second account: the canvas is read-only and commenting works. Grant `@yourdomain` view. Request access from a third account, then approve it.

---

## 8. Pause frames at rest

**Problem.** A mounted frame stays mounted, and its animations keep running even off screen (`src/lib/frameMounting.ts`, header comment). A canvas of animated frames keeps the main thread busy while panning.

**Marver reference.** `src/client/shell/canvas/sleep.ts`, `src/client/shell/canvas/FrameNode.tsx` (~L179-206). Marver's `backdrop-filter` texture baking (`src/server/bake.ts`) is deliberately **not** ported, because the complexity is too high for the gain.

**Rule.** `shouldSleep(frame, state)` is a pure function in `src/lib/frameSleep.ts`. A frame sleeps when all of these hold:

- it is not selected and not being edited;
- no agent is streaming into it (the working state);
- it is not hovered;
- it is either outside the viewport (beyond `NEAR_MARGIN`), or on screen while the camera is moving.

An on-screen frame wakes 300 ms after the camera stops. Present mode never sleeps. `?awake=1` in the URL turns sleeping off, for comparison and debugging.

**Runtime.** `doop:sleep { on }` toggles one `<style id="doop-sleep">*,*::before,*::after{animation-play-state:paused!important}</style>`.

- It also pauses the frame's own Web Animations: `document.getAnimations()`, remembering which ones were running so only those resume.
- It pauses `<video>` elements that are playing, and remembers them too.
- Both toggles run inside a "still" wrapper: inline `transition-property: none !important` on the root, then a forced reflow, then the change, then the inline style is restored. Authored transitions therefore never fire on sleep or wake.
- Animations driven by `requestAnimationFrame` in JavaScript cannot be paused this way, which is acceptable.

**Tests.**

- `shouldSleep` truth table.
- The runtime adds and removes the style.
- The runtime resumes only the animations and videos it paused itself (happy-dom).

**Manual check.** On a canvas with several animated frames, pan quickly: the animations freeze during the pan and resume after. With `?awake=1`, they never freeze.

---

## What changed from this plan

The plan above is kept as written. These are the places where the build differs from it.

- **One migration.** The schema landed as a single `0028_marver_upgrades` instead of the five migrations `0028` to `0032` listed under Migrations. It also covers sticky notes, nested pages and speaker notes, which the table does not.
- **Anonymous and password links were added.** The plan said "no anonymous access in this PR" and listed both under Out of scope. Sharing now has a signed-out "anyone" audience, capped at comment, with a name prompt and per-IP limits, and a password audience with a signed, per-canvas unlock cookie. MCP stays authenticated-only and password links never admit agents. See `.context/specs/sharing-roles.md`.
- **Speaker notes, presenter window and deck PDF were added.** Slides carry `speaker_notes` (`create_frame` and `update_frame`), the presenter view opens in a window of its own, and **Export deck as PDF** renders one page per slide through `server/deckPdf.ts`. The plan listed all three as "Not in this PR".
- **Sticky notes were added.** `create_note`, `update_note`, `delete_note`, the `note:upsert` and `note:delete` broadcasts and the `N` key to show or hide them. The plan listed them as out of scope.
- **Nested pages were added.** A page can sit under another page (`parent_id` in `set_canvas_pages` and `get_canvas`). It was not in the plan.
- **Prototype arrows are drawn on the client.** The plan scanned frame HTML on the server and cached the result per `updatedAt`. The build scans in `shared/gotoLinks.ts` from the canvas the client already holds, and `K` toggles the arrows for every frame.
- **Keyboard pack grew.** Beyond the plan's table: `?` opens a help dialog listing the registry, `K` toggles link arrows, `N` toggles notes, and `⌘⇧E` exports the selection.
- **Export got an Export button.** A selected frame, and a multi-frame selection, show an Export button on the canvas and in the top bar, and the dialog exports several frames one after another. The plan only had the context menu entry.
- **Version history reads need edit.** Item 7 says reads need view. History is the one exception: listing and previewing versions need edit too, because an old version can hold content the editors have since removed. A viewer sees only the current design.
- **Zoom and compositing fixes were added.** Two fixes outside the plan: frames no longer flicker when zooming (they keep their native size and the world layer is promoted only while the camera moves), and panels and frames no longer corrupt on a large canvas (`src/lib/cameraLayer.ts`, the `chrome-layer` utility and `content-visibility: auto` on frames).
- **Sleep follows the plan.** `shouldSleep`, the 300 ms wake and `?awake=1` shipped as described; the `backdrop-filter` baking stayed out as planned.
- **Untrusted-input framing.** Frame comments, chat and feedback are wrapped as untrusted data in resident agent prompts.

## Out of scope

These Marver features were reviewed and left out on purpose:

- Rendering frames from a repo's real components through Vite. That is a different product; GitHub import (`server/githubRecon.ts`) covers the realistic part.
- The `context/` folder and `context check`. These are repo-documentation tooling.
- Marver Sign In, a central identity issuer. doop already has accounts through better-auth.
- Baking `backdrop-filter` into textures with headless Chrome. See item 8.
- Spawning a local agent CLI from a comment. The desktop app already runs Claude Code locally (`desktop/src-tauri/src/claude.rs`).
- Password-protected and anonymous public links, speaker notes, deck PDF export, and sticky notes. Each can be its own later plan.

## Docs to update in the same PR

- `README.md`: the feature list and keyboard shortcuts.
- `.context/TECHSTACK.md`: one line on frame sleeping, next to the progressive-mount line in section 10.
- `.context/specs/`: add `sharing-roles.md`, a short spec of the resolver and roles, and update `comment-notifications.md` for people @mentions.
- This file: once the PR merges, move it out of `pending/`, or delete it if its content now lives in the specs, and update `.context/plans/INDEX.md`.
