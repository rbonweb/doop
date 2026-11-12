import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onClaimsChange, resetClaims } from '../server/frameClaims.ts'
import { buildMcpServer } from '../server/mcp.ts'
import type { FrameVersion, FrameVersionInfo } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* the claim tools read history through the database these tests never open: keep the filed versions in memory */
const { versions } = vi.hoisted(() => ({ versions: [] as FrameVersion[] }))

vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/db/persist.ts')>()),
  saveCanvas: () => undefined,
  saveFrame: () => undefined,
  saveActivity: () => undefined,
  saveFrameVersion: (version: FrameVersion) => {
    versions.push(version)
  },
  listFrameVersions: (frameId: string): Promise<FrameVersionInfo[]> =>
    Promise.resolve(
      versions
        .filter((version) => version.frameId === frameId)
        .sort((a, b) => b.savedAt - a.savedAt)
        .map(({ html: _html, ...info }) => info),
    ),
  getFrameVersion: (frameId: string, id: string) =>
    Promise.resolve(versions.find((version) => version.id === id && version.frameId === frameId)),
}))

type ToolResult = Awaited<ReturnType<Client['callTool']>>

function textBlocks(result: ToolResult): string[] {
  return (result.content as { text?: string }[]).map((block) => block.text ?? '')
}

function textOf(result: ToolResult): string {
  return textBlocks(result).join('\n')
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textBlocks(result)[0]!) as Record<string, unknown>
}

