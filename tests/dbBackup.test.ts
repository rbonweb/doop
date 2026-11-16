import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackupFailed,
  dumpConnection,
  lastBackupAt,
  nextNightly,
  startNightlyBackup,
  runBackup,
  type BackupOptions,
} from '../server/dbBackup.ts'

const DATABASE_URL = 'postgres://doop:hunter2@db.internal:5433/doopdb?sslmode=require'
const NOW = new Date('2026-11-16T03:17:00Z')
const DAY_MS = 86_400_000

/* a pg_dump stand-in: it prints what it was given, and nothing else */
const OK_SCRIPT = `printf 'ARGS=%s\\n' "$*"
printf 'PGPASSWORD=%s\\n' "$PGPASSWORD"
printf 'SSL=%s\\n' "$PGSSLMODE"
env | grep -c DOOP_ || true`

const FAIL_SCRIPT = `echo "boom hunter2" >&2
exit 3`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A temp root holding the fake binary, and the backup dir under it (not created yet). */
function tempDir(): { root: string; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'doop-backup-'))
  roots.push(root)
  return { root, dir: path.join(root, 'backups') }
}

function pgDump(root: string, body: string): string {
  const file = path.join(root, 'pg_dump')
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

function options(dir: string, executable: string): BackupOptions {
  return {
    databaseUrl: DATABASE_URL,
    dir,
    keepDays: 14,
    executable,
    now: () => new Date(NOW),
  }
}

function gunzipped(file: string): string {
  return gunzipSync(readFileSync(file)).toString('utf8')
}

function line(text: string, prefix: string): string {
  return text.split('\n').find((entry) => entry.startsWith(prefix)) ?? ''
}

async function rejection(promise: Promise<unknown>): Promise<BackupFailed> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(BackupFailed)
  return error as BackupFailed
}

describe('runBackup', () => {
  it('writes a gzipped dump named for the moment and the label', async () => {
    const { root, dir } = tempDir()
    const file = await runBackup('before-v1.2.0', options(dir, pgDump(root, OK_SCRIPT)))

    expect(file).toBe(path.join(dir, 'doop-20261116-031700-before-v1.2.0.sql.gz'))
    const text = gunzipped(file)
    const args = line(text, 'ARGS=')
    expect(args).toContain('--host db.internal --port 5433 --username doop --dbname doopdb')
    expect(args).not.toContain('hunter2')
    expect(text).toContain('PGPASSWORD=hunter2')
    expect(text).toContain('SSL=require')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(path.join(dir, '.backup.lock'))).toBe(false)
  })

  it('gives the dump no server secrets', async () => {
    const { root, dir } = tempDir()
    process.env.DOOP_DOKPLOY_WEBHOOK_URL = 'https://dokploy.example.com/api/deploy/compose/sekret-token-123'
    try {
      const file = await runBackup('nightly', options(dir, pgDump(root, OK_SCRIPT)))
      const text = gunzipped(file)
      const lines = text.trim().split('\n')
      expect(text).not.toContain('sekret-token-123')
      expect(lines).toHaveLength(4)
      expect(lines.at(-1)).toBe('0')
    } finally {
      delete process.env.DOOP_DOKPLOY_WEBHOOK_URL
    }
  })

  it('fails safely, scrubbing the password out of pg_dump stderr', async () => {
    const { root, dir } = tempDir()
    const error = await rejection(runBackup('nightly', options(dir, pgDump(root, FAIL_SCRIPT))))

    expect(error.message).toContain('boom')
    expect(error.message).not.toContain('hunter2')
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(path.join(dir, '.backup.lock'))).toBe(false)
  })

  it('needs a database URL and creates nothing without one', async () => {
    const { root, dir } = tempDir()
    const error = await rejection(
      runBackup('nightly', {
        databaseUrl: undefined,
        dir,
        keepDays: 14,
        executable: pgDump(root, OK_SCRIPT),
        now: () => new Date(NOW),
      }),
    )

    expect(error.message).toContain('DATABASE_URL')
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses to overlap a running backup but takes over a stale lock', async () => {
    const { root, dir } = tempDir()
    const executable = pgDump(root, OK_SCRIPT)
    mkdirSync(dir, { recursive: true })
    const lock = path.join(dir, '.backup.lock')
    writeFileSync(lock, '')
    utimesSync(lock, NOW, NOW)

    const error = await rejection(runBackup('nightly', options(dir, executable)))
    expect(error.message).toMatch(/Another database backup/)
    expect(existsSync(lock)).toBe(true)

    const stale = new Date(NOW.getTime() - 46 * 60_000)
    utimesSync(lock, stale, stale)
    const file = await runBackup('nightly', options(dir, executable))
    expect(existsSync(file)).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('prunes old dumps and abandoned temp files, and touches nothing else', async () => {
    const { root, dir } = tempDir()
    mkdirSync(dir, { recursive: true })
    const at = (days: number) => new Date(NOW.getTime() - days * DAY_MS)
    for (const [name, days] of [
      ['doop-old.sql.gz', 15],
      ['doop-recent.sql.gz', 2],
      ['notes.txt', 30],
      ['doop-x.sql.gz.tmp', 2],
    ] as const) {
      const file = path.join(dir, name)
      writeFileSync(file, '')
      utimesSync(file, at(days), at(days))
    }

    const file = await runBackup('nightly', options(dir, pgDump(root, OK_SCRIPT)))
    const names = readdirSync(dir)
    expect(names).not.toContain('doop-old.sql.gz')
    expect(names).toContain('doop-recent.sql.gz')
    expect(names).toContain('notes.txt')
    expect(names).not.toContain('doop-x.sql.gz.tmp')
    expect(existsSync(file)).toBe(true)
  })
})

