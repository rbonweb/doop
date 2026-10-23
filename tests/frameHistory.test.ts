import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Actor, Frame, FrameVersion, FrameVersionInfo } from '../shared/types.ts'

/* The action layer runs for real against the in-memory store; only the
 * database is replaced, by a list that keeps frame versions the way the real
 * table does (newest first, no html when listed). */
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
    getFrameVersion: (id: string) => Promise.resolve(saved.find((v) => v.id === id)),
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER_ID = 'owner-1'
const human: Actor = { name: 'Ada', kind: 'user', color: '#000', userId: OWNER_ID }
const otherHuman: Actor = { name: 'Grace', kind: 'user', color: '#000', userId: 'user-2' }
const agent: Actor = { name: 'Claude', kind: 'agent', color: '#000', userId: OWNER_ID }

let frame: Frame
let t0: number

/** the fire-and-forget save finishes on the next macrotask */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
/** oldest first; the first save of a frame finishes a tick after later ones (it checks the database), so order by time */
const versionsOf = (frameId: string) => saved.filter((v) => v.frameId === frameId).sort((a, b) => a.savedAt - b.savedAt)
/** move the clock forward; only Date is faked, so flush() still works */
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

function freshFrame(html: string, ownerId: string | undefined = OWNER_ID): Frame {
  const canvas = store.createCanvas('History', ownerId)
  const created = store.createFrame(canvas.id, { name: 'Hero', html, width: 800, height: 600 }, 'seed', {})
  if (!created) throw new Error('failed to seed a frame')
  return created
}

beforeEach(() => {
  saved.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  t0 = Date.parse('2026-01-01T12:00:00Z')
  vi.setSystemTime(t0)
  frame = freshFrame('<p>v0</p>')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('snapshotFrame', () => {
  it('saves the state before a change, labelled by who is changing it', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    await flush()
    expect(versionsOf(frame.id)).toMatchObject([
      { html: '<p>v0</p>', savedBy: 'Ada', reason: 'human', name: 'Hero', width: 800, height: 600 },
    ])

    const other = freshFrame('<p>a0</p>')
    actions.updateFrame(other.id, { html: '<p>a1</p>' }, agent)
    await flush()
    expect(versionsOf(other.id)).toMatchObject([{ html: '<p>a0</p>', savedBy: 'Claude', reason: 'agent' }])
  })

  it('coalesces a burst of edits by one actor into a single version', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    advance(30_000)
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, human)
    advance(60_000)
    actions.updateFrame(frame.id, { html: '<p>v3</p>' }, human)
    await flush()
    expect(versionsOf(frame.id).map((v) => v.html)).toEqual(['<p>v0</p>'])
  })

  it('snapshots again once the same actor has been quiet for 2 minutes', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    advance(actions.SNAPSHOT_COALESCE_MS + 1)
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, human)
    await flush()
    expect(versionsOf(frame.id).map((v) => v.html)).toEqual(['<p>v0</p>', '<p>v1</p>'])
  })

  it('keeps a separate version for a different actor inside the window', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    advance(10_000)
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, agent)
    advance(10_000)
    actions.updateFrame(frame.id, { html: '<p>v3</p>' }, otherHuman)
    await flush()
    expect(versionsOf(frame.id).map((v) => [v.savedBy, v.html])).toEqual([
      ['Ada', '<p>v0</p>'],
      ['Claude', '<p>v1</p>'],
      ['Grace', '<p>v2</p>'],
    ])
  })

  it('takes no snapshot when the html is unchanged or the frame is empty', async () => {
    actions.updateFrame(frame.id, { html: '<p>v0</p>' }, human)
    actions.updateFrame(frame.id, { x: 40, y: 40 }, human)
    expect(actions.snapshotFrame(frame, human, 'human')).toBe(true)
    advance(actions.SNAPSHOT_COALESCE_MS + 1)
    expect(actions.snapshotFrame(frame, agent, 'agent')).toBe(false) // same html as the latest version

    const empty = freshFrame('')
    actions.updateFrame(empty.id, { html: '<p>first</p>' }, agent)
    await flush()
    expect(versionsOf(empty.id)).toEqual([])
    expect(versionsOf(frame.id)).toHaveLength(1)
  })
})

