import type { CommentAnchor } from '../../shared/types'
import { api, type PostedComment } from './api'
import { getIdentity, hasChosenGuestName } from './identity'
import { useStore } from './store'

/* Posting a comment from the browser, for whoever is looking: an account goes
   through the signed-in routes (with the people it @mentioned), a signed-out
   guest through the public ones under a name they chose once. The server
   returns a `notice` when it kept an @agent mention as plain text (only
   editors can ask agents to make changes); it is shown as a toast. */

/** The name a guest's comments carry; asks once, in a prompt, if there is none yet. */
export function ensureGuestName(): Promise<string> {
  if (hasChosenGuestName()) return Promise.resolve(getIdentity().name)
  return new Promise((resolve, reject) => {
    useStore.getState().setGuestNameRequest({ resolve, reject })
  })
}

function surface(comment: PostedComment): PostedComment {
  if (comment.notice) useStore.getState().pushNotice(comment.notice)
  return comment
}

export async function postComment(
  frameId: string,
  input: { selector: string; snippet: string; text: string; anchor?: CommentAnchor },
  mentions: string[],
): Promise<PostedComment> {
  if (useStore.getState().guest) {
    const name = await ensureGuestName()
    /* the public route stores the pin by selector only */
    const { anchor: _anchor, ...pin } = input
    return surface(await api.guestComment(frameId, { ...pin, name }))
  }
  return surface(await api.addComment(frameId, { ...input, mentions }))
}

export async function postReply(commentId: string, text: string, mentions: string[]): Promise<PostedComment> {
  if (useStore.getState().guest) {
    const name = await ensureGuestName()
    return surface(await api.guestReply(commentId, text, name))
  }
  return surface(await api.replyComment(commentId, text, mentions))
}
