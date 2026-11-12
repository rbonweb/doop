/* The agent guide's section for the canvas tools (markdown, appended to `get_guide` after the core guide). One string per tool family, each owned by its own change, kept apart by these comments so edits to one never touch another. */

/* duplicate_frames */
const DUPLICATE_GUIDE = ''

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
