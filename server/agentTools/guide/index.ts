import { CANVAS_GUIDE } from './canvas.ts'
import { HTML_GUIDE } from './html.ts'
import { RENDER_GUIDE } from './render.ts'

/** The areas' guide sections in a fixed order (render, html, canvas), each `## ` section on its own. Empty sections add nothing. */
export const AGENT_TOOL_GUIDE = [RENDER_GUIDE, HTML_GUIDE, CANVAS_GUIDE]
  .map((section) => section.trim())
  .filter(Boolean)
  .map((section) => `\n${section}\n`)
  .join('')
