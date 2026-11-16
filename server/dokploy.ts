import { z } from 'zod'
import { env } from './env.ts'

/**
 * The one door to a Dokploy panel. The base is fixed by the operator (DOOP_DOKPLOY_URL), never taken
 * from a request, and the API key is sent as `x-api-key` to that origin only: redirects are refused so
 * the key cannot follow one elsewhere. An error carries what went wrong in our words (the status, never
 * Dokploy's body), so neither the key nor anything Dokploy echoes can reach a log, a response or
 * status.json.
 *
 * Dokploy's docs show no response shapes, so every answer is read leniently: only the fields used are
 * checked, and an unexpected shape is a DokployError, never a crash.
 */

const TIMEOUT_MS = 15_000

/** A Dokploy call that failed; the message is safe to show an admin. */
export class DokployError extends Error {}

export interface DokployConfig {
  url: string
  apiKey: string
  composeId: string
  timeoutMs?: number
}

export interface Deployment {
  id: string | null
  status: string
  /** ms since the epoch, null when Dokploy sent none we can read */
  createdAt: number | null
}

const composeSchema = z.object({ env: z.string().nullable().optional() })
const deploymentSchema = z.object({
  deploymentId: z.string().optional(),
  id: z.string().optional(),
  status: z.string(),
  createdAt: z.union([z.string(), z.number()]).nullable().optional(),
})

/** The panel this instance updates through, or null when it is not configured for Dokploy. */
export function dokployConfig(): DokployConfig | null {
  const { DOOP_DOKPLOY_URL: url, DOOP_DOKPLOY_API_KEY: apiKey, DOOP_DOKPLOY_COMPOSE_ID: composeId } = env
  if (!url || !apiKey || !composeId) return null
  return { url, apiKey, composeId }
}

function timestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export class DokployClient {
  constructor(private readonly config: DokployConfig) {}

  private async call(method: 'GET' | 'POST', procedure: string, input: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`/api/${procedure}`, this.config.url)
    if (method === 'GET') for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value))
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'x-api-key': this.config.apiKey,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? TIMEOUT_MS),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new DokployError(
        timedOut ? `Dokploy did not answer ${procedure} in time.` : `Dokploy could not be reached for ${procedure}.`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new DokployError(`Dokploy refused the API key (${res.status}) on ${procedure}.`)
    }
    if (res.status === 404) throw new DokployError(`Dokploy does not know that compose service (${procedure}).`)
    if (!res.ok) throw new DokployError(`Dokploy answered ${res.status} to ${procedure}.`)
    const text = await res.text().catch(() => '')
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new DokployError(`Dokploy sent something other than JSON for ${procedure}.`)
    }
  }

  /** The compose's Environment block, exactly as Dokploy holds it. */
  async composeEnv(): Promise<string> {
    const body = composeSchema.safeParse(await this.call('GET', 'compose.one', { composeId: this.config.composeId }))
    if (!body.success) throw new DokployError('Dokploy answered compose.one in a shape Doop does not recognise.')
    return body.data.env ?? ''
  }

  async setComposeEnv(envText: string): Promise<void> {
    await this.call('POST', 'compose.update', { composeId: this.config.composeId, env: envText })
  }

  async redeploy(): Promise<void> {
    await this.call('POST', 'compose.redeploy', { composeId: this.config.composeId })
  }

  async deployments(): Promise<Deployment[]> {
    const raw = await this.call('GET', 'deployment.allByCompose', { composeId: this.config.composeId })
    const list = z.array(z.unknown()).safeParse(raw ?? [])
    if (!list.success)
      throw new DokployError('Dokploy answered deployment.allByCompose in a shape Doop does not recognise.')
    const out: Deployment[] = []
    for (const item of list.data) {
      const parsed = deploymentSchema.safeParse(item)
      if (!parsed.success) {
        throw new DokployError('Dokploy answered deployment.allByCompose in a shape Doop does not recognise.')
      }
      out.push({
        id: parsed.data.deploymentId ?? parsed.data.id ?? null,
        status: parsed.data.status,
        createdAt: timestamp(parsed.data.createdAt),
      })
    }
    return out
  }
}

/** Replace the one `DOOP_TAG=` line, leaving every other byte (CRLF, final newline) as it was. */
export function withTag(envText: string, tag: string): { env: string; previous: string } {
  const pattern = /^([ \t]*DOOP_TAG[ \t]*=)([^\r\n]*)/gm
  const matches = [...envText.matchAll(pattern)]
  if (matches.length === 0) {
    throw new DokployError(
      'The compose Environment has no DOOP_TAG= line, so Doop cannot tell Dokploy which version to run.',
    )
  }
  if (matches.length > 1) {
    throw new DokployError('The compose Environment has more than one DOOP_TAG= line; leave exactly one.')
  }
  const match = matches[0]!
  const previous = match[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  const start = match.index ?? 0
  const replaced = `${envText.slice(0, start)}${match[1]}${tag}${envText.slice(start + match[0].length)}`
  return { env: replaced, previous }
}
