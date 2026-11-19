/** Pure: no node or server imports, since the CLI bundles it. Which JavaScript identifier a Storybook component is exported as in code (`code.exportName`). */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
/** a one or two letter name is what a minifier leaves, never what a person wrote */
const MIN_LENGTH = 3
const MAX_LENGTH = 100

export interface ExportNameSources {
  /** the story component's own `displayName`, which a production build keeps */
  displayName?: string
  /** the story component's function name, which a production build minifies (`l`, `Kr`) */
  functionName?: string
  /** the story's title, `Components/Alert Dialog` */
  title: string
}

function identifier(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value && IDENTIFIER.test(value) && value.length >= MIN_LENGTH && value.length <= MAX_LENGTH ? value : undefined
}

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The last segment of a story title: `Components/Alert Dialog` is `Alert Dialog`. */
export function titleLeaf(title: string): string {
  return title.split('/').pop()?.trim() ?? ''
}

/** `Alert Dialog`, `alert-dialog` and `AlertDialog` are all `AlertDialog`. */
export function pascalCase(label: string): string {
  return label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')
}

/** A name resembles the title when, ignoring case and anything that is not a letter or digit, one contains the other: `Button` and `Components/Button`, `ButtonGroup` and `Button`, but not `Kr` and `Card`. */
export function resemblesTitle(name: string, title: string): boolean {
  const own = squash(name)
  const leaf = squash(titleLeaf(title))
  return own.length > 0 && leaf.length > 0 && (own.includes(leaf) || leaf.includes(own))
}

/**
 * The export name for a component: its `displayName`, else its function name when that resembles the title, else the title's last segment in PascalCase, else none. A function name in a production build is a minified letter or two, so it is trusted only when it looks like the title.
 */
export function chooseExportName(sources: ExportNameSources): string | undefined {
  const display = identifier(sources.displayName)
  if (display) return display
  const fn = identifier(sources.functionName)
  if (fn && resemblesTitle(fn, sources.title)) return fn
  return identifier(pascalCase(titleLeaf(sources.title)))
}
