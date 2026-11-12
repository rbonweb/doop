import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimFrames, resetClaims } from '../server/frameClaims.ts'
import { buildMcpServer } from '../server/mcp.ts'
import type { Actor, FrameVersion, FrameVersionInfo } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* the version tools read history through the database these tests never open:
   keep the filed versions in memory, the way tests/frameHistory.test.ts does */
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
  const client = new Client({ name: 'doop-expected-version-test', version: '1.0.0' })
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

/** A canvas and frame created through the tools, so the connecting owner has edit access;
 *  the frame holds `<main>one</main>` written by agent-a. */
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

async function currentFrame(client: Client, frameId: string): Promise<Record<string, unknown>> {
  return jsonOf(await client.callTool({ name: 'get_frame', arguments: { frame_id: frameId } }))
}

afterEach(() => {
  resetClaims()
  versions.length = 0
})

describe('expected_version on frame writes', () => {
  it('refuses every write whose version is stale and leaves the frame untouched', async () => {
    const { client, close } = await connected()
    try {
      const { frameId, version: stale } = await seed(client)

      /* agent-b writes, so the version agent-a read is now stale (timestamps are monotonic) */
      const second = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>two</main>', agent_name: 'agent-b' },
      })
      expect(second.isError).not.toBe(true)
      const current = await currentVersion(client, frameId)
      expect(current).not.toBe(stale)

      const listed = jsonOf(
        await client.callTool({ name: 'list_frame_versions', arguments: { frame_id: frameId, agent_name: 'agent-a' } }),
      )
      const versionId = (listed.versions as { id: string }[])[0]!.id

      const writes: { name: string; arguments: Record<string, unknown> }[] = [
        {
          name: 'set_frame_html',
          arguments: { frame_id: frameId, html: '<main>three</main>', expected_version: stale, agent_name: 'agent-a' },
        },
        {
          name: 'edit_frame_html',
          arguments: {
            frame_id: frameId,
            old_str: 'two',
            new_str: 'three',
            expected_version: stale,
            agent_name: 'agent-a',
          },
        },
        {
          name: 'append_frame_html',
          arguments: {
            frame_id: frameId,
            html_chunk: '<p>x</p>',
            start: true,
            done: true,
            expected_version: stale,
            agent_name: 'agent-a',
          },
        },
        {
          name: 'update_frame',
          arguments: { frame_id: frameId, name: 'Renamed', expected_version: stale, agent_name: 'agent-a' },
        },
        {
          name: 'restore_frame_version',
          arguments: { frame_id: frameId, version_id: versionId, expected_version: stale, agent_name: 'agent-a' },
        },
        { name: 'delete_frame', arguments: { frame_id: frameId, expected_version: stale, agent_name: 'agent-a' } },
      ]

      for (const write of writes) {
        const result = await client.callTool({ name: write.name, arguments: write.arguments })
        const text = textOf(result)
        expect(result.isError, write.name).toBe(true)
        expect(text, write.name).toContain('changed since your read')
        expect(text, write.name).toContain(current)
        expect(text, write.name).toContain('agent-b')
        expect(text, write.name).toContain('Nothing was written')
      }

      const after = await currentFrame(client, frameId)
      expect(after.html).toBe('<main>two</main>')
      expect(after.name).toBe('Hero')
    } finally {
      await close()
    }
  })

  it('accepts the current version as an ISO string, as epoch milliseconds, and when omitted', async () => {
    const { client, close } = await connected()
    try {
      const { frameId, version } = await seed(client)

      const isoWrite = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>alpha</main>', expected_version: version, agent_name: 'agent-a' },
      })
      expect(isoWrite.isError).not.toBe(true)

      const iso = await currentVersion(client, frameId)
      const numericWrite = await client.callTool({
        name: 'edit_frame_html',
        arguments: {
          frame_id: frameId,
          old_str: 'alpha',
          new_str: 'beta',
          expected_version: Date.parse(iso),
          agent_name: 'agent-a',
        },
      })
      expect(numericWrite.isError).not.toBe(true)
      expect((await currentFrame(client, frameId)).html).toContain('beta')

      const plainWrite = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>gamma</main>', agent_name: 'agent-a' },
      })
      expect(plainWrite.isError).not.toBe(true)
      expect((await currentFrame(client, frameId)).html).toContain('gamma')
    } finally {
      await close()
    }
  })

  it('refuses an expected_version that is not a version', async () => {
    const { client, close } = await connected()
    try {
      const { frameId } = await seed(client)
      const result = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>three</main>', expected_version: 'banana', agent_name: 'agent-a' },
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('is not a version')
      expect((await currentFrame(client, frameId)).html).toBe('<main>one</main>')
    } finally {
      await close()
    }
  })
})

describe('advisory frame claims', () => {
  const agentA: Actor = { name: 'agent-a', kind: 'agent', color: '#000', userId: 'test-owner-id' }

  it('warns another holder and lists the claims on the canvas only while they last', async () => {
    const { client, close } = await connected()
    try {
      const { canvasId, frameId } = await seed(client)
      claimFrames([{ id: frameId, canvasId }], agentA, 10, 'rebuilding the hero')

      const other = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>three</main>', agent_name: 'agent-b' },
      })
      expect(other.isError).not.toBe(true)
      const otherText = textOf(other)
      expect(otherText).toContain('agent-a')
      expect(otherText).toContain('claimed')
      expect(otherText).toContain('advisory')

      const own = await client.callTool({
        name: 'set_frame_html',
        arguments: { frame_id: frameId, html: '<main>four</main>', agent_name: 'agent-a' },
      })
      expect(own.isError).not.toBe(true)
      expect(textOf(own)).not.toContain('advisory')

      const canvas = jsonOf(
        await client.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId, agent_name: 'agent-a' } }),
      )
      expect(canvas.claims).toEqual([
        expect.objectContaining({ frameId, holder: 'agent-a', note: 'rebuilding the hero' }),
      ])

      resetClaims()
      const cleared = jsonOf(
        await client.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId, agent_name: 'agent-a' } }),
      )
      expect(cleared).not.toHaveProperty('claims')
    } finally {
      await close()
    }
  })
})

describe('get_frame outline mode', () => {
  it('returns an outline instead of html, and html by default', async () => {
    const { client, close } = await connected()
    try {
      const { frameId } = await seed(client)

      const outline = jsonOf(
        await client.callTool({ name: 'get_frame', arguments: { frame_id: frameId, mode: 'outline' } }),
      )
      expect(outline).not.toHaveProperty('html')
      expect(outline).toHaveProperty('outline')

      const plain = await currentFrame(client, frameId)
      expect(plain).toHaveProperty('html')
      expect(plain.html).toBe('<main>one</main>')
    } finally {
      await close()
    }
  })
})
