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
  /** Doop prop -> the export's prop name, the value each enum or boolean value becomes, or omission */
  props?: Record<string, { name?: string; values?: Record<string, string | number | boolean>; omit?: true }>
  /** Doop slot -> `children` or the export prop that receives it */
  slots?: Record<string, string>
  origin?: { kind: ComponentCodeOrigin; storyId?: string; url?: string }
}
