import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  deleteCanvas: () => {},
  frameWritePending: () => false,
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { PropagationRow } from '../server/db/persist.ts'
import type { Actor } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* The component work queue is kept in the database (`component_propagation_queue`) and the room is told which
   frames are waiting. The restart itself is in propagationQueueHttp.test.ts; here the rows and the notices. */

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

/** what the database would hold, as the queue's writes leave it */
const rows = new Map<string, PropagationRow>()
const key = (task: string, frameId: string) => `${task}:${frameId}`
const write = vi.fn(async (upserts: PropagationRow[], removals: { frameId: string; task: string }[]) => {
  for (const row of upserts) rows.set(key(row.task, row.frameId), row)
  for (const row of removals) rows.delete(key(row.task, row.frameId))
})
const changes: { canvasId: string; added: string[]; removed: string[] }[] = []

/** A Button main and `users` frames using it, plus one that does not. */
function kit(users: number) {
  const canvas = store.createCanvas('queue rows')
  const button = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, button)
  const main = actions.createFrame(canvas.id, { name: 'Button main', html: '' }, actor)!
  actions.updateFrame(
    main.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${button.id}"><span data-doop-prop="label">Buy</span></button>`,
      ),
    },
    actor,
  )
  const using = Array.from({ length: users }, (_, index) => {
    const frame = actions.createFrame(canvas.id, { name: `Page ${index}`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(`<doop-use component="Button" label="Go ${index}"></doop-use>`) }, actor)
    return frame
  })
  const plain = actions.createFrame(canvas.id, { name: 'Plain', html: '' }, actor)!
  actions.updateFrame(plain.id, { html: doc('<p>nothing shared</p>') }, actor)
  return { canvas, button, main, using, plain }
}

const restyle = (frameId: string, cls: string) =>
  actions.updateFrame(
    frameId,
    { html: store.getFrame(frameId)!.html.replace(/<button class="btn[^"]*"/, `<button class="btn ${cls}"`) },
    actor,
  )

beforeEach(() => {
  rows.clear()
  changes.length = 0
  write.mockClear()
  propagation.useQueueStore({ write })
  propagation.onCatchingUp((canvasId, added, removed) => changes.push({ canvasId, added, removed }))
})

afterEach(async () => {
  unstubAllEnvs()
  propagation.wake()
  await propagation.whenIdle()
  await propagation.flushQueueStore()
  propagation.useQueueStore(undefined)
  propagation.onCatchingUp(undefined)
})

describe('the queue in the database', () => {
  it('stores one row per queued frame, merged across edits, and none once the frames have had their turn', async () => {
    const { canvas, main, using, plain } = kit(3)
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    rows.clear()

    stubEnv('DOOP_PROPAGATION_PAUSED', 'true')
    restyle(main.id, 'one')
    restyle(main.id, 'two')
    await propagation.flushQueueStore()

    /* the main's own frame is up to date; every other frame waits, once, however many edits asked */
    const waiting = [...rows.values()].filter((row) => row.canvasId === canvas.id)
    expect(waiting.map((row) => row.frameId).sort()).toEqual([...using.map((f) => f.id), plain.id].sort())
    for (const row of waiting) {
      expect(row.task).toBe('propagate')
      expect(row.componentIds).toHaveLength(1)
      expect(row.actor.name).toBe('Tester')
    }
    expect(propagation.pendingFrames(canvas.id)).toBe(4)

    unstubAllEnvs()
    propagation.restore(canvas.id, waiting)
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    expect(rows.size).toBe(0)
    for (const frame of using) expect(store.getFrame(frame.id)!.html).toContain('btn two')
  })

  it('writes nothing for a frame that was never queued, and nothing without a store', async () => {
    const { main } = kit(1)
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    rows.clear()
    propagation.useQueueStore(undefined)
    restyle(main.id, 'quiet')
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    expect(rows.size).toBe(0)
  })

  it('drops the rows of a canvas that is gone, and ignores rows for one that is', async () => {
    const { canvas, main } = kit(2)
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    stubEnv('DOOP_PROPAGATION_PAUSED', 'true')
    restyle(main.id, 'doomed')
    await propagation.flushQueueStore()
    expect(rows.size).toBe(3)
    store.deleteCanvas(canvas.id)
    unstubAllEnvs()
    propagation.restore('no-such-canvas', [
      { frameId: 'f', task: 'propagate', canvasId: 'no-such-canvas', componentIds: ['c'], actor, queuedAt: 1 },
    ])
    /* waking the queue: the canvas is not there, so its frames are owed nothing */
    propagation.wake()
    await propagation.whenIdle()
    await propagation.flushQueueStore()
    expect(rows.size).toBe(0)
  })
})

describe('frames catching up, as the room hears it', () => {
  it('names the frames that use the changed main, then clears each as it is visited', async () => {
    const { canvas, main, using, plain } = kit(3)
    await propagation.whenIdle()
    changes.length = 0

    stubEnv('DOOP_PROPAGATION_PAUSED', 'true')
    restyle(main.id, 'fresh')
    const added = changes.flatMap((change) => change.added)
    expect(added.sort()).toEqual(using.map((f) => f.id).sort())
    expect(added).not.toContain(plain.id)
    expect(propagation.catchingUp(canvas.id).sort()).toEqual(using.map((f) => f.id).sort())

    unstubAllEnvs()
    propagation.wake()
    await propagation.whenIdle()
    const removed = changes.flatMap((change) => change.removed)
    expect(removed.sort()).toEqual(using.map((f) => f.id).sort())
    expect(propagation.catchingUp(canvas.id)).toEqual([])
  })

  it('does not mark a frame twice for two edits', async () => {
    const { main, using } = kit(2)
    await propagation.whenIdle()
    changes.length = 0
    stubEnv('DOOP_PROPAGATION_PAUSED', 'true')
    restyle(main.id, 'a')
    restyle(main.id, 'b')
    expect(changes.flatMap((change) => change.added).sort()).toEqual(using.map((f) => f.id).sort())
  })
})
