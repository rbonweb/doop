import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_COMPONENT_NAME } from '../shared/components.ts'
import { Client, startServer, type Server } from './harness'

/* The real server and database: duplicate_component's action through its REST route. */

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

interface Def {
  id: string
  name: string
  rev: number
  template: string
  rawCss: string
  history: unknown[]
  mainFrameId: string | null
  props: { name: string }[]
  source?: { canvasId: string; library?: boolean }
}
interface FrameBody {
  id: string
  html: string
  pageId?: string
  x: number
  y: number
  width: number
  height: number
}
interface CanvasBody {
  components?: Def[]
  frames: FrameBody[]
  pages?: { id: string; name: string }[]
}
interface Duplicated {
  component: Def
  main_frame_id: string | null
}

describe('duplicate a component', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let canvasId: string
  let buttonId: string
  let pageFrameId: string

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const duplicate = (canvas: string, component: string, as: Client = owner) =>
    as.post(`/api/canvases/${canvas}/components/${component}/duplicate`, {})

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@duplicate.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@duplicate.test', 'Stranger')
    canvasId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Duplicates' }))).id
    const made = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Button',
      description: 'The primary action',
      html: '<button class="btn"><span>Start</span></button>',
      css: '.btn { padding: 8px 14px; color: #fff }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    buttonId = (await json<{ component: Def }>(made)).component.id
    const page = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Hero',
      html: doc('<doop-use component="Button"></doop-use>'),
    })
    expect(page.status).toBe(200)
    pageFrameId = (await json<{ id: string }>(page)).id
  }, 60_000)

  afterAll(() => server?.stop())

  it('makes a new component with the same design, a copy name and a history of its own', async () => {
    const before = await canvasOf(canvasId)
    const source = before.components!.find((def) => def.id === buttonId)!
    const res = await duplicate(canvasId, buttonId)
    expect(res.status, await res.clone().text()).toBe(200)
    const { component, main_frame_id } = await json<Duplicated>(res)
    expect(component.id).not.toBe(buttonId)
    expect(component.name).toBe('Button copy')
    expect(component.rev).toBe(1)
    expect(component.history).toEqual([])
    expect(component.source).toBeUndefined()
    expect(component.template).toContain('Start')
    expect(component.rawCss).toBe(source.rawCss)
    expect(main_frame_id).toBe(component.mainFrameId)
    expect(main_frame_id).not.toBeNull()
    expect(main_frame_id).not.toBe(source.mainFrameId)
    expect((await canvasOf(canvasId)).frames.find((frame) => frame.id === main_frame_id)?.html).toContain(
      `data-doop-component="${component.id}"`,
    )
  })

  it('names the next copies "copy 2", "copy 3"', async () => {
    const second = await json<Duplicated>(await duplicate(canvasId, buttonId))
    const third = await json<Duplicated>(await duplicate(canvasId, buttonId))
    expect(second.component.name).toBe('Button copy 2')
    expect(third.component.name).toBe('Button copy 3')
  })

  it('puts the main beside the original, on its page, clear of every frame', async () => {
    const canvas = await canvasOf(canvasId)
    const source = canvas.frames.find(
      (frame) => frame.id === canvas.components!.find((d) => d.id === buttonId)!.mainFrameId,
    )!
    const copies = canvas.components!.filter((def) => def.name.startsWith('Button copy'))
    expect(copies).toHaveLength(3)
    const mains = copies.map((def) => canvas.frames.find((frame) => frame.id === def.mainFrameId)!)
    for (const main of mains) {
      expect(main.pageId).toBe(source.pageId)
      expect(main.x).toBeGreaterThanOrEqual(source.x + source.width)
      expect(main.y).toBe(source.y)
    }
    const all = [source, ...mains]
    for (const [index, a] of all.entries())
      for (const b of all.slice(index + 1))
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false)
  })

  it('leaves the original and its instances untouched', async () => {
    const canvas = await canvasOf(canvasId)
    const original = canvas.components!.find((def) => def.id === buttonId)!
    expect(original.rev).toBe(1)
    expect(original.name).toBe('Button')
    expect(original.history).toEqual([])
    const page = canvas.frames.find((frame) => frame.id === pageFrameId)!
    expect(page.html).toContain(`data-doop-instance="${buttonId}"`)
    const again = await duplicate(canvasId, buttonId)
    expect(again.status).toBe(200)
    const after = await canvasOf(canvasId)
    expect(after.frames.find((frame) => frame.id === pageFrameId)!.html).toBe(page.html)
    expect(after.frames.find((frame) => frame.id === original.mainFrameId)!.html).toBe(
      canvas.frames.find((frame) => frame.id === original.mainFrameId)!.html,
    )
    expect(after.components!.find((def) => def.id === buttonId)).toEqual(original)
  })

  it('keeps the suffix inside the name limit', async () => {
    const long = 'L'.repeat(MAX_COMPONENT_NAME)
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name: long, html: '<div>Long</div>' })
    expect(made.status).toBe(200)
    const longId = (await json<{ component: Def }>(made)).component.id
    const first = (await json<Duplicated>(await duplicate(canvasId, longId))).component.name
    const second = (await json<Duplicated>(await duplicate(canvasId, longId))).component.name
    expect(first).toBe(`${'L'.repeat(MAX_COMPONENT_NAME - ' copy'.length)} copy`)
    expect(second).toBe(`${'L'.repeat(MAX_COMPONENT_NAME - ' copy 2'.length)} copy 2`)
    expect(first.length).toBeLessThanOrEqual(MAX_COMPONENT_NAME)
  })

  it('refuses an unknown component and a stranger', async () => {
    const missing = await duplicate(canvasId, 'nope')
    expect(missing.status).toBe(400)
    expect((await json<{ error: string }>(missing)).error).toContain('no component')
    expect((await duplicate(canvasId, buttonId, stranger)).status).toBeGreaterThanOrEqual(400)
  })

  describe('from a workspace library', () => {
    let libraryId: string
    let consumerId: string
    let linkedId: string

    beforeAll(async () => {
      const workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
      libraryId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'System', workspaceId }))).id
      consumerId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Landing', workspaceId }))).id
      const made = await owner.post(`/api/canvases/${libraryId}/components`, {
        name: 'Badge',
        html: '<span class="badge">New</span>',
        css: '.badge { color: teal }',
      })
      linkedId = (await json<{ component: Def }>(made)).component.id
      expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
      const frame = await owner.post(`/api/canvases/${consumerId}/frames`, {
        name: 'Hero',
        html: doc('<doop-use component="Badge"></doop-use>'),
      })
      expect(frame.status).toBe(200)
    }, 60_000)

    it('duplicates a linked component into a plain local one with its own main', async () => {
      const before = await canvasOf(consumerId)
      const linked = before.components!.find((def) => def.id === linkedId)!
      expect(linked.source?.library).toBe(true)
      expect(linked.mainFrameId).toBeNull()

      const res = await duplicate(consumerId, linkedId)
      expect(res.status, await res.clone().text()).toBe(200)
      const { component, main_frame_id } = await json<Duplicated>(res)
      expect(component.id).not.toBe(linkedId)
      expect(component.name).toBe('Badge copy')
      expect(component.source).toBeUndefined()
      expect(component.rev).toBe(1)
      expect(main_frame_id).not.toBeNull()

      const after = await canvasOf(consumerId)
      const main = after.frames.find((frame) => frame.id === main_frame_id)!
      expect(main.html).toContain(`data-doop-component="${component.id}"`)
      expect(after.pages!.find((page) => page.id === main.pageId)?.name).toBe('Components')
      /* the linked original and the frame using it are as they were */
      expect(after.components!.find((def) => def.id === linkedId)).toEqual(linked)
      expect(after.frames.find((frame) => frame.html.includes('data-doop-instance'))!.html).toBe(
        before.frames.find((frame) => frame.html.includes('data-doop-instance'))!.html,
      )
    })
  })
})
