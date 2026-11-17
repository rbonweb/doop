import {
  componentBundleSchema,
  MAX_BUNDLE_CSS_BYTES,
  MAX_BUNDLE_HTML_BYTES,
  type BundleComponent,
  type ComponentBundle,
} from '../componentBundle.ts'
import { readArgTypes, type ArgProp } from './argTypes.ts'
import {
  CAPTURE_PRELUDE,
  captureStory,
  readStoryMeta,
  settleStory,
  STYLE_PROPERTIES,
  type CapturedStory,
  type StoryCapture,
} from './capture.ts'
import type { StoryEntry, StorybookIssue } from './index.ts'
import { groupStories, planVariants, STORYBOOK_LIMITS, storyIframeUrl, variantAllowance } from './plan.ts'

/** Pure: no node or server imports, since the CLI bundles it. Turns a Storybook's stories into a ComponentBundle through a page it is handed, so the server (the hardened renderer) and the CLI (the team's own browser) run the same capture and build the same bundle. */

/** The page a story renders in: what the server's isolated page and the CLI's browser page both do. */
export interface StoryPage {
  goto(url: string, timeoutMs: number): Promise<void>
  /** resolves once `storyState()` says ready or error, rejects at the timeout */
  waitForState(timeoutMs: number): Promise<'ready' | 'error'>
  evaluate<Arg, Result>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>
  /** runs a source string, for the prelude */
  evaluateSource(source: string): Promise<unknown>
}

export interface StoryRender {
  capture: StoryCapture
  props: ArgProp[]
  displayName?: string
  issues: StorybookIssue[]
}

export interface RenderRequest {
  baseUrl: string
  storyId: string
  args: Record<string, string | number | boolean>
  readMeta: boolean
}

/** One story, rendered and captured. A failure to load, a story that errors or one that never renders is a `capture` with `ok: false`, never a throw (an abort is the only throw). */
export async function renderStory(page: StoryPage, request: RenderRequest, signal?: AbortSignal): Promise<StoryRender> {
  const issues: StorybookIssue[] = []
  const fail = (reason: string): StoryRender => ({ capture: { ok: false, reason }, props: [], issues })
  try {
    signal?.throwIfAborted()
    await page.goto(storyIframeUrl(request.baseUrl, request.storyId, request.args), STORYBOOK_LIMITS.renderMs)
    const state = await page.waitForState(STORYBOOK_LIMITS.renderMs)
    if (state === 'error') return fail('Storybook shows an error for this story')
    await page.evaluateSource(CAPTURE_PRELUDE)
    await page.evaluate(settleStory, 2000)
    let props: ArgProp[] = []
    let displayName: string | undefined
    if (request.readMeta) {
      const meta = await page.evaluate(readStoryMeta, request.storyId).catch(() => null)
      if (meta) {
        const read = readArgTypes(meta.argTypes, meta.initialArgs)
        props = read.props
        issues.push(...read.issues)
        displayName = meta.displayName
      } else {
        issues.push({
          code: 'argtypes_unavailable',
          message: 'Storybook gave no argTypes for this story; it has no props',
        })
      }
    }
    const textArgs = props
      .filter((prop) => prop.type === 'text' && typeof prop.initial === 'string')
      .map((prop) => ({ prop: prop.name, value: String(prop.initial) }))
    const capture = await page.evaluate(captureStory, {
      textArgs,
      maxBytes: STORYBOOK_LIMITS.captureBytes,
      maxElements: 300,
    })
    return { capture, props, displayName, issues }
  } catch (error) {
    if (signal?.aborted) throw error
    return fail(error instanceof Error ? error.message.slice(0, 200) : 'The story could not be rendered')
  }
}

const DECLARATION_UNSAFE = /[{}<>\n\r]/

