import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UpdateStatus } from '../shared/selfUpdate.ts'
import { BackupFailed, runBackup } from './dbBackup.ts'
import { DokployError, dokployWebhookUrl, triggerDeploy } from './dokploy.ts'

/**
 * Update now on a Dokploy install. The compose follows the image's `latest` tag, so an update is:
 * back the database up, then call the service's deploy webhook once. Dokploy pulls the newest
 * release and restarts Doop; nothing else is written to Dokploy, and Doop holds no API key.
 *
 * The app writes status.json itself here (the host's doop.sh writes it for a folder install). The
 * record stays `running` until a process whose DOOP_VERSION is the tag settles it as `succeeded`
 * (at boot, or when the card next reads it); one older than 20 minutes with another version
 * running is `failed`. If the new release starts and then crashes nothing is left to roll back:
 * the backup exists, and deploy/README.md says how to pin the previous release by hand.
 *
 * The webhook URL is the credential: it never reaches the status file, the logs or a response.
 * DokployError and BackupFailed messages are written in our words, and anything else becomes a
 * generic line.
 */

const STATUS_DIR = path.join(process.cwd(), 'data', 'updates')
/* a running record this old, with another version running, belongs to an install that never happened */
const STALE_MS = 20 * 60_000
/* a failed record may still turn out to have installed, for this long after it was written */
const FAILED_GRACE_MS = 60 * 60_000

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
  webhookUrl: string
  statusDir?: string
  backup?: (label: string) => Promise<string>
  /** per-call bound for the webhook; tests shorten it */
  timeoutMs?: number
  now?: () => number
}

function describeFailure(e: unknown): string {
  if (e instanceof DokployError || e instanceof BackupFailed) return e.message
  return 'An unexpected error stopped the update.'
}

export class DokployUpdater {
  private readonly dir: string
  private readonly file: string
  private readonly backup: (label: string) => Promise<string>
  private readonly now: () => number
  private reserved = false
  private inFlight = false
  /** resolves when the running update ends; tests await it */
  idle: Promise<void> = Promise.resolve()

  constructor(private readonly options: UpdaterOptions) {
    this.dir = options.statusDir ?? STATUS_DIR
    this.file = path.join(this.dir, 'status.json')
    this.backup = options.backup ?? ((label) => runBackup(label))
    this.now = options.now ?? Date.now
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
   * The status as the version card shows it. A record is settled here rather than only at boot.
   * It succeeded once this process runs the tag it names, or any other release than the one that
   * was running when the update was asked for (the compose follows `latest`, so a newer release
   * may have landed between the click and the pull). That also rescues a `failed` record written
   * after Dokploy had already queued the deploy (a timeout, a 5xx), for an hour. A `running` one
   * older than 20 minutes with the same version still running failed.
   */
  async status(): Promise<UpdateStatus> {
    let record = await this.read()
    if (!record) return { state: 'idle' }
    const installed = record.tag === this.options.current || record.previous !== this.options.current
    const recent = this.now() - record.at < FAILED_GRACE_MS
    if (!this.inFlight && installed && (record.state === 'running' || (record.state === 'failed' && recent))) {
      record = {
        ...record,
        state: 'succeeded',
        tag: this.options.current,
        message: `Updated to ${this.options.current}.`,
        at: this.now(),
      }
      await this.write(record).catch(() => {})
    } else if (record.state === 'running' && !this.inFlight) {
      if (this.now() - record.at > STALE_MS) {
        record = {
          ...record,
          state: 'failed',
          message: `Dokploy has not installed ${record.tag} after 20 minutes. Check the service's deployment log in Dokploy. If DOOP_TAG is set in its Environment, clear it so the service follows the latest release.`,
          at: this.now(),
        }
        await this.write(record).catch(() => {})
      }
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
    let reachedDokploy = false
    try {
      await this.backup(`before-${tag}`)
      await this.write({ state: 'running', tag, previous, message: `Asking Dokploy to install ${tag}…` })
      reachedDokploy = true
      await triggerDeploy(this.options.webhookUrl, { timeoutMs: this.options.timeoutMs })
      await this.write({
        state: 'running',
        tag,
        previous,
        message: `Dokploy is installing ${tag}; Doop restarts and this page reloads.`,
      })
    } catch (e) {
      const reason = describeFailure(e)
      if (!(e instanceof DokployError || e instanceof BackupFailed)) {
        console.error('[update] unexpected failure:', e instanceof Error ? e.name : 'error')
      }
      /* a webhook answer is shown as it is; a backup failure says nothing was changed */
      await this.fail(
        tag,
        previous,
        reachedDokploy ? reason : `${reason} Nothing was changed; ${previous} is still running.`,
      )
    }
  }
}

let shared: DokployUpdater | null | undefined

/** The updater for this process's configuration, or null when this is not a Dokploy install. */
export function dokployUpdater(current: string): DokployUpdater | null {
  if (shared === undefined) {
    const webhookUrl = dokployWebhookUrl()
    shared = webhookUrl ? new DokployUpdater({ current, webhookUrl }) : null
  }
  return shared
}