async function connected() {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'doop-claim-tools-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/* a canvas and frame created through the tools so the connecting owner has edit access; it holds `<main>one</main>` */
async function seed(client: Client) {
  const canvas = jsonOf(
    await client.callTool({ name: 'create_canvas', arguments: { name: 'Versions', agent_name: 'agent-a' } }),
  )
  const canvasId = canvas.id as string
  const created = jsonOf(
    await client.callTool({
      name: 'create_frame',
      arguments: { canvas_id: canvasId, name: 'Hero', html: '', agent_name: 'agent-a' },
    }),
  )
  const frameId = (created.frame as { id: string }).id
  const write = await client.callTool({
    name: 'set_frame_html',
    arguments: { frame_id: frameId, html: '<main>one</main>', agent_name: 'agent-a' },
  })
  expect(write.isError).not.toBe(true)
  return { canvasId, frameId, version: await currentVersion(client, frameId) }
}

async function currentVersion(client: Client, frameId: string): Promise<string> {
  const frame = jsonOf(
    await client.callTool({ name: 'get_frame', arguments: { frame_id: frameId, include_html: false } }),
  )
  return frame.updatedAt as string
}

afterEach(() => {
  resetClaims()
  versions.length = 0
})

describe('claim_frames and release_frames', () => {
  it('agent A claims a frame and get_canvas lists the claim', async () => {
    const { client, close } = await connected()
    try {
      const { canvasId, frameId } = await seed(client)

      const result = await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })
      expect(result.isError).not.toBe(true)
      const payload = jsonOf(result)
      const claimed = payload.claimed as { frameId: string; expiresAt: string }[]
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.frameId).toBe(frameId)
      expect(new Date(claimed[0]!.expiresAt).toISOString()).toBe(claimed[0]!.expiresAt)
      expect(payload.heldByOthers).toEqual([])

      const canvas = jsonOf(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: canvasId, agent_name: 'agent-a' },
        }),
      )
      expect(canvas.claims).toEqual([
        expect.objectContaining({ frameId, holder: 'agent-a', note: 'rebuilding the hero' }),
      ])
    } finally {
      await close()
    }
  })

  it("another agent's writes go through and name the holder", async () => {
    const { client, close } = await connected()
    try {
      const { frameId } = await seed(client)

      await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })

      const write = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>two</main>', agent_name: 'agent-b' },
      })
      expect(write.isError).not.toBe(true)
      const writeText = textOf(write)
      expect(writeText).toContain('agent-a')
      expect(writeText).toContain('rebuilding the hero')
      expect(writeText).toContain('advisory')

      const edit = await client.callTool({
        name: 'edit_frame_html',
        arguments: { frame_id: frameId, old_str: 'two', new_str: 'three', agent_name: 'agent-b' },
      })
      expect(edit.isError).not.toBe(true)
      const editText = textOf(edit)
      expect(editText).toContain('agent-a')
      expect(editText).toContain('rebuilding the hero')
      expect(editText).toContain('advisory')

      const own = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>four</main>', agent_name: 'agent-a' },
      })
      expect(own.isError).not.toBe(true)
      expect(textOf(own)).not.toContain('advisory')
    } finally {
      await close()
    }
  })

  it('a second claim on the same frame comes back under heldByOthers', async () => {
    const { client, close } = await connected()
    try {
      const { frameId } = await seed(client)

      await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })

      const result = await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], note: 'also touching this', agent_name: 'agent-b' },
      })
      expect(result.isError).not.toBe(true)
      const payload = jsonOf(result)
      expect(payload.claimed).toEqual([])
      expect(payload.heldByOthers).toEqual([
        expect.objectContaining({ frameId, holder: 'agent-a', note: 'rebuilding the hero' }),
      ])
    } finally {
      await close()
    }
  })

  it('a stale expected_version is refused with the current version and the author', async () => {
    const { client, close } = await connected()
    try {
      const { frameId } = await seed(client)

      await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })
      const stale = await currentVersion(client, frameId)

      await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>two</main>', agent_name: 'agent-b' },
      })
      const current = await currentVersion(client, frameId)

      const result = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>three</main>', expected_version: stale, agent_name: 'agent-a' },
      })
      expect(result.isError).toBe(true)
      const text = textOf(result)
      expect(text).toContain('changed since your read')
      expect(text).toContain(current)
      expect(text).toContain('agent-b')
    } finally {
      await close()
    }
  })

  it('release removes the claim and the warning', async () => {
    const { client, close } = await connected()
    try {
      const { canvasId, frameId } = await seed(client)

      await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })

      const released = jsonOf(await client.callTool({ name: 'release_frames', arguments: { agent_name: 'agent-a' } }))
      expect(released.released).toEqual([frameId])

      const canvas = jsonOf(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: canvasId, agent_name: 'agent-a' },
        }),
      )
      expect(canvas).not.toHaveProperty('claims')

      const other = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>two</main>', agent_name: 'agent-b' },
      })
      expect(other.isError).not.toBe(true)
      expect(textOf(other)).not.toContain('advisory')
    } finally {
      await close()
    }
  })

  it("release only drops the caller's own claims", async () => {
    const { client, close } = await connected()
    try {
      const { canvasId, frameId } = await seed(client)

      await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
      })

      const result = await client.callTool({
        name: 'release_frames',
        arguments: { frame_ids: [frameId], agent_name: 'agent-b' },
      })
      expect(result.isError).not.toBe(true)
      expect(jsonOf(result).released).toEqual([])

      const canvas = jsonOf(
        await client.callTool({
          name: 'get_canvas',
          arguments: { canvas_id: canvasId, agent_name: 'agent-a' },
        }),
      )
      expect(canvas.claims).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('broadcasts the claims of a canvas to subscribers', async () => {
    const { client, close } = await connected()
    try {
      const { canvasId, frameId } = await seed(client)
      const listener = vi.fn()
      const unsubscribe = onClaimsChange(listener)
      try {
        await client.callTool({
          name: 'claim_frames',
          arguments: { frame_ids: [frameId], minutes: 10, note: 'rebuilding the hero', agent_name: 'agent-a' },
        })
        expect(listener).toHaveBeenCalledWith(canvasId, [expect.objectContaining({ frameId, holder: 'agent-a' })])

        const released = await client.callTool({
          name: 'release_frames',
          arguments: { agent_name: 'agent-a' },
        })
        expect(released.isError).not.toBe(true)
        expect(listener).toHaveBeenLastCalledWith(canvasId, [])
      } finally {
        unsubscribe()
      }
    } finally {
      await close()
    }
  })

  it('refuses a claim on a frame the caller cannot edit', async () => {
    const { client, close } = await connected()
    try {
      await seed(client)

      const result = await client.callTool({
        name: 'claim_frames',
        arguments: { frame_ids: ['does-not-exist'], note: 'claiming a missing frame', agent_name: 'agent-a' },
      })
      expect(result.isError).toBe(true)
    } finally {
      await close()
    }
  })
})
