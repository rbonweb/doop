# Components

One design used in many places. People make them from any element; agents make, use and change them
through tools, and read them back in a short form.

## Problems and decisions

| Problem                                             | Decision                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agents redraw components                            | Catalog in `get_canvas` and the resident prompt; a note when a write has lookalikes |
| Component payloads are expensive to read            | `get_frame` returns `<doop-use>`; the full form is opt-in                           |
| Override ID paths are intricate                     | Attributes are props; part-keyed overrides are there when needed                    |
| Agents read pre-override values                     | Instances read back with their real props and overridden parts                      |
| Errors found only in a screenshot                   | Unknown names and values come back in the write's result, with what is valid        |
| Markup or CSS dropped without a word                | A binding on `<doop-use>` and CSS rules not kept are named in the result            |
| Inferred props named `text`, `text-2`               | Named by what the element is, and listed in `create_component`'s result             |
| Edits break the link, or get thrown away            | Any edit becomes the narrowest override that holds it; no detach needed             |
| Sweeping edits have unknown blast radius            | `update_component` reports impact, with `dry_run`                                   |
| Variant explosion                                   | An enum prop is `data-<name>` on the root, and variants are CSS                     |
| Canvases that grew without components               | `create_component` + `replace_matching` retrofit them                               |
| Components disconnected from code                   | Optional `code` mapping; compact form reads like JSX                                |
| Libraries silently change consumers, or are one-way | Linked copies; updates shown, pulled on request                                     |

## Model

Instances are **materialized**: the frame's HTML holds the full markup. Everything that reads frame HTML
(iframes, thumbnails, PDF and image export, comments, Layers) works unchanged, and a deleted
component loses nothing visually: deleting writes no frame at all (see Deleting and restoring).

- **Main**: an element with `data-doop-component="<id>"`. Editing it with any tool edits the component.
  A copy of a main elsewhere becomes an instance. If it disappears the component lives on with no main;
  a marker coming back (undo, restore) reclaims the role, and an update writes a new main.
- **Definition** (`components` table, mirrored on `canvas.components`, keyed per canvas so a copied
  canvas's markers stay valid): `template`, scoped `css`, `rawCss`, `head`, `props`, `slots`, `rev`,
  `mainFrameId`, `code`, `source`, and the last 20 revisions inline.
- **Prop types** (`PROP_TYPES`): `text`, `image`, `link`, `enum`, `boolean`, `number` (`min`, `max`, `step`), `color` (hex, `rgb()`/`hsl()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()`, named colours, `transparent`, `currentColor`, `var(--token)` with an optional fallback, `color-mix()`; anything holding `url(` is refused) and `instance` (a component named in `accepts`, any component when empty). Values are strings; `propValueProblem` in `shared/components.ts` checks them for the engine, `update_instances`, `insert_instance` and the Design tab, and a bad value on a `<doop-use>` is an `invalid_prop_value` naming what is allowed. Booleans stay lenient (any value but `"false"` is on), so old compact frames round-trip unchanged.
- **Booleans on attributes**: a `boolean` prop bound to an HTML boolean attribute (`disabled`, `checked`, `hidden`, `open`, …) writes `attr=""` when on and removes it when off; reconcile reads a removed attribute or a stored `"false"` as off. Other attributes (`aria-pressed`) keep the value string. `reflect: true` also puts `data-<name>` on the root, a variant for CSS like an enum's (`variantAttrs`). The fix needs the prop declared `type: boolean`; an undeclared `disabled:disabled` binding stays a text prop.
- **Text bindings keep siblings**: a bound text prop replaces only the element's own text nodes, so `<a><svg/>Label</a>` keeps its icon. An old instance whose earlier render had wiped such a sibling re-saves with that sibling as a `hidden` override, since old data cannot be told from a deliberate delete.
- **Swap** (`PartOverride.swap`, a component id): one instance renders a nested `<doop-use>` part as another component. Which component renders: the part's `swap`, then a forwarded `component:` prop, then the template's literal; props the new component lacks are dropped, same-named ones carry over. Reconcile records a swap when the nested rendered component differs from that and drops it when it matches again; a cycle or unknown target renders the template's component with an issue. `update_instances` takes `swap: { part, component | null }`. Slot content is the instance's own markup, so it needs no swap.
- **Duplicate and detach**: `duplicate_component` copies a definition under a new id and a unique `<name> copy` name, history reset to rev 1, `code` kept, a new main beside the source's (else on the Components page); a linked library component duplicates into a local one. `detach_from_library` keeps the id, so every instance stays linked, drops `source.library` and writes a local main; library updates stop arriving.
- **Code mapping** (`ComponentCode`, `shared/componentCode.ts`, checked by `validCode` in `server/componentCodeMap.ts` on create and update against the component's real props and slots): the legacy `path`, `name`, `snippet`, plus `importFrom`, `exportName`, `defaultExport`, a `props` map (code name, enum and boolean value maps, `omit`, and `component: { importFrom? }` for an enum whose values are components passed by reference, such as an icon prop: each value is the component's export name, `values` renames one), a `slots` map (`children` or a code prop) and `origin` (`manual`, `storybook`, `cli`, `agent`). `get_component` and writes return it whole; `list_components` shows only `importFrom` and `exportName`. Library publish, pull and restore copy it as stored. Components that arrive through a Storybook or the CLI keep `code.origin` and are described in [react-import.md](react-import.md).
- **Instance**: root attributes `data-doop-instance`, `data-doop-rev`, `data-doop-id`, and when needed
  `data-doop-props` / `data-doop-overrides` as JSON. Every element keeps its `data-doop-part` key.
  Slot content and nested instances are read from the DOM, not repeated in the marker.
  A nested instance's id is derived from its owner's id and part key, so it stays the same across
  renders and through the short form without being stored. Detaching leaves `data-doop-detached-from`
  on the root and a frozen copy of the component's CSS scoped to it, one per revision per frame.
- **Template markup**: `data-doop-prop` binds text, attributes, styles and custom properties;
  `data-doop-if` makes elements conditional; `data-doop-slot` / `data-doop-slot-suggest` declare slots.
  Enum props exist only in the definition and set `data-<name>` on the root. Nested components are
  `<doop-use>` by id, so a rename cannot break them. Prop forwarding: `data-doop-prop="inner:outer"` on a nested `<doop-use>` hands the outer component's prop `outer` to the nested prop `inner` (`component:icon` lets an `instance` prop pick which component renders). It is live only when the outer prop is declared or derived (derivation copies the nested prop's type, options, limits or `accepts`; `component:` makes an `instance` prop accepting the literal). Precedence: the outer instance's own override of that nested part, then the forwarded value (its override, else the prop's default), then the attribute the template wrote; with no forwarded value the nested instance renders as it always did. Reading an instance subtracts forwarded and literal values from the nested state, and retyping a forwarded value inside an instance sets the outer prop. `data-doop-if` on a `<doop-use>` shows or hides it. In a main the nested instance element carries both attributes (`CARRIED_ATTRS`) so reading the main back keeps them. `data-doop-slot` and other template attributes mean nothing on a `<doop-use>`: they are dropped with an `ignored_attribute` issue that says what to write instead.
