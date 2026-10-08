import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let admin: Client

function signUp(client: Client, email: string, invite?: string) {
  return client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: invite ? { 'x-doop-invite': invite } : {},
    body: JSON.stringify({ email, password: 'password12345', name: email.split('@')[0] }),
  })
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get('invite') ?? ''
}

beforeAll(async () => {
  /* the first admin comes in through the environment's list, as an operator's would */
  server = await startServer(4991, {
    DOOP_INVITE_ONLY: '1',
    SIGNUP_ALLOWED_EMAILS: 'admin@example.test',
    ADMIN_EMAILS: 'admin@example.test',
  })
  admin = await new Client(server).signUp('admin@example.test', 'Admin')
}, 70_000)

afterAll(() => server?.stop())

describe('invite-only accounts', () => {
  it('tells the sign-in page that accounts come from invites', async () => {
    expect(await (await fetch(`${server.base}/api/signup-config`)).json()).toEqual({ inviteOnly: true })
  })

  it('refuses a sign-up without an invite', async () => {
    const res = await signUp(new Client(server), 'stranger@example.test')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('invite link')
  })

  it('lets exactly the invited address in, once', async () => {
    const made = await admin.post('/api/admin/invites', { email: 'Guest@Example.test' })
    expect(made.status, await made.clone().text()).toBe(200)
    const invite = await made.json()
    expect(invite).toMatchObject({ email: 'guest@example.test', invitedBy: 'admin@example.test' })
    expect(invite.token).toBeUndefined()
    const token = tokenOf(invite.link)

    /* the sign-up form asks which address the link is for, before anyone signs in */
    const lookup = await fetch(`${server.base}/api/invites/${token}`)
    expect(await lookup.json()).toMatchObject({ email: 'guest@example.test' })

    expect((await signUp(new Client(server), 'someone-else@example.test', token)).status).toBe(400)
    const guest = new Client(server)
    expect((await signUp(guest, 'guest@example.test', token)).status).toBe(200)

    expect((await fetch(`${server.base}/api/invites/${token}`)).status).toBe(404)
    expect(await (await admin.get('/api/admin/invites')).json()).toEqual([])
    expect((await admin.post('/api/admin/invites', { email: 'guest@example.test' })).status).toBe(409)
    expect((await guest.get('/api/admin/invites')).status).toBe(404)
  })

  it('cancels an invite', async () => {
    const invite = await (await admin.post('/api/admin/invites', { email: 'later@example.test' })).json()
    expect((await admin.delete('/api/admin/invites/later@example.test')).status).toBe(200)
    expect((await fetch(`${server.base}/api/invites/${tokenOf(invite.link)}`)).status).toBe(404)
    expect((await signUp(new Client(server), 'later@example.test', tokenOf(invite.link))).status).toBe(400)
  })

  it('refuses an address that is not one', async () => {
    expect((await admin.post('/api/admin/invites', { email: 'not-an-address' })).status).toBe(400)
  })
})
