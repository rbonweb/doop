import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { env } from './env.ts'

/**
 * The in-process database backup: `pg_dump` (the Postgres 16 client in the runtime image) against
 * DATABASE_URL, gzipped into DOOP_BACKUP_DIR, as deploy/doop.sh's `backup` does for a folder install.
 * Update now runs one before it touches anything, and a Dokploy install also gets one every night,
 * since Dokploy has no host cron to run doop.sh.
 *
 * The dump runs without a shell, with the connection split into arguments, and the password goes in
 * the child's environment (PGPASSWORD), never on its command line. The file is written under a temp
 * name and renamed once complete, so a half dump never looks like a backup. One backup runs at a
 * time: a lock file, so a nightly run and an update never overlap.
 */

const PG_DUMP = '/usr/bin/pg_dump'
const NIGHTLY = { hour: 3, minute: 17 }
/* a backup this recent is as good as tonight's */
const NIGHTLY_SKIP_MS = 20 * 3_600_000
/* a dump is stopped after this long */
const DUMP_LIMIT_MS = 30 * 60_000
/* a running dump touches its lock every minute, so a lock this old belongs to a process that died */
const LOCK_TOUCH_MS = 60_000
const LOCK_STALE_MS = 45 * 60_000
const DAY_MS = 86_400_000
const BACKUP_FILE = /^doop-.+\.sql\.gz$/
/* how much of pg_dump's own complaint is worth keeping */
const STDERR_LIMIT = 2_000

/** A backup that did not finish; the message is safe to show an admin. */
export class BackupFailed extends Error {}

export interface BackupOptions {
  /** defaults to DATABASE_URL */
  databaseUrl?: string | undefined
  /** defaults to DOOP_BACKUP_DIR */
  dir?: string
  /** defaults to DOOP_BACKUP_KEEP_DAYS */
  keepDays?: number
  /** the pg_dump binary; tests point it at a script */
  executable?: string
  now?: () => Date
  /** how long a dump may run; tests shorten it */
  limitMs?: number
}

export interface Connection {
  args: string[]
  /** PGPASSWORD and friends, for the child's environment */
  env: Record<string, string>
  secrets: string[]
}

/** Split a Postgres URL into pg_dump arguments and environment; nothing secret lands in the arguments. */
export function dumpConnection(databaseUrl: string): Connection {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new BackupFailed('DATABASE_URL is not a Postgres URL.')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new BackupFailed('DATABASE_URL is not a Postgres URL.')
  }
  const args = ['--no-password']
  const childEnv: Record<string, string> = {}
  const secrets: string[] = []
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host) args.push('--host', host)
  if (url.port) args.push('--port', url.port)
  if (url.username) args.push('--username', decodeURIComponent(url.username))
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (database) args.push('--dbname', database)
  if (url.password) {
    childEnv.PGPASSWORD = decodeURIComponent(url.password)
    secrets.push(childEnv.PGPASSWORD, url.password)
  }
  /* libpq knows six values; node-pg's `no-verify` is the closest to `require` */
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode === 'no-verify') childEnv.PGSSLMODE = 'require'
  else if (sslmode && ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    childEnv.PGSSLMODE = sslmode
  }
  return { args, env: childEnv, secrets }
}

function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (secret) out = out.split(secret).join('***')
  return out
}

/** `20261116-031700`, UTC, as doop.sh names its dumps. */
export function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-')
}

async function dump(file: string, connection: Connection, executable: string, limitMs: number): Promise<void> {
  const child = spawn(executable, connection.args, {
    /* a fixed environment: the dump gets its connection and nothing else the server holds */
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...connection.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    /* its own process group, so a stalled dump is killed with whatever it started */
    detached: true,
  })
  let timedOut = false
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
    child.stdout.destroy(new Error('timed out'))
  }, limitMs)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  /* a failed spawn rejects `exit` before the pipeline sees it */
  exit.catch(() => {})
  try {
    await pipeline(child.stdout, createGzip(), createWriteStream(file, { mode: 0o600 }))
    const code = await exit
    if (code !== 0) throw new Error(`pg_dump exited with ${code}`)
  } catch (e) {
    stop()
    if (timedOut) {
      throw new BackupFailed(
        `The database backup took longer than ${limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} minutes` : `${Math.round(limitMs / 1000)} seconds`} and was stopped.`,
      )
    }
    const reason = e instanceof Error ? e.message : 'unknown error'
    const detail = scrub(stderr.trim(), connection.secrets)
    throw new BackupFailed(
      `The database backup failed (${scrub(reason, connection.secrets)}).${detail ? ` ${detail}` : ''}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function acquire(lock: string, now: number): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600)
      await handle.close()
      return () => fs.rm(lock, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const age = await fs.stat(lock).then(
        (s) => now - s.mtimeMs,
        () => 0,
      )
      if (age < LOCK_STALE_MS) throw new BackupFailed('Another database backup is running.')
      await fs.rm(lock, { force: true })
    }
  }
  throw new BackupFailed('Another database backup is running.')
}