- **Per-attribute conditions**: `data-doop-attr-if="data-no-visuals: trailing-visual!=SearchIcon & !quiet; title: titled"` (`parseAttrConditions` in `shared/components.ts`) keeps an attribute the template writes literally only while every condition of its entry holds (`;` between entries, `&` between conditions, `\;` `\&` `\\` escape inside a value, same grammar as `data-doop-if`). It only ever removes the named attribute from the rendered element, never adds one; the marker is stripped from rendered instances like `data-doop-if`, a read-back never takes the attribute for an override (it follows the props), an entry that does not parse is ignored (its attribute stays), and a main keeps it. The React export writes it as `name={cond ? value : undefined}`.
- **Inferred props** (`inferBindings`, only for markup with no `data-doop-prop` of its own): leaf text,
  image sources and link targets. A name comes from `data-name`, else the last class that is not a
  utility class, else what the element or its nearest ancestor is (`h1`-`h6` title, `button` / `a`
  label, `img` image, `li` item, otherwise text); a link's target is `link` or `<name>-link`.
  `create_component` lists them as `inferred_props`.
- **CSS**: the server has no CSSOM, so rules are matched on what their selectors name, over-keeping occasionally. A rule whose subject is inside a nested component is kept when its selector reaches there from one of the component's own elements (`.plan .btn`), and applies inside this component's instances only; a bare `.btn` is the nested component's to carry. Rules passed as `css` to `create_component` / `update_component` that were not kept come back as a `css_not_kept` issue naming their selectors. CSS scoping: a component's rules are scoped with `:where([data-doop-instance="<id>"])`, which adds no specificity, and a selector's subject also carries `:not(:where(<scope> [data-doop-instance]:not(<scope>) *))`, so a rule of one component never matches inside an instance of another component nested in it (zero added specificity, no `@scope`, works in every browser). The documented exception stays: a rule whose subject is a nested component's element reached from one of this component's own (`.plan .btn`) styles it inside this component's instances only. A sibling combinator after the root (`.card + .card`) is scoped inside the instance only, never to the root's next sibling. Inherited declarations (font, colour) from `html` / `body` / `:root` still land on the instance root. Stylesheet links and the Tailwind CDN script are carried as `head`.

