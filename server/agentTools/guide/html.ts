/** The agent guide's section for the html tools (markdown, appended to `get_guide` after the core guide). */
export const HTML_GUIDE = `
## Editing part of a frame, many frames at once, and working alongside other agents

Read a big page's outline before editing it: \`get_frame\` with \`mode: "outline"\` returns each section's element id, tag, label, size and first words, a few KB instead of the whole HTML. Example: { "frame_id": "f1", "mode": "outline" }.

- A section target is one of { "element_id": "hero" }, { "label": "Pricing" } (its data-doop-label, else its heading text) or { "selector": "main > section:nth-of-type(2) h2" }; add \`all: true\` to a selector that matches several elements. A target inside a component instance is refused: change the component with \`update_component\` instead.
- \`get_section\` reads one element's exact source, size and path when the outline is not enough: { "frame_id": "f1", "target": { "label": "Pricing" } }.
- \`replace_section\` swaps one element and everything inside it in one write, for a reworked block: { "frame_id": "f1", "target": { "element_id": "hero" }, "html": "<section data-doop-id=\\"hero\\">…</section>" }.
- \`patch_frame\` makes up to 100 small edits in one atomic write (ops \`set_text\`, \`set_attr\`, \`remove_attr\`, \`set_style\`, \`insert_before\`, \`insert_after\`, \`remove\`; all or nothing, one version), for anything local: { "frame_id": "f1", "ops": [{ "op": "set_text", "target": { "selector": "#cta" }, "text": "Start free" }] }. Prefer it over \`edit_frame_html\` for anything you can target.
- \`find_frames\` locates frames by name, rendered text, HTML source or image URL, with short snippets, before you edit them: { "canvas_id": "c1", "text": "Learn more" }.
- \`delete_frames\` removes several frames in one call and reports missing and locked ids; dry-run it first: { "canvas_id": "c1", "frame_ids": ["f1", "f2"], "dry_run": true }.
- \`replace_in_frames\` replaces text or markup across frames (\`scope: "text" | "html"\`, optional \`regex\`; regex matching runs under a time bound (see server/frameSearch.ts)), and locked frames and locked layers are left alone. Run it dry first: { "canvas_id": "c1", "find": "Learn more", "replace": "Get started", "scope": "text", "dry_run": true }.
- \`expected_version\`: pass the \`updatedAt\` from your last read (also returned as \`version\`) on every frame write; a stale one is refused and names who changed the frame, so re-read and re-apply: { "frame_id": "f1", "ops": [{ "op": "remove", "target": { "label": "Beta banner" } }], "expected_version": "2026-11-12T10:00:00.000Z" }.
- \`claim_frames\` tells everyone which frames you are working on, with a note saying what you are doing: { "frame_ids": ["f1"], "minutes": 15, "note": "Rewriting the hero" }. Claims are advisory, last up to 60 minutes and show as a badge; another agent's write still goes through and its answer names you. Call \`release_frames\` when done.
- \`compose_frame\` builds a final page from labelled sections of frames on this canvas: { "canvas_id": "c1", "name": "Landing page", "width": 1280, "sections": [{ "frame_id": "f1", "target": { "label": "Hero" } }] }. Read \`dropped\` in the answer: rules tied to the source page's structure are not carried.
`
