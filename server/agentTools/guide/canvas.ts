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
const LAYOUT_GUIDE = ''

/* run_batch */
const BATCH_GUIDE = ''

/* end of the tool families */

/** Empty until the area adds tools; each family's text starts with its own `### ` heading under one `## Canvas tools` heading. */
export const CANVAS_GUIDE = [DUPLICATE_GUIDE, LAYOUT_GUIDE, BATCH_GUIDE].some((part) => part.trim())
  ? ['## Canvas tools', DUPLICATE_GUIDE, LAYOUT_GUIDE, BATCH_GUIDE]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
  : ''
