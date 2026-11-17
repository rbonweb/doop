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
  settleStory,
  STYLE_PROPERTIES,
  type CapturedStory,
  type StoryCapture,
} from './capture.ts'
import type { StoryEntry, StorybookIssue } from './index.ts'
import { guardCss } from './cssGuard.ts'
import { MAX_PROBE_CHARS, probeInstallSource, probeName } from './probe.ts'
import { captureRefusalSchema, storyCaptureSchema, storyMetaSchema } from './schemas.ts'
import { groupStories, planVariants, STORYBOOK_LIMITS, storyIframeUrl, variantAllowance } from './plan.ts'

/** Pure: no node or server imports, since the CLI bundles it. Turns a Storybook's stories into a ComponentBundle through a page it is handed, so the server (the hardened renderer) and the CLI (the team's own browser) run the same capture and build the same bundle. */

/** The page a story renders in: what the server's isolated page and the CLI's browser page both do. `evaluate` and `evaluateSource` run in an ISOLATED world, where the page's own JavaScript cannot reach the capture; the probe is the only thing that runs in the page's main world. */
export interface StoryPage {
  /** runs `source` in the main world of every document the page loads, before any page script */
  installProbe(source: string): Promise<void>
  goto(url: string, timeoutMs: number): Promise<void>
  /** asks the probe called `probe` until its state is ready or error; rejects at the timeout */
  waitForState(probe: string, timeoutMs: number): Promise<'ready' | 'error'>
  /** asks the probe for the story's argTypes, initial args and display name: a JSON string of at most MAX_PROBE_CHARS, or null */
  readMeta(probe: string, storyId: string): Promise<unknown>
  /** runs `fn` in the isolated world */
  evaluate<Arg, Result>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>
  /** runs a source string in the isolated world, for the prelude */
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

function refusalMessage(reason: string, bytes?: number): string {
  if (reason === 'too_large') {
    return `The rendered story is too large to import (${bytes ?? 'over'} bytes; the limit is ${STORYBOOK_LIMITS.captureBytes})`
  }
  if (reason === 'too_many_elements')
    return `The rendered story has too many elements to import (${bytes ?? 'over 20000'})`
  return reason
}

/** One story, rendered and captured. A failure to load, a story that errors or one that never renders is a `capture` with `ok: false`, never a throw (an abort is the only throw). */
export async function renderStory(page: StoryPage, request: RenderRequest, signal?: AbortSignal): Promise<StoryRender> {
  const issues: StorybookIssue[] = []
  const fail = (reason: string): StoryRender => ({ capture: { ok: false, reason }, props: [], issues })
  try {
    signal?.throwIfAborted()
    const probe = probeName()
    await page.installProbe(probeInstallSource(probe))
    await page.goto(storyIframeUrl(request.baseUrl, request.storyId, request.args), STORYBOOK_LIMITS.renderMs)
    const state = await page.waitForState(probe, STORYBOOK_LIMITS.renderMs)
    if (state === 'error') return fail('Storybook shows an error for this story')
    await page.evaluateSource(CAPTURE_PRELUDE)
    await page.evaluate(settleStory, 2000)
    let props: ArgProp[] = []
    let displayName: string | undefined
    if (request.readMeta) {
      /* the answer comes from the page's own world: a bounded string, parsed and validated like anything else */
      const raw = await page.readMeta(probe, request.storyId).catch(() => null)
      let json: unknown
      try {
        json = typeof raw === 'string' && raw.length <= MAX_PROBE_CHARS + 1024 ? JSON.parse(raw) : null
      } catch {
        json = null
      }
      const meta = json === null ? undefined : storyMetaSchema.safeParse(json)
      if (meta?.success) {
        const read = readArgTypes(meta.data.argTypes, meta.data.initialArgs)
        props = read.props
        issues.push(...read.issues)
        displayName = meta.data.displayName
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
    const result: unknown = await page.evaluate(captureStory, {
      textArgs,
      styleProperties: STYLE_PROPERTIES,
      maxBytes: STORYBOOK_LIMITS.captureBytes,
      maxElements: 300,
    })
    /* serialized and measured in the isolated world: a string within the cap, or a small refusal. Anything else is not from the capture */
    if (typeof result !== 'string') {
      const refusal = captureRefusalSchema.safeParse(result)
      if (!refusal.success) return fail('The page returned a capture Doop could not read')
      return fail(refusalMessage(refusal.data.reason, refusal.data.bytes))
    }
    if (result.length > STORYBOOK_LIMITS.captureBytes) return fail(refusalMessage('too_large', result.length))
    let json: unknown
    try {
      json = JSON.parse(result)
    } catch {
      return fail('The page returned a capture Doop could not read')
    }
    const parsed = storyCaptureSchema.safeParse(json)
    if (!parsed.success) return fail('The page returned a capture Doop could not read')
    const capture = parsed.data
    if (capture.ok) {
      /* the CSS is text the page chose: only whole, well-formed rules of the kinds the capture emits go on */
      const own = guardCss(capture.css)
      let dropped = own.dropped
      const sharedRules: string[] = []
      for (const rule of capture.sharedRules) {
        const guarded = guardCss(rule)
        dropped += guarded.dropped
        if (guarded.css) sharedRules.push(guarded.css)
      }
      capture.css = own.css
      capture.sharedRules = sharedRules
      if (dropped) {
        capture.issues.push({
          code: 'css_rules_dropped',
          message: `${dropped} CSS rules were left out because they were malformed or unsafe`,
        })
      }
    }
    return { capture, props, displayName, issues }
  } catch (error) {
    if (signal?.aborted) throw error
    return fail(error instanceof Error ? error.message.slice(0, 200) : 'The story could not be rendered')
  }
}

/** a class as `CSS.escape` writes it: plain characters, a backslash and one character, or a backslash and hex digits */
const CSS_IDENT = String.raw`(?:[A-Za-z0-9_-]|\\[^\n\r0-9a-fA-F]|\\[0-9a-fA-F]{1,6} ?)+`
const TAG = '[a-z][a-z0-9-]*'
/** the root path `capture` writes: its tag and up to six classes */
const ROOT_PATH = new RegExp(`^${TAG}(?:\\.${CSS_IDENT}){0,6}$`)
/** a descendant path: `tag:nth-child(n)` steps from the root's children down */
const CHILD_PATH = new RegExp(`^${TAG}:nth-child\\(\\d{1,4}\\)(?: > ${TAG}:nth-child\\(\\d{1,4}\\)){0,30}$`)
/** the only url() a computed value may keep: a quoted http(s) address */
const HTTP_URL = /url\(\s*"https?:\/\/[^"\\\s()]{1,1000}"\s*\)/gi
const VALUE_CHARS = /^[\p{L}\p{N}\s.,%#()/+\-"'*_]*$/u

/** Whether `path` is a selector `capture` could have written for the element at `index` (0 is the root). */
export function isEmittedPath(path: string, index: number): boolean {
  return (index === 0 ? ROOT_PATH : CHILD_PATH).test(path)
}

/** A computed value that is safe to write into a rule: no way to end the declaration or the rule, open a comment or an at-rule, escape, or fetch from anywhere but http(s). */
export function safeDeclarationValue(value: string): boolean {
  if (!value || value.length > 500) return false
  const bare = value.replace(HTTP_URL, 'url_')
  if (/url\s*\(|expression|javascript|behavior|image-set|\/\*/i.test(bare)) return false
  if (!VALUE_CHARS.test(bare)) return false
  return (bare.match(/"/g)?.length ?? 0) % 2 === 0 && (bare.match(/'/g)?.length ?? 0) % 2 === 0
}

/** The CSS that turns the default render into a variant's, from the computed styles of both: for each element whose look differs, one rule on its path. Only when the two trees have the same shape, and every path is one `capture` could have written; undefined otherwise. Both captures are page-controlled, so paths and values are checked against the exact grammar emitted, whatever the importer does after. */
export function diffStyles(base: CapturedStory, variant: CapturedStory): string | undefined {
  if (!base.styles || !variant.styles || base.shape !== variant.shape) return undefined
  const rules: string[] = []
  for (const [index, baseValues] of base.styles.entries()) {
    const values = variant.styles[index]
    const path = base.paths[index]
    if (!values || !path || !isEmittedPath(path, index)) return undefined
    const declarations: string[] = []
    for (const [column, property] of STYLE_PROPERTIES.entries()) {
      const next = values[column]
      if (next !== undefined && next !== baseValues[column] && next !== '' && safeDeclarationValue(next)) {
        declarations.push(`  ${property}: ${next};`)
      }
    }
    if (declarations.length) rules.push(`${path} {\n${declarations.join('\n')}\n}`)
  }
  return guardCss(rules.join('\n')).css
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
  /** the components the import will render, once the stories are grouped and before the first render */
  onPlan?: (groups: PlannedComponent[]) => void
  /** after each render: `total` is what is planned so far (a component's variants join it once its default has been read), so it only grows */
  onRender?: (event: { rendered: number; total: number; component: string }) => void
}

export interface PlannedComponent {
  name: string
  /** the Storybook title path */
  group: string
  stories: number
  /** renders known before any story is read: the default story, one */
  renders: number
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
  input.onPlan?.(
    grouped.groups.map((group) => ({
      name: group.name,
      group: group.title,
      stories: group.stories.length,
      renders: 1,
    })),
  )
  let plannedTotal = grouped.groups.length
  let renderedCount = 0
  const concurrency = input.concurrency ?? 1
  const components: BundleComponent[] = []
  const shared = new Set<string>()
  let renders = 0

  /* a page that cannot be opened (the renderer is busy, the browser would not start) is not a story that failed: the import carries on without that render, and gives up with what it has after a few in a row */
  let openFailures = 0
  const render = async (request: Omit<RenderRequest, 'baseUrl'>): Promise<StoryRender> => {
    try {
      const result = await input.withPage((page) =>
        renderStory(page, { ...request, baseUrl: input.baseUrl }, input.signal),
      )
      openFailures = 0
      return result
    } catch (error) {
      if (input.signal?.aborted) throw error
      openFailures++
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'a page could not be opened'
      return { capture: { ok: false, reason }, props: [], issues: [] }
    }
  }

  for (const [index, group] of grouped.groups.entries()) {
    input.signal?.throwIfAborted()
    if (openFailures >= 3) {
      issues.push({
        code: 'renderer_unavailable',
        message: `Doop's renderer could not open pages (${components.length} components were imported before that); try again shortly`,
      })
      break
    }
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
    renderedCount++
    input.onRender?.({ rendered: renderedCount, total: plannedTotal, component: group.name })
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
    plannedTotal += plan.renders.length
    const rendered = await inPool(plan.renders, concurrency, async (variant) => {
      const result = await render({
        storyId: group.defaultStory.id,
        args: { [variant.arg]: variant.argValue },
        readMeta: false,
      })
      renderedCount++
      input.onRender?.({ rendered: renderedCount, total: plannedTotal, component: group.name })
      return { variant, result }
    })
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
      (
        issues.find((issue) => issue.code === 'renderer_unavailable') ??
        issues.find((issue) => issue.code === 'story_failed')
      )?.message ?? 'No component could be imported from this Storybook',
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