describe('streams', () => {
  it('snapshots once at the start of a stream, never per chunk', async () => {
    actions.appendFrameHtml(frame.id, '<section>one</section>', agent, { start: true })
    actions.appendFrameHtml(frame.id, '<section>two</section>', agent)
    actions.appendFrameHtml(frame.id, '<section>three</section>', agent, { done: true })
    await flush()
    expect(versionsOf(frame.id)).toMatchObject([{ html: '<p>v0</p>', reason: 'agent' }])
  })

  it('does not snapshot a stream by an actor who just snapshotted this frame', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, agent)
    advance(5_000)
    actions.appendFrameHtml(frame.id, '<section>new</section>', agent, { start: true, done: true })
    await flush()
    expect(versionsOf(frame.id).map((v) => v.html)).toEqual(['<p>v0</p>'])
  })

  it('keeps a human edit that interrupts a stream from snapshotting the half-written design', async () => {
    actions.appendFrameHtml(frame.id, '<section>half</section>', agent, { start: true })
    actions.updateFrame(frame.id, { html: '<p>mine</p>' }, human)
    await flush()
    expect(versionsOf(frame.id).map((v) => v.html)).toEqual(['<p>v0</p>'])
  })
})

describe('restoreFrameVersion', () => {
  it('snapshots the current design first, then applies the version', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>', name: 'Renamed', width: 1000, height: 700 }, agent)
    await flush()
    const old = versionsOf(frame.id)[0]!
    expect(old).toMatchObject({ html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 })

    advance(5_000)
    const restored = actions.restoreFrameVersion(old, human)
    await flush()

    expect(restored).toMatchObject({ html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 })
    expect(store.getFrame(frame.id)).toMatchObject({ html: '<p>v0</p>', name: 'Hero', width: 800, height: 600 })
    const after = versionsOf(frame.id)
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({
      html: '<p>v1</p>',
      name: 'Renamed',
      width: 1000,
      height: 700,
      reason: 'restore',
      savedBy: 'Ada',
    })
    expect(after[1]!.savedAt).toBeGreaterThan(old.savedAt)
  })

  it('snapshots even when the actor edited the frame seconds ago, and logs one activity line', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    advance(1_000)
    actions.updateFrame(frame.id, { html: '<p>v2</p>' }, human) // coalesced: no version
    advance(1_000)
    await flush()
    const old = versionsOf(frame.id)[0]!

    actions.restoreFrameVersion(old, human)
    await flush()

    expect(versionsOf(frame.id).map((v) => [v.reason, v.html])).toEqual([
      ['human', '<p>v0</p>'],
      ['restore', '<p>v2</p>'],
    ])
    const lines = actions.getActivity(frame.canvasId).map((a) => a.message)
    expect(lines[0]).toBe('restored “Hero” to the version from 2026-01-01 12:00 UTC')
    expect(lines.filter((m) => m.startsWith('updated the design'))).toHaveLength(2) // the two edits, not the restore
  })

  it('returns undefined for a frame that is gone', () => {
    const version: FrameVersion = {
      id: 'v',
      frameId: 'missing',
      canvasId: 'c',
      name: 'x',
      html: '<p>x</p>',
      width: 1,
      height: 1,
      savedAt: 1,
      savedBy: 'Ada',
      reason: 'human',
    }
    expect(actions.restoreFrameVersion(version, human)).toBeUndefined()
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

  it('lists versions without html and restores one for the owner', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    await flush()
    const old = versionsOf(frame.id)[0]!
    const { client, close } = await connect(OWNER_ID)
    try {
      const list = await call(client, 'list_frame_versions', { frame_id: frame.id })
      expect(list.isError).toBe(false)
      const parsed = JSON.parse(list.raw) as { versions: Record<string, unknown>[] }
      expect(parsed.versions).toHaveLength(1)
      expect(parsed.versions[0]).toMatchObject({ id: old.id, savedBy: 'Ada', reason: 'human' })
      expect(parsed.versions[0]).not.toHaveProperty('html')

      const restore = await call(client, 'restore_frame_version', {
        frame_id: frame.id,
        version_id: old.id,
        agent_name: 'Claude',
      })
      expect(restore.isError).toBe(false)
      expect(store.getFrame(frame.id)?.html).toBe('<p>v0</p>')
      expect(versionsOf(frame.id).map((v) => v.reason)).toEqual(['human', 'restore'])
    } finally {
      await close()
    }
  })

  it('refuses a caller without access to the canvas, for both tools', async () => {
    actions.updateFrame(frame.id, { html: '<p>v1</p>' }, human)
    await flush()
    const old = versionsOf(frame.id)[0]!
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
    const other = freshFrame('<p>o0</p>')
    actions.updateFrame(other.id, { html: '<p>o1</p>' }, human)
    await flush()
    const foreign = versionsOf(other.id)[0]!
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
