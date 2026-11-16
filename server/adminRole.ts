/**
 * The admin role, granted or taken away by one UPDATE against the account's row. The client is passed in rather than opened here, so instanceCli.ts keeps the connection wiring and a test can hand in a fake that records the statement.
 */

const EMAIL = /^[^\s@]+@[^\s@]+$/

export interface QueryClient {
  query(sql: string, values: unknown[]): Promise<{ rowCount: number | null }>
}

/** The address as the user table stores it: trimmed, lowercase, an email. */
export function normalizeAdminEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!EMAIL.test(email)) throw new Error('That is not an email address.')
  return email
}

const PROMOTE = `update "user" set role = 'admin' where lower(email) = $1 returning id`
const DEMOTE = `update "user" set role = 'user' where lower(email) = $1 and role = 'admin' returning id`

/** Returns whether an account was actually changed. */
export async function setAdminRole(client: QueryClient, email: string, admin: boolean): Promise<boolean> {
  const result = await client.query(admin ? PROMOTE : DEMOTE, [normalizeAdminEmail(email)])
  return (result.rowCount ?? 0) > 0
}
