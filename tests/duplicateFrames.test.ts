import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { planDuplicates } from '../server/agentTools/canvasDuplicate.ts'
import { blankComponent } from '../server/components.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { Actor, Frame } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const HTML = '<!doctype html><html><head><title>Home</title></head><body><h1 data-doop-id="h1x">Hi</h1>\n</body></html>'

function setup() {
  const canvas = store.createCanvas('duplicate test')
  const source = actions.createFrame(
    canvas.id,
    { name: 'Home', html: HTML, width: 390, height: 844, x: 100, y: 100, slide: true, speakerNotes: 'say hi' },
    actor,
  )!
  return { canvas, source }
}

const copy = (canvasId: string, items: Parameters<typeof planDuplicates>[1]) => {
  const canvas = store.getCanvas(canvasId)!
  const planned = planDuplicates(canvas, items)
  if (!planned.ok) throw new Error(planned.error)
  return actions.duplicateFrames(canvasId, planned.plan, actor)
}

const overlaps = (a: Frame, b: Frame) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
})

describe('duplicateFrames', () => {
  it('copies the HTML byte for byte under a new id with the source’s settings', () => {
    const { canvas, source } = setup()
    const [made] = copy(canvas.id, [{ frame_id: source.id }])
    const frame = made!.frame
    expect(frame.id).not.toBe(source.id)
    expect(frame.html).toBe(HTML)
    expect(frame.html).toContain('data-doop-id="h1x"')
    expect(frame.name).toBe('Home copy')
    expect([frame.width, frame.height]).toEqual([390, 844])
    expect(frame.slide).toBe(true)
    expect(frame.speakerNotes).toBe('say hi')
    expect(frame.approval ?? null).toBeNull()
    expect(made!.rewritten).toBe(false)
    expect(store.getCanvas(canvas.id)!.frames.map((f) => f.id)).toContain(frame.id)
  })

  it('does not copy approval or comments', () => {
    const { canvas, source } = setup()
    store.getFrame(source.id)!.approval = { status: 'ready_for_dev', by: 'x', at: 1 } as unknown as Frame['approval']
    const [made] = copy(canvas.id, [{ frame_id: source.id, name: 'Variant' }])
    expect(made!.frame.approval ?? null).toBeNull()
    expect(made!.frame.name).toBe('Variant')
  })

  it('points links between frames copied in one call at the copies', () => {
    const canvas = store.createCanvas('links')
    const b = actions.createFrame(canvas.id, { name: 'B', html: '<p>b</p>' }, actor)!
    const a = actions.createFrame(
      canvas.id,
      {
        name: 'A',
        html: `<a data-doop-on="click" data-doop-action="navigate:${b.id}">go</a><a data-doop-action="navigate:elsewhere">x</a>`,
      },
      actor,
    )!
    const made = copy(canvas.id, [{ frame_id: a.id }, { frame_id: b.id }])
    const [copyA, copyB] = made.map((m) => m.frame)
    expect(copyA!.html).toContain(`navigate:${copyB!.id}`)
    expect(copyA!.html).not.toContain(`navigate:${b.id}`)
    expect(copyA!.html).toContain('navigate:elsewhere')
    const alone = copy(canvas.id, [{ frame_id: a.id }])
    expect(alone[0]!.frame.html).toContain(`navigate:${b.id}`)
  })

  it('rewrites a copy of a component main so the canvas keeps one main', () => {
    const canvas = store.createCanvas('components')
    const def = blankComponent({ name: 'Button', by: 'Tester', props: [] })
    store.saveComponent(canvas.id, def)
    const main = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    actions.updateFrame(
      main.id,
      {
        html: `<!doctype html><html><body><button class="btn" ${COMPONENT_ATTR}="${def.id}">Buy</button></body></html>`,
      },
      actor,
    )
    const [made] = copy(canvas.id, [{ frame_id: main.id }])
    expect(made!.rewritten).toBe(true)
    const mains = store.getCanvas(canvas.id)!.frames.filter((f) => f.html.includes(`${COMPONENT_ATTR}="${def.id}"`))
    expect(mains).toHaveLength(1)
  })

  it('places copies clear of the source, other frames and earlier copies', () => {
    const { canvas, source } = setup()
    actions.createFrame(
      canvas.id,
      { name: 'Next', html: '<p>n</p>', x: 100 + 390 + 80, y: 100, width: 300, height: 300 },
      actor,
    )
    const made = copy(canvas.id, [{ frame_id: source.id }, { frame_id: source.id }, { frame_id: source.id }])
    const all = store.getCanvas(canvas.id)!.frames
    for (const [i, one] of all.entries()) for (const other of all.slice(i + 1)) expect(overlaps(one, other)).toBe(false)
    expect(made).toHaveLength(3)
  })

  it('keeps a given x or y and takes the other axis from the rule', () => {
    const { canvas, source } = setup()
    const [made] = copy(canvas.id, [{ frame_id: source.id, x: 2000 }])
    expect(made!.frame.x).toBe(2000)
    expect(made!.frame.y).toBe(100)
  })

  it('refuses a frame of another canvas and an unknown page, naming the item', () => {
    const { canvas, source } = setup()
    const other = store.createCanvas('other')
    const foreign = actions.createFrame(other.id, { name: 'F', html: '<p>f</p>' }, actor)!
    const before = store.getCanvas(canvas.id)!.frames.length
    const canvasNow = store.getCanvas(canvas.id)!
    const wrong = planDuplicates(canvasNow, [{ frame_id: source.id }, { frame_id: foreign.id }])
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining('items[1]') })
    const page = planDuplicates(canvasNow, [{ frame_id: source.id, page_id: 'nope' }])
    expect(page).toMatchObject({ ok: false, error: expect.stringContaining('items[0]') })
    expect(store.getCanvas(canvas.id)!.frames).toHaveLength(before)
  })
})