Custom properties the main's frame declares are no longer copied onto the root as values: every `var(--x)` the component uses, in its scoped css and in its template's inline styles, gets the main's value as a fallback, `var(--x, <value>)` (values naming other properties get theirs too), so a consuming frame that defines `--x` on `:root`, or a token theme switch, wins, and a frame that does not renders like the main. Canvas tokens are never copied (they are live through the frame's token block). `rawCss`, the main's own stylesheet, is unchanged.

Frame isolation: a frame's own rules no longer match component-owned elements inside an instance. Every `<style>` of the frame (not a managed block, not a stylesheet inside a main or instance) gets `:not(:where([data-doop-instance] [data-doop-part]):not(:where([data-doop-component] *)))` on each rule's subject (elements of instances nested inside a main are left to the main's own frame, so a main renders the same as its instances) (`server/frameIsolation.ts`, written by `prepareFrameHtml` after the head is synced, so every renderer sees it). Component-owned elements wear `data-doop-part`; slot content does not, so frame rules keep styling what a person put in a slot, and the instance root itself is still laid out by frame rules (margin, grid placement, width). Inherited and custom properties flow in from the frame as before. Agents and the HTML read-back never see the exclusion (`compactDocument` takes it off), and saving either form gives the same stored bytes.

Old content: the isolating form is marked by `/* doop-scope:2 */` as the first line of a definition's css. A definition stored without it, and every frame holding only such instances, keeps its bytes and its pixels: `prepareMains` compares a stored definition with its main in the form it was written in, so an unchanged main opens no revision and stays unmarked. The first change to the main extracts it in the isolating form (a new revision), its instances upgrade, and a frame holding one of them is isolated from then on.

The decision is per frame, not per instance: one instance of a new-form component in a frame isolates every rule of that frame, which also stops them reaching that frame's older instances (their pixels change on that save). Removing the new instance leaves the stored exclusion in place (harmless; an agent write reads the text without it and writes it back without it, so the stored form then loses it too).

The stored exclusion is read back without it by `get_frame` (also with `expand_components`), `find_frames`, `frameStylesheets` and the React export; the Inspector's HTML editor, Copy HTML and Download HTML still show the stored form (it is valid CSS, idempotent on write-back, and the downloaded file keeps its `data-doop-*` attributes so it renders the same).

Frame `<style>` elements are found by parse5 source offsets, so a script string, a comment or a template never has its text rewritten.

## List props

A component can repeat an element once per item of a `list` prop.

A list prop has `fields`: a record of field name to `{ type }`, the type being `text`, `link`, `image` or `boolean`, at most 12 fields, each named like a prop (`[a-z][a-z0-9-]*`, so `data-doop-prop` bindings and `data-doop-if` conditions can name it; `constructor` and `prototype` are refused).

Its value is an array of items, one value per field, stored in `data-doop-props` as JSON text (key-sorted, `<` and `>` escaped as `\u003c` and `\u003e`, so the same items always write the same bytes and no angle bracket reaches the marker).

At most 100 items and 200,000 characters; a text field takes up to 4,000 characters; a link or image field passes the same address guard as a link or image prop; a boolean is `true` or `false` (the strings "true" and "false" are read too).

`readList` and `propValueProblem` in `shared/components.ts` are the one check. A value that is not JSON, not an array, too long or with a bad field value is refused with an `invalid_prop_value` issue that names the fields and limits and never quotes the value, and the prop's default shows. A field the list does not declare is dropped with a `list_field_dropped` issue.

The template marks one element with `data-doop-each="<list prop>"`. It is the template of one item. Inside it (the element itself included) `data-doop-prop`, `data-doop-if` and `data-doop-attr-if` name the item's fields first, then the component's props: a field shadows a component prop of the same name, and a field an item leaves out is empty (a text clears, an address attribute is removed). The each-element's own `data-doop-if` is the exception: it gates the whole list and reads component props. The root cannot repeat, a list inside an item is an ordinary element, and slots inside an item are not supported.

Declaring: `props: [{ name: "links", type: "list", fields: { label: { type: "text" }, url: { type: "link" } }, default: "[…]" }]`. Not declared, the prop and its fields are inferred from the each-element's bindings (an `src` binding is an image, `href` a link, a condition a boolean, anything else text). An item that also reads component props needs the fields declared, since inference takes every name inside the element as a field. A declared default is canonicalised.

Render: an instance renders the each-element once per item, in order. Each copy carries `data-doop-item="<index>"`, every part key in it is `<template key>-<index>`, and a nested `<doop-use>` in it gets an id derived from its owner and that key, so ids are stable. Zero items renders nothing. An instance with no value shows the declared default, else one item read from the main's own bound content, so a fresh instance previews like the main. An empty string clears an instance's value back to that.

The main is stored as authored: it holds the each-element once, as its sample, and is not re-rendered per default item.

Reconcile: copies are taken out of the diff and read back into the list prop, never into part overrides. The text of a bound element, and a link or image changed through its bound attribute, update that item (an address that fails the guard is refused and the old one kept). A copy removed by hand removes its item. A copy duplicated by hand, or written with its part keys but no index, adds an item that starts from the copied one; copies are read in document order, so moving a copy reorders the list. Booleans are left to explicit edits. Any other edit inside a copy (a class, a removed element, new markup) is not kept and is reported once per list as `list_item_edit_dropped`. A copy with no part keys at all is not recognised as a copy.

Agents: `<doop-use component="Menu" links='[{"label":"Home","url":"/"}]'>`; `insert_instance` and `update_instances` take the list as an array or as JSON text in `props` (an update replaces the whole list; `[]` shows no items; `""` goes back to the default). `get_component` shows the fields in `props` and the signature (`Menu(links: list(label: text, url: link))`), marks the repeated part `repeats_for` and the parts inside it `item_of`.

Issue codes added: `list_field_dropped`, `list_item_edit_dropped`.

Copies are keyed `<template key>-<index>`; in a main that contains a `data-doop-each` element, `stampParts` re-keys any authored part key ending in `-<digits>` so it cannot collide with a copy (mains without a list keep their keys byte for byte). The index is the key suffix, so a copy with a missing or wrong `data-doop-item` still finds its item. A list whose copies were never rendered (a false `data-doop-if` on it or around it, a hidden part) is left untouched by reconcile. A stored text value is kept as given when the page shows it with spaces collapsed; only a change of the words is an edit.

A value bound to a style property or custom property (`style.x`, `--x`), from any text prop or list field, must be one value: no `;`, `{`, `}`, backslash, `/*` or loading function (`url(`, `image-set(`, `src(`, `image(`). A write that breaks it is refused with `invalid_prop_value` (`<doop-use>`, insert_instance, update_instances), and the render skips such a value too. A binding to the whole `style` attribute (`data-doop-prop="style:x"`) counts as a style target too, so a multi-declaration value is refused there; a stored value that breaks the rule is skipped at render (the template's value shows) with `invalid_prop_value`.

## Rich-text props

A prop of type `richtext` carries a safe subset of inline HTML instead of plain text. Declare it in `props` (`{ name: "title", type: "richtext" }`) and bind it with a bare `data-doop-prop="title"` on an element: an instance's value replaces that element's children, where a `text` binding replaces only the element's own text nodes. The default is the bound element's own content in the main, so a richtext prop has no `default` field (it is dropped when declared).

The value is sanitized on every write by one parse5-based sanitizer (`server/richText.ts`, `sanitizeRichText`), and again whenever an instance is rendered, so a hostile marker written straight into stored markup is cleaned the next time the frame is written. Allowed: text, `b`, `i`, `strong`, `em`, `br`, `a` with an absolute `http:` or `https:` `href` (relative, `javascript:`, `data:`, `vbscript:`, protocol-relative and any address with a space, control character, backslash or quote is refused and the link becomes its text), and `span` with a `class` of letters, digits, `_` and `-` (any other class makes the span its text; a span with no class is unwrapped). Every other element is unwrapped to its sanitized children; `script`, `style`, `template`, `iframe`, `object`, `embed`, `svg`, `math`, `noscript`, `textarea`, `select` and the other raw-text or foreign elements are dropped with their content. Every other attribute and every comment is dropped, control characters are removed, and a link left empty is dropped. The output is rebuilt from a fresh tree and serialized canonically, and the sanitizer is idempotent (it re-reads its own output until it is stable). Work is bounded: a value over 20,000 characters (`MAX_RICHTEXT_CHARS`), or one whose escaped form is, is refused (an `invalid_prop_value` issue naming the limit, the prop keeps its previous value) and kept elements nest at most 16 deep (deeper ones are flattened to their text).

Reconcile: an instance whose bound element's content differs from what its revision would render records the sanitized inner HTML as that prop's value in `data-doop-props`, never as a part override. A value equal to the main's sanitized content is not recorded. Whitespace-only differences are ignored. On the canvas the frame runtime lets people edit text inside an instance and bold or italic (`<b>`, `<strong>`, `<i>`, `<em>`) survives; inline `style` on runs, `data-doop-run` and block wrappers a browser adds are not part of the subset and are dropped on save.

Agents: `<doop-use component="Card" title="<b>Hi</b> there">`, `update_instances` and `insert_instance` accept rich-text values. When the sanitizer removed anything the result carries a `richtext_sanitized` issue naming what was removed (`onclick attribute on <b>`, `<script> and its content`, `unsafe link address`), never the removed content itself.

Slots: with one slot a component takes unnamed content as before. With several, unnamed content still goes into the first slot the engine finds (never dropped) and the result carries an `unnamed_slot_content` issue naming that slot and the component's slot names; `<template slot="x">` for a slot the component lacks does the same with an `unknown_slot` issue naming `x`.

## The write pipeline

`prepareFrameHtml` runs synchronously inside every `actions.ts` write:

1. Expand `<doop-use>` at string level (a parser would foster-parent one out of a `<table>`).
2. Fold a changed main into its definition: a new revision, reported as `changed`. One
   `update_component` call is one revision: when it changes props it opens the revision itself, and
   the main's write that follows fills it (`withinRevision`) rather than adding a second.
3. Reconcile each outermost instance: render its own `rev` with its marker's state, diff against the
   incoming markup, record differences as overrides, render at the current revision. Unchanged input
   stays byte-identical. This three-way step is what stops a stale client's save being taken for edits.
4. Put exactly the needed stylesheets in the head.

Edits map to the narrowest thing that holds them: a bound element to its prop; attributes and individual
style properties to a part override; a deleted element to `hidden`; moved or added children to an `html`
override on that one element, which stays linked above and beside. Setting something back to the
template's value removes the override.

A changed main is then carried to the frames using it **in the background** (`server/propagation.ts`): the
write that changed it only queues the component (`actions.queuePropagation`) and returns. The queue is per
canvas and per frame, visits ONE frame per event-loop tick (`setImmediate` between frames) and lets canvases
take turns, so no request rewrites a canvas synchronously; a frame waits once however many components ask
for it, and a canvas with work pending stays loaded and held. Each visit is an ordinary write: history is
filed, sign-off stands (the frame itself was not edited; decided 2026-11-12), the room sees `frame:updated` (the `component`
message goes out when the change is queued), and one activity line names the frames when the canvas's queue
drains. A frame written while it was being prepared is queued again rather than overwritten. A frame
mid-stream catches up when its stream ends, including one whose agent went silent. `update_component`
reports `propagation: { status: 'queued' | 'deferred' | 'none', frames }`; `update_library_everywhere` waits
for each canvas's queue and reports what it changed. `DOOP_DEFER_COMPONENT_PROPAGATION` still skips the queue for frame writes.

The queue is kept in the database. `component_propagation_queue` (migration 0065, idempotent) holds one row per queued frame and task (`frame_id` and `task` are the key; `canvas_id`, the `component_ids` asking for the frame, the `actor` the work is done in the name of, `queued_at`). Rows are written after the commit that queued the work (batched per tick, one upsert per frame however many edits asked, a delete never overtaking its upsert) and deleted once the frame has had its turn: visited, skipped, left to its own next write after five attempts, or gone with its frame or canvas. A frame waiting for a stream to close keeps its row. After the server starts listening, `actions.resumePropagationQueue` reads the rows one canvas at a time, deletes the ones whose canvas or frame is gone (and the propagate rows when `DOOP_DEFER_COMPONENT_PROPAGATION` is on), and hands the rest to the ordinary queue (`propagation.restore`), which loads and holds each canvas until it drains; `catchUpComponentsBehind` runs after it for instances behind by revision. `DOOP_PROPAGATION_PAUSED` holds the queue's turns (work is queued and stored, no frame is visited until the next boot without it).

Frames waiting for a change of a main are shown to the room. `propagation.catchingUp(canvasId)` lists the frames queued for the `propagate` task that use one of the components being carried (a frame whose html is not loaded yet counts). The room `init` carries them as `catchingUp` and a `frame:catching-up` message (`added`, `removed`) follows each change, to viewers too. The client store keeps `catchingUp`, and `FrameCatchingUpBadge` draws a quiet "Catching up" pill with a slow sync glyph beside the frame's name until the frame is visited. `GET /healthz/propagation` reports the queue (`canvases`, `frames`, `paused`).

## Deleting and restoring

Delete is **soft** (`status: 'deleted'`, `deletedAt`, `deletedBy` on the definition; migration
`0063_component_soft_delete`). `deleteComponent` marks the definition and writes **no frame**: it used to
detach every instance on every frame in one synchronous request.

- **Instances** of a deleted component keep their stored markup byte for byte and are left out of
  everything that follows a main: `prepareInstances` skips them (no reconcile, no upgrade), the propagation
  queue drops deleted ids, and their stylesheet stays in the head (`closureOf` still finds the definition).
  They read back in full, not as `<doop-use>` (`compactDocument`), and take no props or overrides
  (`changeInstances` refuses; detaching one still works).
- **New uses** are refused: a `<doop-use>` naming a deleted component is left out with a
  `deleted_component` issue, and `insert_instance` fails. A name resolves to the component in use first, so
  a new component may take a deleted one's name.
- **Its main** is frozen: markup carrying the marker stays where it is as ordinary markup of that frame. An
  edit to it (an old client's save, a paste) changes only that frame, never the definition, and does not
  bring the component back (`prepareMains` skips it).
- **Nested use**: a component built from a deleted one keeps rendering as it did. A `<doop-use>` that
  already wears a part key is a template's own, not a new use, so the outer component's main, its template
  and new instances of it still expand the deleted definition, frozen at its last revision.
- **Restore** (`restoreComponent`): active again under its name, or `<name> (restored)` if that was given
  away. The main is the markup still carrying the marker, re-read through an ordinary write so that edits
  made to it meanwhile become a new revision; if none is left, a main is written from the kept definition.
- **Detach all** (`detachAllInstances`) is its own, explicit act: the `detach` task of the background queue
  (`server/propagation.ts`), one frame per tick, each an ordinary write. A frame an agent is streaming into is not rewritten under it: its request is
  kept outside the queue (`defer`) and resumed when the stream closes or is abandoned (`finishStream` →
  `propagation.resumeFrame`). It is not undone by a restore.
- Surfaces: `DELETE /api/canvases/:id/components/:componentId`, `POST …/undelete`,
  `POST …/detach-instances`; MCP and the resident agent share `delete_component` (with
  `detach_instances`) and `restore_component`; `get_canvas` lists `deletedComponents` that still have
  instances; `GET …/components` and every catalog list the components in use only (`activeComponents`).
  In the editor, Delete in the Components panel soft-deletes, and the Design tab on an instance of a
  deleted component shows "Main component deleted" with Restore and Detach (`ComponentSection.tsx`).
- **Libraries**: a library's publication holds the components it can publish and the deleted ones those
  are built from (`publication` in `componentLibrary.ts`), so a published Card that nests a deleted Button
  still brings its Button. Such a snapshot is a dependency only: `librariesForCanvas` does not offer it,
  a canvas adopting it gets it already deleted, and it leaves the publication once nothing in use is built
  from it. On the consuming side a locally deleted link is frozen: `pullFromLibrary` (sync_component and
  update everywhere), its dry-run preview and a copy import's sync skip it, so its template, CSS and
  revision stay as they were while the component built from it moves on. A copy import (`import_component`
  from a canvas that is not a workspace library) brings the deleted components its target is built from
  the same way: copied as they stand, still deleted, with no main. Tests:
  `libraryDeletedComponents.test.ts`.
- A deleted definition is never purged, and does not count towards `MAX_COMPONENTS`.

Tests: `componentSoftDelete.test.ts`, `componentSoftDeleteRoutes.test.ts`,
`componentSectionDeleted.test.tsx`.

## Work budget

The engine is synchronous, and what it costs is parsing. Every engine parse goes through `parse` /
`parseFragment` in `server/workBudget.ts`, which charge the **operation** they run in: an
`AsyncLocalStorage` context opened per HTTP request (middleware in `server/index.ts`), per MCP tool call
(`withArgsCanvases`), per resident tool call (`execTool`), per frame of the propagation queue and for an
idle stream's settling pass. An operation may hand the parser `DOOP_WORK_BUDGET_PARSE_MB` (96) of HTML and
spend `DOOP_WORK_BUDGET_MS` (2000) inside it; the time is parser time, not wall time, so a tool call that
awaits a render is not charged for the wait. Past either limit the parse throws `WorkBudgetError`, which
names the operation and the canvas: REST answers 422 `work_budget_exceeded`, MCP and the resident agent
return it as the tool's error, and the queue skips that frame and leaves it materialized as it was.
`prepareFrameHtml` puts back any definition it had already saved (a main folded in, a library component
taken up), and `updateComponent` its own, so a refused write leaves nothing behind. The budget is
checked before a parse (bytes that do not fit are never parsed) and again after it, so the parse that took
an operation over its time is refused itself, including an operation's last one. Every write therefore
parses first and saves after: `updateComponent` reads the template before it saves props or a name, a new
main's empty frame is removed if its write is refused, a stream chunk's library adoption is put back (also when the last chunk's whole-frame pass is the one
refused, and the room hears of an adoption only after the chunk is in the frame), and an
import of several components takes back the ones it had made. A check that runs after a write has landed
(the css-not-kept note, lookalike and reuse notes, reading instances back, an inserted instance's id) goes
through `optional()`: out of budget it is left out, never turned into a refusal of a finished write.
`replace_matching` stops instead and reports `matching_stopped`; a sync that had already updated a
dependency says what it updated (`WorkBudgetError.afterPartialWork`). `workBudgetCommit.test.ts` makes each
parse of each writing operation the one that goes over, and requires the operation to land whole or leave
the canvas exactly as it was.
Work outside any operation (a timer, a socket message) is counted per event-loop turn and only logged.
Tests: `workBudget.test.ts`, `workBudgetHttp.test.ts`.

## Usage counts

`server/componentUsage.ts` answers "where is each component used" for a whole canvas from one pass over
its frames: a string scan for instance markers, never a parse, kept per frame until that frame is written
again (its `updatedAt` moves). `catalog(canvas)` (the list in `get_canvas`, `list_components` and the
resident prompt) takes every component's count from that one pass instead of splitting every frame once per
component. `update_component`'s impact report reads the same index, and looks for orphaned overrides only
in frames that can hold one (an overrides marker, or a slot / nested component at a part the new template
drops), within a quarter of the operation's parse budget; frames it had to leave out are counted in
`overrides_unchecked_frames`. Tests: `componentUsage.test.ts`.

## Agent surface

`server/componentTools.ts` holds each tool's schema and handler once, for MCP and the resident agent:
`list_components`, `get_component`, `create_component`, `update_component`, `insert_instance`,
`update_instances`, `delete_component`, `restore_component`, `restore_component_version`,
`import_component`, `sync_component`, `duplicate_component`, `detach_from_library`. Previews are `get_component_preview` (MCP) and
`screenshot_component` (resident). `get_canvas` carries the catalog; `get_frame` and `edit_frame_html` speak
the compact form. Instructions are `COMPONENTS` in `server/guide.ts`.

## Editor

Layers / Components switch in the left rail (`ComponentsPanel.tsx`): search, previews, click to place, repeated
design scan, library import. `ComponentSection.tsx` heads the Design tab: props, go to main, reset, detach on an
instance; description and make-a-prop / make-a-slot on a main. Right-click and ⌘⌥K create one. Props have a control per type (number with min/max/step, colour with the canvas's tokens, instance from `accepts`), each overridden prop and part wears a dot with its own reset, and a swapped nested instance says what it was swapped to. On a main the section lists its instances with jump-to (`InstanceList.tsx`) and shows its code mapping with a copyable import line and an edit form (`ComponentCodeSection.tsx`). The Components panel's card menu duplicates a component and detaches a linked library one (after a confirm).

An instance's list prop is drawn as a block of one card per item (`ListPropEditor.tsx`): an input for each declared field (text, link, image picker, on/off switch), an add button, and per card a drag grip, ⌥↑ / ⌥↓ and a menu with Move up, Move down, Duplicate and Remove.

An instance that has no items of its own shows the one sample item its main's bound elements hold (`listSample` in `src/lib/listProps.ts`, the same reading as the server's `sampleItem`), so the rows match the canvas.

Every edit sends the whole next list through `changeInstance` as one `props` value (`listJson`, key-sorted JSON), so one edit is one save and one undo step like any prop edit; a cleared text field leaves the item, a new item starts with its on/off fields off, and the reset dot puts the main's items back.

A rich-text prop is a small contenteditable (`RichTextPropField.tsx`) with Bold, Italic, Link and Remove link buttons, ⌘B / ⌘I, Enter as a line break, plain-text paste and a link form that takes only an absolute http(s) address.

It sends the subset markup (`richTextSubset`: `b`, `i`, `br`, `a` with an http(s) `href`; everything else is unwrapped, text escaped) when the field loses focus, through the same prop-edit path; the server sanitizes again and the field shows what it kept.

A rich-text field cleared completely resets the prop to the main's content, as an empty text field does.

The Design tab on a main has a Variants group (`src/components/VariantsSection.tsx`): every enum and reflected boolean prop with its values as chips (the default is the highlighted chip), and the edits to them: add a value (inline field), rename a value (double-click or the chip's menu), make a value the default, remove a value (a dry run first, then a confirm that says how many instances use it and asks for a new default when the value is the default), add a choice or an on/off variant, rename or remove a variant. Every action is one `POST /api/canvases/:id/components/:componentId/variants` call, so one write of the main; the editor's undo history holds frame edits only and cannot take a server-side component edit, so none of these can be undone from it and the confirm says so. Viewers see the chips and the preview but no edit controls.

"Preview variant" has one select per variant prop. It shows the combination on the main in the live frame only: the runtime (`doop:variant-preview`, `previewVariant` in `frameBridge.ts`) sets `data-<prop>` on the main's root, puts them back on every render of the document, and `cleanClone` restores the root's own values, so a save or export never carries the preview. The preview ends when the selection leaves the component or the frame changes.

While a combination with at least one non-default value is previewed, the Design panel's `apply` and scrub gestures for the main or an element inside it are sent as `set_style` ops for that combination instead of inline styles (`src/lib/variantPreview.ts`): the element is its `data-doop-part` key, or `root` for the main root, `when` holds the previewed props that are not at their default, and a null or empty value clears the property from the rule. Bursts of edits to one element merge into one call per 220 ms and calls run in order. A scrub previews inline in the live frame, is put back when it ends and is written once. A panel header says "Editing size=lg" with a Back to base button. An element with no part key is refused with a notice. Geometry edits (move, rotate, align) stay inline on the element.

## Limits

- Variants are authored on the server by `server/componentVariants.ts` (`editVariants`), so the Design tab, REST and agents write one thing. A variant is an `enum` prop (`data-<name>="<value>"` on every instance root) or a `boolean` prop with `reflect: true`; its style is a plain rule in the component's stylesheet (`rawCss`, the main's `data-doop-component-source` block): `[data-size="lg"] [data-doop-part="<element key>"] { … }`, or `[data-size="lg"] { … }` for the root (an instance root carries its variant attributes but no part key, and the engine scopes both forms to the instance), never an inline style on the main. One call applies an ordered list of ops as one main write, one revision and normal propagation: `add_enum`, `add_value`, `rename_value`, `remove_value` (`new_default` when the default goes; the last value is refused), `set_default`, `add_boolean`, `rename_prop`, `remove_prop`, `set_style` (declarations merged per selector, null or empty removes a property, a rule left empty is dropped) and `clear_style`. `rename_value` rewrites every `[data-<prop>="old"]` selector, the template's `data-doop-if` and `data-doop-attr-if` conditions naming the old value, and the stored value of every instance that held it, in the same operation; `remove_value` drops the value's rules and sends instances that used it back to the default; `rename_prop` and `remove_prop` are refused while a binding (`data-doop-prop`) or, for removal, a condition names the prop. Declarations are validated: property names are lowercase hyphenated or custom properties (not `behavior` or `-moz-binding`), values may not hold control characters, `{`, `}`, `;`, `<`, `>`, backslashes, comments, `@import` or script URLs, must balance parentheses and quotes, and may call only colour, maths (`calc`, `min`, `max`, `clamp`, `var`, `env`), gradient, transform, easing and filter functions (so `url()`, `image-set()` and the like are refused). Variant ops edit every stylesheet of the main's frame in place (a main made from an element keeps its design's own `<style>` block, and sibling rules stay); a new rule goes into the component's source block unless one with the same selector already exists elsewhere. `remove_value` drops rules that ask for the value and keeps ones that exclude it (`:not([data-size="sm"])`). Stored option names that are not short words cannot be styled until renamed. Instances inside another component's template (`<doop-use size="old">`) are not rewritten. REST: `GET /api/canvases/:id/components/:componentId/variants` (view) answers `{ props, rules }`; `POST …/variants` (edit) takes `{ ops, expectedRev?, dryRun? }` (a stale `expectedRev` is a 400 on a dry run and a no-op too) and answers `{ component, props, rules, instances_updated, frames_updated, impact, propagation }`. MCP and the resident agent: `edit_component_variants`. Tests: `componentVariants.test.ts`, `componentVariantsHttp.test.ts`. A main's CSS is extracted from its frame's stylesheets minus other components' `data-doop-component-source` blocks, so two mains in one frame never take each other's variant rules.
- Selection outlines do not yet distinguish mains and instances; the Layers glyph and Design tab do.
- The Components page frame for a main made from markup uses a default size until resized.
- A component made from markup is not placed anywhere; the result says to write `<doop-use>` or call
  `insert_instance`.
- A `<doop-use>` cannot be a slot's default content directly (`data-doop-slot` on it is refused): wrap it in an element that carries the slot. Own overrides of a nested instance whose component an outer `instance` prop swaps are kept only for the props and parts the new component also has.
- Figma import does not map Figma components to these.
- A restored revision older than the 20 kept cannot be used for merging: its instance keeps its marker
  state and upgrades.
- Nested rules (CSS nesting) and `@scope` / `@starting-style` blocks in a frame's stylesheet are not isolated. Frame rules do not reach a component's own elements inside an instance; style them through the component (`update_component`) or an override on the instance. A component nested in itself through a slot keeps its own rules, but its own elements below a third component's instance are treated as that component's.
- Storybook importer, what a repeated capture would take (not built): Props reach Doop through `shared/storybook/argTypes.ts` (`readArgTypes` turns argTypes and initial args into `ArgProp`s), `bindings.ts` (matches an arg's value to an element's text or attribute in the captured DOM) and `plan.ts` / `bundle.ts` (the component plan and bundle). An array arg of objects (`items: [{ title, url }]`) is today either dropped as unsupported or bound as text. To import it as a list: in `readArgTypes` accept an array-of-objects initial arg and derive `fields` from the object keys and value shapes (a URL string a link, an image URL an image, a boolean a boolean, anything else text); in `bindings.ts` detect the repeat by finding sibling elements with the same tag and class shape whose texts equal the array's items in order, bind the first sibling's elements to the fields and mark it `data-doop-each`; drop the other siblings from the template and keep the array as the prop's `default`. The capture needs one story rendered with at least two items so the siblings can be told apart from a lone element, and the stories where the array differs in length are the check that the repeat is real.
- Workspace libraries (publish once, use on every canvas of the workspace) are their own spec:
  [workspace-component-library.md](workspace-component-library.md).
