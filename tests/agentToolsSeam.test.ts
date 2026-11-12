import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentToolContext } from '../server/agentTools/context.ts'
import { buildMcpServer } from '../server/mcp.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* The seam is mocked around the real registration so a test can see the call, leave the areas out to get the tool list as it was before the seam, or add a probe tool of its own. */
const seam = vi.hoisted(() => ({
  calls: [] as { server: unknown; ctx: unknown }[],
  skipAreas: false,
  probe: undefined as ((server: unknown, ctx: unknown) => void) | undefined,
}))

vi.mock('../server/agentTools/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/agentTools/index.ts')>()
  return {
    registerAgentSpeedTools: (server: Parameters<typeof real.registerAgentSpeedTools>[0], ctx: AgentToolContext) => {
      seam.calls.push({ server, ctx })
      if (!seam.skipAreas) real.registerAgentSpeedTools(server, ctx)
      seam.probe?.(server, ctx)
    },
  }
})

beforeEach(() => {
  seam.calls = []
  seam.skipAreas = false
  seam.probe = undefined
})

async function toolNames(): Promise<string[]> {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'seam-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools.map((tool) => tool.name).sort()
}

it('registers the agent speed tools once per MCP session and adds no tool of its own yet', async () => {
  seam.skipAreas = true
  const before = await toolNames()
  expect(seam.calls).toHaveLength(1)

  seam.skipAreas = false
  seam.calls = []
  const after = await toolNames()
  expect(seam.calls).toHaveLength(1)
  /* every tool of before is still there, under the same name; the areas' own tools come on top as each lands */
  expect(after).toEqual(expect.arrayContaining(before))
  expect(before).toEqual(expect.arrayContaining(['get_canvas', 'get_frame', 'get_guide', 'set_frame_html']))
})

it('hands the tools the session helpers', async () => {
  await toolNames()
  const ctx = seam.calls[0]?.ctx as AgentToolContext
  for (const helper of [
    'actorFrom',
    'arrive',
    'canvasFor',
    'frameFor',
    'noCanvas',
    'noFrame',
    'err',
    'text',
    'textWithNudge',
    'withFeedback',
    'withFeedbackNotice',
    'withStatusNudge',
    'withGuidelinesNudge',
    'withPreview',
    'frameSummary',
    'takeSlot',
  ] as const)
    expect(typeof ctx[helper], helper).toBe('function')
  expect(ctx.ownerId).toBe('test-owner-id')
  expect(ctx.owner).toBe('Test Owner')
  expect(ctx.reviewNudge).toContain('get_frame_screenshot')
  expect(ctx.err('nope')).toMatchObject({ isError: true, content: [{ text: 'Error: nope' }] })
  /* a rolling-minute budget per bucket and user */
  expect([1, 2, 3].map(() => ctx.takeSlot('seam-test', 'u1', 2))).toEqual([true, true, false])
  expect(ctx.takeSlot('seam-test', 'u2', 2)).toBe(true)
})

it('lists a tool registered through the seam like any other', async () => {
  seam.probe = (server, ctx) => {
    const c = ctx as AgentToolContext
    ;(server as { registerTool: (...args: unknown[]) => unknown }).registerTool(
      'seam_probe',
      { description: 'probe', inputSchema: { agent_name: c.agentName } },
      async () => c.text('ok'),
    )
    expect(c.agentName).toBeInstanceOf(z.ZodString)
  }
  expect(await toolNames()).toContain('seam_probe')
})
