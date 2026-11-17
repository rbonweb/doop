import { randomBytes } from 'node:crypto'
import type { Actor } from '../shared/types.ts'
import { env } from './env.ts'

/**
 * One-time upload tickets for component bundles. A bundle from a Storybook can be megabytes, far more than should ride
 * through an agent's tool call, so `create_import_ticket` (and the import picker's REST route) hand out a capability URL
 * and the CLI or curl sends the bundle straight to `PUT /import/<token>` (server/index.ts).
 * The token is the capability: 32 random bytes, 15 minutes, single use, bound to one canvas and the person it was made for;
 * the upload route checks that person's edit role again when the bytes arrive. In memory on purpose, as asset tickets are:
 * a restart drops them and a new one is a call away.
 */

export const IMPORT_TICKET_TTL_MS = 15 * 60 * 1000
/** Tickets one person may make an hour, and hold at once. */
export const IMPORT_TICKETS_PER_HOUR = 5
export const IMPORT_TICKETS_LIVE = 20

export interface ImportTicket {
  token: string
  canvasId: string
  /** the account the ticket was made for; its edit role is checked again at upload */
  userId: string
  /** who the import is credited to in the activity feed */
  actor: Actor
  expiresAt: number
  inFlight: boolean
}

/** A ticket that cannot be made: no signed-in account behind the request, or a cap reached. */
export class ImportTicketError extends Error {}

export class ImportTicketLimitError extends ImportTicketError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message)
  }
}

const tickets = new Map<string, ImportTicket>()
/** When each person's recent tickets were made, for the hourly cap. */
const made = new Map<string, number[]>()

function sweep(now: number) {
  for (const [token, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(token)
}

export function createImportTicket(input: {
  canvasId: string
  userId: string | undefined
  actor: Actor
}): ImportTicket {
  const key = input.userId
  if (!key)
    throw new ImportTicketError('import tickets are made for a signed-in account: connect with your Doop account')
  const now = Date.now()
  sweep(now)
  const recent = (made.get(key) ?? []).filter((at) => now - at < 60 * 60 * 1000)
  if (recent.length >= IMPORT_TICKETS_PER_HOUR) {
    const wait = Math.ceil((recent[0]! + 60 * 60 * 1000 - now) / 1000)
    throw new ImportTicketLimitError(
      `at most ${IMPORT_TICKETS_PER_HOUR} import tickets an hour: reuse the one you have (it stays valid for 15 minutes until it is used) or try again in ${Math.ceil(wait / 60)} minutes`,
      wait,
    )
  }
  const live = [...tickets.values()].filter((ticket) => ticket.userId === key).length
  if (live >= IMPORT_TICKETS_LIVE)
    throw new ImportTicketLimitError(
      `${live} import tickets are open for this account (at most ${IMPORT_TICKETS_LIVE}): use or let some expire first`,
      60,
    )
  made.set(key, [...recent, now])
  if (made.size > 10_000)
    for (const [name, times] of made) if (times.every((at) => now - at >= 60 * 60 * 1000)) made.delete(name)
  const ticket: ImportTicket = {
    token: randomBytes(32).toString('base64url'),
    canvasId: input.canvasId,
    userId: key,
    actor: input.actor,
    expiresAt: now + IMPORT_TICKET_TTL_MS,
    inFlight: false,
  }
  tickets.set(ticket.token, ticket)
  return ticket
}

/** The ticket for a dry run: looked at, not claimed, and not used up. */
export function peekImportTicket(token: string): ImportTicket | null {
  const ticket = tickets.get(token)
  return ticket && ticket.expiresAt > Date.now() ? ticket : null
}

/** Claim a ticket for an upload attempt: null when it is unknown, expired, used or being used. */
export function beginImportUpload(token: string): ImportTicket | null {
  const ticket = peekImportTicket(token)
  if (!ticket || ticket.inFlight) return null
  ticket.inFlight = true
  return ticket
}

/** A success uses the ticket up; a failure gives it back for a retry until it expires. */
export function endImportUpload(token: string, success: boolean) {
  if (success) tickets.delete(token)
  else {
    const ticket = tickets.get(token)
    if (ticket) ticket.inFlight = false
  }
}

/** What a ticket's holder is told: the URL, when it stops working and the two ways to use it. */
export function ticketAnswer(ticket: Pick<ImportTicket, 'token' | 'expiresAt'>) {
  const upload_url = `${env.BETTER_AUTH_URL}/import/${ticket.token}`
  return {
    upload_url,
    expires_at: new Date(ticket.expiresAt).toISOString(),
    command: `npx doop-import --storybook ./storybook-static --ticket ${upload_url}`,
    curl: `curl -T bundle.json ${upload_url}`,
    curl_gzip: `curl -T bundle.json.gz -H 'Content-Encoding: gzip' ${upload_url}`,
  }
}

/** Test seam: forget every ticket and count. */
export function resetImportTickets() {
  tickets.clear()
  made.clear()
}
