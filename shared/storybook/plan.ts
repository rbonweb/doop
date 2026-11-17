import { MAX_COMPONENT_NAME } from '../components.ts'
import type { ArgProp, ArgValue } from './argTypes.ts'
import type { StoryEntry, StorybookIssue } from './index.ts'

/** Pure: no node or server imports, since the CLI bundles it. Decides what an import renders: which stories are components, which story is each one's default, and which variants are worth a render inside the limits. */

export const STORYBOOK_LIMITS = {
  /** components in one bundle (the bundle schema's cap) */
  components: 60,
  /** story renders in one import, defaults and variants together */
  renders: 400,
  /** one story render, to a ready or failed answer */
  renderMs: 20_000,
  /** one whole import */
  importMs: 600_000,
  /** one story's captured html, in bytes */
  captureBytes: 2_000_000,
  /** imports running at once across the server */
  concurrentImports: 3,
  /** variant axes per component and values per axis (the bundle schema's caps) */
  axes: 4,
  values: 8,
} as const

export interface StoryGroup {
  /** the title path, "Inputs/Button" */
  title: string
  /** the component's name: the title's last segment, made unique inside the import */
  name: string
  stories: StoryEntry[]
  defaultStory: StoryEntry
}

export interface GroupedStories {
  groups: StoryGroup[]
  issues: StorybookIssue[]
}

/** `--default`, then `--primary`, else the first story, the way a designer would call it the component's resting look. */
export function pickDefaultStory(stories: StoryEntry[]): StoryEntry | undefined {
  const named = (word: string) =>
    stories.find((story) => story.id.endsWith(`--${word}`) || story.name.trim().toLowerCase() === word)
  return named('default') ?? named('primary') ?? stories[0]
}

function lastSegment(title: string): string {
  const segments = title
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  return segments[segments.length - 1] ?? title.trim()
}

/** The last segment of a title that names a set of stories rather than a component. */
const COLLECTION_WORDS = new Set([
  'features',
  'examples',
  'playground',
  'stories',
  'dev',
  'docs',
  'default',
  'variants',
])

