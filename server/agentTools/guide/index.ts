import { CANVAS_GUIDE } from './canvas.ts'
import { HTML_GUIDE } from './html.ts'
import { RENDER_GUIDE } from './render.ts'

const topic = (title: string, sections: string) => `# ${title}\n\n${sections.trim()}\n`

/** The topic texts for the fork's agent speed tools, loaded with `get_guide({ topic })`; the main guide only points at them. Each keeps its areas' `## ` sections, so `get_guide({ section })` finds them by their old slugs. */
export const EDITING_TOOLS_GUIDE = topic('Editing tools — part of a frame, many frames, other agents', HTML_GUIDE)
export const CHECKING_TOOLS_GUIDE = topic('Checking tools — measure, lint, targeted screenshots', RENDER_GUIDE)
export const CANVAS_TOOLS_GUIDE = topic('Canvas tools — copy, arrange, batch', CANVAS_GUIDE)
