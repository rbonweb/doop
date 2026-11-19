import { z } from 'zod'
import { CODE_ORIGINS } from './componentCode.ts'
import { LIST_FIELD_TYPES, MAX_LIST_FIELDS, PROP_TYPES } from './components.ts'

/**
 * The zod shapes of a component's props and code mapping, shared by the agent tools (server/componentTools.ts),
 * the REST routes and the component bundle (shared/componentBundle.ts). Pure: the CLI bundles it.
 */

export const propSchema = z.object({
  name: z.string().describe('Lowercase, it becomes an attribute: "label", "tone", "show-icon"'),
  type: z
    .enum(PROP_TYPES)
    .optional()
    .describe(
      'text (default), richtext (inline <b> <i> <a href> <span class>, sanitized), image, link, boolean, number, color, instance, list (needs fields; an element marked data-doop-each repeats per item), or enum with options',
    ),
  default: z
    .string()
    .optional()
    .describe(
      'enum, boolean, number, color, instance and list only; text-like defaults are the template content. A list default is a JSON array of items',
    ),
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
  fields: z
    .record(z.object({ type: z.enum(LIST_FIELD_TYPES) }))
    .optional()
    .describe(
      `list only: the fields of one item, e.g. { "title": { "type": "text" }, "url": { "type": "link" } } (type text, link, image or boolean; at most ${MAX_LIST_FIELDS}, named like props). An element marked data-doop-each="<list prop>" is repeated per item, and its data-doop-prop bindings and data-doop-if conditions read the item's fields`,
    ),
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
            component: z
              .object({
                importFrom: z
                  .string()
                  .max(300)
                  .optional()
                  .describe('Package the components are imported from, e.g. "@primer/octicons-react"'),
              })
              .optional()
              .describe(
                'Enum only: its values are components the export takes by reference, as an icon prop does. Each value is the component export\'s name ("HeartIcon"; `values` renames one) and is imported from importFrom, not passed as a string',
              ),
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
