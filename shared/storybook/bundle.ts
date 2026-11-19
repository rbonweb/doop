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
import { bindHtml, findBindings, mapBindings, ownBindings, unboundChange } from './bindings.ts'
import { innerIdentities, onStateRules, planCompound } from './compound.ts'
import { guardCss, splitRules } from './cssGuard.ts'
import { chooseExportName } from './exportName.ts'
import { iconPackageOf } from './iconPackages.ts'
import { MAX_PROBE_CHARS, probeInstallSource, probeName } from './probe.ts'
import { captureRefusalSchema, storyCaptureSchema, storyMetaSchema } from './schemas.ts'
import {
  describeSkipped,
  groupStories,
  isPageLike,
  MAX_PLANNED_COMPONENTS,
  planVariants,
  STORYBOOK_LIMITS,
  storyIframeUrl,
  variantAllowance,
} from './plan.ts'

/** Pure: no node or server imports, since the CLI bundles it. Turns a Storybook's stories into a ComponentBundle through a page it is handed, so the server (the hardened renderer) and the CLI (the team's own browser) run the same capture and build the same bundle. */

/** The page a story renders in: what the server's isolated page and the CLI's browser page both do. `evaluate` and `evaluateSource` run in an ISOLATED world, where the page's own JavaScript cannot reach the capture; the probe is the only thing that runs in the page's main world. */
export interface StoryPage {
  /** runs `source` in the main world of every document the page loads, before any page script */
  installProbe(source: string): Promise<void>
  goto(url: string, timeoutMs: number): Promise<void>
  /** asks the probe called `probe` until its state is ready or error; rejects at the timeout */
  waitForState(probe: string, timeoutMs: number): Promise<'ready' | 'error' | 'needs_worker'>
  /** sets the story's args through Storybook's channel and resolves once it has rendered again (`error` when it did not); a page that cannot do this leaves the args to the story URL */
  applyArgs?(
    probe: string,
    storyId: string,
    args: Record<string, string | number | boolean>,
  ): Promise<'ready' | 'error'>
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
  /** the component's function name, minified in a production build */
  functionName?: string
  issues: StorybookIssue[]
}

export interface RenderRequest {
  baseUrl: string
  storyId: string
  args: Record<string, string | number | boolean>
  readMeta: boolean
  /** the component the story is for, so a story that shows it among other things is captured from its own part */
  focus?: string
}

function refusalMessage(reason: string, bytes?: number): string {
  if (reason === 'too_large') {
    return `The rendered story is too large to import (${bytes ?? 'over'} bytes; the limit is ${STORYBOOK_LIMITS.captureBytes})`
  }
  if (reason === 'too_many_elements')
    return `The rendered story has too many elements to import (${bytes ?? 'over 20000'})`
  return reason
}

/** A reason a render failed that its raiser wrote for the person: shown as is. Any other error (a browser, protocol or network failure) can name internal addresses and paths, so it is replaced by `RENDER_FAILED`. */
export class KnownRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnownRenderError'
  }
}

/** A story that registers a service worker (MSW, for mocked data) cannot run where the page may not start one. */
export const NEEDS_WORKER =
  'this story needs a service worker, which a published-Storybook import cannot run; use the Doop CLI on your machine'

export const RENDER_FAILED = 'The renderer could not open this story'

const reasonOf = (error: unknown): string =>
  error instanceof KnownRenderError ? error.message.slice(0, 200) : RENDER_FAILED

/** The import itself could not produce a bundle (nothing could be captured, or what was captured is not a valid bundle). The message is written for the person, never taken raw from an exception. */
export class BundleImportError extends Error {
  constructor(
    message: string,
    /** why, when a caller can act on it (`needs_worker`: the Storybook can only be imported with the CLI) */
    readonly code?: 'needs_worker',
  ) {
    super(message)
    this.name = 'BundleImportError'
  }
}

/** The stories of a component that might carry controls when its default story has none, best first: a Playground (Storybook's own name for the story you tweak), then the rest in index order. */
function controlStories(group: { defaultStory: { id: string }; stories: { id: string; name: string }[] }) {
  const others = group.stories.filter((story) => story.id !== group.defaultStory.id)
  const playground = (story: { id: string; name: string }) =>
    /playground|interactive|controls/i.test(story.name) || /--(playground|interactive)/i.test(story.id)
  return [...others.filter(playground), ...others.filter((story) => !playground(story))]
}

/** How many other stories are rendered to find controls the default story lacks. */
const MAX_CONTROL_PROBES = 2