describe('dumpConnection', () => {
  it('decodes credentials into arguments and the child environment only', () => {
    const connection = dumpConnection('postgres://u%40x:p%40ss@h/db')
    expect(connection.args[connection.args.indexOf('--username') + 1]).toBe('u@x')
    expect(connection.env.PGPASSWORD).toBe('p@ss')
    expect(connection.args).not.toContain('p@ss')
    expect(connection.args.join(' ')).not.toContain('p%40ss')
  })

  it('rejects a URL that is not Postgres', () => {
    expect(() => dumpConnection('mysql://u:p@h/db')).toThrow(BackupFailed)
  })
})

describe('nextNightly', () => {
  it('schedules the same day at 03:17 when it is still ahead', () => {
    const next = nextNightly(new Date(2026, 10, 16, 2, 0, 0))
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([16, 3, 17])
  })

  it('moves to tomorrow at exactly 03:17', () => {
    const next = nextNightly(new Date(2026, 10, 16, 3, 17, 0))
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([17, 3, 17])
  })
})

describe('lastBackupAt', () => {
  it('is null with no backups, and the newest mtime otherwise', async () => {
    const { root } = tempDir()
    expect(await lastBackupAt(path.join(root, 'missing'))).toBeNull()
    const dir = path.join(root, 'backups')
    mkdirSync(dir)
    expect(await lastBackupAt(dir)).toBeNull()

    const older = path.join(dir, 'doop-old.sql.gz')
    const newer = path.join(dir, 'doop-new.sql.gz')
    writeFileSync(older, '')
    writeFileSync(newer, '')
    const olderAt = new Date(NOW.getTime() - DAY_MS)
    utimesSync(older, olderAt, olderAt)
    utimesSync(newer, NOW, NOW)
    expect(await lastBackupAt(dir)).toBe(statSync(newer).mtimeMs)
  })
})

describe('sslmode', () => {
  it('reaches pg_dump only as one of the six libpq values, with no-verify mapped to require', () => {
    const mode = (query: string) => dumpConnection(`postgres://u:p@h/db${query}`).env.PGSSLMODE
    for (const value of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']) {
      expect(mode(`?sslmode=${value}`)).toBe(value)
    }
    expect(mode('?sslmode=no-verify')).toBe('require')
    expect(mode('?sslmode=bogus')).toBeUndefined()
    expect(mode('?sslmode=')).toBeUndefined()
    expect(mode('')).toBeUndefined()
  })
})

describe('a stalled dump', () => {
  it('is killed at the bound, reported, and leaves no lock or temp file', async () => {
    const { root, dir } = tempDir()
    const hang = pgDump(root, 'exec sleep 30')
    const error = await rejection(runBackup('before-v2', { ...options(dir, hang), limitMs: 300 }))
    expect(error.message).toMatch(/took longer than 0 seconds|took longer than \d+ seconds and was stopped/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not stop the nightly schedule: it is armed again before the run starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 16, 2, 0, 0))
      const { root, dir } = tempDir()
      const hang = pgDump(root, 'exec sleep 30')
      const stop = startNightlyBackup({ databaseUrl: DATABASE_URL, dir, keepDays: 14, executable: hang, limitMs: 200 })
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(80 * 60_000)
      /* the run is under way (and will hang until its bound), yet the next night is already scheduled */
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the nightly schedule', () => {
  it('schedules the next run for tomorrow even when the timer fires a little early', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 16, 2, 0, 0))
      const { root, dir } = tempDir()
      const ok = pgDump(root, 'echo dump')
      const delays: number[] = []
      const realSetTimeout = globalThis.setTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0)
        return realSetTimeout(fn, ms)
      }) as typeof setTimeout)
      /* a clock that runs 5 ms behind the timers, so the run fires "early" by its own reading */
      const now = () => new Date(Date.now() - 5)
      const stop = startNightlyBackup({ databaseUrl: DATABASE_URL, dir, keepDays: 14, executable: ok, now })
      const first = delays[0] ?? 0
      expect(first).toBe(77 * 60_000 + 5)
      /* fires when the clock still reads 5 ms before 03:17, as a timer may */
      vi.advanceTimersByTime(first)
      expect(vi.getTimerCount()).toBe(1)
      const second = delays[1] ?? 0
      /* tomorrow's 03:17, a day from today's, not a second away */
      expect(second).toBeGreaterThan(23 * 3_600_000)
      stop()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
})
