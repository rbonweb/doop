import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Resident html writes persist and broadcast like any canvas change; these
   tests only care about the answer the model reads, so persistence is stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { claimFrames, releaseFrames } = await import('../server/frameClaims.ts')
const { execTool } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = () => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
  arrangeWrites: 0,
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })
const html = '<!doctype html><html><body><section data-doop-id="hero"><h1>Hi</h1></section></body></html>'

let canvasId: string
let frameId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('html', 'kevin').id
  frameId = actions.createFrame(canvasId, { name: 'Home', width: 1280, height: 800, html }, actor())!.id
})

describe('resident html writes', () => {
  it('warns when another agent holds a claim on the frame it just wrote', async () => {
    const other = actions.resolveActor({ name: 'Other agent', kind: 'agent' })
    const { claimed } = claimFrames([{ id: frameId, canvasId }], other, 10, 'Rewriting the hero')
    expect(claimed).toHaveLength(1)
    const result = await execTool(
      call('replace_section', {
        frame_id: frameId,
        target: { element_id: 'hero' },
        html: '<section data-doop-id="hero"><h1>New</h1></section>',
      }),
      canvasId,
      actor(),
      run(),
    )
    expect(String(result.content)).toContain('is claimed by Other agent')
    expect(result.is_error).toBeUndefined()
    releaseFrames([frameId], other)
  })

  it('refuses a stale expected_version before writing', async () => {
    const result = await execTool(
      call('patch_frame', {
        frame_id: frameId,
        ops: [{ op: 'set_text', target: { element_id: 'hero' }, text: 'New' }],
        expected_version: '2000-01-01T00:00:00.000Z',
      }),
      canvasId,
      actor(),
      run(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('changed since your read')
  })
})
