import { afterAll, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { measureFrame } from '../server/measure.ts'

/**
 * A frame with the shapes `measure` reports on: a 900 px hero whose h1 wraps only on a narrow viewport, grey-on-white and
 * white-on-black contrast pairs, a section cut off by its own overflow, one that spills visibly, and text over an image.
 */

const HEADLINE = 'Measure the page before you ship it'

const FIXTURE_HTML = `<!doctype html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; font-family: Arial, sans-serif; }
  .hero { height: 900px; background: #ffffff; }
  .hero h1 { font-size: 32px; line-height: 1.2; }
  .grey { height: 300px; background: #ffffff; padding: 20px; }
  .grey p { color: #777777; font-size: 16px; }
  .black { background: #000000; color: #ffffff; padding: 20px; }
  .clipped { height: 80px; overflow: hidden; }
  .clipped p, .spills p { font-size: 16px; line-height: 24px; }
  .spills { height: 40px; }
  .image { height: 120px; background-image: linear-gradient(#ffffff, #000000); padding: 20px; }
</style></head><body>
<section class="hero" data-doop-id="hero" data-doop-label="Hero">
  <h1>${HEADLINE}</h1>
</section>
<section class="grey">
  <p>Grey text on white</p>
  <div class="black">White on black</div>
</section>
<section class="clipped">
  <p>${'Clipped line of copy. '.repeat(80)}</p>
</section>
<section class="spills">
  <p>${'Overflowing line of copy. '.repeat(80)}</p>
</section>
<section class="image">
  <p>Text over an image</p>
</section>
</body></html>`

const frame = (): Frame => ({
  id: 'measure-fixture',
  canvasId: 'c',
  name: 'Measure fixture',
  x: 0,
  y: 0,
  width: 1200,
  height: 1440,
  html: FIXTURE_HTML,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'test',
})

afterAll(async () => {
  if (findBrowserPath()) await (await getBrowser()).close()
})

describe.skipIf(!findBrowserPath())('measureFrame', { timeout: 120_000 }, () => {
  it('measures the top-level sections and their boxes', async () => {
    const started = Date.now()
    const measured = await measureFrame(frame(), { width: 1200 })
    console.log(`measureFrame took ${Date.now() - started} ms`)

    expect(measured.width).toBe(1200)
    expect(measured.sections).toHaveLength(5)
    expect(measured.sections[0]).toMatchObject({ element_id: 'hero', label: 'Hero', tag: 'section' })
    expect(measured.sections[0]?.box).toEqual({ x: 0, y: 0, width: 1200, height: 900 })
    expect(measured.sections[1]?.box).toMatchObject({ y: 900, width: 1200, height: 300 })
    expect(measured.sections[4]?.box).toMatchObject({ y: 1320, width: 1200, height: 120 })
    /* the visibly spilling section pushes the document past the sum of the sections */
    expect(measured.height).toBeGreaterThanOrEqual(1440)
    expect(measured.text).toContain(HEADLINE)
  })

  it('counts heading lines at the width it is measured at', async () => {
    const narrow = await measureFrame(frame(), { width: 400 })
    const narrowHero = narrow.sections.find((section) => section.element_id === 'hero')
    expect(narrowHero?.box).toMatchObject({ width: 400, height: 900 })
    expect(narrowHero?.texts[0]).toMatchObject({ tag: 'h1', lines: 2, text: HEADLINE })

    const wide = await measureFrame(frame(), { width: 1200 })
    const wideHero = wide.sections.find((section) => section.element_id === 'hero')
    expect(wideHero?.texts[0]).toMatchObject({ tag: 'h1', lines: 1 })
  })

  it('reports contrast, colours and unknown backgrounds', async () => {
    const measured = await measureFrame(frame(), { width: 1200 })
    const grey = measured.sections[1]
    const greyText = grey?.texts.find((text) => text.text === 'Grey text on white')
    expect(greyText).toMatchObject({ color: '#777777', background: '#ffffff', large: false })
    expect(greyText?.contrast).toBeCloseTo(4.48, 2)

    const whiteText = grey?.texts.find((text) => text.text === 'White on black')
    expect(whiteText).toMatchObject({ color: '#ffffff', background: '#000000', contrast: 21 })

    expect(grey?.colors).toContain('#777777')
    expect(measured.colors).toContain('#777777')

    const overImage = measured.sections[4]?.texts[0]
    expect(overImage).toMatchObject({ background: null, contrast: null })
  })

  it('tells clipping from visible overflow', async () => {
    const measured = await measureFrame(frame(), { width: 1200 })
    expect(measured.sections[2]).toMatchObject({ overflow: false, clipped: true })
    expect(measured.sections[3]).toMatchObject({ overflow: true, clipped: false })
    /* the clipped section's paragraph is cut off by its ancestor, not by itself */
    const copy = measured.sections[2]?.texts[0]
    expect(copy).toMatchObject({ overflow: false, clipped: true })
  })

  it('measures only the sections its targets name', async () => {
    const byId = await measureFrame(frame(), { width: 1200, targets: [{ element_id: 'hero' }] })
    expect(byId.sections).toHaveLength(1)
    expect(byId.sections[0]).toMatchObject({ element_id: 'hero', label: 'Hero' })

    const byLabel = await measureFrame(frame(), { width: 1200, targets: [{ label: 'Hero' }] })
    expect(byLabel.sections).toHaveLength(1)
    expect(byLabel.sections[0]?.element_id).toBe('hero')
  })

  it('answers line queries by selector, and nothing for an invalid one', async () => {
    const measured = await measureFrame(frame(), { width: 400, lineQueries: ['h1', 'p', '['] })
    expect(measured.queries[0]?.matches).toHaveLength(1)
    expect(measured.queries[0]?.matches[0]?.lines).toBe(2)
    expect(measured.queries[1]?.matches.length).toBe(4)
    expect(measured.queries[1]?.matches.every((match) => match.lines >= 1)).toBe(true)
    expect(measured.queries[2]).toEqual({ selector: '[', matches: [] })
  })
})
