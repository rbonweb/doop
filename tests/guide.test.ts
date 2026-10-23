import { describe, expect, it } from 'vitest'
import { DESIGN_BRIEF, DOOP_GUIDE } from '../server/guide.ts'

const headings = DOOP_GUIDE.split('\n')
  .filter((line) => line.startsWith('## '))
  .map((line) => line.slice(3).trim())

describe('the agent guide', () => {
  it('has no duplicated section headings', () => {
    expect(headings.filter((h, i) => headings.indexOf(h) !== i)).toEqual([])
  })

  it.each([
    'Show the work first',
    'Review checkpoints — MANDATORY',
    "Fork, don't overwrite",
    'Questions go on the frame',
    'Report back — honest, with the link',
    'Version history and access',
    'Redesigns — audit first, then two drafts',
    'Pages',
    'Prototypes — screens that link',
    'Decks — slides on a page',
    'Sticky notes — say why, not just what',
  ])('has the "%s" section', (heading) => {
    expect(headings).toContain(heading)
  })

  it('keeps one review section, with the budget and the checklist inside it', () => {
    expect(headings.filter((h) => h.startsWith('Review'))).toHaveLength(1)
    for (const text of [
      'one batch of fixes',
      'at most one confirmation screenshot',
      'mobile 390',
      'tablet 834',
      'laptop 1280',
      'desktop 1440',
    ]) {
      expect(DOOP_GUIDE).toContain(text)
    }
  })

  it('teaches discovery limits and the UNCONFIRMED marker in the shared brief', () => {
    expect(DESIGN_BRIEF).toContain('at most 5 questions in one message')
    expect(DESIGN_BRIEF).toContain('UNCONFIRMED')
    expect(DOOP_GUIDE).toContain(DESIGN_BRIEF)
  })

  it('ends replies with the canvas link and rolls back with version history', () => {
    expect(DOOP_GUIDE).toContain('/c/<canvasId>?frame=<frameId>')
    expect(DOOP_GUIDE).toContain('restore_frame_version')
    expect(DOOP_GUIDE).toContain('list_frame_versions')
  })
})
