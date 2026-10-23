import { describe, expect, it } from 'vitest'
import {
  addPage,
  applyPageChanges,
  canNestPage,
  movePage,
  normalizePageTree,
  pageAncestors,
  pageDepth,
  pageDescendants,
  pageTree,
  removePage,
  samePages,
  validatePageTree,
} from '../shared/pages.ts'
import type { CanvasPageInfo } from '../shared/types.ts'

const page = (id: string, parentId?: string): CanvasPageInfo => ({
  id,
  name: id.toUpperCase(),
  ...(parentId ? { parentId } : {}),
})
const ids = (pages: CanvasPageInfo[]) => pages.map((p) => p.id)

/* a
 * ├─ b
 * │  └─ c
 * └─ d
 * e */
const tree = [page('a'), page('b', 'a'), page('c', 'b'), page('d', 'a'), page('e')]

describe('page tree queries', () => {
  it('builds nested nodes with depth', () => {
    const roots = pageTree(tree)
    expect(roots.map((n) => n.page.id)).toEqual(['a', 'e'])
    expect(roots[0]!.children.map((n) => [n.page.id, n.depth])).toEqual([
      ['b', 2],
      ['d', 2],
    ])
    expect(roots[0]!.children[0]!.children[0]).toMatchObject({ depth: 3, page: { id: 'c' } })
  })

  it('answers depth, ancestors and descendants', () => {
    expect(pageDepth(tree, 'a')).toBe(1)
    expect(pageDepth(tree, 'c')).toBe(3)
    expect(pageDepth(tree, 'missing')).toBe(0)
    expect(ids(pageAncestors(tree, 'c'))).toEqual(['a', 'b'])
    expect(pageAncestors(tree, 'a')).toEqual([])
    expect(ids(pageDescendants(tree, 'a'))).toEqual(['b', 'c', 'd'])
    expect(pageDescendants(tree, 'e')).toEqual([])
  })

  it('survives a cycle in the data instead of looping', () => {
    const loop = [page('x', 'y'), page('y', 'x')]
    expect(pageDepth(loop, 'x')).toBe(Infinity)
    expect(pageAncestors(loop, 'x').map((p) => p.id)).toEqual(['y'])
    expect(pageDescendants(loop, 'x').map((p) => p.id)).toEqual(['y'])
  })
})

describe('validatePageTree', () => {
  it('accepts flat lists and trees up to three levels', () => {
    expect(validatePageTree([page('a'), page('b')])).toBeNull()
    expect(validatePageTree(tree)).toBeNull()
  })

  it('accepts children listed before their parent (order is normalized later)', () => {
    expect(validatePageTree([page('b', 'a'), page('a')])).toBeNull()
  })

  it('rejects duplicate ids, missing parents, self parents, cycles and excess depth', () => {
    expect(validatePageTree([page('a'), page('a')])).toMatch(/unique/)
    expect(validatePageTree([page('a', 'ghost')])).toMatch(/does not exist/)
    expect(validatePageTree([page('a', 'a')])).toMatch(/itself/)
    expect(validatePageTree([page('a', 'b'), page('b', 'a')])).toMatch(/own subpages/)
    expect(validatePageTree([...tree, page('f', 'c')])).toMatch(/at most 2 levels/)
  })
})

describe('normalizePageTree', () => {
  it('orders pre-order and keeps sibling order', () => {
    const scrambled = [page('e'), page('d', 'a'), page('c', 'b'), page('b', 'a'), page('a')]
    expect(ids(normalizePageTree(scrambled))).toEqual(['e', 'a', 'd', 'b', 'c'])
  })

  it('leaves a flat list untouched', () => {
    const flat = [page('a'), page('b'), page('c')]
    expect(normalizePageTree(flat)).toEqual(flat)
  })

  it('lifts a dangling parent to top level', () => {
    expect(normalizePageTree([page('a'), page('b', 'ghost')])).toEqual([page('a'), page('b')])
  })

  it('opens cycles at the first page in list order', () => {
    const fixed = normalizePageTree([page('a', 'b'), page('b', 'a'), page('c', 'b')])
    expect(validatePageTree(fixed)).toBeNull()
    expect(fixed).toEqual([page('a'), page('b', 'a'), page('c', 'b')])
  })

  it('lifts a too-deep page to its deepest valid ancestor', () => {
    const fixed = normalizePageTree([...tree, page('f', 'c'), page('g', 'f')])
    expect(validatePageTree(fixed)).toBeNull()
    expect(fixed.find((p) => p.id === 'f')!.parentId).toBe('b')
    expect(fixed.find((p) => p.id === 'g')!.parentId).toBe('b')
  })

  it('drops duplicate ids and self parents', () => {
    expect(normalizePageTree([page('a'), page('a'), page('b', 'b')])).toEqual([page('a'), page('b')])
  })
})

describe('samePages', () => {
  it('compares parents as well as ids and names', () => {
    expect(samePages(tree, tree)).toBe(true)
    expect(samePages([page('a'), page('b', 'a')], [page('a'), page('b')])).toBe(false)
    expect(samePages([{ id: 'a', name: 'A', parentId: undefined }], [page('a')])).toBe(true)
  })
})

