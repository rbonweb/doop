import http from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* every request the stand-in for the Anthropic API received, by model */
const seen: { model: string; stream: boolean }[] = []
let anthropic: http.Server
let server: Server
let admin: Client

beforeAll(async () => {
  anthropic = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const request = JSON.parse(body || '{}')
      seen.push({ model: request.model, stream: Boolean(request.stream) })
      /* a short answer for the Test button; an agent run's stream is refused,
         which is all this test needs to see which model it asked for */
      if (request.stream) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stand-in' } }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => anthropic.listen(0, '127.0.0.1', resolve))
  server = await startServer(4992, {
    ANTHROPIC_API_KEY: 'server-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`,
    DOOP_AGENT_MODEL: 'env-agent-model',
    RESIDENT_TASK_LIMIT: '5',
    ADMIN_EMAILS: 'admin@example.test',
  })
  admin = await new Client(server).signUp('admin@example.test', 'Admin')
}, 70_000)

afterAll(() => {
  server?.stop()
  anthropic?.close()
})

async function waitFor(check: () => boolean, ms = 20_000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe('model settings', () => {
  it('starts from the environment', async () => {
    const models = await (await admin.get('/api/admin/models')).json()
    expect(models).toMatchObject({
      agent: { value: 'env-agent-model', default: 'env-agent-model' },
      distill: { value: 'claude-haiku-4-5-20251001' },
      serverKey: true,
    })
    expect(models.baseUrl).toContain('127.0.0.1')
  })

  it('tests a name with one call on the server key', async () => {
    const result = await (await admin.post('/api/admin/models/test', { model: 'proxy/opus-latest' })).json()
    expect(result).toEqual({ ok: true, model: 'proxy/opus-latest' })
    expect(seen.at(-1)).toEqual({ model: 'proxy/opus-latest', stream: false })
  })

  it('changes the agent model without a restart', async () => {
    const res = await admin.req('/api/admin/models', {
      method: 'PUT',
      body: JSON.stringify({ agent: 'proxy/opus-latest' }),
    })
    expect((await res.json()).agent.value).toBe('proxy/opus-latest')
    const stored = JSON.parse(readFileSync(path.join(server.dataDir, 'data', 'instance.json'), 'utf8'))
    expect(stored.agentModel).toBe('proxy/opus-latest')

    /* a card queued now runs on the new name */
    const [canvas] = await (await admin.get('/api/canvases')).json()
    const before = seen.length
    expect((await admin.post(`/api/canvases/${canvas.id}/cards`, { title: 'A pricing section' })).status).toBe(200)
    await waitFor(() => seen.slice(before).some((r) => r.stream))
    expect(seen.slice(before).find((r) => r.stream)?.model).toBe('proxy/opus-latest')
  })

  it('refuses what is not a model name, and goes back to the default on an empty one', async () => {
    const bad = await admin.req('/api/admin/models', { method: 'PUT', body: JSON.stringify({ agent: 'two words' }) })
    expect(bad.status).toBe(400)
    const reset = await admin.req('/api/admin/models', { method: 'PUT', body: JSON.stringify({ agent: '' }) })
    expect((await reset.json()).agent.value).toBe('env-agent-model')
  })

  it('is for admins only', async () => {
    const member = await new Client(server).signUp('member@example.test', 'Member')
    expect((await member.get('/api/admin/models')).status).toBe(404)
  })
})
