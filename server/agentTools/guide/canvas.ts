/* The agent guide's section for the canvas tools (markdown, appended to `get_guide` after the core guide). One string per tool family, each owned by its own change, kept apart by these comments so edits to one never touch another. */

/* duplicate_frames */
const DUPLICATE_GUIDE = ''

/* arrange_frames and check_layout */
const LAYOUT_GUIDE = `### arrange_frames and check_layout

Use arrange_frames after you create or duplicate several frames on a page, instead of moving each one with update_frame: it puts them in tidy rows in one call. By default desktops (900 px and wider) go in the first row and everything narrower in the second, left to right by their current x, 300 px apart, starting at the top-left of the frames being arranged. Pass \`page_id\` for a whole page (demo frames excepted) or \`frame_ids\` (all on one page), \`rows\` to group differently (each row has \`min_width\`, \`max_width\`, \`name\` and \`order\`), \`gap\` and \`origin\`. Locked frames never move and are listed in \`skipped_locked\`; a rotated frame is arranged by its unrotated box; sticky notes attached to a moved frame move with it; frames already in place are not written. Arrange only what you made: a locked or unlisted frame is not avoided, so run check_layout afterwards.

Call check_layout before you hand a page back: it lists frames and sticky notes that overlap, or that face each other closer than \`min_gap\` (default 40 px). It changes nothing.

\`\`\`
arrange_frames({ canvas_id, page_id, rows: [{ min_width: 900 }, { max_width: 899, order: "name" }], gap: 200, agent_name })
check_layout({ canvas_id, page_id, min_gap: 40, agent_name })
\`\`\``

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
