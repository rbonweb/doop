# React export

Status: the converter core (S6), components and pages to React (S7) and the packaging and export surfaces (S8) are built; Tailwind styling (S9) is the remaining slice. Plan: Phase B of the component-upgrades plan.

## Goal

A design made in Doop, by a person or an agent, leaves as React components a team can drop into its app: one `.tsx` file per component and per page, styled with CSS Modules (default) or Tailwind, with the canvas's tokens as CSS variables and as W3C DTCG JSON. Doop HTML and components stay the source of truth; the export is deterministic (no model).

## Safety

Customers compile and run the exported code, and any canvas collaborator or agent can write the HTML and CSS it comes from, so nothing in the input may become code:

- Every text node is a `{"…"}` JavaScript string literal and every attribute value a string literal (`jsString`: JSON escaping plus `<`, U+2028 and U+2029 escaped). There is no `dangerouslySetInnerHTML` in any output.
- `<script>`, `<style>`, `base`, `meta`, `link`, `object`, `embed`, `noscript`, `template`, `on*` attributes, `srcdoc`, React-reserved props (`key`, `ref`, `children`, `dangerouslySetInnerHTML`) and invalid tag or attribute names are dropped and reported.
- `javascript:`, `vbscript:` and non-image `data:` URLs are dropped from attributes and CSS `url()` (`isUnsafeUrl`, after stripping whitespace and control characters; CSS escapes decoded first). Frames and embeds take no `data:` URL at all.
- A CSS `url()` is kept only when it is `http(s):`, `//`, root-relative `/` with no `..` segment, a `#fragment` or a safe `data:image/*`: a bundler resolves a relative one at build time and would copy a file from the customer's machine into their build.
- CSS: `@import`, `@charset`, unknown at-rules, `composes`, `:global` / `:local`, `expression()`, `behavior`, `-moz-binding` and anything with unbalanced brackets or quotes are dropped and reported; every emitted sheet parses.

Everything dropped or changed is an `ExportIssue` (`kind`, `detail`, optional `path`), joined into `export-report.json` by S8.

## Converter core (S6, `server/reactExport/`)

- `issues.ts`: `ExportIssue`, `isUnsafeUrl`, `jsString`.
- `htmlToJsx.ts`: `htmlToJsx(html, options)` and `nodeToJsx(node, options)` turn a body fragment into one JSX expression (several roots become a fragment, nothing becomes `null`) on parse5: `class` to `className` (`class` on custom elements), `for` to `htmlFor`, the React HTML and SVG attribute tables, style strings to style objects (custom properties as quoted keys, `!important` reported), void elements self-closing, form values as `defaultValue` / `defaultChecked`, `data-*` and `aria-*` kept, `data-doop-*` stripped, HTML whitespace rules. Two hooks let S7 build components on it: `visit(el, ctx)` may return any JSX string for an element (it sees `data-doop-*` attributes; `ctx.children()` and `ctx.element(attrs, children)` give the default rendering with attributes replaced, and can never emit a dropped element or an unsafe attribute), and `className(classes, el)` sets the className value.
- `cssSplit.ts`: `splitComponentCss(css, { rootClass })` splits a definition's CSS into `moduleCss` (rules naming a class kept as written; classless rules scoped under `.root`; variant selectors, keyframes, media, container, supports and layer blocks kept), `classes` (what `styles['x']` can look up), `globalCss` (`:root`, `html`, `body`, `@font-face`, `@property`) and issues; `moduleClassName(classes, moduleClasses)` gives `{styles["a"]}` or `{cx(styles["a"], "b")}`.
- `names.ts`: `isIdentifier`, `pascalCase`, `camelCase`, `NameAllocator` and `componentName`, `propName`, `fileBase` (ASCII, no dots or separators, at most 64 characters, never a Windows device name, unique case-insensitively).
- `tokensDtcg(tokens, themeOrder)` in `shared/designTokens.ts`, beside `tokensCss` and `tokensTailwind`: groups per token type, `$value` / `$type` / `$description`, aliases as `{group.key}`, themes under `$extensions["design.doop"].themes`.

Tests: `tests/htmlToJsx.test.ts` (attribute tables, SVG, styles, an injection corpus that is transpiled with `typescript` and rendered with `react-dom/server` to prove text stays data), `tests/reactExportCss.test.ts` (including a seeded fuzz whose output must parse), `tests/reactExportNames.test.ts`, `tests/designTokensDtcg.test.ts`.

## Built

- S7, components and pages to React (`componentToReact.ts`, `pageToReact.ts`, `report.ts`, `urls.ts`, entry `index.ts`): props typed from the definition (enum as a string union, boolean, number, colour as string, slots and `instance` props as `ReactNode`), `data-doop-if` as `&&`, bindings as expressions, enum variants as `data-<name>={value}` on the root so the CSS carries over, forwarded props passed through, an instance with props and slots only as `<Comp …/>` and deeper overrides inlined with a report line, and a component with a `code` mapping imported from its package with renamed and value-mapped props instead of generated.
- S8, packaging and surfaces. `server/reactExport/zip.ts` (`zipExport(result, rootDir)`) packs `<canvas>-react/` (`README.md`, `export-report.json`, `src/tokens.css`, `src/tokens.json`, `src/cx.ts`, `src/css-modules.d.ts`, `src/components/<Name>.tsx` and `.module.css`, `src/components/index.ts`, `src/pages/<Frame>.tsx` and `.css`) with sorted entries and a fixed date and mode, and refuses a path that could leave the archive. `server/reactExport/canvasExport.ts` turns a request into the export input for the route and the tool: `frameIds` (in order, 404 for one not on the canvas), `pageId` (visible screens in reading order; hidden, demo and paper-drawing frames are skipped, a frame holding a component's main stays a screen), `componentIds` (ids or names of active components, deleted ones are a 404), the canvas's first page when none is given, `styling`, `tokens`; asset URLs are made absolute on the origin of `BETTER_AUTH_URL`; 20 MB of files at most (413), 20 exports a minute per account (`REACT_EXPORTS_PER_MIN`, 429 with `Retry-After`). `POST /api/canvases/:id/export/react` (`server/reactExportRoutes.ts`) is behind the view role, takes a strict zod body, answers a zip with the `X-Doop-Export-Issues` header (the count of report issues) or `format: 'json'` `{ files, report }` (413 above 300 KB). MCP `export_react` (`COMPONENT_TOOLS`, so the resident agent has it too) takes `canvas_id`, `frame_ids`, `page_id`, `component_ids`, `styling` and `tokens`, answers `{ files, report }` up to 300 KB, and above it the report, a file listing and the zip as an embedded `application/zip` resource (a resident run is told to narrow the scope); the guide's `export` topic teaches it. The client (the Export to React… dialog, "Copy as React") is S8 client, see `src/lib/reactExport.ts`.

## Still to build

- S9, Tailwind styling: component CSS as utilities where they say the same thing, the rest kept in a `.module.css`, tokens as `@theme` through `tokensTailwind`.
- Acceptance: `tests/reactExport.e2e.test.ts` exports the worked-example canvas (a Card with `title`, `tone`, `badge`, a forwarded `cta` and an `actions` slot holding a Button), type-checks it strictly, bundles it with esbuild, renders it with `react-dom/server` and compares the DOM with Doop's own instance rendering, in both styling modes.
