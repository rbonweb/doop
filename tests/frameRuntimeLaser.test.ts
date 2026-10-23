// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

/* Laser mode in the frame runtime, driven the way FrameView drives it: doop:laser from the parent, then a click. */

const posted: unknown[] = []

function send(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}

const render = (body: string) =>
  send({ type: 'doop:html', html: `<!doctype html><html><head></head><body>${body}</body></html>` })

const laserStyle = () => document.getElementById('doop-laser')
const copies = () => posted.filter((m) => (m as { type?: string }).type === 'doop:laser-copy') as { selector: string }[]

beforeAll(() => {
  /* the runtime talks to its parent; in this document the parent is the window itself */
  vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
    posted.push(message)
  }) as typeof window.postMessage)
  const boot = /<script data-v-boot>([\s\S]*)<\/script>/.exec(FRAME_BOOTSTRAP)?.[1]
  if (!boot) throw new Error('bootstrap script not found')
  new Function(boot)()
})

afterEach(() => {
  send({ type: 'doop:laser', on: false })
  posted.length = 0
})

describe('frame runtime laser mode', () => {
  it('injects one style for depths 1 to 12 and removes it again', () => {
    render('<main><section><p>Hi</p></section></main>')
    expect(laserStyle()).toBeNull()

    send({ type: 'doop:laser', on: true })
    const css = laserStyle()?.textContent ?? ''
    expect(css).toContain('body > *{')
    expect(css).toContain('body > * > *{')
    expect(css).toContain(`body${' > *'.repeat(12)}{`)
    expect(css).not.toContain(`body${' > *'.repeat(13)}{`)
    expect(css).toContain('outline:1px solid hsl(var(--doop-hue) 80% 55%)')
    /* the hue steps by 60 per level and wraps every six */
    expect(css).toContain('--doop-hue:60;')
    expect(css).toContain('--doop-hue:0;')
    expect(document.querySelectorAll('#doop-laser')).toHaveLength(1)

    send({ type: 'doop:laser', on: true })
    expect(document.querySelectorAll('#doop-laser')).toHaveLength(1)

    send({ type: 'doop:laser', on: false })
    expect(laserStyle()).toBeNull()
    expect(document.getElementById('doop-laser-box')).toBeNull()
    expect(document.getElementById('doop-laser-label')).toBeNull()
  })

  it('survives a new render of the frame, which would sweep a style out of head or body', () => {
    render('<main><p>one</p></main>')
    send({ type: 'doop:laser', on: true })
    render('<main><p>two</p><p>three</p></main>')
    expect(laserStyle()).not.toBeNull()
  })

  it('posts the clicked element path to the parent and swallows the click', () => {
    render('<main><section><p id="hello">Hi</p></section></main>')
    send({ type: 'doop:laser', on: true })
    const p = document.getElementById('hello')!
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    p.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(copies()).toEqual([{ type: 'doop:laser-copy', selector: '#hello' }])
  })

  it('uses an nth-of-type path for elements without an id', () => {
    render('<main><section><p>a</p><p>b</p></section></main>')
    send({ type: 'doop:laser', on: true })
    document.querySelectorAll('p')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(copies().at(-1)?.selector).toBe(
      'body:nth-of-type(1) > main:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(2)',
    )
  })

  it('does not post or swallow clicks when laser is off', () => {
    render('<main><p id="x">Hi</p></main>')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.getElementById('x')!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(copies()).toEqual([])
  })

  it('ignores a click on the page itself', () => {
    render('<main><p>Hi</p></main>')
    send({ type: 'doop:laser', on: true })
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(copies()).toEqual([])
  })

  it('labels the hovered element with its tag and the first 40 characters of its text', () => {
    render(`<main><p id="long">${'word '.repeat(30)}</p></main>`)
    send({ type: 'doop:laser', on: true })
    document
      .getElementById('long')!
      .dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }))
    const label = document.getElementById('doop-laser-label')
    expect(label?.style.display).toBe('block')
    expect(label?.textContent).toBe(`p · "${'word '.repeat(30).trim().slice(0, 40)}"`)
    expect(document.getElementById('doop-laser-box')?.style.outline).toContain('2px')
  })

  it('keeps laser markup out of the saved document', () => {
    render('<main><p id="x">Hi</p></main>')
    send({ type: 'doop:laser', on: true })
    /* editing serializes the live document; the overlays must not ride along into the saved html */
    send({ type: 'doop:edit', on: true })
    send({ type: 'doop:edit', on: false })
    const edited = posted.find((m) => (m as { type?: string }).type === 'doop:edited') as { html: string } | undefined
    expect(edited).toBeDefined()
    expect(edited!.html).not.toContain('doop-laser')
  })
})
