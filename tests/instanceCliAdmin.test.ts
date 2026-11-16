import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeAdminEmail, setAdminRole } from '../server/adminRole.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const PROMOTE = `update "user" set role = 'admin' where lower(email) = $1 returning id`
const DEMOTE = `update "user" set role = 'user' where lower(email) = $1 and role = 'admin' returning id`

type Call = { sql: string; values: unknown[] }

function fakeClient(rowCount: number | null) {
  const calls: Call[] = []
  return {
    calls,
    query(sql: string, values: unknown[]) {
      calls.push({ sql, values })
      return Promise.resolve({ rowCount })
    },
  }
}

function cli(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      ['server/instanceCli.ts', ...args],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: '' } },
      (error, _stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stderr }),
    )
  })
}

describe('setAdminRole', () => {
  it('promotes with the account row named by parameter', async () => {
    const client = fakeClient(1)
    await expect(setAdminRole(client, 'a@b.co', true)).resolves.toBe(true)
    expect(client.calls).toEqual([{ sql: PROMOTE, values: ['a@b.co'] }])
  })

  it('reports whether an account was there to promote', async () => {
    await expect(setAdminRole(fakeClient(1), 'a@b.co', true)).resolves.toBe(true)
    await expect(setAdminRole(fakeClient(0), 'a@b.co', true)).resolves.toBe(false)
  })

  it('demotes only a current admin', async () => {
    const client = fakeClient(1)
    await expect(setAdminRole(client, 'a@b.co', false)).resolves.toBe(true)
    expect(client.calls).toEqual([{ sql: DEMOTE, values: ['a@b.co'] }])
    await expect(setAdminRole(fakeClient(0), 'a@b.co', false)).resolves.toBe(false)
  })

  it('normalises the address before it reaches the database', async () => {
    const client = fakeClient(1)
    await setAdminRole(client, '  A@B.CO ', true)
    expect(client.calls).toEqual([{ sql: PROMOTE, values: ['a@b.co'] }])
  })
})

describe('normalizeAdminEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeAdminEmail('  Person@Example.COM ')).toBe('person@example.com')
  })

  it('refuses what is not an address', () => {
    expect(() => normalizeAdminEmail('not-an-email')).toThrow('That is not an email address.')
    expect(() => normalizeAdminEmail('a b@c.co')).toThrow('That is not an email address.')
  })
})

describe('admin command', () => {
  it('asks for an address', async () => {
    const { code, stderr } = await cli('admin')
    expect(code).toBe(1)
    expect(stderr).toContain('Usage: admin EMAIL (or admin --remove EMAIL)')
  }, 30_000)

  it('needs a real database', async () => {
    const { code, stderr } = await cli('admin', 'a@b.co')
    expect(code).toBe(1)
    expect(stderr).toContain('DATABASE_URL')
  }, 30_000)

  it('takes --remove with an address only', async () => {
    const { code, stderr } = await cli('admin', '--remove')
    expect(code).toBe(1)
    expect(stderr).toContain('Usage: admin EMAIL (or admin --remove EMAIL)')
  }, 30_000)
})
