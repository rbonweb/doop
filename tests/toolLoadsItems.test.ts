import { describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => ({ loaded: [] as string[], holding: new Set<string>(), seen: [] as string[][] }))

vi.mock('../server/store.ts', () => ({
  store: {
    getFrame: (id: string) => ({ f1: { canvasId: 'c1' }, f2: { canvasId: 'c2' } })[id],
    load: async (id: string) => void held.loaded.push(id),
    hold: (id: string) => {
      held.holding.add(id)
      return () => held.holding.delete(id)
    },
  },
}))

const { withArgsCanvases } = await import('../server/toolLoads.ts')

describe('withArgsCanvases', () => {
  it('loads and holds the canvases of every compare_frames item while the tool runs', async () => {
    await withArgsCanvases({ items: [{ frame_id: 'f1' }, { frame_id: 'f2' }, { frame_id: 'gone' }, 'odd'] }, () => {
      held.seen.push([...held.holding].sort())
    })
    expect(held.loaded.sort()).toEqual(['c1', 'c2'])
    expect(held.seen).toEqual([['c1', 'c2']])
    expect(held.holding.size).toBe(0)
  })
})