/** Backups past their keep window, and temp files a crash left behind; the file just written is never touched. */
export async function pruneBackups(dir: string, keepDays: number, keep: string, now: number): Promise<string[]> {
  const removed: string[] = []
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const file = path.join(dir, name)
    if (file === keep) continue
    const isBackup = BACKUP_FILE.test(name)
    const isTemp = /^doop-.+\.sql\.gz\.tmp$/.test(name)
    if (!isBackup && !isTemp) continue
    const mtime = await fs.stat(file).then(
      (s) => s.mtimeMs,
      () => null,
    )
    if (mtime === null) continue
    if (now - mtime > (isTemp ? DAY_MS : keepDays * DAY_MS)) {
      await fs.rm(file, { force: true })
      removed.push(name)
    }
  }
  return removed
}

/**
 * Dump the database to `<dir>/doop-<stamp>-<label>.sql.gz` and prune old ones. `label` is
 * `before-<tag>` for an update and `nightly` for the schedule. Resolves to the file written.
 */
export async function runBackup(label: string, options: BackupOptions = {}): Promise<string> {
  const databaseUrl = 'databaseUrl' in options ? options.databaseUrl : env.DATABASE_URL
  const dir = options.dir ?? env.DOOP_BACKUP_DIR
  const keepDays = options.keepDays ?? env.DOOP_BACKUP_KEEP_DAYS
  const now = options.now ?? (() => new Date())
  if (!databaseUrl) {
    throw new BackupFailed('The database backup needs DATABASE_URL, a Postgres the server can reach.')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new BackupFailed('That is not a backup label.')
  const connection = dumpConnection(databaseUrl)
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  } catch {
    throw new BackupFailed(`The backup folder ${dir} cannot be created.`)
  }
  const lock = path.join(dir, '.backup.lock')
  const release = await acquire(lock, now().getTime())
  /* a long legitimate dump keeps its lock fresh, so nothing takes it over */
  const touch = setInterval(() => {
    const at = now()
    void fs.utimes(lock, at, at).catch(() => {})
  }, LOCK_TOUCH_MS)
  touch.unref()
  try {
    const final = path.join(dir, `doop-${stamp(now())}-${label}.sql.gz`)
    const temp = `${final}.tmp`
    try {
      await dump(temp, connection, options.executable ?? PG_DUMP, options.limitMs ?? DUMP_LIMIT_MS)
      await fs.rename(temp, final)
    } catch (e) {
      await fs.rm(temp, { force: true })
      if (e instanceof BackupFailed) throw e
      throw new BackupFailed(
        `The database backup failed (${scrub(e instanceof Error ? e.message : 'error', connection.secrets)}).`,
      )
    }
    await pruneBackups(dir, keepDays, final, now().getTime()).catch((e) =>
      console.error('[backup] pruning old backups failed:', e instanceof Error ? e.message : e),
    )
    return final
  } finally {
    clearInterval(touch)
    await release()
  }
}

/** When the lastest backup in `dir` was written, ms since the epoch, or null when there is none. */
export async function lastBackupAt(dir: string): Promise<number | null> {
  let latest: number | null = null
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!BACKUP_FILE.test(name)) continue
    const mtime = await fs.stat(path.join(dir, name)).then(
      (s) => s.mtimeMs,
      () => null,
    )
    if (mtime !== null && (latest === null || mtime > latest)) latest = mtime
  }
  return latest
}

/** The next 03:17 server time after `from`. */
export function nextNightly(from: Date): Date {
  const next = new Date(from)
  next.setHours(NIGHTLY.hour, NIGHTLY.minute, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/**
 * Every night at 03:17 server time, unless a backup was written in the last 20 hours. A failure is
 * logged and the next night tries again. Returns a function that stops the schedule.
 */
export function startNightlyBackup(options: BackupOptions = {}): () => void {
  let timer: NodeJS.Timeout | undefined
  const now = options.now ?? (() => new Date())
  const arm = () => {
    const wait = nextNightly(now()).getTime() - now().getTime()
    timer = setTimeout(
      () => {
        /* armed again before tonight's run starts, so no outcome of it can stop the schedule */
        arm()
        void tonight()
      },
      /* setTimeout caps at 2^31 ms; a day is far under it */
      Math.max(1_000, wait),
    )
    timer.unref()
  }
  const tonight = async () => {
    try {
      const dir = options.dir ?? env.DOOP_BACKUP_DIR
      const last = await lastBackupAt(dir)
      if (last !== null && now().getTime() - last < NIGHTLY_SKIP_MS) return
      const file = await runBackup('nightly', options)
      console.log(`[backup] nightly backup written: ${path.basename(file)}`)
    } catch (e) {
      console.error('[backup] nightly backup failed:', e instanceof Error ? e.message : 'unknown error')
    }
  }
  arm()
  return () => clearTimeout(timer)
}
