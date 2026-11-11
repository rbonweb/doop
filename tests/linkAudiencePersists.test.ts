import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * A share link's audience, role and password must land in the database whatever order the
 * writes finish in. Each setting used to be its own fire-and-forget upsert of the whole canvas
 * row, so on a connection pool a stale snapshot (audience still unset) could commit after the
 * newer one and null the column: the link then asked signed-out visitors to sign in.
 *
 * Set DOOP_TEST_DATABASE_URL to run against a real Postgres (a pool, where the race lives)
 * instead of the embedded PGlite, which runs one query at a time.
 */

const databaseUrl = process.env.DOOP_TEST_DATABASE_URL ?? ''
const LINKS = 24

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer({ DATABASE_URL: databaseUrl })
  owner = await new Client(server).signUp('owner@audience.test', 'Owner')
}, 70_000)

afterAll(() => server?.stop())

async function createCanvas(name: string): Promise<string> {
  const res = await owner.post('/api/canvases', { name })
  expect(res.status).toBeLessThan(300)
  return ((await res.json()) as { id: string }).id
}

async function ownerView(id: string) {
  const res = await owner.get(`/api/canvases/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()) as { linkAccess?: string; linkAudience?: string; hasLinkPassword?: boolean }
}

async function reboot() {
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({ DATABASE_URL: databaseUrl }, server.dataDir)
  owner.cookies.clear()
  await owner.post('/api/auth/sign-in/email', { email: 'owner@audience.test', password: 'password12345' })
}

describe('share link settings persist', () => {
  it('keeps audience, role and password after a restart, in the order seed.mjs and the share dialog send them', async () => {
    const seeded: { id: string; audience: 'anyone' | 'password'; access: 'view' | 'comment' }[] = []
    for (let i = 0; i < LINKS; i++) {
      const id = await createCanvas(`Link ${i}`)
      const audience = i % 2 ? 'password' : 'anyone'
      const access = i % 3 ? 'view' : 'comment'
      if (i % 4 < 2) {
        /* one request with everything, as the rehearsal seed did */
        const res = await owner.patch(`/api/canvases/${id}`, {
          linkAccess: access,
          linkAudience: audience,
          ...(audience === 'password' ? { linkPassword: 'open-sesame-123' } : {}),
        })
        expect(res.status).toBe(200)
      } else {
        /* the share dialog: role first, then the password with the audience, or the audience alone */
        expect((await owner.patch(`/api/canvases/${id}`, { linkAccess: access })).status).toBe(200)
        const next =
          audience === 'password'
            ? { linkPassword: 'open-sesame-123', linkAudience: 'password' }
            : { linkAudience: 'anyone' }
        expect((await owner.patch(`/api/canvases/${id}`, next)).status).toBe(200)
      }
      seeded.push({ id, audience, access })
    }

    await reboot()

    for (const { id, audience, access } of seeded) {
      const view = await ownerView(id)
      expect({ id, linkAudience: view.linkAudience, linkAccess: view.linkAccess }).toEqual({
        id,
        linkAudience: audience,
        linkAccess: access,
      })
      expect(view.hasLinkPassword).toBe(audience === 'password' ? true : undefined)
    }

    /* signed-out visitors: only through the link's own audience, and a password link asks for its password */
    const visitor = new Client(server)
    for (const { id, audience } of seeded) {
      const res = await visitor.get(`/api/public/canvas/${id}`)
      expect(((await res.json()) as { mode: string }).mode).toBe(audience === 'anyone' ? 'open' : 'password')
    }
  }, 120_000)
})
