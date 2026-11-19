/**
 * Where a Doop component lives in the team's code: which package export it is, and how
 * its props and slots map onto that export. The React export imports a mapped component
 * instead of generating one. Validated on write by server/componentCodeMap.ts.
 * Spec: .context/specs/components.md.
 */

/** Where a mapping came from: typed by a person, a Storybook import, the CLI, or an agent. */
export const CODE_ORIGINS = ['manual', 'storybook', 'cli', 'agent'] as const
export type ComponentCodeOrigin = (typeof CODE_ORIGINS)[number]

/** A mapping is read back whole by list_components and get_component: larger than this is a mistake. */
export const MAX_CODE_BYTES = 16_000

/** Where the components an enum prop's values name are imported from; without a package the export leaves the prop for the developer and says so in its report. */
export interface ComponentRefMapping {
  /** package the components are imported from, `@primer/octicons-react` */
  importFrom?: string
}

export interface ComponentCode {
  /** legacy, kept: source file or package, `src/components/ui/button.tsx` or `@acme/ui` */
  path?: string
  /** legacy, kept: export name, `Button` */
  name?: string
  /** legacy, kept: free-form usage or a prop mapping */
  snippet?: string
  /** package the export is imported from, `@acme/ui` */
  importFrom?: string
  /** the export to import, a JavaScript identifier */
  exportName?: string
  /** the export is the package's default export rather than a named one */
  defaultExport?: boolean
  /** Doop prop -> the export's prop name, the value each enum or boolean value becomes, whether its values are components, or omission */
  props?: Record<
    string,
    {
      name?: string
      values?: Record<string, string | number | boolean>
      /** the enum's values are components the export takes by reference (an icon prop): each value is the export's name (`values` renames one) and is imported, not passed as a string */
      component?: ComponentRefMapping
      omit?: true
    }
  >
  /** Doop slot -> `children` or the export prop that receives it */
  slots?: Record<string, string>
  origin?: { kind: ComponentCodeOrigin; storyId?: string; url?: string }
}

/** A bare package specifier (`@scope/name`, `name`, either with a subpath) or a `@/` or `~/` alias: never a relative or absolute path or a URL. The export writes it into an `import`, so nothing else is let through. */
const SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~@-]+)*$/
const ALIAS = /^(?:@|~)\/[A-Za-z0-9_./-]+$/

export const isBareSpecifier = (value: string): boolean =>
  value.length <= 214 &&
  (SPECIFIER.test(value) || ALIAS.test(value)) &&
  !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..')
