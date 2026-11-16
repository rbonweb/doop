import { env } from './env.ts'

/**
 * The one call Doop makes to a Dokploy panel: a POST to the compose service's deploy webhook. The
 * webhook can redeploy that one service and nothing else, which is why Doop holds it instead of an
 * API key (a key controls every app on the panel).
 *
 * The URL is the whole credential, so it never leaves this module: not in a log line, a response,
 * status.json or an error. Every error is written in our words and names only "the Dokploy webhook"
 * and the HTTP status. Redirects are never followed, so the URL cannot lead anywhere else.
 */

const TIMEOUT_MS = 15_000
/* a real answer is a few hundred bytes; anything past this is not Dokploy answering */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** A webhook call that failed; the message is safe to show an admin. */
export class DokployError extends Error {}

export interface WebhookOptions {
  timeoutMs?: number
}

/** The webhook this instance updates through, or null when it is not configured for Dokploy. */
export function dokployWebhookUrl(): string | null {
  return env.DOOP_DOKPLOY_WEBHOOK_URL ?? null
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {})
    return ''
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return ''
      }
      chunks.push(value)
    }
  } catch {
    return ''
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Ask Dokploy to redeploy the service. Resolves when Dokploy accepted it; otherwise throws a
 * DokployError whose message tells the admin what to do.
 */
export async function triggerDeploy(webhookUrl: string, options: WebhookOptions = {}): Promise<void> {
  let res: Response
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      /* a redirect is Dokploy's answer, never somewhere to go */
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new DokployError(
      timedOut ? 'The Dokploy webhook did not answer in time.' : 'The Dokploy webhook could not be reached.',
    )
  }
  const body = await readCapped(res)
  if (res.status >= 200 && res.status < 300) return
  if (res.status === 400 && /automatic deployments are disabled/i.test(body)) {
    throw new DokployError('Turn on Autodeploy for this service in Dokploy (General tab).')
  }
  if (res.status === 404) {
    throw new DokployError("Dokploy does not know this webhook; copy it again from the service's Deployments tab.")
  }
  if (res.status === 301) {
    throw new DokployError(
      'Dokploy refused the webhook: this service deploys from git; Update now needs a Raw compose.',
    )
  }
  throw new DokployError(`Dokploy answered the webhook with ${res.status}.`)
}
