import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4997
const INVITE_ONLY_PORT = 4995

let server: Server
let client: Client
let inviteOnly: Server
let inviteOnlyClient: Client

function signUp(target: Client, base: string, email: string, name: string) {
  return target.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base },
    body: JSON.stringify({ email, password: 'password12345', name }),
  })
}

beforeAll(async () => {
  ;[server, inviteOnly] = await Promise.all([
    startServer(PORT, {
      SIGNUP_EMAIL_DOMAINS: 'jointhetroops.com, partner.test',
      SIGNUP_ALLOWED_EMAILS: 'guest@example.com',
    }),
    startServer(INVITE_ONLY_PORT, { SIGNUP_ALLOWED_EMAILS: 'Owner@Example.com, teammate@example.com' }),
  ])
  client = new Client(server)
  inviteOnlyClient = new Client(inviteOnly)
}, 70_000)

afterAll(() => {
  server?.stop()
  inviteOnly?.stop()
})

describe('signup domain restrictions', () => {
  it('allows configured email domains', async () => {
    const res = await signUp(client, server.base, 'person@jointhetroops.com', 'Allowed Person')
    expect(res.status, await res.text()).toBe(200)
  })

  it('also allows invited addresses outside those domains', async () => {
    const res = await signUp(client, server.base, 'guest@example.com', 'Invited Guest')
    expect(res.status, await res.text()).toBe(200)
  })

  it('rejects other domains without creating an account', async () => {
    const email = 'outsider@example.com'
    const res = await signUp(client, server.base, email, 'Outsider')
    expect(res.status).toBe(400)
    const { message } = await res.json()
    expect(message).toContain('@jointhetroops.com')
    expect(message).not.toContain('guest@example.com')

    const exists = await client.post('/api/account-exists', { email })
    expect(await exists.json()).toEqual({ exists: false })
  })
})

describe('invite-only signup', () => {
  it('allows invited addresses, ignoring case', async () => {
    const res = await signUp(inviteOnlyClient, inviteOnly.base, 'owner@example.COM', 'Owner')
    expect(res.status, await res.text()).toBe(200)
  })

  it('rejects everyone else without naming who is invited', async () => {
    const email = 'stranger@example.com'
    const res = await signUp(inviteOnlyClient, inviteOnly.base, email, 'Stranger')
    expect(res.status).toBe(400)
    const { message } = await res.json()
    expect(message).toBe('Sign up is restricted to invited email addresses.')

    const exists = await inviteOnlyClient.post('/api/account-exists', { email })
    expect(await exists.json()).toEqual({ exists: false })
  })
})
