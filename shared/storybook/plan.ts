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
  /** what an import takes: the first STORYBOOK_LIMITS.components of `candidates` */
  groups: StoryGroup[]
  /** every component `include` selects, for a plan to list and a person to pick from */
  candidates: StoryGroup[]
  issues: StorybookIssue[]
}

/** `--default`, then `--primary`, else the first story, the way a designer would call it the component's resting look. */
export function pickDefaultStory(stories: StoryEntry[]): StoryEntry | undefined {
  const named = (word: string) =>
    stories.find((story) => story.id.endsWith(`--${word}`) || story.name.trim().toLowerCase() === word)
  return named('default') ?? named('primary') ?? stories[0]
}

/** The component's own name: the title's last segment, with its parent in front when it is only a collection word ("Table Features", not "Features"). */
function lastSegment(title: string): string {
  const segments = title
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const last = segments[segments.length - 1] ?? title.trim()
  const parent = segments[segments.length - 2]
  return parent && isCollectionSegment(last) ? `${parent} ${last}` : last
}

/** Words that name a set of stories rather than a component: a title segment made only of these ("Features", "Responsive Tests", "Performance Tests") is a collection. */
const COLLECTION_WORDS = new Set([
  'features',
  'examples',
  'playground',
  'stories',
  'dev',
  'docs',
  'default',
  'variants',
  'tests',
  'test',
  'responsive',
  'performance',
  'sandbox',
  'recipes',
])

const isCollectionSegment = (segment: string): boolean => {
  const words = segment
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
  return words.length > 0 && words.every((word) => COLLECTION_WORDS.has(word))
}

function normalizedTitle(title: string): string {
  return title
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

/** `./src/Button/Button.features.stories.tsx` and `./src/Button/Button.stories.tsx` are the same stem, `./src/Button/Button`: the file a component's stories live in, however the story files are split. */
function pathStem(path: string | undefined): string | undefined {
  if (!path) return undefined
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dot = base.indexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem ? `${path.slice(0, slash + 1)}${stem}` : undefined
}

/** What lets a story's title be read as a collection of the component above it. */
interface TitleIndex {
  /** every story title, normalised */
  titles: Set<string>
  /** every folder above a title ("Components" above "Components/Button") */
  folders: Set<string>
  /** per title, the file stems and component files of its stories */
  stems: Map<string, Set<string>>
}

function indexTitles(entries: StoryEntry[]): TitleIndex {
  const titles = new Set<string>()
  const folders = new Set<string>()
  const stems = new Map<string, Set<string>>()
  for (const entry of entries) {
    const title = normalizedTitle(entry.title)
    titles.add(title)
    const parts = title.split('/')
    /* a collection does not make its parent a folder of components: "Layout/Features" alone leaves no "Layout" */
    if (!isCollectionSegment(parts[parts.length - 1] ?? ''))
      for (let end = 1; end < parts.length; end++) folders.add(parts.slice(0, end).join('/'))
    const set = stems.get(title) ?? new Set<string>()
    const stem = pathStem(entry.importPath)
    if (stem) set.add(stem)
    if (entry.componentPath) set.add(`component:${entry.componentPath}`)
    stems.set(title, set)
  }
  return { titles, folders, stems }
}

/**
 * The title of the component a story belongs to. Evidence in order: the story files (a title directly under another title whose stories sit in the same file or name the same component file is more of that component, whatever the segment is called: Storybook 8+ `componentPath`, else the `importPath` stem), then the words (a trailing segment that is only collection words, "Features", "Responsive Tests", comes off), taken only when what is left is a component with stories or a folder of them, so "Layout/Features" with no Layout stays a component of its own.
 */
function componentTitle(entry: StoryEntry, index: TitleIndex): string {
  const title = normalizedTitle(entry.title)
  const segments = title.split('/')
  const mine = new Set<string>()
  const stem = pathStem(entry.importPath)
  if (stem) mine.add(stem)
  if (entry.componentPath) mine.add(`component:${entry.componentPath}`)
  /* the files first: one step up while the parent is a component whose stories sit in the same file */
  let current = segments
  while (current.length > 1) {
    const parent = current.slice(0, -1).join('/')
    const sharedFile = index.titles.has(parent) && [...(index.stems.get(parent) ?? [])].some((key) => mine.has(key))
    if (!sharedFile) break
    current = current.slice(0, -1)
  }
  /* then the words: every trailing collection segment comes off together, when what is left is a component or a folder of them */
  const stripped = [...current]
  while (stripped.length > 1 && isCollectionSegment(stripped[stripped.length - 1] ?? '')) stripped.pop()
  const left = stripped.join('/')
  if (stripped.length < current.length && (index.titles.has(left) || index.folders.has(left))) current = stripped
  return current.join('/')
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

/** The most components a plan line lists; what an import takes is STORYBOOK_LIMITS.components of them. */
export const MAX_PLANNED_COMPONENTS = 500

/** Stories to components (see `componentTitle`), in index order. `candidates` is every component `include` selects; `groups` is what an import takes of them, the first STORYBOOK_LIMITS.components. */
export function groupStories(entries: StoryEntry[], options: { include?: string[] } = {}): GroupedStories {
  const issues: StorybookIssue[] = []
  const index = indexTitles(entries)
  const owned = new Map<string, StoryEntry[]>()
  for (const entry of entries) {
    const title = componentTitle(entry, index)
    /* `include` names components, so it is matched against the title a story ends up under */
    if (!matchesInclude(title, options.include)) continue
    const list = owned.get(title)
    if (list) list.push(entry)
    else owned.set(title, [entry])
  }
  const candidates: StoryGroup[] = []
  const names = new Set<string>()
  for (const [title, members] of owned) {
    /* the component's own stories come first, so its default is one of them rather than an example's */
    const own = (entry: StoryEntry) => normalizedTitle(entry.title) === title
    const stories = [...members.filter(own), ...members.filter((entry) => !own(entry))]
    const defaultStory = pickDefaultStory(stories)
    if (!defaultStory) continue
    const segments = title.split('/')
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
      message: `The Storybook has ${candidates.length} components and one import holds ${STORYBOOK_LIMITS.components}: the first ${groups.length} were taken and ${left} were left out. Use include to pick others.`,
    })
  }
  if (!groups.length && entries.length) {
    issues.push({ code: 'no_components', message: 'No story matched the include filter' })
  }
  return { groups, candidates, issues }
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
