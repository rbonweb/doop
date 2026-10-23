import { ROLE_RANK, type CanvasRole } from '../../shared/types'
import { useStore } from './store'

/* What the open canvas lets this connection do. The server is the authority
   (it refuses every write below the role); these only decide what the UI
   offers, so nobody is handed a control that would be turned down. */

const atLeast = (role: CanvasRole | null, min: CanvasRole) => !!role && ROLE_RANK[role] >= ROLE_RANK[min]

/** Edit or owner: toolbar, inspector, drag, resize, prompt bar, delete. */
export const useCanEdit = () => useStore((s) => atLeast(s.role, 'edit'))
/** Comment or above: pins, replies, resolving. */
export const useCanComment = () => useStore((s) => atLeast(s.role, 'comment'))
/** The signed-out visitor's role is capped at comment and has no account. */
export const useIsGuest = () => useStore((s) => s.guest)

export const canEditNow = () => atLeast(useStore.getState().role, 'edit')
export const canCommentNow = () => atLeast(useStore.getState().role, 'comment')

/** The badge in the header for people below edit; null for editors. */
export function roleBadge(role: CanvasRole | null, guest: boolean): string | null {
  if (role === 'view') return guest ? 'View only · guest' : 'View only'
  if (role === 'comment') return guest ? 'Can comment · guest' : 'Can comment'
  return null
}
