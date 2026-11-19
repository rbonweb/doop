import { z } from 'zod'
import { CODE_ORIGINS } from './componentCode.ts'
import { PROP_TYPES } from './components.ts'

/**
 * The zod shapes of a component's props and code mapping, shared by the agent tools (server/componentTools.ts),
 * the REST routes and the component bundle (shared/componentBundle.ts). Pure: the CLI bundles it.
 */

export const propSchema = z.object({
  name: z.string().describe('Lowercase, it becomes an attribute: "label", "tone", "show-icon"'),
  type: z
    .enum(PROP_TYPES)
    .optional()
    .describe('text (default), image, link, boolean, number, color, instance, or enum with options'),
  default: z
    .string()
    .optional()
    .describe('enum, boolean, number, color and instance only; text-like defaults are the template content'),
  options: z
    .array(z.string())
    .optional()
    .describe('enum values. An enum sets data-<name> on the root, for CSS to key on'),
  min: z.number().optional().describe('number only: smallest value'),
  max: z.number().optional().describe('number only: largest value'),
  step: z.number().positive().optional().describe('number only: values sit on this step, counted from min (else 0)'),
  accepts: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('instance only: component names or ids that may be chosen; leave out for any'),
  reflect: z
    .boolean()
    .optional()
    .describe('boolean only: put data-<name>="true"|"false" on the root, for CSS to key on like an enum'),
  description: z.string().optional().describe('When to use it, in a line'),
})

export const codeSchema = z
  .object({
    path: z.string().max(500).optional().describe('Source file or package, e.g. "src/components/ui/button.tsx"'),
    name: z.string().max(200).optional().describe('Export name, e.g. "Button"'),
    snippet: z.string().max(4000).optional().describe('How it is used in code, or how props map to it'),
    importFrom: z.string().max(300).optional().describe('Package to import from, e.g. "@acme/ui"'),
    exportName: z.string().max(200).optional().describe('The export to import, a JavaScript identifier: "Button"'),
    defaultExport: z.boolean().optional().describe('The export is the package default, not a named one'),
    props: z
      .record(
        z
          .object({
            name: z.string().optional().describe('The export prop that receives this one, if named differently'),
            values: z
              .record(z.union([z.string(), z.number(), z.boolean()]))
              .optional()
              .describe('Enum or boolean value -> what the export receives, e.g. { "ghost": "secondary" }'),
            omit: z.literal(true).optional().describe('The export has no such prop: do not pass it'),
          })
          .partial(),
      )
      .optional()
      .describe('Doop prop -> its mapping on the export, keyed by prop name'),
    slots: z
      .record(z.string())
      .optional()
      .describe('Doop slot -> "children" or the export prop that receives it, e.g. { "actions": "footer" }'),
    origin: z
      .object({
        kind: z.enum([...CODE_ORIGINS]).describe('manual, storybook, cli or agent'),
        storyId: z.string().optional().describe('Storybook story id, for a storybook mapping'),
        url: z.string().optional().describe('The page the mapping was read from, http(s)'),
      })
      .optional()
      .describe('Where this mapping came from'),
  })
  .describe('Where this lives in code: the package export it is, and how its props and slots map onto it')

const variantProp = z.string().describe('The variant prop: lowercase, becomes data-<prop> on every instance root')
const variantWhen = z
  .record(z.string())
  .describe(
    'The variant combination the style applies under, e.g. { "size": "lg" } or { "size": "lg", "tone": "ghost" }',
  )

/** One edit of a component's variants, applied in order by `edit_component_variants` and `POST …/variants`. */
export const variantOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_enum'),
    prop: variantProp,
    options: z.array(z.string()).min(1).max(40).describe('The values, first is the default unless default is given'),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    op: z.literal('add_value'),
    prop: variantProp,
    value: z.string(),
    make_default: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('rename_value'),
    prop: variantProp,
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    op: z.literal('remove_value'),
    prop: variantProp,
    value: z.string(),
    new_default: z.string().optional().describe('Needed when the value removed is the default'),
  }),
  z.object({ op: z.literal('set_default'), prop: variantProp, value: z.string() }),
  z.object({
    op: z.literal('add_boolean'),
    prop: variantProp,
    default: z.boolean().optional().describe('Off unless true'),
    description: z.string().optional(),
  }),
  z.object({ op: z.literal('rename_prop'), prop: variantProp, to: z.string() }),
  z.object({ op: z.literal('remove_prop'), prop: variantProp }),
  z.object({
    op: z.literal('set_style'),
    element: z
      .string()
      .describe('A data-doop-part key of the main (get_component lists them in the template); "root" is the main root'),
    when: variantWhen,
    declarations: z
      .record(z.string().nullable())
      .describe(
        'CSS property -> value, merged into the variant rule; null or "" removes that property. No url(), braces, semicolons or @import',
      ),
  }),
  z.object({
    op: z.literal('clear_style'),
    when: variantWhen,
    element: z.string().optional().describe('Leave out to clear every element under this combination'),
  }),
])

export type VariantOp = z.infer<typeof variantOpSchema>
