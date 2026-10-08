import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UpdateInfo, UpdateRelease, UpdateStatus } from '../shared/selfUpdate.ts'

/**
 * Updating a deployed instance from its Admin page.
 *
 * The release workflow publishes every release twice: as a GitHub release and
 * as a container image of the same tag. This module reads the latest release
 * and, when an admin asks for it, leaves a request in a folder it shares with
 * the host. It never touches Docker itself: deploy/doop.sh, started on the
 * host by a systemd path unit when the request appears, pulls the image,
 * restarts the app, and writes its progress to status.json, which this module
 * reads back. A compromised app can therefore ask for the latest release and
 * nothing else.
 *
 *   DOOP_VERSION      the release this image was built as (baked in by the Dockerfile)
 *   DOOP_UPDATE_REPO  owner/repo whose releases to follow
 *   DOOP_UPDATE_DIR   the folder the host's updater watches; unset = no button
 *   DOOP_UPDATE_API   the GitHub API base, overridden only by tests
 */

const CURRENT = process.env.DOOP_VERSION || 'dev'
const REPO = process.env.DOOP_UPDATE_REPO || ''
const DIR = process.env.DOOP_UPDATE_DIR || ''
const API = (process.env.DOOP_UPDATE_API || 'https://api.github.com').replace(/\/$/, '')

/* GitHub allows 60 anonymous API calls an hour per address */
const CACHE_MS = 10 * 60_000
/* the shape of a tag the host's updater will act on, checked on both sides */
const TAG = /^v[0-9A-Za-z][0-9A-Za-z.-]*$/

const releaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  html_url: z.string(),
  published_at: z.string().nullable(),
})

const statusSchema = z.object({
  state: z.enum(['idle', 'requested', 'running', 'succeeded', 'failed']),
  tag: z.string().optional(),
  at: z.number().optional(),
  message: z.string().optional(),
})

export class UpdateRefused extends Error {}

let cached: { at: number; release: UpdateRelease | null } | null = null

async function latestRelease(fresh: boolean): Promise<UpdateRelease | null> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.release
  const res = await fetch(`${API}/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'doop-self-update' },
    signal: AbortSignal.timeout(10_000),
  })
  /* a repository with no release yet answers 404 */
  if (res.status === 404) {
    cached = { at: Date.now(), release: null }
    return null
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = releaseSchema.parse(await res.json())
  const release = {
    tag: body.tag_name,
    name: body.name || body.tag_name,
    url: body.html_url,
    publishedAt: body.published_at ?? '',
  }
  cached = { at: Date.now(), release }
  return release
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

async function readStatus(): Promise<UpdateStatus> {
  if (!DIR) return { state: 'idle' }
  let status: UpdateStatus = { state: 'idle' }
  try {
    status = statusSchema.parse(JSON.parse(await fs.readFile(path.join(DIR, 'status.json'), 'utf8')))
  } catch {
    /* nothing installed yet, or a file mid-write: report idle */
  }
  /* the host has not picked the request up yet */
  if (status.state !== 'running' && (await exists(path.join(DIR, 'request.json')))) {
    try {
      const request = z
        .object({ tag: z.string(), at: z.number() })
        .parse(JSON.parse(await fs.readFile(path.join(DIR, 'request.json'), 'utf8')))
      return { state: 'requested', tag: request.tag, at: request.at }
    } catch {
      return { state: 'requested' }
    }
  }
  return status
}

/** The version card's contents. `fresh` skips the cache (the Check again button). */
export async function updateInfo(fresh = false): Promise<UpdateInfo> {
  const status = await readStatus()
  let latest: UpdateRelease | null = null
  let error: string | undefined
  if (REPO) {
    try {
      latest = await latestRelease(fresh)
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not reach GitHub'
    }
  }
  return {
    current: CURRENT,
    enabled: Boolean(DIR && REPO),
    latest,
    updateAvailable: latest !== null && latest.tag !== CURRENT,
    status,
    ...(error ? { error } : {}),
  }
}

/** Ask the host to install `tag`, which must be the latest release. */
export async function requestUpdate(tag: string, requestedBy: string): Promise<UpdateInfo> {
  if (!DIR || !REPO) throw new UpdateRefused('This server installs updates from its command line only.')
  if (!TAG.test(tag)) throw new UpdateRefused('That is not a release tag.')
  const latest = await latestRelease(true)
  if (!latest || latest.tag !== tag) throw new UpdateRefused('Only the latest release can be installed.')
  if (tag === CURRENT) throw new UpdateRefused(`This server already runs ${tag}.`)
  const status = await readStatus()
  if (status.state === 'requested' || status.state === 'running') {
    throw new UpdateRefused('An update is already under way.')
  }
  /* written whole, then renamed, so the watcher never reads half a file */
  const file = path.join(DIR, 'request.json')
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ tag, requestedBy, at: Date.now() }))
  await fs.rename(`${file}.tmp`, file)
  return updateInfo()
}
