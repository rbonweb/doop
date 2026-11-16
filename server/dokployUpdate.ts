import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UpdateStatus } from '../shared/selfUpdate.ts'
import { BackupFailed, runBackup } from './dbBackup.ts'
import { DokployClient, DokployError, dokployConfig, withTag, type DokployConfig } from './dokploy.ts'

/**
 * Update now on a Dokploy install. The compose names its image `...:${DOOP_TAG}` and DOOP_TAG lives in
 * the service's Environment in Dokploy, so an update is: back the database up, put the new tag in that
 * Environment, ask Dokploy to redeploy, and watch the deployment while this process is still up.
 *
 * The app writes status.json itself here (the host's doop.sh writes it for a folder install). A failed
 * deployment puts the previous tag back, so the Environment never keeps naming a version that did not
 * install. If the new release starts and then crashes there is nothing left running to roll back:
 * the backup exists, and deploy/README.md says how to set DOOP_TAG back by hand.
 *
 * Nothing secret reaches the status file, the logs or a response: DokployError and BackupFailed
 * messages are written in our words, and anything else becomes a generic line.
 */

const STATUS_DIR = path.join(process.cwd(), 'data', 'updates')
const POLL_MS = 5_000
const WATCH_MS = 15 * 60_000
/* Dokploy says done but this process still runs the old version: the container was not replaced */
const DONE_GRACE_MS = 60_000
/* a running record this old, with another version running, belongs to an install that never happened */
const STALE_MS = 20 * 60_000

interface StatusRecord {
  state: 'running' | 'succeeded' | 'failed'
  tag: string
  previous: string
  at: number
  message: string
}

const recordSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed']),
  tag: z.string(),
  previous: z.string(),
  at: z.number(),
  message: z.string(),
})

export interface UpdaterOptions {
  /** the release this process runs */
  current: string
  config: DokployConfig
  statusDir?: string
  backup?: (label: string) => Promise<string>
  pollMs?: number
  watchMs?: number
  doneGraceMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function describeFailure(e: unknown): string {
  if (e instanceof DokployError || e instanceof BackupFailed) return e.message
  return 'An unexpected error stopped the update.'
}

/** The watch ran out while Dokploy was still deploying: not a failure to undo, the deployment may yet finish. */
class StillInstalling extends DokployError {}

const STILL_INSTALLING = 'Dokploy is still installing'

export class DokployUpdater {
  private readonly client: DokployClient
  private readonly dir: string
  private readonly file: string
  private readonly backup: (label: string) => Promise<string>
  private readonly pollMs: number
  private readonly watchMs: number
  private readonly doneGraceMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private reserved = false
  private inFlight = false
  /** resolves when the running update ends; tests await it */
  idle: Promise<void> = Promise.resolve()

