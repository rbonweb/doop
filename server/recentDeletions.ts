export type NoteDeletion =
  | { cause: 'frame'; canvasId: string; frameId: string; frameName: string; by: string; at: number }
  | { cause: 'note'; canvasId: string; by: string; at: number }

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5_000

/** Deleted notes by id, oldest first (a Map keeps insertion order). */
const deletedNotes = new Map<string, NoteDeletion>()

/** Drop the entries older than 24 h, then the oldest ones beyond the cap. */
function prune(now: number) {
  for (const [id, deletion] of deletedNotes) {
    if (now - deletion.at >= DAY_MS) deletedNotes.delete(id)
  }
  while (deletedNotes.size > MAX_ENTRIES) {
    const oldest = deletedNotes.keys().next().value
    if (oldest === undefined) return
    deletedNotes.delete(oldest)
  }
}

/** Remember deleted notes for 24 h, at most 5,000 entries (the oldest dropped first). */
export function rememberDeletedNote(noteId: string, deletion: NoteDeletion): void {
  deletedNotes.delete(noteId)
  deletedNotes.set(noteId, deletion)
  prune(Date.now())
}

/** The deletion of a note, while remembered. */
export function noteDeletion(noteId: string): NoteDeletion | undefined {
  const deletion = deletedNotes.get(noteId)
  if (!deletion) return undefined
  const now = Date.now()
  if (now - deletion.at >= DAY_MS) {
    deletedNotes.delete(noteId)
    return undefined
  }
  prune(now)
  return deletion
}

/** "note <id> was deleted with its frame “<name>” (<frameId>) by <by> at <ISO time>" or "note <id> was already deleted by <by> at <ISO time>" */
export function describeNoteDeletion(noteId: string, deletion: NoteDeletion): string {
  const when = new Date(deletion.at).toISOString()
  if (deletion.cause === 'frame')
    return `note ${noteId} was deleted with its frame “${deletion.frameName}” (${deletion.frameId}) by ${deletion.by} at ${when}`
  return `note ${noteId} was already deleted by ${deletion.by} at ${when}`
}
