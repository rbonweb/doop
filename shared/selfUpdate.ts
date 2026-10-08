/** A published release, as the Admin page's version card shows it. */
export interface UpdateRelease {
  tag: string
  name: string
  url: string
  publishedAt: string
}

/** Where an update stands, as the host's updater last reported it. */
export type UpdateState = 'idle' | 'requested' | 'running' | 'succeeded' | 'failed'

export interface UpdateStatus {
  state: UpdateState
  /** the release being, or last, installed */
  tag?: string
  /** when the state last changed, ms since the epoch */
  at?: number
  message?: string
}

export interface UpdateInfo {
  /** the release this server runs; 'dev' for an image built by hand */
  current: string
  /** whether this server can install an update itself (its host runs the updater) */
  enabled: boolean
  latest: UpdateRelease | null
  updateAvailable: boolean
  status: UpdateStatus
  /** why the latest release could not be read */
  error?: string
}
