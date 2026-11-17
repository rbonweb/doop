import { z } from 'zod'
import { codeSchema, propSchema } from './componentSchemas.ts'
import { MAX_COMPONENT_DESCRIPTION, MAX_COMPONENT_NAME } from './components.ts'
import { TOKEN_TYPES } from './designTokens.ts'

/**
 * A ComponentBundle: every way of bringing React components into a canvas (a published Storybook, the CLI, an agent)
 * produces one, and one importer (server/componentBundleImport.ts) reads it. Pure (zod and shared/* only), since the
 * CLI bundles it. Everything in a bundle is untrusted: the importer validates it with this schema and sanitizes it.
 */

export const BUNDLE_VERSION = 1
/** Components in one bundle. */
export const MAX_BUNDLE_COMPONENTS = 60
/** The whole bundle as JSON, after any gzip is undone. */
export const MAX_BUNDLE_BYTES = 20_000_000
/** The bundle `import_components` takes inline; a bigger one goes through an upload ticket. */
export const MAX_INLINE_BUNDLE_BYTES = 300_000
/** One component's html, and one variant's. */
export const MAX_BUNDLE_HTML_BYTES = 200_000
/** One component's css, one variant's, and the bundle's shared css. */
export const MAX_BUNDLE_CSS_BYTES = 400_000
export const MAX_VARIANT_AXES = 4
export const MAX_VARIANT_VALUES = 8
export const BUNDLE_SOURCES = ['storybook', 'cli', 'agent'] as const
export type BundleSource = (typeof BUNDLE_SOURCES)[number]

const variantSchema = z.object({
  html: z.string().max(MAX_BUNDLE_HTML_BYTES).optional(),
  css: z.string().max(MAX_BUNDLE_CSS_BYTES).optional(),
})

export const bundleComponentSchema = z
  .object({
    name: z.string().min(1).max(MAX_COMPONENT_NAME),
    description: z.string().max(MAX_COMPONENT_DESCRIPTION).optional(),
    /** Storybook title path ("Inputs/Button"), for the layout on the page */
    group: z.string().max(200).optional(),
    /** One root element, the default render; may carry data-doop-prop / data-doop-slot / data-doop-if and <doop-use> */
    html: z.string().max(MAX_BUNDLE_HTML_BYTES),
    css: z.string().max(MAX_BUNDLE_CSS_BYTES).optional(),
    props: z.array(propSchema).max(40).optional(),
    /** prop -> value -> what changes when the prop has that value: css written against the default html, or a whole alternative render */
    variants: z.record(z.string().max(100), z.record(z.string().max(200), variantSchema)).optional(),
    code: codeSchema.optional(),
  })
  .superRefine((component, ctx) => {
    const axes = Object.entries(component.variants ?? {})
    if (axes.length > MAX_VARIANT_AXES)
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: `at most ${MAX_VARIANT_AXES} variant props (got ${axes.length})`,
      })
    const props = new Map((component.props ?? []).map((prop) => [prop.name, prop]))
    for (const [name, values] of axes) {
      const prop = props.get(name)
      const type = prop && (prop.type ?? (prop.options?.length ? 'enum' : 'text'))
      if (!prop || (type !== 'enum' && type !== 'boolean')) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', name],
          message: `variant “${name}” must name an enum or boolean prop of the component`,
        })
        continue
      }
      const keys = Object.keys(values)
      if (keys.length > MAX_VARIANT_VALUES)
        ctx.addIssue({
          code: 'custom',
          path: ['variants', name],
          message: `at most ${MAX_VARIANT_VALUES} values per variant prop (got ${keys.length})`,
        })
      const allowed = type === 'boolean' ? ['true', 'false'] : (prop.options ?? [])
      for (const key of keys)
        if (!allowed.includes(key))
          ctx.addIssue({
            code: 'custom',
            path: ['variants', name, key],
            message:
              type === 'boolean'
                ? `a boolean variant value is "true" or "false", not “${key}”`
                : `“${key}” is not an option of enum prop “${name}”`,
          })
    }
  })

export const componentBundleSchema = z
  .object({
    version: z.literal(BUNDLE_VERSION),
    source: z.object({
      kind: z.enum(BUNDLE_SOURCES),
      url: z.string().url().max(2000).optional(),
      name: z.string().max(200).optional(),
    }),
    /** default code.importFrom for every component */
    package: z.string().max(300).optional(),
    /** shared CSS every component needs: resets, :root custom properties */
    css: z.string().max(MAX_BUNDLE_CSS_BYTES).optional(),
    tokens: z
      .array(
        z.object({
          name: z.string().regex(/^--[A-Za-z0-9_-]{1,100}$/),
          value: z.string().max(500),
          type: z.enum(TOKEN_TYPES).optional(),
        }),
      )
      .max(500)
      .optional(),
    components: z.array(bundleComponentSchema).min(1).max(MAX_BUNDLE_COMPONENTS),
  })
  .superRefine((bundle, ctx) => {
    const seen = new Set<string>()
    bundle.components.forEach((component, index) => {
      const key = component.name.trim().toLowerCase()
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['components', index, 'name'],
          message: `component name “${component.name}” appears twice in the bundle`,
        })
      seen.add(key)
    })
  })

export type ComponentBundle = z.infer<typeof componentBundleSchema>
export type BundleComponent = z.infer<typeof bundleComponentSchema>
