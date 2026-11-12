/* The agent guide's section for the canvas tools (markdown, appended to `get_guide` after the core guide). One string per tool family, each owned by its own change, kept apart by these comments so edits to one never touch another. */

/* duplicate_frames */
const DUPLICATE_GUIDE = `### duplicate_frames

Copy frames with \`duplicate_frames\` whenever you want the same design again: a variant to try beside the original, a phone and a desktop pair, a frame on another page, a set of states. Never re-type or re-stream HTML to copy a frame, and never read a frame only to write it back: the copy is the source's HTML byte for byte, so element ids, prototype wiring and every \`data-doop-*\` attribute carry over.

Each copy keeps the source's size, slide flag, speaker notes, hidden, locked and rotation. Approval, comments, version history and sticky notes are not copied; a copy starts as a draft. It stacks in front of its page. Without \`page_id\`, \`x\` and \`y\` it lands to the right of its source, clear of every other frame; a copy on another page keeps the source's own spot when it is free there.

Prototype links between frames copied in the same call follow the copies, so a copied flow points at its own screens; a link to any frame outside the call stays as it is. A frame holding a component main goes through the normal write path so the canvas never has two mains of one component, and its entry says \`rewritten: true\`. The call is checked whole before anything is written: a frame that is not on this canvas (use \`move_frame\` to change canvas) or an unknown page refuses all of it, naming the item.

Up to 50 copies per call. Example:

\`\`\`json
{ "canvas_id": "abc123", "agent_name": "Designer", "items": [
  { "frame_id": "f1", "name": "Home / mobile", "page_id": "p2" },
  { "frame_id": "f1", "name": "Home / dark variant" }
] }
\`\`\`
`

/* arrange_frames and check_layout */
const LAYOUT_GUIDE = `### arrange_frames and check_layout

Use arrange_frames after you create or duplicate several frames on a page, instead of moving each one with update_frame: it puts them in tidy rows in one call. By default desktops (900 px and wider) go in the first row and everything narrower in the second, left to right by their current x, 300 px apart, starting at the top-left of the frames being arranged. Pass \`page_id\` for a whole page (demo frames excepted) or \`frame_ids\` (all on one page), \`rows\` to group differently (each row has \`min_width\`, \`max_width\`, \`name\` and \`order\`), \`gap\` and \`origin\`. Locked frames never move and are listed in \`skipped_locked\`; a rotated frame is arranged by its unrotated box; sticky notes attached to a moved frame move with it; frames already in place are not written. Arrange only what you made: a locked or unlisted frame is not avoided, so run check_layout afterwards.

Call check_layout before you hand a page back: it lists frames and sticky notes that overlap, or that face each other closer than \`min_gap\` (default 40 px). It changes nothing.

\`\`\`
arrange_frames({ canvas_id, page_id, rows: [{ min_width: 900 }, { max_width: 899, order: "name" }], gap: 200, agent_name })
check_layout({ canvas_id, page_id, min_gap: 40, agent_name })
\`\`\``

/* run_batch */
const BATCH_GUIDE = `### run_batch

Use run_batch when you have many small independent edits or reads to make and each round trip is slow (a remote server): rename ten frames, nudge a column of frames, read three frames before deciding. It runs the ops in order in one call. Each op is checked, rate-limited and run exactly as if you had called that tool alone, so every op still carries its own \`agent_name\` and ids, and a view-only account still cannot write. An unknown tool, \`run_batch\` itself or arguments the tool would refuse fail that op only. With \`stop_on_error\` (default true) the ops after the first failure are reported as skipped; pass false to run the rest anyway. The answer starts with a JSON summary (\`ok\`, then each op's index, tool and status), followed by each op's own output under \`--- op <index> <tool> ---\`. Do not batch streaming writes (\`append_frame_html\`) or steps that depend on a previous op's output, since the ops are fixed before any runs.

\`\`\`json
run_batch({
  "ops": [
    { "tool": "get_canvas", "args": { "canvas_id": "c1", "agent_name": "Claude" } },
    { "tool": "update_frame", "args": { "frame_id": "f1", "name": "Hero", "agent_name": "Claude" } },
    { "tool": "update_frame", "args": { "frame_id": "f2", "x": 800, "agent_name": "Claude" } }
  ],
  "stop_on_error": true
})
\`\`\``

/* end of the tool families */

/** Empty until the area adds tools; each family's text starts with its own `### ` heading under one `## Canvas tools` heading. */
export const CANVAS_GUIDE = [DUPLICATE_GUIDE, LAYOUT_GUIDE, BATCH_GUIDE].some((part) => part.trim())
  ? ['## Canvas tools', DUPLICATE_GUIDE, LAYOUT_GUIDE, BATCH_GUIDE]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
  : ''
