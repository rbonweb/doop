import { z } from 'zod'
import type { Page } from 'puppeteer-core'

export type PageAction =
  { click: string } | { hover: string } | { type: { selector: string; text: string } } | { wait_for: string }

export const MAX_ACTIONS = 10

export const ACTIONS_BUDGET_MS = 5000

const selectorSchema = z.string().min(1).max(500)

export const pageActionsSchema = z
  .array(
    z.union([
      z.object({ click: selectorSchema }).strict(),
      z.object({ hover: selectorSchema }).strict(),
      z.object({ type: z.object({ selector: selectorSchema, text: z.string().max(2000) }).strict() }).strict(),
      z.object({ wait_for: selectorSchema }).strict(),
    ]),
  )
  .max(MAX_ACTIONS)
  .describe(
    'Run before the capture, in order: { click: selector }, { hover: selector }, { type: { selector, text } }, { wait_for: selector }. At most 10 steps and 5 s in all.',
  )

export interface ActionsOutcome {
  ok: boolean
  done: number
  error?: string
}

function kindOf(action: PageAction): string {
  return Object.keys(action)[0] ?? 'unknown'
}

function selectorOf(action: PageAction): string {
  if ('click' in action) return action.click
  if ('hover' in action) return action.hover
  if ('type' in action) return action.type.selector
  return action.wait_for
}

function briefly(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || /timed? ?out|timeout/i.test(error.message)) return 'timed out'
    return error.message.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return String(error).slice(0, 200)
}

async function runStep(page: Page, action: PageAction, timeout: number): Promise<void> {
  if ('click' in action) {
    await page.waitForSelector(action.click, { visible: true, timeout })
    await page.click(action.click)
    return
  }
  if ('hover' in action) {
    await page.waitForSelector(action.hover, { visible: true, timeout })
    await page.hover(action.hover)
    return
  }
  if ('type' in action) {
    await page.waitForSelector(action.type.selector, { visible: true, timeout })
    await page.click(action.type.selector)
    await page.type(action.type.selector, action.type.text)
    return
  }
  await page.waitForSelector(action.wait_for, { visible: true, timeout })
}

/* Let the page show the result of the steps before it is captured: two frames so style and layout have run, then a short wait for finite running animations to finish. */
async function settleAfterActions(page: Page, remaining: number): Promise<void> {
  const deadline = Date.now() + remaining
  const left = () => Math.max(1, deadline - Date.now())
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.evaluate(async (ms: number) => {
    const finite = document
      .getAnimations()
      .filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    if (finite.length === 0) return
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, Math.min(ms, 300))),
    ])
  }, left())
}

export async function runPageActions(
  page: Page,
  actions: PageAction[],
  budgetMs: number = ACTIONS_BUDGET_MS,
): Promise<ActionsOutcome> {
  const deadline = Date.now() + budgetMs
  const left = () => Math.max(1, deadline - Date.now())
  let done = 0
  for (const action of actions) {
    try {
      await runStep(page, action, left())
    } catch (error) {
      return {
        ok: false,
        done,
        error: `step ${done + 1} (${kindOf(action)} "${selectorOf(action)}"): ${briefly(error)}`,
      }
    }
    done++
  }
  if (done > 0) await settleAfterActions(page, left()).catch(() => {})
  return { ok: true, done }
}