  constructor(private readonly options: UpdaterOptions) {
    this.client = new DokployClient(options.config)
    this.dir = options.statusDir ?? STATUS_DIR
    this.file = path.join(this.dir, 'status.json')
    this.backup = options.backup ?? ((label) => runBackup(label))
    this.pollMs = options.pollMs ?? POLL_MS
    this.watchMs = options.watchMs ?? WATCH_MS
    this.doneGraceMs = options.doneGraceMs ?? DONE_GRACE_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** An update is under way in this process. */
  get busy(): boolean {
    return this.reserved
  }

  /** Claim the one update slot synchronously, before any await, so two clicks cannot both start. */
  reserve(): boolean {
    if (this.reserved) return false
    this.reserved = true
    return true
  }

  release(): void {
    this.reserved = false
  }

  private async write(record: Omit<StatusRecord, 'at'>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ ...record, at: this.now() }), { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  private async read(): Promise<StatusRecord | null> {
    try {
      return recordSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  /**
   * The status as the version card shows it. A running record is settled here rather than only at
   * boot: it succeeded once this process is the tag it names, and it failed once it is older than
   * the watch could last and nothing in this process is still on it.
   */
  async status(): Promise<UpdateStatus> {
    let record = await this.read()
    if (!record) return { state: 'idle' }
    if (record.state === 'running' && !this.inFlight) {
      if (record.tag === this.options.current) {
        record = { ...record, state: 'succeeded', message: `Updated to ${record.tag}.`, at: this.now() }
        await this.write(record).catch(() => {})
      } else if (this.now() - record.at > STALE_MS) {
        record = {
          ...record,
          state: 'failed',
          message: `Dokploy did not install ${record.tag}; ${this.options.current} is running.`,
          at: this.now(),
        }
        await this.write(record).catch(() => {})
      }
    }
    /* the deployment outlasted the watch but finished: this process is the new version */
    if (
      record.state === 'failed' &&
      record.tag === this.options.current &&
      record.message.startsWith(STILL_INSTALLING)
    ) {
      record = { ...record, state: 'succeeded', message: `Updated to ${record.tag}.`, at: this.now() }
      await this.write(record).catch(() => {})
    }
    return { state: record.state, tag: record.tag, at: record.at, message: record.message }
  }

  /** Settle a record left by the process this one replaced. Call once at boot. */
  async settleAtBoot(): Promise<void> {
    await this.status()
  }

  /**
   * Begin an update to `tag`. The slot must be reserved. The first record is written before this
   * returns, so the card shows it at once; the rest runs in the background.
   */
  async start(tag: string): Promise<void> {
    const previous = this.options.current
    try {
      await this.write({ state: 'running', tag, previous, message: 'Backing up the database…' })
    } catch (e) {
      this.release()
      throw e
    }
    this.inFlight = true
    this.idle = this.run(tag, previous).finally(() => {
      this.inFlight = false
      this.release()
    })
  }

  private async fail(tag: string, previous: string, message: string): Promise<void> {
    await this.write({ state: 'failed', tag, previous, message }).catch((e) =>
      console.error('[update] could not record the failure:', e instanceof Error ? e.message : 'error'),
    )
  }

  private async run(tag: string, previous: string): Promise<void> {
    let wrote = false
    let original = ''
    /* the DOOP_TAG value to put back: what the Environment names, which need not equal the running version's name */
    let oldTag = previous
    try {
      /* the Environment is checked before the backup, so a bad key or a missing DOOP_TAG does not cost a dump */
      withTag(await this.client.composeEnv(), tag)
      await this.backup(`before-${tag}`)
      await this.write({ state: 'running', tag, previous, message: `Asking Dokploy to install ${tag}…` })
      original = await this.client.composeEnv()
      const swapped = withTag(original, tag)
      const next = swapped.env
      oldTag = swapped.previous || previous
      const known = new Set((await this.client.deployments()).map((d) => d.id).filter((id) => id !== null))
      const startedAt = this.now()
      wrote = true
      await this.client.setComposeEnv(next)
      await this.write({
        state: 'running',
        tag,
        previous: oldTag,
        message: `Dokploy is installing ${tag}; Doop restarts and this page reloads.`,
      })
      await this.client.redeploy()
      await this.watch(tag, previous, known, startedAt)
    } catch (e) {
      const reason = describeFailure(e)
      if (!(e instanceof DokployError || e instanceof BackupFailed)) {
        console.error('[update] unexpected failure:', e instanceof Error ? e.name : 'error')
      }
      if (e instanceof StillInstalling) {
        /* the tag stays: the deployment may still finish, and the next boot marks it done */
        await this.fail(tag, oldTag, e.message)
        return
      }
      const reverted = wrote ? await this.revert(oldTag, original) : true
      await this.fail(tag, oldTag, this.failureText(reason, wrote, reverted, previous, oldTag))
    }
  }

  private failureText(reason: string, wrote: boolean, reverted: boolean, running: string, oldTag: string): string {
    if (!wrote) return `${reason} Nothing was changed; ${running} is still running.`
    if (reverted) return `${reason} DOOP_TAG is back at ${oldTag}, and ${running} is still running.`
    return `${reason} DOOP_TAG could not be set back: set it to ${oldTag} in Dokploy.`
  }

  /** Put the previous tag back in the Environment: re-read it first so other edits survive. */
  private async revert(previous: string, original: string): Promise<boolean> {
    try {
      await this.client.setComposeEnv(withTag(await this.client.composeEnv(), previous).env)
      return true
    } catch {
      try {
        await this.client.setComposeEnv(original)
        return true
      } catch {
        return false
      }
    }
  }

  /** Follow the deployment this update started until it ends, or this process is replaced. */
  private async watch(tag: string, previous: string, known: Set<string | null>, startedAt: number): Promise<void> {
    const deadline = this.now() + this.watchMs
    let doneAt: number | null = null
    /* one look at the deployment this update started; throws only when it ended badly */
    const look = async (): Promise<void> => {
      let list
      try {
        list = await this.client.deployments()
      } catch {
        /* Dokploy may be restarting itself; the next look tries again */
        return
      }
      const fresh = list
        .filter((d) => (d.id !== null ? !known.has(d.id) : d.createdAt !== null && d.createdAt >= startedAt - 60_000))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      if (!fresh) return
      if (fresh.status === 'error' || fresh.status === 'cancelled') {
        throw new DokployError(
          `Dokploy could not install ${tag} (the deployment ${fresh.status === 'error' ? 'failed' : 'was cancelled'}).`,
        )
      }
      if (fresh.status === 'done') {
        doneAt ??= this.now()
        if (this.now() - doneAt > this.doneGraceMs) {
          throw new DokployError(`Dokploy finished deploying ${tag}, but ${previous} is still running.`)
        }
      }
    }
    while (this.now() < deadline) {
      await this.sleep(this.pollMs)
      await look()
    }
    /* out of time: look once more, and unless it ended badly leave the tag where it is */
    await look()
    throw new StillInstalling(
      `${STILL_INSTALLING} ${tag}; check its deployment log in Dokploy. DOOP_TAG was left at ${tag}.`,
    )
  }
}

let shared: DokployUpdater | null | undefined

/** The updater for this process's configuration, or null when this is not a Dokploy install. */
export function dokployUpdater(current: string): DokployUpdater | null {
  if (shared === undefined) {
    const config = dokployConfig()
    shared = config ? new DokployUpdater({ current, config }) : null
  }
  return shared
}
