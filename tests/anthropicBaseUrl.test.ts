import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_API, userAnthropicClient } from '../server/agentModel.ts'

const PROXY = 'https://llm-proxy.example.test'

afterEach(() => vi.unstubAllEnvs())

describe('ANTHROPIC_BASE_URL', () => {
  it("moves the server key's clients, which are built without a baseURL", () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', PROXY)
    expect(new Anthropic({ apiKey: 'server-key' }).baseURL).toBe(PROXY)
  })

  it('leaves a user’s own Claude key on Anthropic', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', PROXY)
    expect(userAnthropicClient('sk-ant-user-key').baseURL).toBe(ANTHROPIC_API)
  })

  it('falls back to Anthropic when it is set but empty, as docker compose passes it', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', '')
    expect(new Anthropic({ apiKey: 'server-key' }).baseURL).toBe(ANTHROPIC_API)
  })
})
