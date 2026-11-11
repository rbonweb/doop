import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { canvasLink } from './links.ts'
import type { Canvas, MemberRole } from '../shared/types.ts'

/**
 * The "shared with you" email: an owner invited an existing account to a
 * canvas. Sent once, when the membership is new; requires SMTP like every
 * other courtesy email (server/mailer.ts), and never goes to a banned account.
 */

interface Person {
  name: string
  email: string
}

/** What the invitee may do, in the words of the email. */
const ROLE_SENTENCE: Record<MemberRole, string> = {
  view: 'You can view it.',
  comment: 'You can view and comment.',
  edit: 'You can view, comment and edit.',
}

export function shareEmail(
  inviter: Person,
  invitee: Person,
  canvas: Pick<Canvas, 'id' | 'name'>,
  role: MemberRole = 'edit',
): { to: string; subject: string; text: string } {
  const title = `“${canvas.name}”`
  return {
    to: invitee.email,
    subject: `${inviter.name} shared ${title} with you`,
    text: `Hi ${invitee.name || 'there'},\n\n${inviter.name} (${inviter.email}) invited you to collaborate on ${title} on doop. ${ROLE_SENTENCE[role]}\n\nOpen the canvas:\n${canvasLink(canvas.id)}\n\nIt is also listed under “Shared with me” on your home page.\n`,
  }
}

export async function emailShare(
  inviter: Person,
  inviteeId: string,
  canvas: Pick<Canvas, 'id' | 'name'>,
  role: MemberRole = 'edit',
) {
  if (!mailerConfigured) return
  try {
    const [row] = await db
      .select({ name: authSchema.user.name, email: authSchema.user.email, banned: authSchema.user.banned })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, inviteeId))
    if (!row || row.banned) return
    await sendMail(shareEmail(inviter, row, canvas, role))
  } catch (err) {
    console.error(`[share] email to ${inviteeId} failed`, err)
  }
}