function normalizedTitle(title: string): string {
  return title
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

/** The title of the component a collection's stories belong to (collection words come off the end, never the first segment), or undefined when the title is not a collection. */
function collectionOwner(title: string): string | undefined {
  const segments = title
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const before = segments.length
  while (segments.length > 1 && COLLECTION_WORDS.has((segments[segments.length - 1] ?? '').toLowerCase()))
    segments.pop()
  return segments.length < before ? segments.join('/') : undefined
}

function matchesInclude(title: string, include: string[] | undefined): boolean {
  if (!include?.length) return true
  const lower = title.toLowerCase()
  return include.some((entry) => {
    const wanted = entry.trim().replace(/\/+$/, '').toLowerCase()
    /* a whole title, or the folders above it: "Components/Button" is not "Components/ButtonGroup" */
    return wanted !== '' && (lower === wanted || lower.startsWith(`${wanted}/`))
  })
}

/** Stories to components by title, in index order, limited to `include` (a title, or the folders above it, up to a `/`) and to STORYBOOK_LIMITS.components. */
export function groupStories(entries: StoryEntry[], options: { include?: string[] } = {}): GroupedStories {
  const issues: StorybookIssue[] = []
  /* a title ending in a collection word ("Components/ActionMenu/Features") is more stories of the component above it when that component has stories of its own; with none above it ("Layout/Features") it is a component itself. `include` names components, so it is matched against the title a story ends up under. */
  const titles = new Set(entries.map((entry) => normalizedTitle(entry.title)))
  const owned = new Map<string, StoryEntry[]>()
  for (const entry of entries) {
    const owner = collectionOwner(entry.title)
    const title = owner !== undefined && titles.has(owner) ? owner : entry.title
    if (!matchesInclude(title, options.include)) continue
    const list = owned.get(title)
    if (list) list.push(entry)
    else owned.set(title, [entry])
  }
  const candidates: StoryGroup[] = []
  const names = new Set<string>()
  for (const [title, stories] of owned) {
    const defaultStory = pickDefaultStory(stories)
    if (!defaultStory) continue
    const segments = title
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
    let name = lastSegment(title).slice(0, MAX_COMPONENT_NAME)
    for (let take = 2; names.has(name.toLowerCase()) && take <= segments.length; take++) {
      name = segments.slice(-take).join(' ').slice(0, MAX_COMPONENT_NAME)
    }
    for (let n = 2; names.has(name.toLowerCase()); n++)
      name = `${lastSegment(title).slice(0, MAX_COMPONENT_NAME - 4)} ${n}`
    names.add(name.toLowerCase())
    candidates.push({ title, name, stories, defaultStory })
  }
  const groups = candidates.slice(0, STORYBOOK_LIMITS.components)
  if (candidates.length > groups.length) {
    const left = candidates.length - groups.length
    issues.push({
      code: 'components_capped',
      message: `The Storybook has ${candidates.length} components and one import holds ${STORYBOOK_LIMITS.components}: the first ${groups.length} were planned and ${left} were left out. Use include to pick others.`,
    })
  }
  if (!groups.length && entries.length) {
    issues.push({ code: 'no_components', message: 'No story matched the include filter' })
  }
  return { groups, issues }
}

export interface VariantRender {
  /** the Doop prop and the value an instance sets */
  prop: string
  value: string
  /** the Storybook arg and what the story URL sets it to */
  arg: string
  argValue: ArgValue
}

export interface VariantPlan {
  renders: VariantRender[]
  /** props that could not be varied, with why */
  skipped: string[]
}

/** What a component can be rendered as: every option of an enum (up to values per axis), and the other value of a boolean, on at most `axes` props, never more than `maxRenders` renders in all. Enums go first, then booleans, each in the story's own order. */
export function planVariants(props: ArgProp[], maxRenders: number): VariantPlan {
  const renders: VariantRender[] = []
  const skipped: string[] = []
  const axes = [...props.filter((prop) => prop.type === 'enum'), ...props.filter((prop) => prop.type === 'boolean')]
  for (const [index, prop] of axes.entries()) {
    if (index >= STORYBOOK_LIMITS.axes) {
      skipped.push(`${prop.name}: only ${STORYBOOK_LIMITS.axes} props are varied`)
      continue
    }
    if (prop.type === 'boolean') {
      const next = prop.default === 'true' ? 'false' : 'true'
      if (renders.length >= maxRenders) skipped.push(`${prop.name}: over the render budget`)
      else renders.push({ prop: prop.name, value: next, arg: prop.arg, argValue: next === 'true' })
      continue
    }
    const options = (prop.options ?? []).filter((option) => option !== prop.default).slice(0, STORYBOOK_LIMITS.values)
    if ((prop.options?.length ?? 0) - (prop.default !== undefined ? 1 : 0) > options.length) {
      skipped.push(`${prop.name}: only ${STORYBOOK_LIMITS.values} values are rendered`)
    }
    for (const option of options) {
      if (renders.length >= maxRenders) {
        skipped.push(`${prop.name}: over the render budget`)
        break
      }
      const numeric = Number(option)
      const argValue = option.trim() !== '' && Number.isFinite(numeric) && String(numeric) === option ? numeric : option
      /* a value Storybook's args syntax cannot carry would render as the default, so it is not rendered at all */
      if (argsParam({ [prop.arg]: argValue }) === undefined) {
        skipped.push(`${prop.name}: "${option.slice(0, 30)}" cannot be written in a story URL`)
        continue
      }
      renders.push({ prop: prop.name, value: option, arg: prop.arg, argValue })
    }
  }
  return { renders, skipped }
}

/** The render budget left for one component's variants: its fair share of what the components after it still need, so one component with a hundred options cannot starve the rest. `used` counts every render so far, defaults included. */
export function variantAllowance(
  used: number,
  componentsLeft: number,
  totalRenders: number = STORYBOOK_LIMITS.renders,
): number {
  const left = Math.max(0, totalRenders - used - componentsLeft)
  return Math.floor(left / Math.max(1, componentsLeft))
}

const URL_ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const URL_ARG_STRING = /^[A-Za-z0-9 _-]*$/

/** Storybook's `args=` URL syntax (`tone:primary;disabled:!true`), or undefined when a value cannot be written in it. */
export function argsParam(args: Record<string, ArgValue>): string | undefined {
  const parts: string[] = []
  for (const [name, value] of Object.entries(args)) {
    if (!URL_ARG_NAME.test(name)) return undefined
    if (typeof value === 'boolean') parts.push(`${name}:!${value}`)
    else if (typeof value === 'number') parts.push(`${name}:${value}`)
    else if (URL_ARG_STRING.test(value)) parts.push(`${name}:${value}`)
    else return undefined
  }
  return parts.join(';')
}

/** A Storybook's directory: `/sb/`, `/sb` and `/sb/index.html` all mean `/sb/`. */
export function storybookBasePath(pathname: string): string {
  const directory = /\/[^/]*\.[^/]*$/.test(pathname) ? pathname.replace(/[^/]*$/, '') : pathname
  return directory.endsWith('/') ? directory : directory + '/'
}

/** `<origin>/iframe.html?id=<story>&viewMode=story[&args=…]` for a Storybook at `base`. */
export function storyIframeUrl(base: string | URL, storyId: string, args?: Record<string, ArgValue>): string {
  const url = new URL(String(base))
  url.pathname = storybookBasePath(url.pathname)
  url.search = ''
  url.hash = ''
  url.pathname += 'iframe.html'
  url.searchParams.set('id', storyId)
  url.searchParams.set('viewMode', 'story')
  const param = args ? argsParam(args) : undefined
  if (param) url.searchParams.set('args', param)
  return url.href
}
