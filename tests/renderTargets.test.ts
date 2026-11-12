import { afterAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { findBrowserPath, getBrowser, loadFramePage } from '../server/screenshot.ts'
import {
  TargetError,
  clipForTarget,
  describeTarget,
  frameTargetSchema,
  resolveTargets,
  targetSelector,
} from '../server/renderTargets.ts'

/**
 * Element targets: the one way every render tool names a region of a frame. Pure tests cover the selector spelling and the schema; the Chromium tests resolve targets in a real loaded page, including document coordinates below the first viewport.
 */

describe('targetSelector', () => {
  it('spells an element_id as its data-doop-id attribute', () => {
    expect(targetSelector({ element_id: 'hero' })).toBe('[data-doop-id="hero"]')
  })

  it('spells a label as its data-doop-label attribute', () => {
    expect(targetSelector({ label: 'Hero' })).toBe('[data-doop-label="Hero"]')
  })

  it('passes a selector through untouched', () => {
    expect(targetSelector({ selector: 'main > .card[data-x="1"]' })).toBe('main > .card[data-x="1"]')
  })

  it('escapes backslashes and double quotes in attribute values', () => {
    expect(targetSelector({ element_id: 'a"b\\c' })).toBe('[data-doop-id="a\\"b\\\\c"]')
    expect(targetSelector({ label: 'say "hi"' })).toBe('[data-doop-label="say \\"hi\\""]')
  })
})

describe('describeTarget', () => {
  it('names the form and the value', () => {
    expect(describeTarget({ element_id: 'hero' })).toBe('element_id "hero"')
    expect(describeTarget({ label: 'Hero' })).toBe('label "Hero"')
    expect(describeTarget({ selector: '.a' })).toBe('selector ".a"')
  })
})

describe('frameTargetSchema', () => {
  it('accepts each of the three forms', () => {
    expect(frameTargetSchema.safeParse({ element_id: 'hero' }).success).toBe(true)
    expect(frameTargetSchema.safeParse({ label: 'Hero' }).success).toBe(true)
    expect(frameTargetSchema.safeParse({ selector: '.a' }).success).toBe(true)
  })

  it('rejects an empty object, two keys at once and empty values', () => {
    expect(frameTargetSchema.safeParse({}).success).toBe(false)
    expect(frameTargetSchema.safeParse({ element_id: 'hero', label: 'Hero' }).success).toBe(false)
    expect(frameTargetSchema.safeParse({ element_id: '' }).success).toBe(false)
    expect(frameTargetSchema.safeParse({ selector: 'x'.repeat(501) }).success).toBe(false)
  })
})

const frame: Frame = {
  id: 'targets',
  canvasId: 'c',
  name: 'Targets',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  html: `<!doctype html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box }
    body { font: 16px/1.2 sans-serif; background: #fff }
    .hero { position: absolute; left: 0; top: 0; width: 200px; height: 100px; background: #123456 }
    .badge { position: absolute; left: 300px; top: 20px; width: 60px; height: 30px; background: #eee }
    .tile { position: absolute; width: 100px; height: 50px; background: #ddd }
    .edge { position: absolute; left: 750px; top: 550px; width: 100px; height: 100px; background: #ccc }
    .far { position: absolute; left: 40px; top: 1200px; width: 120px; height: 80px; background: #bbb }
    .pricing { position: absolute; left: 20px; top: 400px; width: 320px; height: 140px; background: #aaa }
    .ghost { position: absolute; left: 10px; top: 10px; width: 0; height: 0 }
  </style></head><body>
    <div class="hero" data-doop-id="hero"></div>
    <div class="badge" data-doop-label="Badge"></div>
    <div class="tile" data-doop-id="a" style="left: 10px; top: 300px"></div>
    <div class="tile" data-doop-id="b" style="left: 200px; top: 400px"></div>
    <div class="edge" data-doop-id="edge"></div>
    <div class="ghost" data-doop-id="ghost"></div>
    <main>
      <h1>Landing</h1>
      <section class="pricing"><h2>  Pricing Plans </h2><p>Compare the plans.</p></section>
    </main>
    <div class="far" data-doop-id="far"></div>
  </body></html>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'test',
}

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const loaded = await loadFramePage(frame)
  try {
    return await fn(loaded.page)
  } finally {
    await loaded.close()
  }
}

describe.skipIf(!findBrowserPath())('resolveTargets and clipForTarget in Chromium', () => {
  it('resolves an element_id to its exact rect', async () => {
    await withPage(async (page) => {
      const matches = await resolveTargets(page, { element_id: 'hero' })
      expect(matches).toHaveLength(1)
      expect(matches[0]!.elementId).toBe('hero')
      expect(matches[0]!.rect).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    })
  })

  it('resolves a label through data-doop-label', async () => {
    await withPage(async (page) => {
      const clip = await clipForTarget(page, { label: 'Badge' }, frame)
      expect(clip).toEqual({ x: 300, y: 20, width: 60, height: 30 })
    })
  })

  it('leaves heading labels to the server: the page only looks up data-doop-label', async () => {
    await withPage(async (page) => {
      await expect(clipForTarget(page, { label: 'pricing PLANS' }, frame)).rejects.toThrow(
        'no element matches label "pricing PLANS"',
      )
    })
  })

  it('unions several selector matches only when all is set', async () => {
    await withPage(async (page) => {
      await expect(clipForTarget(page, { selector: '.tile' }, frame)).rejects.toThrow(
        '2 elements match selector ".tile"; name one by element_id',
      )
      const clip = await clipForTarget(page, { selector: '.tile' }, frame, { all: true })
      expect(clip).toEqual({ x: 10, y: 300, width: 290, height: 150 })
    })
  })

  it('reports an invalid selector', async () => {
    await withPage(async (page) => {
      const error = await clipForTarget(page, { selector: '..oops' }, frame).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TargetError)
      expect((error as Error).message).toMatch(/^invalid selector: /)
    })
  })

  it('reports a target with no match and skips zero-size elements', async () => {
    await withPage(async (page) => {
      await expect(clipForTarget(page, { label: 'Nothing here' }, frame)).rejects.toThrow(
        'no element matches label "Nothing here"',
      )
      expect(await resolveTargets(page, { element_id: 'ghost' })).toEqual([])
    })
  })

  it('pads by the given amount and clamps at the frame edge', async () => {
    await withPage(async (page) => {
      expect(await clipForTarget(page, { element_id: 'hero' }, frame, { pad: 10 })).toEqual({
        x: 0,
        y: 0,
        width: 210,
        height: 110,
      })
      expect(await clipForTarget(page, { element_id: 'edge' }, frame, { pad: 10 })).toEqual({
        x: 740,
        y: 540,
        width: 60,
        height: 60,
      })
    })
  })

  it('reports document coordinates for an element below the first 1000 px', async () => {
    await withPage(async (page) => {
      await page.evaluate(() => window.scrollTo(0, 800))
      const matches = await resolveTargets(page, { element_id: 'far' })
      expect(matches).toHaveLength(1)
      expect(matches[0]!.rect).toEqual({ x: 40, y: 1200, width: 120, height: 80 })
    })
  })
})

afterAll(async () => {
  if (findBrowserPath()) await (await getBrowser()).close()
})