describe('tree edits', () => {
  it('nests a page with its subtree as the last child', () => {
    expect(movePage(tree, 'b', { type: 'into', targetId: 'e' })).toEqual([
      page('a'),
      page('d', 'a'),
      page('e'),
      page('b', 'e'),
      page('c', 'b'),
    ])
  })

  it('places a page before or after a sibling at the target depth', () => {
    expect(ids(movePage(tree, 'e', { type: 'before', targetId: 'b' })!)).toEqual(['a', 'e', 'b', 'c', 'd'])
    expect(movePage(tree, 'e', { type: 'before', targetId: 'b' })![1]!.parentId).toBe('a')
    /* after a parent means after its whole subtree */
    expect(ids(movePage(tree, 'e', { type: 'after', targetId: 'a' })!)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('moves to top level', () => {
    expect(movePage(tree, 'd', { type: 'top' })).toEqual([
      page('a'),
      page('b', 'a'),
      page('c', 'b'),
      page('e'),
      page('d'),
    ])
  })

  it('refuses a move into its own subtree, onto itself or past the depth limit', () => {
    expect(movePage(tree, 'a', { type: 'into', targetId: 'c' })).toBeNull()
    expect(movePage(tree, 'a', { type: 'into', targetId: 'a' })).toBeNull()
    expect(movePage(tree, 'a', { type: 'before', targetId: 'c' })).toBeNull()
    /* a (height 3) cannot sit under e, but the leaf d can sit under b */
    expect(movePage(tree, 'a', { type: 'into', targetId: 'e' })).toBeNull()
    expect(movePage(tree, 'd', { type: 'into', targetId: 'b' })).not.toBeNull()
    expect(movePage(tree, 'e', { type: 'into', targetId: 'c' })).toBeNull()
    expect(canNestPage(tree, 'e', 'b')).toBe(true)
    expect(canNestPage(tree, 'e', 'c')).toBe(false)
  })

  it('adds a page as the last child of a parent', () => {
    expect(ids(addPage(tree, page('n'), 'a'))).toEqual(['a', 'b', 'c', 'd', 'n', 'e'])
    expect(addPage(tree, page('n'), 'a')[4]!.parentId).toBe('a')
    expect(ids(addPage(tree, page('n')))).toEqual(['a', 'b', 'c', 'd', 'e', 'n'])
  })

  it('lifts children to the removed page parent in place', () => {
    const lifted = removePage(tree, 'b')
    expect(lifted).toEqual([page('a'), page('c', 'a'), page('d', 'a'), page('e')])
    expect(validatePageTree(lifted)).toBeNull()
    expect(removePage(tree, 'a')).toEqual([page('b'), page('c', 'b'), page('d'), page('e')])
  })
})

describe('applyPageChanges with nesting', () => {
  it('applies a nest move on top of a collaborator addition', () => {
    const from = [page('a'), page('b')]
    const to = [page('a'), page('b', 'a')]
    const current = [page('a'), page('b'), page('x')]
    expect(applyPageChanges(current, from, to)).toEqual([page('a'), page('b', 'a'), page('x')])
  })

  it('moves a whole subtree when the order changes with the parent', () => {
    const next = applyPageChanges(tree, tree, movePage(tree, 'b', { type: 'into', targetId: 'e' })!)
    expect(next).toEqual(movePage(tree, 'b', { type: 'into', targetId: 'e' }))
  })

  it('is a no-op when a collaborator already made the same move', () => {
    const from = [page('a'), page('b')]
    const to = [page('a'), page('b', 'a')]
    expect(applyPageChanges(to, from, to)).toEqual(to)
  })

  it('refuses when a collaborator moved the page elsewhere', () => {
    const from = [page('a'), page('b'), page('c')]
    const to = [page('a'), page('b', 'a'), page('c')]
    const current = [page('a'), page('b', 'c'), page('c')]
    expect(() => applyPageChanges(current, from, to)).toThrow('This page was moved by a collaborator.')
  })

  it('refuses when the new parent was deleted meanwhile', () => {
    const from = [page('a'), page('b')]
    const to = [page('a'), page('b', 'a')]
    expect(() => applyPageChanges([page('b')], from, to)).toThrow('The page you moved this into no longer exists.')
  })

  it('refuses a move of a page a collaborator deleted', () => {
    const from = [page('a'), page('b')]
    const to = [page('a'), page('b', 'a')]
    expect(() => applyPageChanges([page('a')], from, to)).toThrow('This page no longer exists.')
  })

  it('handles a new page nested under another new page', () => {
    const from = [page('a')]
    const to = [page('a'), page('n', 'a'), page('m', 'n')]
    expect(applyPageChanges([page('a'), page('x')], from, to)).toEqual([
      page('a'),
      page('n', 'a'),
      page('m', 'n'),
      page('x'),
    ])
  })

  it('undoes a delete that lifted children', () => {
    const before = [page('a'), page('b', 'a'), page('c', 'b')]
    const after = removePage(before, 'b')
    expect(applyPageChanges(after, after, before)).toEqual(before)
  })

  it('keeps renames working next to a move', () => {
    const from = [page('a'), page('b')]
    const to = [page('a'), { ...page('b', 'a'), name: 'Renamed' }]
    expect(applyPageChanges(from, from, to)).toEqual(to)
    const current = [page('a'), { ...page('b'), name: 'Theirs' }]
    expect(() => applyPageChanges(current, from, to)).toThrow('This page was renamed by a collaborator.')
  })
})