/** The marker attribute every captured element carries (`data-doop-m-<random>="<index>"`), which differs per render and says nothing about the story. */
const RENDER_MARKER = / data-doop-m-[0-9a-f]+="\d{1,6}"/g

/** Whether two captures are the same render: the same markup, rules and computed looks, ignoring the per-render markers. */
export function sameRender(a: CapturedStory, b: CapturedStory): boolean {
  return (
    a.html.replace(RENDER_MARKER, '') === b.html.replace(RENDER_MARKER, '') &&
    a.css === b.css &&
    JSON.stringify(a.styles) === JSON.stringify(b.styles)
  )
}

/** A capture that failed for a reason that says nothing about the story: the render ran out of time, the page would not load, or the renderer could not open it. A story that errors or needs a worker would fail the same way again. */
function isTransientFailure(capture: { ok: false; reason: string; code?: string }): boolean {
  return !capture.code && (capture.reason === RENDER_FAILED || /in time|took too long/.test(capture.reason))
}

/** One story, rendered and captured. A failure to load, a story that errors or one that never renders is a `capture` with `ok: false`, never a throw (an abort is the only throw). */
export async function renderStory(page: StoryPage, request: RenderRequest, signal?: AbortSignal): Promise<StoryRender> {
  const issues: StorybookIssue[] = []
  const fail = (reason: string, code?: string): StoryRender => ({
    capture: { ok: false, reason, ...(code ? { code } : {}) },
    props: [],
    issues,
  })
  try {
    signal?.throwIfAborted()
    const probe = probeName()
    await page.installProbe(probeInstallSource(probe))
    await page.goto(storyIframeUrl(request.baseUrl, request.storyId, request.args), STORYBOOK_LIMITS.renderMs)
    const state = await page.waitForState(probe, STORYBOOK_LIMITS.renderMs)
    if (state === 'needs_worker') return fail(NEEDS_WORKER, 'story_needs_worker')
    if (state === 'error') return fail('Storybook shows an error for this story')
    if (page.applyArgs && Object.keys(request.args).length) {
      /* the URL's args are dropped for an argType Storybook cannot type: ask the story to take them */
      if ((await page.applyArgs(probe, request.storyId, request.args)) === 'error')
        return fail('Storybook did not render this story with those args')
    }
    await page.evaluateSource(CAPTURE_PRELUDE)
    await page.evaluate(settleStory, 2000)
    let props: ArgProp[] = []
    let displayName: string | undefined
    let functionName: string | undefined
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
        functionName = meta.data.functionName
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
    /* every render marks its elements so a binding found later can be put on the right one, in the default's markup and in a variant's own */
    const marker = probeName().replace('__doop_probe_', 'data-doop-m-')
    const result: unknown = await page.evaluate(captureStory, {
      textArgs,
      marker,
      styleProperties: STYLE_PROPERTIES,
      maxBytes: STORYBOOK_LIMITS.captureBytes,
      maxElements: 300,
      ...(request.focus ? { focus: request.focus } : {}),
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
      capture.marker = marker
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
    return { capture, props, displayName, functionName, issues }
  } catch (error) {
    if (signal?.aborted) throw error
    return fail(reasonOf(error))
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

const normalName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

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
  onPlan?: (components: PlannedComponent[], info: PlanInfo) => void
  /** after each component is finished (imported, left out or failed): `rendered` counts components done and `total` is the number the import takes, fixed from the plan on, since a component's variant renders are only known once its default has been read */
  onRender?: (event: { rendered: number; total: number; component: string }) => void
}

/** What a plan says beside its list: how many components the Storybook offers, whether the list is cut short (the plan line holds MAX_PLANNED_COMPONENTS), and how many an import takes. */
export interface PlanInfo {
  total: number
  capped: boolean
  importing: number
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

/** Every component a plan offers, for a person to choose from: up to MAX_PLANNED_COMPONENTS. */
export function plannedList(groups: { name: string; title: string; stories: unknown[] }[]): PlannedComponent[] {
  return groups.slice(0, MAX_PLANNED_COMPONENTS).map((group) => ({
    name: group.name,
    group: group.title,
    stories: group.stories.length,
    renders: 1,
  }))
}

/** What a bundle's shared CSS needs so imported components keep the Storybook's font: when no shared rule on html, body, :root or :host sets `font-family`, the page's own body font becomes `--font-root` (which the importer makes a token) and the body's font. Nothing when the page has none, or when the font could break out of a declaration. */
export function rootFontRules(sharedRules: Iterable<string>, rootFont: string | undefined): string[] {
  const font = rootFont?.trim()
  if (!font || font.length > 500 || /[;{}<>\\\r\n]|\/\*|\(/.test(font)) return []
  const document = /^(?:html|body|:root|:host)$/i
  for (const rule of sharedRules) {
    const open = rule.indexOf('{')
    if (open < 0 || rule.trimStart().startsWith('@')) continue
    if (
      rule
        .slice(0, open)
        .split(',')
        .some((selector) => document.test(selector.trim())) &&
      /(?:^|[;{\s])font-family\s*:/i.test(rule.slice(open))
    )
      return []
  }
  return [`:root { --font-root: ${font} }`, 'body { font-family: var(--font-root) }']
}

/** Stories to a bundle, inside STORYBOOK_LIMITS: components, renders and the whole import's time. A component whose default story fails is left out and said so; a variant that fails is left out and said so. Throws only when nothing at all could be imported or the signal aborts. */
export async function buildComponentBundle(input: BundleInput): Promise<BundleResult> {
  const now = input.now ?? Date.now
  const started = now()
  const issues: StorybookIssue[] = []
  const grouped = groupStories(input.entries, { include: input.include })
  issues.push(...grouped.issues)
  input.onPlan?.(plannedList(grouped.candidates), {
    total: grouped.candidates.length,
    capped: grouped.candidates.length > MAX_PLANNED_COMPONENTS,
    importing: grouped.groups.length,
  })
  /** a component is done: the one progress unit, so `total` is known from the plan and never grows */
  const finish = (index: number, component: string) => {
    input.onProgress?.(index + 1, grouped.groups.length)
    input.onRender?.({ rendered: index + 1, total: grouped.groups.length, component })
  }
  const concurrency = input.concurrency ?? 1
  const components: BundleComponent[] = []
  const compounds: { name: string; inner: Set<string> }[] = []
  const bundleNames = new Set(grouped.groups.map((group) => normalName(group.name)))
  const shared = new Set<string>()
  /* the story page's own body font, from the first component captured */
  let rootFont: string | undefined
  let renders = 0

  /* a page that cannot be opened (the renderer is busy, the browser would not start) is not a story that failed: the import carries on without that render, and gives up with what it has after a few in a row */
  let openFailures = 0
  /* the component being imported: each of its renders is captured from the part that names itself so */
  let focusName: string | undefined
  const render = async (request: Omit<RenderRequest, 'baseUrl'>): Promise<StoryRender> => {
    try {
      const result = await input.withPage((page) =>
        renderStory(page, { focus: focusName, ...request, baseUrl: input.baseUrl }, input.signal),
      )
      openFailures = 0
      return result
    } catch (error) {
      if (input.signal?.aborted) throw error
      openFailures++
      return { capture: { ok: false, reason: reasonOf(error) }, props: [], issues: [] }
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
    focusName = group.name
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
    /* an empty root or a page-sized render is a docs page, a catalogue or a layout, not a component */
    if (!capture.ok && /rendered nothing|too many elements/.test(capture.reason)) {
      note(
        'not_a_component',
        `"${group.title}" is not a component: its story ${capture.reason.replace(/^The (rendered )?story /, '')}, so it was left out`,
      )
      finish(index, group.name)
      continue
    }
    if (!capture.ok) {
      note(
        capture.code ?? 'story_failed',
        `The default story "${group.defaultStory.name}" could not be captured: ${capture.reason}`,
      )
      finish(index, group.name)
      continue
    }
    if (
      isPageLike({
        elements: capture.paths.length,
        multipleRoots: capture.issues.some((issue) => issue.code === 'multiple_roots'),
        hasProps: base.props.length > 0,
      })
    ) {
      note(
        'not_a_component',
        `"${group.title}" is not a component: its story renders a whole page (${capture.paths.length} elements, no controls), so it was left out`,
      )
      finish(index, group.name)
      continue
    }
    for (const issue of capture.issues) note(issue.code, issue.message)
    if (capture.html.length > MAX_BUNDLE_HTML_BYTES || capture.css.length > MAX_BUNDLE_CSS_BYTES) {
      note('component_too_large', 'The component renders more html or css than a bundle holds, so it was left out')
      finish(index, group.name)
      continue
    }
    for (const rule of capture.sharedRules) shared.add(rule)
    rootFont ??= capture.rootFont

    let props = base.props.map((prop) => ({ ...prop }))
    /* the story whose controls are varied, and what it looks like at its own resting args: the default story, unless it has no controls and a sibling (a Playground) does */
    let controls = { storyId: group.defaultStory.id, base: capture }
    let displayNameOf = base.displayName
    let functionNameOf = base.functionName
    /* what the component ships: the story whose controls it has, so its variant rules and text bindings match the markup */
    let shipped = capture
    if (!props.length) {
      for (const candidate of controlStories(group).slice(0, MAX_CONTROL_PROBES)) {
        /* a story that fails to render is tried once more: a hosted Storybook can drop a request, and a lost Playground leaves the component with no props at all */
        let probe: StoryRender | undefined
        for (let attempt = 0; attempt < 2 && renders < STORYBOOK_LIMITS.renders; attempt++) {
          renders++
          probe = await render({ storyId: candidate.id, args: {}, readMeta: true })
          if (probe.capture.ok) break
        }
        if (!probe) break
        if (!probe.capture.ok) {
          note(
            'controls_probe_failed',
            `The story "${candidate.name}", which may have the component's controls, could not be captured: ${probe.capture.reason}`,
          )
          continue
        }
        if (!probe.props.length) continue
        if (probe.capture.html.length > MAX_BUNDLE_HTML_BYTES || probe.capture.css.length > MAX_BUNDLE_CSS_BYTES)
          continue
        for (const issue of probe.capture.issues) note(issue.code, issue.message)
        for (const rule of probe.capture.sharedRules) shared.add(rule)
        shipped = probe.capture
        note(
          'controls_from_story',
          `The default story has no controls, so the component comes from the story "${candidate.name}", which has them`,
        )
        props = probe.props.map((prop) => ({ ...prop }))
        controls = { storyId: candidate.id, base: probe.capture }
        displayNameOf ??= probe.displayName
        functionNameOf ??= probe.functionName
        break
      }
    }
    const plan = planVariants(props, variantAllowance(renders, grouped.groups.length - index - 1))
    for (const message of describeSkipped(plan.skipped)) note('variants_skipped', message)
    renders += plan.renders.length
    const rendered = await inPool(plan.renders, concurrency, async (variant) => {
      const request = { storyId: controls.storyId, args: { [variant.arg]: variant.argValue }, readMeta: false }
      let result = await render(request)
      /* a render that looks exactly like the default was probably captured before the story took the new args (the page announced the render a beat before the framework committed it), and one that ran out of time or lost its page is a dropped request: ask again once on a fresh page. A value that really changes nothing is told apart by the second render being the same too */
      const again = (shot: StoryCapture) => (shot.ok ? sameRender(controls.base, shot) : isTransientFailure(shot))
      let identical = result.capture.ok && sameRender(controls.base, result.capture)
      if (again(result.capture) && renders < STORYBOOK_LIMITS.renders && !input.signal?.aborted) {
        renders++
        result = await render(request)
        identical = result.capture.ok && sameRender(controls.base, result.capture)
      }
      return { variant, result, identical }
    })
    const variants: NonNullable<BundleComponent['variants']> = {}
    const reflected = new Set<string>()
    /* a prop that an attribute of the real element follows is bound to that element, and the library's own rules for it (they match only while the attribute has the value, so they come from the renders of each value) style it: a CSS diff is only for a prop no attribute follows */
    const found = findBindings(
      controls.base,
      rendered.flatMap(({ variant, result }) =>
        result.capture.ok ? [{ prop: variant.prop, value: variant.value, shot: result.capture }] : [],
      ),
      props,
    )
    const { bound } = found
    /* what the markup says of the component's parts and of the props the Storybook left unbound: parts become slots, and a prop whose value is on an element is bound to that attribute */
    const followedNow = new Set(bound)
    for (const match of shipped.html.matchAll(/ data-doop-prop="([^"]*)"/g)) {
      for (const binding of (match[1] ?? '').split(','))
        followedNow.add(binding.slice(binding.lastIndexOf(':') + 1).trim())
    }
    const compound = planCompound({
      capture: shipped,
      props,
      bound: followedNow,
      occupied: new Set([...ownBindings(shipped.html, shipped.marker), ...found.bindings.keys()]),
      boundAttrs: new Set(
        [...found.bindings].flatMap(([index, list]) =>
          list.map((binding) => `${index}\u0000${binding.slice(0, Math.max(0, binding.lastIndexOf(':')))}`),
        ),
      ),
      taken: new Set(props.map((prop) => prop.name)),
      bundleNames,
    })
    const bindings = new Map(found.bindings)
    for (const [index, list] of compound.bindings) bindings.set(index, [...(bindings.get(index) ?? []), ...list])
    if (compound.slots.size) {
      note('slots_from_parts', `Parts of the component became slots: ${[...compound.slots.values()].join(', ')}`)
    }
    for (const [name, type] of compound.retyped) {
      const prop = props.find((entry) => entry.name === name)
      if (prop) prop.type = type
    }
    const known = new Set(splitRules(shipped.css).rules)
    const extraRules: string[] = []
    for (const { variant, result, identical } of rendered) {
      const shot = result.capture
      if (!shot.ok) {
        note('variant_failed', `${variant.prop}=${variant.value} could not be captured: ${shot.reason}`)
        continue
      }
      if (identical) {
        note(
          'variant_identical',
          `${variant.prop}=${variant.value} rendered exactly like the default, twice, so it adds nothing: either the value changes nothing visible or the story did not take it`,
        )
      }
      for (const rule of shot.sharedRules) shared.add(rule)
      if (bound.has(variant.prop)) {
        for (const rule of splitRules(shot.css).rules) {
          if (known.has(rule)) continue
          known.add(rule)
          extraRules.push(rule)
        }
        /* a state the library also says through an attribute no prop follows (`data-state` beside `aria-checked`) is no rule of the library's to apply here: the look it changes is the prop's, as a CSS diff */
        const flag = props.find((prop) => prop.name === variant.prop)
        if (flag?.type === 'boolean' && unboundChange(controls.base, shot, bindings, variant.prop)) {
          const diff = diffStyles(controls.base, shot)
          if (diff) {
            ;(variants[variant.prop] ??= {})[variant.value] = { css: diff }
            reflected.add(variant.prop)
          }
        }
        continue
      }
      const diff = diffStyles(controls.base, shot)
      let entry: { html?: string; css?: string } | undefined
      if (diff !== undefined) {
        if (diff) entry = { css: diff }
      } else {
        /* the variant's own markup carries the bindings found on the default, so only what differs is branched */
        const html = bindHtml(
          shot.html,
          shot.marker,
          mapBindings(controls.base, shot, bindings),
          mapBindings(controls.base, shot, compound.slots),
        )
        /* its rules are scoped under the prop's value, which outranks the default's own: a rule the default already has (the base look, the theme variables) would beat the library's variant rules, so only the rules the default lacks go along */
        const own = splitRules(shot.css)
          .rules.filter((rule) => !known.has(rule))
          .join('\n')
        if (html.length <= MAX_BUNDLE_HTML_BYTES && own.length <= MAX_BUNDLE_CSS_BYTES) {
          entry = { html, css: own }
        } else {
          note(
            'variant_failed',
            `${variant.prop}=${variant.value} renders more than a bundle holds, so it was left out`,
          )
        }
      }
      if (!entry || (entry.css ?? '').length > MAX_BUNDLE_CSS_BYTES) continue
      ;(variants[variant.prop] ??= {})[variant.value] = entry
      if (entry.css || entry.html) reflected.add(variant.prop)
    }
    let shippedCss = shipped.css
    if (extraRules.length) {
      const joined = [shipped.css, ...extraRules].filter(Boolean).join('\n')
      if (joined.length <= MAX_BUNDLE_CSS_BYTES) shippedCss = joined
      else
        note(
          'variant_css_capped',
          "The rules for the props' values are over the bundle limit, so only the default look has them",
        )
    }
    const finalHtml = bindHtml(shipped.html, shipped.marker, bindings, compound.slots)
    props.push(...compound.added)
    /* a prop is something in the markup follows: an enum (it sets data-<name> on the root and the variant rules read it), an attribute or text bound to it, or a boolean whose look is a CSS rule. The rest could never change anything here, and the importer would drop them */
    const followed = new Set(
      [...finalHtml.matchAll(/ data-doop-prop="([^"]*)"/g)].flatMap((match) =>
        (match[1] ?? '').split(',').map((binding) => binding.slice(binding.lastIndexOf(':') + 1).trim()),
      ),
    )
    const useful = props.filter(
      (prop) =>
        prop.type === 'enum' || followed.has(prop.name) || (prop.type === 'boolean' && reflected.has(prop.name)),
    )
    if (useful.length < props.length) {
      note(
        'props_unbound',
        `${props.length - useful.length} props have nothing in the markup that follows them, so they were left out: ${props
          .filter((prop) => !useful.includes(prop))
          .slice(0, 12)
          .map((prop) => prop.name)
          .join(', ')}`,
      )
    }
    /* the on state of a state the markup mirrors into `data-state`: the library's rules for that value, applied while the prop is on (a rule that names the other side stays as it is) */
    for (const state of compound.states) {
      const css = guardCss(onStateRules(shippedCss, state)).css
      if (css && css.length <= MAX_BUNDLE_CSS_BYTES) {
        ;(variants[state.prop] ??= {}).true = { css }
        reflected.add(state.prop)
      }
    }
    const outProps = useful.map(({ arg: _arg, initial: _initial, componentExports: _exports, ...prop }) => ({
      ...prop,
      ...(prop.type === 'boolean' && reflected.has(prop.name) ? { reflect: true } : {}),
    }))
    const exportName = chooseExportName({
      displayName: displayNameOf,
      functionName: functionNameOf,
      title: group.title,
    })
    /* the code mapping names only props the component has */
    const iconPackage = useful.some((prop) => prop.componentExports)
      ? iconPackageOf([
          finalHtml,
          ...Object.values(variants).flatMap((values) => Object.values(values).map((variant) => variant.html ?? '')),
        ])
      : undefined
    const propMapping = Object.fromEntries(
      useful.flatMap((prop) => {
        const mapping: NonNullable<NonNullable<BundleComponent['code']>['props']>[string] = {}
        if (prop.arg !== prop.name) mapping.name = prop.arg
        if (compound.omit.has(prop.name)) mapping.omit = true
        if (prop.componentExports) {
          /* the options are component references: the package when the markup names it, and the export of each option that is not its own name */
          mapping.component = iconPackage ? { importFrom: iconPackage } : {}
          const renamed = Object.entries(prop.componentExports).filter(([option, exported]) => option !== exported)
          if (renamed.length) mapping.values = Object.fromEntries(renamed)
        }
        return Object.keys(mapping).length ? [[prop.name, mapping] as const] : []
      }),
    )
    components.push({
      name: group.name,
      group: group.title.slice(0, 200),
      html: finalHtml,
      ...(shippedCss ? { css: shippedCss } : {}),
      ...(outProps.length ? { props: outProps } : {}),
      ...(Object.keys(variants).length ? { variants } : {}),
      code: {
        ...(exportName ? { exportName } : {}),
        ...(Object.keys(propMapping).length ? { props: propMapping } : {}),
        origin: {
          kind: input.source.kind,
          /* the story the markup came from: the default, or the one with the controls */
          storyId: controls.storyId,
          url: storyIframeUrl(input.baseUrl, controls.storyId),
        },
      },
    })
    compounds.push({ name: group.name, inner: innerIdentities(shipped) })
    finish(index, group.name)
  }

  /* a story that shows other components of the Storybook (a card with a form in it) is told once, since its markup holds their parts rather than instances of them */
  const byNormal = new Map(components.map((component) => [normalName(component.name), component.name]))
  for (const entry of compounds) {
    const own = normalName(entry.name)
    const others = [...entry.inner].flatMap((id) => (id !== own && byNormal.has(id) ? [byNormal.get(id)!] : []))
    if (others.length) {
      issues.push({
        component: entry.name,
        code: 'composite_story',
        message: `The story also renders parts of ${others.slice(0, 6).join(', ')}, which are components of this Storybook; they stay part of this component's markup`,
      })
    }
  }

  if (!components.length) {
    const stories = issues.filter((issue) => issue.code === 'story_failed' || issue.code === 'story_needs_worker')
    /* only when every story that failed needs the worker is the CLI the way in */
    const allNeedWorker = stories.length > 0 && stories.every((issue) => issue.code === 'story_needs_worker')
    const failure =
      issues.find((issue) => issue.code === 'renderer_unavailable') ??
      stories[0] ??
      issues.find((issue) => issue.code === 'not_a_component')
    /* the error is not a card row, so it names its component itself */
    throw new BundleImportError(
      failure
        ? `${failure.component ? `${failure.component}: ` : ''}${failure.message}`
        : 'No component could be imported from this Storybook',
      failure?.code === 'story_needs_worker' && allNeedWorker ? 'needs_worker' : undefined,
    )
  }
  for (const rule of rootFontRules(shared, rootFont)) shared.add(rule)
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
    throw new BundleImportError(
      `The captured components do not make a valid bundle: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    )
  }
  return { bundle: parsed.data, issues, renders }
}
