/** The top-level parts of a get_canvas payload an agent can ask for on its own. */
export const CANVAS_FIELDS = [
  'pages',
  'frames',
  'notes',
  'guidelines',
  'references',
  'components',
  'fonts',
  'webFonts',
  'tokens',
  'tokenThemes',
  'flow',
  'claims',
  'note',
] as const

export type CanvasField = (typeof CANVAS_FIELDS)[number]

/** What get_canvas says about hosted fonts: the roster itself is in `webFonts`, so the note only points at it. */
export const HOSTED_FONTS_NOTE =
  'Hosted fonts: name any family listed in webFonts in your CSS and Doop links it from Google Fonts by itself, so do not add the <link> yourself and keep the <link data-doop-webfonts> it adds. OS fonts such as Georgia, Verdana or Helvetica render differently on each machine and in exports; prefer the hosted or the canvas’s custom fonts.'

/** Keep `id`, `name` and the listed top-level keys of a get_canvas payload; no list keeps everything. */
export function pickCanvasFields(
  payload: Record<string, unknown>,
  fields?: readonly CanvasField[],
): Record<string, unknown> {
  if (!fields?.length) return payload
  const picked: Record<string, unknown> = { id: payload.id, name: payload.name }
  for (const field of fields) if (field in payload) picked[field] = payload[field]
  return picked
}

/** Keep `id` plus the listed keys of each frame summary (unknown keys are ignored); no list keeps everything. */
export function pickFrameFields(frame: Record<string, unknown>, fields?: readonly string[]): Record<string, unknown> {
  if (!fields?.length) return frame
  const picked: Record<string, unknown> = { id: frame.id }
  for (const field of fields) if (field in frame) picked[field] = frame[field]
  return picked
}

/** A page of items: cursor is the decimal offset a previous call returned as nextCursor (undefined = 0). Returns the slice, the total and nextCursor (undefined on the last page). A cursor that is not a non-negative integer below or equal to the total returns { error }. */
export function pageOf<T>(
  items: readonly T[],
  limit?: number,
  cursor?: string,
): { items: T[]; total: number; nextCursor?: string } | { error: string } {
  const total = items.length
  let start = 0
  if (cursor !== undefined) {
    if (!/^\d+$/.test(cursor)) return { error: `cursor must be a non-negative integer offset, not "${cursor}".` }
    start = Number(cursor)
    if (start > total) return { error: `cursor ${cursor} is past the end of the list (${total} items).` }
  }
  const end = limit === undefined ? total : Math.min(start + limit, total)
  const page = items.slice(start, end)
  return end < total ? { items: page, total, nextCursor: String(end) } : { items: page, total }
}
