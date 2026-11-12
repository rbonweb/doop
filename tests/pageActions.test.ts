import { describe, expect, it } from 'vitest'
import { loadFramePage, findBrowserPath } from '../server/screenshot.ts'
import {
  ACTIONS_BUDGET_MS,
  MAX_ACTIONS,
  pageActionsSchema,
  runPageActions,
  type PageAction,
} from '../server/pageActions.ts'
import type { Frame } from '../shared/types.ts'

const page = (html: string): Frame => ({
  id: 'f1',
  canvasId: 'c1',
  name: 'actions',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

const fixture = `<!doctype html><html><head><style>
  .panel { display: none }
  .panel.open { display: block }
  .hoverable { color: rgb(0, 0, 0) }
  .hoverable:hover { color: rgb(255, 0, 0) }
</style></head><body>
  <button id="tab" onclick="document.getElementById('panel').classList.add('open')">tab</button>
  <div id="panel" class="panel">panel body</div>
  <span id="hover" class="hoverable">hover me</span>
  <input id="field" />
  <div id="later"></div>
  <script>setTimeout(() => { document.getElementById('later').textContent = 'arrived' }, 200)</script>
</body></html>`

async function withPage<T>(
  html: string,
  run: (p: Awaited<ReturnType<typeof loadFramePage>>['page']) => Promise<T>,
): Promise<T> {
  const loaded = await loadFramePage(page(html))
  try {
    return await run(loaded.page)
  } finally {
    await loaded.close()
  }
}

describe('pageActionsSchema', () => {
  it('accepts each action form', () => {
    expect(
      pageActionsSchema.parse([
        { click: '#a' },
        { hover: '.b' },
        { type: { selector: '#c', text: 'hi' } },
        { wait_for: '#d' },
      ]),
    ).toEqual([{ click: '#a' }, { hover: '.b' }, { type: { selector: '#c', text: 'hi' } }, { wait_for: '#d' }])
  })

  it(`rejects ${MAX_ACTIONS + 1} steps`, () => {
    const actions = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => ({ click: `#a${i}` }))
    expect(pageActionsSchema.safeParse(actions).success).toBe(false)
  })

  it('rejects unknown keys', () => {
    expect(pageActionsSchema.safeParse([{ click: '#a', extra: true }]).success).toBe(false)
    expect(pageActionsSchema.safeParse([{ type: { selector: '#a', text: 'x', extra: true } }]).success).toBe(false)
  })
})

describe.skipIf(!findBrowserPath())('runPageActions', { timeout: 30_000 }, () => {
  it('clicks a tab button and shows its hidden panel', async () => {
    await withPage(fixture, async (p) => {
      const outcome = await runPageActions(p, [{ click: '#tab' }])
      expect(outcome).toEqual({ ok: true, done: 1 })
      expect(await p.evaluate(() => getComputedStyle(document.getElementById('panel') as HTMLElement).display)).toBe(
        'block',
      )
    })
  })

  it('hovers an element and applies its :hover style', async () => {
    await withPage(fixture, async (p) => {
      const before = await p.evaluate(() => getComputedStyle(document.getElementById('hover') as HTMLElement).color)
      const outcome = await runPageActions(p, [{ hover: '#hover' }])
      expect(outcome.ok).toBe(true)
      const after = await p.evaluate(() => getComputedStyle(document.getElementById('hover') as HTMLElement).color)
      expect(before).not.toBe(after)
      expect(after).toBe('rgb(255, 0, 0)')
    })
  })

  it('types into an input', async () => {
    await withPage(fixture, async (p) => {
      const outcome = await runPageActions(p, [{ type: { selector: '#field', text: 'hello' } }])
      expect(outcome).toEqual({ ok: true, done: 1 })
      expect(await p.evaluate(() => (document.getElementById('field') as HTMLInputElement).value)).toBe('hello')
    })
  })

  it('waits for an element a script adds after 200 ms', async () => {
    await withPage(fixture, async (p) => {
      const outcome = await runPageActions(p, [{ wait_for: '#later:not(:empty)' }])
      expect(outcome).toEqual({ ok: true, done: 1 })
    })
  })

  it('fails on a missing selector with step 1 and timed out within the budget', async () => {
    await withPage(fixture, async (p) => {
      const started = Date.now()
      const outcome = await runPageActions(p, [{ click: '#missing' }], 400)
      const elapsed = Date.now() - started
      expect(outcome.ok).toBe(false)
      expect(outcome.done).toBe(0)
      expect(outcome.error).toContain('step 1')
      expect(outcome.error).toContain('timed out')
      expect(elapsed).toBeLessThan(2000)
    })
  })

  it('keeps one budget across all steps', async () => {
    await withPage(fixture, async (p) => {
      const started = Date.now()
      const outcome = await runPageActions(p, [{ wait_for: '#no1' }, { wait_for: '#no2' }, { wait_for: '#no3' }], 400)
      const elapsed = Date.now() - started
      expect(outcome).toMatchObject({ ok: false, done: 0 })
      expect(outcome.error).toContain('step 1')
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(2000)
      expect(ACTIONS_BUDGET_MS).toBe(5000)
    })
  })

  it('reports the step that failed and the steps it completed', async () => {
    await withPage(fixture, async (p) => {
      const actions: PageAction[] = [{ click: '#tab' }, { wait_for: '#nope' }]
      const outcome = await runPageActions(p, actions, 400)
      expect(outcome.done).toBe(1)
      expect(outcome.error).toContain('step 2 (wait_for "#nope")')
    })
  })
})
