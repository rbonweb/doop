import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The editor's two variant routes on the real server: access roles, the shapes the Design tab calls, and refusals as 400s. */

describe('component variant routes', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let canvasId: string
  let componentId: string

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@variants.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@variants.test', 'Stranger')
    canvasId = ((await (await owner.post('/api/canvases', { name: 'Variants' })).json()) as { id: string }).id
    const created = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Chip',
      html: '<span class="chip">Hi</span>',
      css: '.chip { padding: 4px }',
      props: [{ name: 'size', type: 'enum', options: ['sm', 'md'] }],
    })
    componentId = ((await created.json()) as { component: { id: string } }).component.id
  }, 60_000)

  afterAll(() => server?.stop())

  it('lists variant props and rules, and applies ordered edits', async () => {
    const read = await owner.get(`/api/canvases/${canvasId}/components/${componentId}/variants`)
    expect(read.status).toBe(200)
    expect(((await read.json()) as { props: { name: string }[] }).props.map((prop) => prop.name)).toEqual(['size'])
    const write = await owner.post(`/api/canvases/${canvasId}/components/${componentId}/variants`, {
      ops: [
        { op: 'add_value', prop: 'size', value: 'lg' },
        { op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { padding: '12px' } },
      ],
    })
    expect(write.status).toBe(200)
    const body = (await write.json()) as {
      props: { options: string[] }[]
      rules: { when: Record<string, string>; declarations: Record<string, string> }[]
    }
    expect(body.props[0]!.options).toEqual(['sm', 'md', 'lg'])
    expect(body.rules).toEqual([expect.objectContaining({ when: { size: 'lg' }, declarations: { padding: '12px' } })])
  })

  it('answers a refusal as a 400 that names what is allowed, and refuses a stranger', async () => {
    const bad = await owner.post(`/api/canvases/${canvasId}/components/${componentId}/variants`, {
      ops: [{ op: 'set_style', element: 'root', when: { size: 'lg' }, declarations: { background: 'url(x)' } }],
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('url()')
    const malformed = await owner.post(`/api/canvases/${canvasId}/components/${componentId}/variants`, { ops: [] })
    expect(malformed.status).toBe(400)
    const denied = await stranger.post(`/api/canvases/${canvasId}/components/${componentId}/variants`, {
      ops: [{ op: 'set_default', prop: 'size', value: 'sm' }],
    })
    expect([401, 403, 404]).toContain(denied.status)
  })
})
