import type { Frame } from '../../shared/types'
import { useStore } from './store'

/** Keep the canvas, frame and CSS selector in the URL so agents can resolve
 *  the same element from the frame HTML without opening the editor. */
export function elementLink(frame: Pick<Frame, 'id' | 'canvasId'>, selector: string): string {
  const url = new URL(`/c/${encodeURIComponent(frame.canvasId)}`, location.origin)
  url.searchParams.set('frame', frame.id)
  url.searchParams.set('selector', selector)
  return url.href
}

export async function copyElementLink(frame: Pick<Frame, 'id' | 'canvasId'>, selector: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(elementLink(frame, selector))
    useStore.getState().pushNotice('Element link copied')
  } catch {
    useStore.getState().pushNotice('Couldn’t copy the element link. Please try again.')
  }
}
