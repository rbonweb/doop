import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* The one label rule behind measure_frame, lint_frame, snapshot_frame, get_frame_screenshot and compare_frames: every
   label get_frame's outline prints resolves in each tool, and a label (or selector) that names nothing is an error. */

const held = vi.hoisted(() => ({ stamps: [] as Array<{ path: string; by: string }> }))

vi.mock('../server/actions.ts', () => ({
  ensureElementId: async (frameId: string, path: string, by: string) => {
    held.stamps.push({ path, by })
    return { id: `stamped-${held.stamps.length}`, frame: { ...frameFor(frameId), updatedAt: 9 } }
  },
}))
vi.mock('../server/componentActions.ts', () => ({ compactFrameHtml: (frame: Frame) => frame.html }))
vi.mock('../server/store.ts', () => ({ store: { renderSource: async (frame: Frame) => frame } }))

const { resolveFrameTargets } = await import('../server/targetResolution.ts')
const { measureFrame } = await import('../server/measure.ts')
const { frameScreenshot } = await import('../server/frameShots.ts')
const { TargetError } = await import('../server/renderTargets.ts')
const { frameOutline } = await import('../server/sectionEdits.ts')
const { findBrowserPath, getBrowser } = await import('../server/screenshot.ts')

const HTML = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; font-family: Arial, sans-serif }
  section { height: 120px; padding: 10px }
</style></head><body><div>
<section><div><h2>High-converting Shopify themes</h2><p>Copy.</p></div></section>
<section data-doop-id="keep-me"><h2>Pricing</h2></section>
<section aria-label="Footer links"><p>Links.</p></section>
<section><h3>Twin</h3></section>
<section><h3>Twin</h3></section>
</div></body></html>`

function frameFor(id: string): Frame {
  return {
    id,
    canvasId: 'c',
    name: 'Labels',
    x: 0,
    y: 0,
    width: 800,
    height: 700,
    html: HTML,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'test',
  }
}

const frame = frameFor('labels')

afterAll(async () => {
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe('resolveFrameTargets', () => {
  it('turns every unique outline label into an element id or a positional selector', async () => {
    const labels = frameOutline(HTML)
      .sections.map((section) => section.label)
      .filter((label): label is string => label !== undefined && label !== 'Twin')
    expect(labels).toEqual(['High-converting Shopify themes', 'Pricing', 'Footer links'])
    const resolved = await resolveFrameTargets(
      frame,
      labels.map((label) => ({ label })),
    )
    expect(resolved.targets).toEqual([
      { selector: 'body:nth-of-type(1) > div:nth-of-type(1) > section:nth-of-type(1)' },
      { element_id: 'keep-me' },
      { selector: 'body:nth-of-type(1) > div:nth-of-type(1) > section:nth-of-type(3)' },
    ])
    expect(held.stamps).toEqual([])
  })

  it('stamps an element id for a caller who may edit, and matches case and spacing loosely', async () => {
    const resolved = await resolveFrameTargets(frame, [{ label: '  high-CONVERTING  shopify themes ' }], {
      stampAs: 'Ada',
    })
    expect(resolved.targets).toEqual([{ element_id: 'stamped-1' }])
    expect(resolved.frame.updatedAt).toBe(9)
    expect(held.stamps).toEqual([
      { path: 'body:nth-of-type(1) > div:nth-of-type(1) > section:nth-of-type(1)', by: 'Ada' },
    ])
  })

  it('refuses a label that names several sections and leaves unknown labels for the page', async () => {
    await expect(resolveFrameTargets(frame, [{ label: 'Twin' }])).rejects.toThrow(/label "Twin" matches 2 sections/)
    const resolved = await resolveFrameTargets(frame, [{ label: 'Nothing here' }, { selector: 'p' }])
    expect(resolved.targets).toEqual([{ label: 'Nothing here' }, { selector: 'p' }])
  })
})

describe.skipIf(!findBrowserPath())('outline labels in the render tools', () => {
  it('measure_frame measures the section each label names', async () => {
    const measured = await measureFrame(frame, {
      targets: [{ label: 'High-converting Shopify themes' }, { label: 'Pricing' }, { label: 'Footer links' }],
    })
    expect(measured.sections.map((section) => section.label)).toEqual([
      'High-converting Shopify themes',
      'Pricing',
      null,
    ])
    expect(measured.sections.every((section) => section.box.height === 120)).toBe(true)
  })

  it('measure_frame and lint targets that match nothing are errors naming the target', async () => {
    const error = await measureFrame(frame, { targets: [{ label: 'Pricing' }, { label: 'Nope' }] }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(TargetError)
    expect((error as Error).message).toContain('label "Nope"')
    await expect(measureFrame(frame, { targets: [{ selector: '.missing' }] })).rejects.toThrow('selector ".missing"')
    await expect(measureFrame(frame, { targets: [{ element_id: 'gone' }] })).rejects.toThrow('element_id "gone"')
  })

  it('get_frame_screenshot and compare_frames crop to the section a label names', async () => {
    const shot = await frameScreenshot(frame, { target: { label: 'High-converting Shopify themes' }, format: 'png' })
    expect(shot.clip).toEqual({ x: 0, y: 0, width: 800, height: 120 })
    const second = await frameScreenshot(frame, { target: { label: 'Footer links' }, format: 'png' })
    expect(second.clip).toEqual({ x: 0, y: 240, width: 800, height: 120 })
    await expect(frameScreenshot(frame, { target: { label: 'Nope' } })).rejects.toThrow(
      'no element matches label "Nope"',
    )
    await expect(frameScreenshot(frame, { target: { label: 'Twin' } })).rejects.toThrow(/matches 2 sections/)
  })
})
