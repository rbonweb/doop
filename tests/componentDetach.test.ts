import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The real server and database: detach_from_library's action through its REST route. */

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

interface Def {
  id: string
  name: string
  rev: number
  template: string
  mainFrameId: string | null
  source?: { canvasId: string; rev: number; library?: boolean }
}
interface CanvasBody {
  components?: Def[]
  frames: { id: string; html: string; pageId?: string }[]
  pages?: { id: string; name: string }[]
}
interface LibraryBody {
  updates: { id: string; name: string }[]
}
interface Detached {
  component: Def
  main_frame_id: string | null
}

describe('detach a component from its workspace library', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let libraryId: string
  let consumerId: string
  let badgeId: string
  let heroId: string
  let heroBefore: string

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const libraryOf = async (id: string) => json<LibraryBody>(await owner.get(`/api/canvases/${id}/library`))
  const detach = (canvas: string, component: string, as: Client = owner) =>
    as.post(`/api/canvases/${canvas}/components/${component}/detach-library`, {})

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@detach.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@detach.test', 'Stranger')
    const workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    libraryId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'System', workspaceId }))).id
    consumerId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Landing', workspaceId }))).id
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Badge',
      html: '<span class="badge">New</span>',
      css: '.badge { color: teal }',
    })
    badgeId = (await json<{ component: Def }>(made)).component.id
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    const hero = await owner.post(`/api/canvases/${consumerId}/frames`, {
      name: 'Hero',
      html: doc('<doop-use component="Badge"></doop-use>'),
    })
    heroId = (await json<{ id: string }>(hero)).id
    heroBefore = (await canvasOf(consumerId)).frames.find((frame) => frame.id === heroId)!.html
  }, 60_000)

  afterAll(() => server?.stop())

  it('starts linked, with no main and no way to edit it here', async () => {
    const def = (await canvasOf(consumerId)).components!.find((entry) => entry.id === badgeId)!
    expect(def.source).toMatchObject({ canvasId: libraryId, library: true })
    expect(def.mainFrameId).toBeNull()
    const edit = await owner.patch(`/api/canvases/${consumerId}/components/${badgeId}`, { find: 'New', replace: 'Hot' })
    expect(edit.status).toBe(400)
    const { error } = await json<{ error: string }>(edit)
    expect(error).toContain('detach_from_library')
    expect(error).toContain('duplicate_component')
  })

  it('refuses a stranger and an unknown component', async () => {
    expect((await detach(consumerId, badgeId, stranger)).status).toBeGreaterThanOrEqual(400)
    const missing = await detach(consumerId, 'nope')
    expect(missing.status).toBe(400)
  })

  it('keeps the id, drops the link and writes a main on the Components page', async () => {
    const res = await detach(consumerId, badgeId)
    expect(res.status, await res.clone().text()).toBe(200)
    const { component, main_frame_id } = await json<Detached>(res)
    expect(component.id).toBe(badgeId)
    expect(component.name).toBe('Badge')
    expect(component.source).toBeUndefined()
    expect(main_frame_id).toBe(component.mainFrameId)
    expect(main_frame_id).not.toBeNull()
    const canvas = await canvasOf(consumerId)
    const main = canvas.frames.find((frame) => frame.id === main_frame_id)!
    expect(main.html).toContain(`data-doop-component="${badgeId}"`)
    expect(main.html).toContain('New')
    expect(canvas.pages!.find((page) => page.id === main.pageId)?.name).toBe('Components')
    expect(canvas.components!.find((def) => def.id === badgeId)?.source).toBeUndefined()
  })

  it('leaves every instance linked and unchanged', async () => {
    const canvas = await canvasOf(consumerId)
    const hero = canvas.frames.find((frame) => frame.id === heroId)!
    expect(hero.html).toBe(heroBefore)
    expect(hero.html).toContain(`data-doop-instance="${badgeId}"`)
  })

  it('is editable here afterwards, and the instances follow', async () => {
    const edit = await owner.patch(`/api/canvases/${consumerId}/components/${badgeId}`, { find: 'New', replace: 'Hot' })
    expect(edit.status, await edit.clone().text()).toBe(200)
    const canvas = await canvasOf(consumerId)
    expect(canvas.components!.find((def) => def.id === badgeId)!.template).toContain('Hot')
    expect(canvas.frames.find((frame) => frame.id === heroId)!.html).toContain('Hot')
  })

  it('no longer takes library updates: sync refuses and nothing is offered', async () => {
    const edit = await owner.patch(`/api/canvases/${libraryId}/components/${badgeId}`, {
      find: 'New',
      replace: 'Fresh',
    })
    expect(edit.status, await edit.clone().text()).toBe(200)
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    expect((await libraryOf(consumerId)).updates).toEqual([])
    const sync = await owner.post(`/api/canvases/${consumerId}/components/${badgeId}/sync`, {})
    expect(sync.status).toBe(400)
    expect((await json<{ error: string }>(sync)).error).toContain('not imported from a library')
    expect((await canvasOf(consumerId)).components!.find((def) => def.id === badgeId)!.template).toContain('Hot')
  })

  it('refuses a component that is already local', async () => {
    const again = await detach(consumerId, badgeId)
    expect(again.status).toBe(400)
    expect((await json<{ error: string }>(again)).error).toContain('already local')
    const own = await owner.post(`/api/canvases/${libraryId}/components/${badgeId}/detach-library`, {})
    expect(own.status).toBe(400)
  })
})
