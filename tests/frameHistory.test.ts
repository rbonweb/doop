import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame, FrameVersion, FrameVersionInfo } from '../shared/types.ts'

/* What this fork adds on top of the burst history (tests/frameVersionBursts.test.ts and tests/frameVersions.test.ts
 * cover the bursts, the routes and the restore contract): every version records the frame's name in that state and
 * why it was filed, and a restore brings the name back. The action layer runs for real against the in-memory store;
 * only the database is replaced, by a list that keeps versions the way the real table does. */
const saved: FrameVersion[] = []

vi.mock('../server/db/persist.ts', () => {
  const noop = () => {}
  return {
    saveTask: noop,
    saveFeedback: noop,
    saveComment: noop,
    saveActivity: noop,
    saveDecision: noop,
    saveProposal: noop,
    saveFrame: noop,
    saveCanvas: noop,
    deleteFrame: noop,
    saveFrameVersion: (v: FrameVersion) => {
      saved.push(v)
      return Promise.resolve()
    },
    listFrameVersions: (frameId: string): Promise<FrameVersionInfo[]> =>
      Promise.resolve(
        saved
          .filter((v) => v.frameId === frameId)
          .sort((a, b) => b.savedAt - a.savedAt)
          .map(({ html: _html, ...info }) => info),
      ),
    getFrameVersion: (frameId: string, id: string) =>
      Promise.resolve(saved.find((v) => v.id === id && v.frameId === frameId)),
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER_ID = 'owner-1'
const CANVAS: Canvas = { id: 'c1', name: 'History', ownerId: OWNER_ID, createdAt: 0, updatedAt: 0, frames: [] }
const human = actions.resolveActor({ name: 'Ada', kind: 'user' })
const agent = actions.resolveActor({ name: 'Claude', kind: 'agent' })

let frame: Frame

beforeEach(() => {
  saved.length = 0
  store.init([structuredClone(CANVAS)])
  frame = actions.createFrame(CANVAS.id, { name: 'Hero', html: '<p>v0</p>', width: 800, height: 600 }, agent)!
})

describe('version name and reason', () => {
  it('labels each filed state by the kind of whoever wrote it', () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, agent, { replace: true })
    expect(saved.map((v) => [v.html, v.savedBy, v.reason])).toEqual([
      ['<p>v0</p>', 'Claude', 'agent'],
      ['<p>v1</p>', 'Ada', 'human'],
    ])
  })

  it('files the name the frame had in that state, not the one it was renamed to', () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>', name: 'Renamed' }, agent, { replace: true })
    expect(saved).toMatchObject([{ html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 }])
    expect(store.getFrame(frame.id)?.name).toBe('Renamed')
  })
})

describe('restoreFrameVersion', () => {
  it('brings back the name with the design, and files what it replaced as a restore', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>', name: 'Renamed', width: 1000, height: 700 }, agent, {
      replace: true,
    })
    const old = saved[0]!

    const restored = await actions.restoreFrameVersion(frame.id, old.id, human)

    expect(restored).toMatchObject({
      frame: { html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 },
      replaced: { html: '<p>v1</p>', width: 1000, height: 700 },
    })
    expect(store.getFrame(frame.id)).toMatchObject({ html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 })
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ html: '<p>v1</p>', name: 'Renamed', reason: 'restore' })
  })

  it('keeps the current name when the version predates names', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>', name: 'Renamed' }, agent, { replace: true })
    const legacy: FrameVersion = {
      id: 'legacy',
      frameId: frame.id,
      canvasId: CANVAS.id,
      html: '<p>old</p>',
      width: 800,
      height: 600,
      savedAt: 1,
      savedBy: 'Grace',
      htmlBytes: 10,
    }
    saved.push(legacy)

    const restored = await actions.restoreFrameVersion(frame.id, legacy.id, human)

    expect(restored?.frame).toMatchObject({ html: '<p>old</p>', name: 'Renamed' })
  })

  it('answers null for a version that belongs to another frame', async () => {
    const other = actions.createFrame(CANVAS.id, { name: 'Other', html: '<p>o0</p>' }, agent)!
    actions.updateFrame(other.id, { html: '<p>o1</p>' }, human)
    const foreign = saved[0]!
    expect(foreign.frameId).toBe(other.id)

    expect(await actions.restoreFrameVersion(frame.id, foreign.id, human)).toBeNull()
    expect(store.getFrame(frame.id)?.html).toBe('<p>v0</p>')
  })
})

describe('MCP frame history tools', () => {
  async function connect(ownerId: string | undefined) {
    const server = buildMcpServer('Test Owner', ownerId)
    const client = new Client({ name: 'doop-frame-history-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { client, close: () => Promise.all([client.close(), server.close()]) }
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as unknown as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }
    const raw = result.content.map((block) => block.text ?? '').join('\n')
    return { raw, isError: result.isError === true }
  }

  beforeEach(() => {
    vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  })

  it('lists versions with their name and reason but no html, and restores one for the owner', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    const old = saved[0]!
    const { client, close } = await connect(OWNER_ID)
    try {
      const list = await call(client, 'list_frame_versions', { frame_id: frame.id })
      expect(list.isError).toBe(false)
      const parsed = JSON.parse(list.raw) as { versions: Record<string, unknown>[] }
      expect(parsed.versions).toHaveLength(1)
      expect(parsed.versions[0]).toMatchObject({ id: old.id, savedBy: 'Claude', name: 'Hero', reason: 'agent' })
      expect(parsed.versions[0]).not.toHaveProperty('html')

      const restore = await call(client, 'restore_frame_version', {
        frame_id: frame.id,
        version_id: old.id,
        agent_name: 'Claude',
      })
      expect(restore.isError).toBe(false)
      expect(store.getFrame(frame.id)?.html).toBe('<p>v0</p>')
      expect(saved.map((v) => v.reason)).toEqual(['agent', 'restore'])
    } finally {
      await close()
    }
  })

  it('refuses a caller without access to the canvas, for both tools', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    const old = saved[0]!
    for (const stranger of ['someone-else', undefined]) {
      const { client, close } = await connect(stranger)
      try {
        const list = await call(client, 'list_frame_versions', { frame_id: frame.id })
        expect(list.isError).toBe(true)
        expect(list.raw).toContain('accessible to this account')

        const restore = await call(client, 'restore_frame_version', {
          frame_id: frame.id,
          version_id: old.id,
          agent_name: 'Mallory',
        })
        expect(restore.isError).toBe(true)
        expect(store.getFrame(frame.id)?.html).toBe('<p>v1</p>')
      } finally {
        await close()
      }
    }
  })

  it('refuses a version that belongs to another frame', async () => {
    const other = actions.createFrame(CANVAS.id, { name: 'Other', html: '<p>o0</p>' }, agent)!
    actions.updateFrame(other.id, { html: '<p>o1</p>' }, human)
    const foreign = saved[0]!
    const { client, close } = await connect(OWNER_ID)
    try {
      const restore = await call(client, 'restore_frame_version', {
        frame_id: frame.id,
        version_id: foreign.id,
        agent_name: 'Claude',
      })
      expect(restore.isError).toBe(true)
      expect(store.getFrame(frame.id)?.html).toBe('<p>v0</p>')
    } finally {
      await close()
    }
  })
})
