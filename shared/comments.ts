import type { ElementComment } from './types.ts'

/** A comment pinned to a point on the canvas rather than to an element. */
export type CanvasComment = ElementComment & { frameId?: undefined; pageId: string; x: number; y: number }

export function isCanvasComment(c: ElementComment): c is CanvasComment {
  return c.frameId === undefined && c.pageId !== undefined && c.x !== undefined && c.y !== undefined
}