/** The CSS that turns the default render into a variant's, from the computed styles of both: for each element whose look differs, one rule on its path. Only when the two trees have the same shape; undefined otherwise. */
export function diffStyles(base: CapturedStory, variant: CapturedStory): string | undefined {
  if (!base.styles || !variant.styles || base.shape !== variant.shape) return undefined
  const rules: string[] = []
  for (const [index, baseValues] of base.styles.entries()) {
    const values = variant.styles[index]
    const path = base.paths[index]
    if (!values || !path) return undefined
    const declarations: string[] = []
    for (const [column, property] of STYLE_PROPERTIES.entries()) {
      const next = values[column]
      if (next !== undefined && next !== baseValues[column] && next !== '' && !DECLARATION_UNSAFE.test(next)) {
        declarations.push(`  ${property}: ${next};`)
      }
    }
    if (declarations.length) rules.push(`${path} {\n${declarations.join('\n')}\n}`)
  }
  return rules.join('\n')
}

function identifier(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value && /^[A-Za-z_$][\w$]*$/.test(value) && value.length <= 100 ? value : undefined
}

export interface BundleInput {
  entries: StoryEntry[]
  source: { kind: 'storybook' | 'cli'; url?: string; name?: string }
  /** the Storybook's own base URL, from which story iframes are loaded */
  baseUrl: string
  package?: string
  include?: string[]
  /** runs `use` with a page that is closed afterwards; each call is one story render */
  withPage: <T>(use: (page: StoryPage) => Promise<T>) => Promise<T>
  signal?: AbortSignal
  /** story renders at once (default 1) */
  concurrency?: number
  /** the clock, for the import's time box */
  now?: () => number
  onProgress?: (done: number, total: number) => void
}

export interface BundleResult {
  bundle: ComponentBundle
  issues: StorybookIssue[]
  renders: number
}

async function inPool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane))
  return results
}

