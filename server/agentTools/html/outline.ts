import type { Frame } from '../../../shared/types.ts'

/** The section outline of a frame; the sections slice fills this in. */
export async function frameOutlineFor(_frame: Frame, _opts: { measure?: boolean }): Promise<unknown> {
  return { unavailable: 'outline lands with the sections slice' }
}
