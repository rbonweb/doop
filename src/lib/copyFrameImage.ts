import { clampImageScale } from '../../shared/imageScale'
import type { Frame } from '../../shared/types'
import { useStore } from './store'

/** Whether this browser can put an image on the clipboard at all. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function'
}

const shortName = (name: string) => (name.length > 32 ? `${name.slice(0, 31)}…` : name)

/**
 * `i` / `⇧I`: copy a frame to the clipboard as a PNG, rendered by the server at 2× or 4×.
 * The clipboard write gets the pending fetch, not a finished blob, so Safari and WebKit keep the key press as the
 * user gesture while the server renders.
 */
export async function copyFrameImage(frame: Frame, scale: 2 | 4): Promise<void> {
  const notify = useStore.getState().pushNotice
  if (!canCopyImages()) {
    notify('This browser can’t copy images to the clipboard. Use Export on the frame menu to save a PNG instead.')
    return
  }
  const name = shortName(frame.name)
  notify(`Rendering ${name} at ${scale}×…`, { busy: true })

  const failure: { message: string | null } = { message: null }
  const png = fetch(`/i/${frame.id}.png?scale=${scale}`, { cache: 'no-cache' })
    .then(async (res) => {
      if (res.status === 429) throw new Error('Too many renders right now — try again in a minute')
      if (!res.ok) throw new Error(`The server could not render it (${res.status})`)
      const blob = await res.blob()
      /* an app server that answers an unknown path with its index page must not end up on the clipboard as a "PNG" */
      if (!blob.type.startsWith('image/')) throw new Error('The server did not send an image')
      return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })
    })
    .catch((err: unknown) => {
      failure.message = err instanceof Error ? err.message : 'The render failed'
      throw err
    })

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    const effective = clampImageScale(scale, frame)
    notify(`Copied ${name} as a ${Math.round(frame.width * effective)}×${Math.round(frame.height * effective)} PNG`)
  } catch {
    notify(
      failure.message
        ? `Couldn’t copy ${name}. ${failure.message}.`
        : 'The clipboard refused the image. Allow clipboard access for this site and try again.',
    )
  }
}