/** Stories to a bundle, inside STORYBOOK_LIMITS: components, renders and the whole import's time. A component whose default story fails is left out and said so; a variant that fails is left out and said so. Throws only when nothing at all could be imported or the signal aborts. */
export async function buildComponentBundle(input: BundleInput): Promise<BundleResult> {
  const now = input.now ?? Date.now
  const started = now()
  const issues: StorybookIssue[] = []
  const grouped = groupStories(input.entries, { include: input.include })
  issues.push(...grouped.issues)
  const concurrency = input.concurrency ?? 1
  const components: BundleComponent[] = []
  const shared = new Set<string>()
  let renders = 0

  const render = (request: Omit<RenderRequest, 'baseUrl'>) =>
    input.withPage((page) => renderStory(page, { ...request, baseUrl: input.baseUrl }, input.signal))

  for (const [index, group] of grouped.groups.entries()) {
    input.signal?.throwIfAborted()
    const note = (code: string, message: string) => issues.push({ component: group.name, code, message })
    if (now() - started > STORYBOOK_LIMITS.importMs) {
      issues.push({
        code: 'import_timeout',
        message: `The import hit its ${STORYBOOK_LIMITS.importMs / 60_000} minute limit after ${components.length} components; use include to import the rest`,
      })
      break
    }
    if (renders >= STORYBOOK_LIMITS.renders) {
      issues.push({
        code: 'renders_capped',
        message: `The import hit its ${STORYBOOK_LIMITS.renders} render limit; use include to import the rest`,
      })
      break
    }
    renders++
    const base = await render({ storyId: group.defaultStory.id, args: {}, readMeta: true })
    for (const issue of base.issues) note(issue.code, issue.message)
    const capture = base.capture
    if (!capture.ok) {
      note('story_failed', `The default story "${group.defaultStory.name}" could not be captured: ${capture.reason}`)
      input.onProgress?.(index + 1, grouped.groups.length)
      continue
    }
    for (const issue of capture.issues) note(issue.code, issue.message)
    if (capture.html.length > MAX_BUNDLE_HTML_BYTES || capture.css.length > MAX_BUNDLE_CSS_BYTES) {
      note('component_too_large', 'The component renders more html or css than a bundle holds, so it was left out')
      input.onProgress?.(index + 1, grouped.groups.length)
      continue
    }
    for (const rule of capture.sharedRules) shared.add(rule)

    const props = base.props.map((prop) => ({ ...prop }))
    const plan = planVariants(props, variantAllowance(renders, grouped.groups.length - index - 1))
    for (const reason of plan.skipped) note('variants_skipped', reason)
    renders += plan.renders.length
    const rendered = await inPool(plan.renders, concurrency, async (variant) => ({
      variant,
      result: await render({
        storyId: group.defaultStory.id,
        args: { [variant.arg]: variant.argValue },
        readMeta: false,
      }),
    }))
    const variants: NonNullable<BundleComponent['variants']> = {}
    const reflected = new Set<string>()
    for (const { variant, result } of rendered) {
      const shot = result.capture
      if (!shot.ok) {
        note('variant_failed', `${variant.prop}=${variant.value} could not be captured: ${shot.reason}`)
        continue
      }
      for (const rule of shot.sharedRules) shared.add(rule)
      const diff = diffStyles(capture, shot)
      let entry: { html?: string; css?: string } | undefined
      if (diff !== undefined) {
        if (diff) entry = { css: diff }
      } else if (shot.html.length <= MAX_BUNDLE_HTML_BYTES && shot.css.length <= MAX_BUNDLE_CSS_BYTES) {
        entry = { html: shot.html, css: shot.css }
      } else
        note('variant_failed', `${variant.prop}=${variant.value} renders more than a bundle holds, so it was left out`)
      if (!entry || (entry.css ?? '').length > MAX_BUNDLE_CSS_BYTES) continue
      ;(variants[variant.prop] ??= {})[variant.value] = entry
      if (entry.css) reflected.add(variant.prop)
    }
    const outProps = props.map(({ arg: _arg, initial: _initial, ...prop }) => ({
      ...prop,
      ...(prop.type === 'boolean' && reflected.has(prop.name) ? { reflect: true } : {}),
    }))
    const exportName =
      identifier(base.displayName) ??
      identifier(
        group.title
          .split('/')
          .pop()
          ?.replace(/[^\w$]/g, ''),
      )
    const propMapping = Object.fromEntries(
      props.filter((prop) => prop.arg !== prop.name).map((prop) => [prop.name, { name: prop.arg }]),
    )
    components.push({
      name: group.name,
      group: group.title.slice(0, 200),
      html: capture.html,
      ...(capture.css ? { css: capture.css } : {}),
      ...(outProps.length ? { props: outProps } : {}),
      ...(Object.keys(variants).length ? { variants } : {}),
      code: {
        ...(exportName ? { exportName } : {}),
        ...(Object.keys(propMapping).length ? { props: propMapping } : {}),
        origin: {
          kind: input.source.kind,
          storyId: group.defaultStory.id,
          url: storyIframeUrl(input.baseUrl, group.defaultStory.id),
        },
      },
    })
    input.onProgress?.(index + 1, grouped.groups.length)
  }

  if (!components.length) {
    throw new Error(
      issues.find((issue) => issue.code === 'story_failed')?.message ??
        'No component could be imported from this Storybook',
    )
  }
  let css = ''
  for (const rule of shared) {
    if (css.length + rule.length + 1 > MAX_BUNDLE_CSS_BYTES) {
      issues.push({
        code: 'shared_css_capped',
        message: 'The shared CSS is over the bundle limit; the rest was left out',
      })
      break
    }
    css += rule + '\n'
  }
  const parsed = componentBundleSchema.safeParse({
    version: 1,
    source: { ...input.source },
    ...(input.package ? { package: input.package } : {}),
    ...(css ? { css } : {}),
    components,
  })
  if (!parsed.success) {
    throw new Error(
      `The captured components do not make a valid bundle: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    )
  }
  return { bundle: parsed.data, issues, renders }
}
