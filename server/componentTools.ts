import { z } from 'zod'
import { activeComponents, USE_TAG, type ComponentDef } from '../shared/components.ts'
import { codeSchema, propSchema, variantOpSchema } from '../shared/componentSchemas.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import {
  catalog,
  catalogEntry,
  changeInstances,
  codeSummary,
  componentDetail,
  ComponentError,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  detachAllInstances,
  detachFromLibrary,
  duplicateComponent,
  findComponent,
  findDeletedComponent,
  importableEntry,
  importComponent,
  insertInstance,
  instancesIn,
  libraryCatalog,
  libraryConsumers,
  lookalikesIn,
  publishToLibrary,
  restoreComponent,
  restoreComponentVersion,
  syncComponent,
  unpublishFromLibrary,
  updateComponent,
  updateLibraryConsumers,
  usageExample,
  usageOf,
  waitingLibraryUpdates,
} from './componentActions.ts'
import { editVariants, MAX_VARIANT_OPS } from './componentVariants.ts'
import { isLibrary, librariesForCanvas } from './componentLibrary.ts'
import * as actions from './actions.ts'
import { componentReuseNotes, componentSystemNotes, frameReuseNotes } from './reuseNotes.ts'
import { store } from './store.ts'
import { inlineDataRefusal, type Surface } from './inlineData.ts'
import { optional, WorkBudgetError } from './workBudget.ts'
import { transaction } from './journal.ts'
import { exportCanvasReact, MAX_INLINE_EXPORT_BYTES, reactExportRequest } from './reactExport/canvasExport.ts'
import { zipExport } from './reactExport/zip.ts'
import { batchScope } from './responseShaping.ts'
import { componentBundleSchema, MAX_INLINE_BUNDLE_BYTES } from '../shared/componentBundle.ts'
import { importComponentBundle } from './componentBundleImport.ts'
import { createImportTicket, ImportTicketError, ticketAnswer } from './componentImportTickets.ts'
import { failedBeforeRendering, planStorybookImport, storybookFailure, storybookInput } from './storybookImportRun.ts'
import { checkStorybookUrl, takeStorybookPlan } from './storybookImport.ts'
import {
  cancelStorybookJob,
  JobLimitError,
  JobNotFoundError,
  readStorybookJob,
  startStorybookJob,
  type JobView,
} from './storybookJobs.ts'

export { codeSchema, propSchema }

/**
 * The component tools every agent gets, over MCP (server/mcp.ts) or in the server
 * (server/resident.ts): one schema and one handler each, so the two cannot drift.
 * Spec: .context/specs/components.md.
 */

export interface ToolContext {
  canvas: Canvas
  actor: Actor
  /** may this account read that other canvas? a library is only imported from one it can */
  canRead: (canvasId: string) => boolean
  /** may this account change that other canvas? update_library_everywhere writes only where it can */
  canEdit: (canvasId: string) => boolean
  /** canvases this account can read, for the library listing */
  readableCanvases: () => Canvas[]
  /** the account acting: the person an agent works for. Publishing is checked against it */
  userId: string | undefined
  /** which agent is calling, for the tools a refusal may point it at */
  surface?: Surface
  /** whose per-minute budget a metered tool spends: the account the call is made for (the signed-in user over MCP, the payer of a resident run), never a name the caller chose */
  budgetKey?: string
}

/** A file that travels beside the answer: over MCP an embedded resource, as export_frame's PDF does. The resident agent has no use for one and never gets it. */
export interface ToolAttachment {
  uri: string
  mimeType: string
  bytes: Buffer
}

export type ToolResult = { data: unknown; note?: string; frames?: Frame[]; attachment?: ToolAttachment }

interface ComponentTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  destructive?: boolean
  shape: z.ZodRawShape
  /** a promise only where the tool has to load other canvases (update_library_everywhere) */
  run(input: Record<string, unknown>, context: ToolContext): ToolResult | Promise<ToolResult>
}

/** The components a new main names in a <doop-use> that resolved to nothing, by the name it gave. */
function missingNested(def: ComponentDef): string[] {
  if (!def.mainFrameId) return []
  const refs = actions
    .peekComponentIssues(def.mainFrameId)
    .filter((issue) => issue.code === 'unknown_component')
    .map((issue) => /“([^”]*)”/.exec(issue.message)?.[1] ?? '')
  return [...new Set(refs)]
}

/** The Storybook job tools: the resident agent asks them the same way. */
export const STORYBOOK_JOB_TOOLS: ReadonlySet<string> = new Set([
  'import_storybook',
  'get_import_status',
  'cancel_import',
])

function readJob(
  input: Record<string, unknown>,
  { canvas, userId, budgetKey, canEdit }: Pick<ToolContext, 'canvas' | 'userId' | 'budgetKey' | 'canEdit'>,
  find: typeof readStorybookJob,
): JobView | undefined {
  try {
    return find(String(input.job_id), canvas.id, {
      owner: userId ?? budgetKey ?? `canvas:${canvas.id}`,
      canEdit: () => canEdit(canvas.id),
    })
  } catch (error) {
    if (error instanceof JobNotFoundError) throw new ComponentError(error.message)
    throw error
  }
}

/** A job as the tools answer it: the status and, once it is done, what it made, with the note an agent acts on. */
function importStatus(job: JobView | undefined, canvas: Canvas, cancelled = false): ToolResult {
  if (!job) {
    return {
      data: { ok: true, status: 'unknown' },
      note: 'No import job with that id: the server may have restarted, or the job ended more than 30 minutes ago. Start the import again with import_storybook (a canvas that already has the components updates them in place).',
    }
  }
  const { result, issues = [], renders } = job
  /* cancel_import on a job that had already ended: said plainly, with the job as it stands */
  if (cancelled && (job.status === 'done' || job.status === 'failed')) {
    return {
      data: { ok: true, ...job },
      note: `Nothing to cancel: the job had already ${job.status === 'done' ? 'finished (read result in this answer)' : `failed: ${job.error?.message ?? 'unknown error'}`}.`,
    }
  }
  if (job.status === 'cancelling') {
    return {
      data: { ok: true, ...job },
      note: 'Cancelling: the renders are stopping and nothing will be written. Call get_import_status to see it end as cancelled.',
    }
  }
  if (job.status === 'running') {
    return {
      data: { ok: true, ...job },
      note: `Still importing: ${job.rendered} of ${job.total} renders${job.component ? ` (last: ${job.component})` : ''}. Call get_import_status again; the total only grows as variants are found.`,
    }
  }
  if (job.status === 'failed')
    return { data: { ok: true, ...job }, note: `The import failed: ${job.error?.message ?? 'unknown error'}` }
  if (job.status === 'cancelled')
    return { data: { ok: true, ...job }, note: 'The import was cancelled before anything was written.' }
  if (!result) return { data: { ok: true, ...job } }
  const defs = [...result.created, ...result.updated].flatMap(({ id }) => {
    const def = id ? findComponent(canvas.id, id) : undefined
    return def ? [def] : []
  })
  const counts = `${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} refused`
  return {
    data: { ok: true, ...job },
    note: [
      `Imported from the Storybook (${renders ?? job.rendered} story renders): ${counts}. The mains are on the "Imported components" page; compose screens from them with <doop-use component="Name">. Check one with get_component_preview.`,
      ...(result.skipped.length
        ? [`Refused: ${result.skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`]
        : []),
      ...(issues.length
        ? [
            `${issues.length} issue${issues.length === 1 ? '' : 's'} are listed in issues: read them, they say what could not be captured or was left out.`,
          ]
        : []),
    ].join('\n'),
    frames: defs.flatMap((def) => outcomeFrames({ canvas } as ToolContext, def)),
  }
}

/** One create_components call: a canvas's starting kit, not its whole library. */
export const MAX_BATCH_COMPONENTS = 12

/** The largest zip an export_react call carries as an embedded resource (export_frame's PDF cap). */
const MAX_ZIP_BYTES = 15_000_000
/** A resident run reads the answer in its model context: past this it is told to narrow the scope instead. */
const MAX_RESIDENT_INLINE_BYTES = 100 * 1024

const COMPONENT_REF = z.string().describe('Component name or id')
const FRAME_ID = z.string().describe('Frame id from get_canvas')
const LIBRARY_NOTE =
  'This canvas is a workspace library: other canvases keep the last published version until you publish_library here (when the human wants the change shared) and each pulls it with sync_component (or, when the human asks for it everywhere, update_library_everywhere here).'
const IMPACT_NOTE =
  'Check one affected frame with get_frame_screenshot. Approved frames keep their sign-off: following a component is not an edit of the frame.'

/** Whether the instances have the change yet: said, because the call returns before they do. */
function propagationNote(result: { propagation?: { status: string; frames: number } }): string[] {
  const { status, frames } = result.propagation ?? { status: 'none', frames: 0 }
  const count = `${frames} frame${frames === 1 ? '' : 's'}`
  if (status === 'queued')
    return [
      `Instances are updating in the background: queued for ${count} (impact.frames). get_frame and get_frame_screenshot wait a moment for it; on a large canvas the last frames can take longer.`,
    ]
  if (status === 'deferred')
    return [
      `This server has component propagation switched off for now: the ${count} in impact.frames keep the previous revision until each is next written.`,
    ]
  return []
}

function summary(canvas: Canvas, def: ComponentDef) {
  return catalogEntry(canvas, def)
}

/** The frames a component write touched: every instance's frame and the main's,
 *  so a resident run counts the work and re-checks what it had verified. */
function outcomeFrames(context: ToolContext, def: ComponentDef, extra: string[] = []): Frame[] {
  const ids = new Set([...usageOf(context.canvas, def.id).frames.map((f) => f.id), ...extra])
  if (def.mainFrameId) ids.add(def.mainFrameId)
  return context.canvas.frames.filter((frame) => ids.has(frame.id))
}

const asProps = (value: unknown) => value as Record<string, string> | undefined

const inferredProps = (names: string[]) => (names.length ? { inferred_props: names } : {})

/** Names the server made up are the ones worth a second look, while nothing uses them yet. */
function inferredNote(names: string[]): string {
  if (!names.length) return ''
  return ` Props inferred from the markup: ${names.join(', ')}. To name one yourself, write data-doop-prop on its element (now: update_component with find + replace on the template, before instances set it); pass props to give one a type or description.`
}

export const COMPONENT_TOOLS: ComponentTool[] = [
  {
    name: 'list_components',
    title: 'List components',
    description:
      "List the reusable components on a canvas: each name, its props and slots as a one-line signature, a ready-to-paste <doop-use> and how often it is used. Check this BEFORE writing markup: anything on this list must be used through <doop-use>, never redrawn. workspace_libraries lists what the canvas's workspace has published and this canvas does not use yet: write <doop-use> with that name and it is added, linked to its library. With libraries=true, also lists components on other canvases this account can read, ready for import_component.",
    readOnly: true,
    shape: {
      query: z.string().optional().describe('Only components whose name or description contains this'),
      libraries: z.boolean().optional().describe('Also list importable components from other canvases'),
    },
    run({ query, libraries }, { canvas, readableCanvases }) {
      const wanted = typeof query === 'string' ? query.toLowerCase() : ''
      const matches = (def: ComponentDef) =>
        !wanted || def.name.toLowerCase().includes(wanted) || def.description.toLowerCase().includes(wanted)
      const components = catalog(canvas, activeComponents(canvas.components).filter(matches)).map(
        ({ code, ...entry }) => ({ ...entry, ...codeSummary({ code }) }),
      )
      const shared = libraryCatalog(canvas)
        .map((library) => ({
          ...library,
          components: library.components.filter(
            (entry) =>
              !wanted ||
              entry.name.toLowerCase().includes(wanted) ||
              (entry.description ?? '').toLowerCase().includes(wanted),
          ),
        }))
        .filter((library) => library.components.length)
      return {
        data: {
          components,
          ...(shared.length ? { workspace_libraries: shared } : {}),
          ...(libraries
            ? {
                libraries: readableCanvases()
                  .filter((other) => other.id !== canvas.id && activeComponents(other.components).length)
                  .map((other) => ({
                    canvas_id: other.id,
                    canvas_name: other.name,
                    components: activeComponents(other.components).filter(matches).map(importableEntry),
                  })),
              }
            : {}),
          ...(components.length || shared.length
            ? {}
            : {
                note: 'No components match. If a block repeats, make it one with create_component.',
              }),
        },
      }
    },
  },
  {
    name: 'get_component',
    title: 'Read a component',
    description:
      'Read one component in full: its template (each element keyed with data-doop-part, the keys overrides use), its CSS, props, slots, where it is used, earlier revisions and where it lives in code. Read this before update_component.',
    readOnly: true,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas }) {
      const def = findComponent(canvas.id, String(component))
      if (!def) throw new ComponentError(`no component “${String(component)}” on this canvas`)
      return { data: componentDetail(canvas, def) }
    },
  },
  {
    name: 'create_component',
    title: 'Create a component',
    description:
      'Make a reusable component from new markup (html + css) or from an element already in a frame (frame_id + element). From markup, the main lands on the canvas\'s Components page and no instance is placed anywhere: to use it, write <doop-use component="…"> in a frame\'s HTML or call insert_instance. From an element (its data-doop-id from get_frame), that element stays where it is and becomes the main; pass replace_matching=true to turn every other element of the same shape on the canvas into a linked instance in one go, differing text and links becoming props. Unless the markup already says otherwise, leaf text, image sources and link targets become props, named after what each element is (title, label, image, link, text) or its class; the result lists them. Name your own with data-doop-prop="label" (text; declare it type richtext in props to let instances carry <b>, <i>, <em>, <strong>, <br>, <a href="https://…"> and <span class="…"> inside it, anything else is stripped), data-doop-prop="src:photo" (an image; on an <img> a bare name binds its src too), data-doop-prop="href:link,--accent:accent" (attributes, custom properties), data-doop-if="tone=ghost" or "show-icon" (conditional elements), data-doop-slot="actions" (content each instance supplies, add data-doop-slot-suggest="Button"). An enum prop in props sets data-<name> on the root, so variants are plain CSS: .btn[data-tone="ghost"] { … }. Give it a description saying when to use it: it is how the next agent knows.',
    readOnly: false,
    shape: {
      name: z.string().describe('Short and unique, e.g. "Button", "Pricing Card"'),
      description: z.string().optional().describe('When to use this. Later agents choose by it'),
      frame_id: z.string().optional().describe('With element: make this existing element the main'),
      element: z.string().optional().describe("The element's data-doop-id from get_frame"),
      replace_matching: z
        .boolean()
        .optional()
        .describe('With frame_id: turn same-shaped elements across the canvas into instances'),
      html: z.string().optional().describe('New markup, one root element'),
      css: z.string().optional().describe('With html: the rules it needs, unscoped; they get scoped for you'),
      width: z.number().optional().describe('With html: the main frame width, default 480'),
      height: z.number().optional().describe('With html: the main frame height, default 240'),
      props: z.array(propSchema).optional().describe('Enum props, and metadata for bound ones'),
      auto_props: z.boolean().optional().describe('false = do not infer props'),
      code: codeSchema.optional(),
    },
    run(input, { canvas, actor }) {
      const shared = {
        name: String(input.name ?? ''),
        description: input.description as string | undefined,
        props: input.props as never,
        code: input.code as never,
        autoProps: input.auto_props as boolean | undefined,
      }
      if (typeof input.html === 'string') {
        const { component: def, inferred } = createComponentFromHtml(
          canvas.id,
          {
            ...shared,
            html: input.html,
            css: input.css as string | undefined,
            width: input.width as number | undefined,
            height: input.height as number | undefined,
          },
          actor,
        )
        return {
          data: {
            ok: true,
            component: summary(canvas, def),
            main_frame_id: def.mainFrameId,
            ...inferredProps(inferred),
          },
          note: [
            `The main is frame main_frame_id on the Components page. No instance was placed: to use it, write ${usageExample(def)} in a frame's HTML, or call insert_instance. Call get_frame_screenshot on main_frame_id, and resize that frame to fit with update_frame.${inferredNote(inferred)}`,
            ...(optional(() => componentReuseNotes(canvas, def, shared.autoProps)) ?? []),
          ].join('\n'),
          frames: outcomeFrames({ canvas } as ToolContext, def),
        }
      }
      if (typeof input.frame_id !== 'string' || typeof input.element !== 'string')
        throw new ComponentError('pass html, or frame_id with element')
      const { component, converted, inferred, matching_stopped } = createComponentFromElement(
        canvas.id,
        {
          ...shared,
          frameId: input.frame_id,
          element: input.element,
          replaceMatching: input.replace_matching as boolean | undefined,
        },
        actor,
      )
      return {
        data: {
          ok: true,
          component: summary(canvas, component),
          main_frame_id: component.mainFrameId,
          converted,
          ...(matching_stopped ? { matching_stopped } : {}),
          ...inferredProps(inferred),
        },
        note: [
          `Use it with ${usageExample(component)}.${inferredNote(inferred)}`,
          ...(matching_stopped
            ? [
                'replace_matching stopped part of the way (the work budget for one call): the frames in `converted` are linked, later frames were not looked at and their copies stay plain markup.',
              ]
            : []),
          ...(optional(() => componentReuseNotes(canvas, component, shared.autoProps)) ?? []),
        ].join('\n'),
        frames: outcomeFrames(
          { canvas } as ToolContext,
          component,
          converted.map((entry) => entry.frameId),
        ),
      }
    },
  },
  {
    name: 'create_components',
    title: 'Create several components',
    description: `Make up to ${MAX_BATCH_COMPONENTS} components from new markup in one call: the way to set up a canvas's component system (the primitives and patterns its screens are built from) before the first screen. Each entry takes what create_component takes from html: name, description, html (one root element), css, width, height, props, auto_props, code. Entries are made in order, so a later one can <doop-use> an earlier one: list primitives first (Button, Input, Badge), then what is built from them (Card, NavItem, Sidebar). Each entry stands alone: one that is refused is reported with its reason and the others are still made. The mains land on the Components page and no instance is placed anywhere; use them with <doop-use> in frame HTML. To make a component from an element already in a frame, use create_component.`,
    readOnly: false,
    shape: {
      components: z
        .array(
          z.object({
            name: z.string().describe('Short and unique, e.g. "Button"'),
            description: z.string().optional().describe('When to use this. Later agents choose by it'),
            html: z.string().describe('Markup, one root element'),
            css: z.string().optional().describe('The rules it needs, unscoped; they get scoped for you'),
            width: z.number().optional().describe('The main frame width, default 480'),
            height: z.number().optional().describe('The main frame height, default 240'),
            props: z.array(propSchema).optional().describe('Enum props, and metadata for bound ones'),
            auto_props: z.boolean().optional().describe('false = do not infer props'),
            code: codeSchema.optional(),
          }),
        )
        .min(1)
        .max(MAX_BATCH_COMPONENTS)
        .describe('In dependency order: a component another one nests comes first'),
    },
    run(input, { canvas, actor }) {
      const entries = (Array.isArray(input.components) ? input.components : []) as Record<string, unknown>[]
      if (!entries.length) throw new ComponentError('pass at least one component')
      if (entries.length > MAX_BATCH_COMPONENTS)
        throw new ComponentError(`at most ${MAX_BATCH_COMPONENTS} components per call; send the rest in another call`)
      const made: ComponentDef[] = []
      const refused: string[] = []
      const notes: string[] = []
      const results = entries.map((entry, index) => {
        const name = String(entry.name ?? '')
        try {
          /* each entry is its own unit: a refused one leaves nothing behind and the rest go on */
          const { component: def, inferred } = transaction(() => {
            const created = createComponentFromHtml(
              canvas.id,
              {
                name,
                description: entry.description as string | undefined,
                props: entry.props as never,
                code: entry.code as never,
                autoProps: entry.auto_props as boolean | undefined,
                html: String(entry.html ?? ''),
                css: entry.css as string | undefined,
                width: entry.width as number | undefined,
                height: entry.height as number | undefined,
              },
              actor,
            )
            /* a <doop-use> naming nothing renders as nothing: saved, the entry would lose that part for
               good, so it is refused (undone with this unit) and can be sent again once that one exists */
            const missing = missingNested(created.component)
            if (missing.length)
              throw new ComponentError(
                `it nests ${missing.map((ref) => (ref ? `“${ref}”` : 'a <doop-use> that could not be read')).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a component on this canvas${refused.length ? ' (an entry this call refused, or one never made)' : ''}; nothing was made for it`,
              )
            return created
          })
          made.push(def)
          notes.push(
            ...(optional(() => componentReuseNotes(canvas, def, entry.auto_props as boolean | undefined)) ?? []),
          )
          return {
            index,
            ok: true as const,
            component: summary(canvas, def),
            main_frame_id: def.mainFrameId,
            ...inferredProps(inferred),
          }
        } catch (error) {
          /* a refusal is this entry's; a spent work budget refuses the whole call (runComponentTool) */
          if (!(error instanceof ComponentError)) throw error
          refused.push(name)
          return { index, ok: false as const, name, error: error.message }
        }
      })
      const failed = results.filter((result) => !result.ok)
      const usage = made.map((def) => usageExample(def)).join('\n')
      return {
        data: { ok: failed.length === 0, created: made.length, failed: failed.length, results },
        note: [
          made.length
            ? `Made ${made.length} component${made.length === 1 ? '' : 's'} on the Components page. No instance was placed: compose screens from them with\n${usage}\nCall get_frame_screenshot on a main_frame_id or two, and resize a main to fit with update_frame. Props each one inferred are in its inferred_props.`
            : 'Nothing was made.',
          ...(failed.length
            ? [
                `${failed.length} entr${failed.length === 1 ? 'y was' : 'ies were'} refused (see results): fix ${failed.length === 1 ? 'it' : 'them'} and send ${failed.length === 1 ? 'it' : 'them'} again. An entry that nests a refused one is refused too.`,
              ]
            : []),
          ...notes,
        ].join('\n'),
        frames: made.flatMap((def) => outcomeFrames({ canvas } as ToolContext, def)),
      }
    },
  },
  {
    name: 'update_component',
    title: 'Update a component',
    description:
      "Change a component's main; every instance on the canvas follows in the background within moments, keeping its props and overrides, so this is how a sweeping design change is one call rather than one edit per screen. Small changes to the markup: find + replace on the template (from get_component). CSS is not searched: to change a style, pass the whole stylesheet as css. Rewrites: html, keeping data-doop-part attributes where you can so overrides stay attached. The result reports the impact: which frames hold instances and are queued to follow (propagation), how many of them are approved (they keep their sign-off), which overrides no longer have an element to apply to. Pass dry_run=true to read that report first, which you should for a component with many instances. A changed main is one undo-able revision: restore_component_version goes back.",
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      find: z.string().optional().describe('Exact text in the template; must occur once'),
      replace: z.string().optional(),
      html: z.string().optional().describe('New template markup, one root element'),
      css: z
        .string()
        .optional()
        .describe('The rules the template needs, unscoped; replaces what this tool wrote before'),
      name: z.string().optional(),
      description: z.string().optional(),
      props: z.array(propSchema).optional().describe('Full replacement of the prop metadata'),
      code: codeSchema.nullable().optional().describe('Full replacement of the code mapping; null clears it'),
      expected_rev: z.number().optional().describe('Refuse if the component has moved past this revision'),
      dry_run: z.boolean().optional().describe('Report the impact and change nothing'),
    },
    run(input, { canvas, actor, canRead }) {
      const result = updateComponent(
        canvas.id,
        String(input.component),
        {
          ...(input.find !== undefined ? { find: String(input.find), replace: String(input.replace ?? '') } : {}),
          ...(input.html !== undefined ? { html: String(input.html) } : {}),
          ...(input.css !== undefined ? { css: String(input.css) } : {}),
          ...(input.name !== undefined ? { name: String(input.name) } : {}),
          ...(input.description !== undefined ? { description: String(input.description) } : {}),
          ...(input.props !== undefined ? { props: input.props as never } : {}),
          ...(input.code !== undefined ? { code: input.code as never } : {}),
          ...(input.expected_rev !== undefined ? { expectedRev: Number(input.expected_rev) } : {}),
          dryRun: input.dry_run === true,
        },
        actor,
      )
      /* on a library canvas the impact above counts this canvas alone: say who else follows it */
      const shared = isLibrary(canvas.id)
        ? libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
        : []
      return {
        data: {
          ok: true,
          ...result,
          component: summary(canvas, result.component),
          rev: result.component.rev,
          ...(shared.length ? { library_used_by: shared } : {}),
        },
        ...(result.dry_run
          ? shared.length
            ? {
                note: 'The impact counts this canvas only. It is a workspace library: the canvases in library_used_by get this change once it is published (publish_library) and each pulls it (sync_component).',
              }
            : {}
          : {
              note: [
                ...propagationNote(result),
                isLibrary(canvas.id) ? `${IMPACT_NOTE} ${LIBRARY_NOTE}` : IMPACT_NOTE,
                ...(optional(() => componentReuseNotes(canvas, result.component)) ?? []),
              ].join('\n'),
              frames: outcomeFrames({ canvas } as ToolContext, result.component),
            }),
      }
    },
  },
  {
    name: 'edit_component_variants',
    title: "Edit a component's variants",
    description: `Add, rename, remove or style the variants of a component (an enum prop such as size = sm | md | lg, or a boolean such as disabled) without rewriting its CSS by hand. Use it instead of update_component whenever the change is "a new size", "rename ghost to outline", "make it styleable when disabled" or "what does lg look like": the server keeps props, the [data-<prop>="<value>"] rules and every instance consistent in one revision. ops run in order, at most ${MAX_VARIANT_OPS}: add_enum, add_value, rename_value (instances holding the old value and its CSS follow), remove_value (instances fall back to the default; new_default when removing the default), set_default, add_boolean, rename_prop, remove_prop, set_style (declarations for one element, a data-doop-part key or "root", under a variant combination such as { "size": "lg" }; null removes a property) and clear_style. Style lands as a rule in the component's stylesheet, never inline on the main. Values may not hold url(), braces, semicolons or @import. dry_run=true plans the edit and counts the instances that would be rewritten. Answers with the component's variant props and every variant rule.`,
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      ops: z.array(variantOpSchema).min(1).max(MAX_VARIANT_OPS),
      expected_rev: z.number().optional().describe('Refuse if the component has moved past this revision'),
      dry_run: z.boolean().optional().describe('Plan the edit and change nothing'),
    },
    run(input, { canvas, actor }) {
      const result = editVariants(
        canvas.id,
        String(input.component),
        {
          ops: input.ops as never,
          ...(input.expected_rev !== undefined ? { expectedRev: Number(input.expected_rev) } : {}),
          dryRun: input.dry_run === true,
        },
        actor,
      )
      return {
        data: {
          ok: true,
          dry_run: result.dry_run,
          component: summary(canvas, result.component),
          rev: result.component.rev,
          props: result.props,
          rules: result.rules,
          instances_updated: result.instances_updated,
          frames_updated: result.frames_updated,
          impact: result.impact,
        },
        ...(result.dry_run
          ? {}
          : {
              note: [...propagationNote(result), IMPACT_NOTE].join('\n'),
              frames: outcomeFrames({ canvas } as ToolContext, result.component),
            }),
      }
    },
  },
  {
    name: 'insert_instance',
    title: 'Place a component',
    description: `Place one instance of a component into a frame, inside or beside an element, and get back its instance_id. When you are already writing the frame's HTML, write <${USE_TAG}> in it instead.`,
    readOnly: false,
    shape: {
      frame_id: FRAME_ID,
      component: COMPONENT_REF,
      props: z.record(z.string()).optional().describe('Prop values, e.g. { "label": "Sign up", "tone": "ghost" }'),
      target: z.string().optional().describe('A data-doop-id. Defaults to the page body'),
      position: z
        .enum(['append', 'prepend', 'before', 'after'])
        .optional()
        .describe('Relative to target; default append'),
    },
    run(input, { canvas, actor }) {
      const { frame, instanceId } = insertInstance(
        canvas.id,
        {
          frameId: String(input.frame_id),
          component: String(input.component),
          props: asProps(input.props),
          target: input.target as string | undefined,
          position: input.position as never,
        },
        actor,
      )
      return { data: { ok: true, instance_id: instanceId, frame_id: frame.id }, frames: [frame] }
    },
  },
  {
    name: 'update_instances',
    title: 'Change instances',
    description:
      "Change instances in one frame in a single undo step: set props, override one element (keyed by part, from get_component), swap the component nested at a part for another on this instance only (swap: { part, component }; component null undoes it), reset overrides back to the main, or detach. Instance ids come from get_frame's instances list. An override is sparse: everything else keeps following the main. Detaching keeps the look and cuts the link, for that instance only (instances nested inside it stay linked).",
    readOnly: false,
    shape: {
      frame_id: FRAME_ID,
      instances: z
        .array(
          z.object({
            instance_id: z.string(),
            props: z.record(z.string()).optional().describe('Merged over current props; "" clears one'),
            overrides: z
              .record(z.any())
              .optional()
              .describe('By part key, e.g. { "abcd": { "style": { "color": "red" }, "text": "Hi", "hidden": true } }'),
            reset: z
              .union([z.boolean(), z.array(z.string())])
              .optional()
              .describe('true = everything, or these part keys'),
            detach: z.boolean().optional(),
            swap: z
              .object({
                part: z.string().describe("The nested component's part key, from get_component"),
                component: z
                  .string()
                  .nullable()
                  .describe("Name or id of the component to show there instead; null puts the main's own back"),
              })
              .optional()
              .describe(
                "Show another component in one nested <doop-use> of this instance only; props the new one lacks are dropped, same-named props carry over. Content inside a slot is the instance's own markup: edit it in the frame, there is no swap for it.",
              ),
          }),
        )
        .min(1),
    },
    run(input, { canvas, actor }) {
      const list = input.instances as {
        instance_id: string
        props?: Record<string, string>
        overrides?: Record<string, never>
        reset?: boolean | string[]
        detach?: boolean
        swap?: { part: string; component: string | null }
      }[]
      const { frame, missing } = changeInstances(
        canvas.id,
        String(input.frame_id),
        list.map((entry) => ({
          instanceId: entry.instance_id,
          props: entry.props,
          overrides: entry.overrides,
          reset: entry.reset,
          detach: entry.detach,
          swap: entry.swap,
        })),
        actor,
      )
      /* the change is in: reading the instances back is a courtesy the budget may not cover */
      const instances = optional(() => instancesIn(frame))
      return {
        data: { ok: true, ...(instances ? { instances } : {}), ...(missing.length ? { not_found: missing } : {}) },
        ...(instances ? {} : { note: 'The change was applied. Call get_frame to read the instances back.' }),
        frames: [frame],
      }
    },
  },
  {
    name: 'delete_component',
    title: 'Delete a component',
    description:
      'Delete a component. Nothing changes in any design and no frame is rewritten: its instances keep exactly the markup they have and simply stop following it, its main stays in its frame as ordinary markup, and a component built from it keeps rendering as it did. It leaves the catalog, <doop-use> of it is refused, and get_canvas lists it under deletedComponents while instances of it remain. restore_component brings it back with every instance linked again. Pass detach_instances=true only when the human wants the leftovers to be plain markup for good: that rewrites every frame using it, in the background, and cannot be restored (it also works on a component that is already deleted).',
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      detach_instances: z
        .boolean()
        .optional()
        .describe('Also turn every instance into plain markup, in the background. Not undone by restore_component'),
    },
    run({ component, detach_instances }, { canvas, actor }) {
      const ref = String(component)
      const pending = findDeletedComponent(canvas.id, ref)
      /* detaching what an earlier delete left behind is the same call again */
      const result =
        pending && detach_instances === true
          ? { deleted: pending.name, component_id: pending.id, already_deleted: true }
          : deleteComponent(canvas.id, ref, actor)
      const detach = detach_instances === true ? detachAllInstances(canvas.id, result.component_id, actor) : undefined
      const touched = detach?.queued ? usageOf(canvas, result.component_id).frames.map((frame) => frame.id) : []
      return {
        data: { ok: true, ...result, ...(detach ? { detach } : {}) },
        note: detach
          ? detach.queued
            ? `Detaching ${detach.instances} instance${detach.instances === 1 ? '' : 's'} in ${detach.frames} frame${detach.frames === 1 ? '' : 's'} in the background, a frame at a time: they become plain markup that keeps its look. This is not undone by restore_component.`
            : 'Nothing on the canvas uses it, so there was nothing to detach.'
          : 'No frame was changed: its instances look the same and no longer follow it. restore_component brings it back; delete_component with detach_instances=true turns what is left into plain markup.',
        frames: canvas.frames.filter((frame) => touched.includes(frame.id)),
      }
    },
  },
  {
    name: 'restore_component',
    title: 'Restore a deleted component',
    description:
      'Bring back a component that delete_component removed (get_canvas lists those still in use under deletedComponents). Its instances were never changed, so they are linked again as they are, and it is back in the catalog. Its main is the markup that still carries it; if that is gone, a new main is written on the Components page from the kept definition. If its name was given to another component meanwhile it comes back as “<name> (restored)”. Instances that were detached stay plain markup.',
    readOnly: false,
    shape: { component: COMPONENT_REF.describe('Name or id of the deleted component') },
    run({ component }, { canvas, actor }) {
      const { component: def, main } = restoreComponent(canvas.id, String(component), actor)
      return {
        data: { ok: true, component: summary(canvas, def), main, main_frame_id: def.mainFrameId },
        note:
          main === 'written'
            ? 'Its old main was gone, so a new one was written on the Components page (main_frame_id).'
            : 'Its instances follow it again.',
        frames: outcomeFrames({ canvas } as ToolContext, def),
      }
    },
  },
  {
    name: 'duplicate_component',
    title: 'Duplicate a component',
    description:
      'Make a second component from an existing one: the same design, props, slots and code mapping, named "<name> copy" ("copy 2", … when taken), with a main of its own beside the original\'s (or on the Components page when the original has none). Use it to start a variant or a divergent version without disturbing the original: the original and every instance of it stay exactly as they are, and the copy has no instances yet. A component linked from a workspace library is duplicated into a plain local one, which you can edit here. The copy starts at revision 1 with no history. Rename it with update_component.',
    readOnly: false,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas, actor }) {
      const { component: def, source } = duplicateComponent(canvas.id, String(component), actor)
      return {
        data: { ok: true, component: summary(canvas, def), source: source.name, main_frame_id: def.mainFrameId },
        note: `“${source.name}” is unchanged. The copy's main is frame main_frame_id on the Components page. No instance was placed: use it with ${usageExample(def)}, and rename it with update_component.`,
        frames: outcomeFrames({ canvas } as ToolContext, def),
      }
    },
  },
  {
    name: 'detach_from_library',
    title: 'Detach a component from its workspace library',
    description:
      "Make a component linked from a workspace library this canvas's own. It keeps its id, so every instance stays linked and none of them changes; the link to the library is dropped, a main is written on the Components page from the design it has now, and from then on it is edited here with update_component and sync_component no longer applies. Use it only when the human wants this canvas to diverge from the shared library: later library updates will not reach it. Refused for a component that is already local. For a separate copy that leaves the linked one alone, use duplicate_component.",
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas, actor }) {
      const { component: def } = detachFromLibrary(canvas.id, String(component), actor)
      return {
        data: { ok: true, component: summary(canvas, def), main_frame_id: def.mainFrameId },
        note: 'It is local now: its main is frame main_frame_id on the Components page, and every instance still follows it. Later library publications will not reach it.',
        frames: outcomeFrames({ canvas } as ToolContext, def),
      }
    },
  },
  {
    name: 'restore_component_version',
    title: 'Restore a component revision',
    description:
      'Put a component back to an earlier revision (listed by get_component) and carry that to every instance in the background, keeping their props and overrides. It is a new revision, so this can be undone too.',
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF, rev: z.number() },
    run({ component, rev }, { canvas, actor }) {
      const result = restoreComponentVersion(canvas.id, String(component), Number(rev), actor)
      const note = propagationNote(result).join('\n')
      return {
        data: { ok: true, ...result, component: summary(canvas, result.component), rev: result.component.rev },
        ...(note ? { note } : {}),
        frames: outcomeFrames({ canvas } as ToolContext, result.component),
      }
    },
  },
  {
    name: 'import_component',
    title: 'Import a component from a library',
    description:
      'Add a component, and whatever it is built from, from another canvas. From a workspace library (list_components → workspace_libraries) it is linked to what that library published and has no main here: change it on the library canvas. Writing <doop-use> with its name does the same without this call; use this when two libraries publish the same name. From any other canvas this account can read (list_components with libraries=true) it is copied with a main of its own. Either way a later change at the origin shows up as library_update_available and arrives only when sync_component pulls it, so publishing alone never changes this canvas.',
    readOnly: false,
    shape: {
      source_canvas_id: z.string().describe('The library canvas'),
      component: COMPONENT_REF,
    },
    run({ source_canvas_id, component }, { canvas, actor, canRead }) {
      const source = String(source_canvas_id)
      /* a workspace library goes by the canvas, like its fonts: whoever may edit here may use it */
      const shared = librariesForCanvas(canvas).some((library) => library.canvasId === source)
      if (!shared && !canRead(source)) throw new ComponentError('this account cannot read that canvas')
      const def = importComponent(canvas.id, source, String(component), actor)
      return { data: { ok: true, component: summary(canvas, def) }, note: `Use it with ${usageExample(def)}.` }
    },
  },
  {
    name: 'sync_component',
    title: 'Pull a library update',
    description:
      "Bring an imported component up to what its library last published (or, for a copy from another canvas, that canvas's current revision), carrying it to every instance here. Without component, pulls every workspace-library update waiting on this canvas in one call. Instance overrides are kept; edits made to a copied main are replaced. Approved frames keep their sign-off. It works on one canvas: after publish_library, call it on each canvas listed in that result's used_by, or use update_library_everywhere on the library canvas when the human wants every canvas updated at once.",
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF.optional().describe('Component name or id; omit for every waiting library update'),
    },
    run({ component }, { canvas, actor, canRead }) {
      if (component === undefined || component === '') {
        const waiting = waitingLibraryUpdates(canvas)
        const frames = new Map<string, Frame>()
        const updated: string[] = []
        for (const def of waiting) {
          const result = syncComponent(canvas.id, def.id, actor, canRead)
          if (!result.updated) continue
          updated.push(result.component.name)
          for (const frame of outcomeFrames({ canvas } as ToolContext, result.component)) frames.set(frame.id, frame)
        }
        return {
          data: { ok: true, updated: updated.length > 0, components: updated },
          ...(waiting.length ? {} : { note: 'No workspace-library update is waiting on this canvas.' }),
          frames: [...frames.values()],
        }
      }
      const result = syncComponent(canvas.id, String(component), actor, canRead)
      return {
        data: { ok: true, updated: result.updated, component: summary(canvas, result.component) },
        frames: result.updated ? outcomeFrames({ canvas } as ToolContext, result.component) : [],
      }
    },
  },
  {
    name: 'publish_library',
    title: 'Publish components to the workspace library',
    description:
      "Share this canvas's components with every canvas in its workspace. Publishing snapshots them: other canvases use the published state, never work in progress, and a canvas already using one sees library_update_available and pulls it when it chooses, so publishing changes no other canvas by itself. The result's used_by lists the canvases using this library and which components each still has to pull (sync_component there, or update_library_everywhere when the human asks for the change on every canvas). Without components, everything this canvas owns is published; with them, only those (each with what it is built from). dry_run=true lists what would be published or removed. unpublish=true stops sharing instead (the named components, or all); canvases using them keep their definition and every instance. Publish when the human asks for it in any words (make this available to the team, share it with our other canvases), not on your own initiative: it is how a team's design system reaches their other canvases. Needs a canvas in a workspace on the Team plan, and a workspace can keep publishing to its owner and admins; when it is refused for either reason, tell the human rather than working around it.",
    readOnly: false,
    shape: {
      components: z.array(z.string()).optional().describe('Component names or ids; omit for all'),
      dry_run: z.boolean().optional().describe('Report what would change and publish nothing'),
      unpublish: z.boolean().optional().describe('Stop sharing instead of publishing'),
    },
    run({ components, dry_run, unpublish }, { canvas, actor, canRead, userId }) {
      const refs = Array.isArray(components) && components.length ? components.map(String) : undefined
      /* other canvases by name: only the ones this account can open */
      const usedBy = () => libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
      if (unpublish === true) {
        const result = unpublishFromLibrary(canvas.id, refs, actor, userId)
        return { data: { ok: true, unpublished: result.unpublished, is_library: result.library.library } }
      }
      const result = publishToLibrary(canvas.id, refs, actor, userId, dry_run === true)
      const unpublished = result.library.changes.filter((entry) => entry.change !== 'unchanged')
      return {
        data: {
          ok: true,
          dry_run: result.dry_run,
          published: result.published,
          removed: result.removed,
          /* whether this canvas shares anything with its workspace right now */
          is_library: result.library.library,
          ...(result.dry_run ? {} : { still_unpublished: unpublished.map((entry) => entry.name) }),
          used_by: usedBy(),
        },
        note: result.dry_run
          ? 'Dry run: nothing was published. `published` and `removed` are what a real call would do.'
          : 'Published. Canvases in used_by with update_waiting keep the previous version until sync_component is called on each. Only when the human asks for the change everywhere: update_library_everywhere.',
      }
    },
  },
  {
    name: 'update_library_everywhere',
    title: 'Update every canvas using this library',
    description:
      "Pull this library canvas's latest publication into every canvas of the workspace that uses it, in one call: what sync_component does on one canvas, done on all of them. Use it ONLY when the human asks for the change everywhere / across all canvases, never as a follow-up to publish_library on your own initiative: it changes other people's canvases (approved frames keep their sign-off). Run it with dry_run=true first and tell the human what it would touch. It applies what is published, so publish_library comes first (its used_by shows which canvases are waiting). The result reports per canvas which components were updated, how many frames changed (approvals_withdrawn is always 0: approved frames keep their sign-off); skipped lists canvases this account may not edit, or where the pull was refused, and each of those still needs sync_component by someone who can. Relay the report to the human.",
    readOnly: false,
    destructive: true,
    shape: {
      dry_run: z.boolean().optional().describe('Report what would change on each canvas and change nothing'),
    },
    async run({ dry_run }, { canvas, actor, canEdit, canRead, userId }) {
      const report = await updateLibraryConsumers(canvas.id, actor, {
        dryRun: dry_run === true,
        canEdit,
        canRead,
        publisherId: userId,
      })
      const count = report.canvases.length
      return {
        data: { ok: true, ...report },
        note:
          count + report.skipped.length === 0
            ? 'Every canvas using this library already has its latest publication. Changes made here since then reach nobody until publish_library.'
            : report.dry_run
              ? 'Dry run: nothing was changed. frames_changed counts the frames holding an instance of what would update; approved frames keep their sign-off. Tell the human before running it for real.'
              : `Updated ${count} canvas${count === 1 ? '' : 'es'}. Tell the human which canvases changed${report.skipped.length ? ', and which were skipped and why' : ''}.`,
      }
    },
  },
  {
    name: 'import_components',
    title: 'Import a component bundle',
    description: `Import a bundle of React components into this canvas as Doop components, in one call: the way to bring a design system in when you already have each component's markup (html, css, props, variants, code mapping). Small bundles only (up to ${MAX_INLINE_BUNDLE_BYTES / 1000} KB inline): for a published Storybook use import_storybook, for a bundle the CLI made or one too big to send here use create_import_ticket. Components land on the "Imported components" page; importing again updates them in place (same id, history kept, instances follow). Pass dry_run=true first to see what would change without writing.`,
    readOnly: false,
    shape: {
      bundle: componentBundleSchema.describe(
        'A component bundle: { version: 1, source: { kind: "agent" }, components: [...] }',
      ),
      dry_run: z.boolean().optional().describe('Report what would be created, updated or refused, and write nothing'),
    },
    run(input, { canvas, actor }) {
      const size = Buffer.byteLength(JSON.stringify(input.bundle ?? null))
      if (size > MAX_INLINE_BUNDLE_BYTES)
        throw new ComponentError(
          `the bundle is ${Math.round(size / 1000)} KB, over the ${MAX_INLINE_BUNDLE_BYTES / 1000} KB an inline import takes: call create_import_ticket and send the file with the curl command it returns`,
        )
      const dryRun = input.dry_run === true
      const result = importComponentBundle({ canvasId: canvas.id, actor }, input.bundle, { dryRun })
      const defs = [...result.created, ...result.updated].flatMap(({ id }) => {
        const def = id ? findComponent(canvas.id, id) : undefined
        return def ? [def] : []
      })
      const counts = `${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} refused`
      return {
        data: { ok: true, dry_run: dryRun, ...result },
        note: [
          dryRun
            ? `Dry run, nothing was written: ${counts}.`
            : `Imported: ${counts}. The mains are on the "Imported components" page; compose screens from them with <doop-use component="Name">. Check one with get_component_preview.`,
          ...(result.skipped.length
            ? [`Refused: ${result.skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`]
            : []),
          ...(result.issues.length
            ? [
                `${result.issues.length} issue${result.issues.length === 1 ? '' : 's'} are listed in issues: unsafe markup and css was removed, and anything a condition could not express was kept as the default.`,
              ]
            : []),
        ].join('\n'),
        frames: defs.flatMap((def) => outcomeFrames({ canvas } as ToolContext, def)),
      }
    },
  },
  {
    name: 'import_storybook',
    title: 'Import a published Storybook',
    description:
      'Import the components of a PUBLISHED Storybook (a public URL, such as the team\'s deployed storybook-static) into this canvas as Doop components: each Storybook component becomes a component with its enum, boolean, number, color and text props, its variants and a code mapping, on the "Imported components" page. Doop renders every story in a sandboxed browser, which takes minutes, so this starts a job and answers at once with { job_id, status: "running", planned }: call get_import_status with the job_id until status is done (it carries the result), failed or cancelled; cancel_import stops it. Private Storybooks (behind a sign-in) are refused: for one of those, or one only on a dev machine, use create_import_ticket and the doop-import CLI. Pass dry_run=true first to see what would be created or updated: it reads the Storybook\'s index in seconds, renders nothing and answers directly. At most 3 imports an hour, one running at a time.',
    readOnly: false,
    shape: {
      ...storybookInput,
      dry_run: z
        .boolean()
        .optional()
        .describe('Read the index and report what would change, rendering and writing nothing'),
    },
    async run(input, { canvas, actor, userId, budgetKey, canEdit }) {
      const owner = userId ?? budgetKey ?? `canvas:${canvas.id}`
      const url = String(input.url)
      const packageName = typeof input.package === 'string' ? input.package : undefined
      const include = Array.isArray(input.include) ? (input.include as string[]) : undefined
      if (input.dry_run === true) {
        let refund = () => {}
        try {
          /* a URL that could never be read costs nothing */
          const checked = checkStorybookUrl(url)
          if (!checked.ok) throw new ComponentError(checked.message)
          refund = takeStorybookPlan(owner)
          const planned = await planStorybookImport({
            canvasId: canvas.id,
            actor,
            url: checked.url.href,
            package: packageName,
            include,
          })
          const { result } = planned
          const counts = `${result.created.length} created, ${result.updated.length} updated`
          return {
            data: {
              ok: true,
              dry_run: true,
              ...result,
              issues: planned.issues,
              planned: { renders: planned.info.importing, total: planned.info.total, components: planned.components },
            },
            note: `Dry run, nothing was rendered or written: an import would start with ${planned.info.importing} component${planned.info.importing === 1 ? '' : 's'} (${counts}). Call import_storybook again without dry_run to start it.`,
          }
        } catch (error) {
          if (failedBeforeRendering(error)) refund()
          if (error instanceof ComponentError) throw error
          throw new ComponentError(storybookFailure(error).message)
        }
      }
      try {
        const job = await startStorybookJob({
          canvasId: canvas.id,
          actor,
          owner,
          url,
          package: packageName,
          include,
          canEdit: () => canEdit(canvas.id),
        })
        if (job.status === 'failed') throw new ComponentError(job.error?.message ?? 'The Storybook import failed')
        return {
          data: { ok: true, ...job },
          note: `The import is running as job ${job.job_id}. Call get_import_status with it until status is done: the result (created, updated, issues) comes with it. It renders every story, so it takes a minute or more; you may do other work between calls.`,
        }
      } catch (error) {
        if (error instanceof ComponentError) throw error
        if (error instanceof JobLimitError) throw new ComponentError(error.message)
        throw new ComponentError(storybookFailure(error).message)
      }
    },
  },
  {
    name: 'get_import_status',
    title: 'See how a Storybook import is going',
    description:
      'How an import_storybook job is going: { status: running | cancelling | done | failed | cancelled, rendered, total, component, planned } while it runs, and on done the result (created, updated, unchanged, skipped, tokens, issues), on failed the error. Only the account that started the job, or another editor of the canvas, can read it. A job is kept 30 minutes after it ends; one the server lost (a restart) answers status "unknown": start the import again.',
    readOnly: true,
    shape: { job_id: z.string().min(1).max(100).describe('The job_id import_storybook returned') },
    run(input, { canvas, userId, budgetKey, canEdit }) {
      return importStatus(readJob(input, { canvas, userId, budgetKey, canEdit }, readStorybookJob), canvas)
    },
  },
  {
    name: 'cancel_import',
    title: 'Stop a Storybook import',
    description:
      'Stop a running import_storybook job: the renders end and nothing is written. A job that already finished is left as it is and answered with its result.',
    readOnly: false,
    shape: { job_id: z.string().min(1).max(100).describe('The job_id import_storybook returned') },
    run(input, { canvas, userId, budgetKey, canEdit }) {
      return importStatus(readJob(input, { canvas, userId, budgetKey, canEdit }, cancelStorybookJob), canvas, true)
    },
  },
  {
    name: 'create_import_ticket',
    title: 'Get an upload URL for a component bundle',
    description:
      'Get a one-time upload URL (15 minutes, one use) for a component bundle too big to send through import_components, or one the doop-import CLI makes from a Storybook build. Returns the URL, the CLI command and a curl command; the bundle goes straight to the server and the import result comes back from that request.',
    readOnly: false,
    shape: {},
    run(_input, { canvas, actor, userId }) {
      try {
        const ticket = createImportTicket({ canvasId: canvas.id, userId, actor })
        return {
          data: { ok: true, ...ticketAnswer(ticket) },
          note: 'Run command (the CLI, for a Storybook build) or curl (for a bundle.json you have) within 15 minutes. Add ?dry_run=1 to the URL to preview the import without using the ticket up. The answer to the request is the import result.',
        }
      } catch (error) {
        if (error instanceof ImportTicketError) throw new ComponentError(error.message)
        throw error
      }
    },
  },
  {
    name: 'export_react',
    title: 'Export as React code',
    description:
      "Export the canvas's components and screens as React + TypeScript code a team can drop into its app: one .tsx per component and per frame, styled with CSS Modules (default) or Tailwind, the canvas's tokens as src/tokens.css and src/tokens.json. Deterministic, no model. Name what to export: frame_ids (screens), page_id (every visible screen on that page), component_ids (ids or names; components used by an exported screen come along). With none of them, the canvas's first page goes out with the components it uses. Returns { files: [{ path, content }], report }: write each file into the project at its path. report lists everything that could not be carried over (dropped scripts, unsafe URLs, unsupported CSS) in issues; read it and tell the human. When the files total more than 300 KB the answer carries the report, the file list with sizes and a zip of everything as an embedded application/zip resource (base64); over the resident agent, narrow the scope instead. Read the guide first: get_guide({ topic: \"export\" }).",
    readOnly: true,
    shape: {
      frame_ids: z.array(z.string()).max(200).optional().describe('Frames to export as screens, in this order'),
      page_id: z.string().optional().describe('Export every visible screen on this page, in reading order'),
      component_ids: z
        .array(z.string())
        .max(200)
        .optional()
        .describe('Components to export (ids or names), even when no exported screen uses them'),
      styling: z.enum(['modules', 'tailwind']).optional().describe('modules (default) or tailwind'),
      tokens: z.boolean().optional().describe('Include src/tokens.css and src/tokens.json (default true)'),
    },
    async run(input, { canvas, userId, surface, budgetKey }) {
      if (batchScope.getStore()) {
        throw new ComponentError(
          'export_react cannot run inside run_batch: its answer can carry a whole zip. Call export_react directly.',
        )
      }
      const request = reactExportRequest.safeParse({
        frameIds: input.frame_ids,
        pageId: input.page_id,
        componentIds: input.component_ids,
        styling: input.styling,
        tokens: input.tokens,
      })
      if (!request.success) {
        const issue = request.error.issues[0]
        throw new ComponentError(
          `invalid export_react arguments: ${issue?.path.join('.') || 'input'} ${issue?.message ?? ''}`.trim(),
        )
      }
      /* one bucket per account; a call with no account known spends the canvas's, never a name the caller picked */
      const exported = exportCanvasReact(canvas, request.data, budgetKey ?? userId ?? `canvas:${canvas.id}`)
      if (!exported.ok) {
        throw new ComponentError(
          exported.retryAfter
            ? `React export rate limit: wait ${exported.retryAfter} seconds before exporting again`
            : exported.error,
        )
      }
      const { result } = exported
      const issues = result.report.issues.length
      const issuesNote = issues
        ? `${issues} thing${issues === 1 ? '' : 's'} did not carry over: read report.issues and tell the human.`
        : 'Everything carried over.'
      const inlineCap = surface === 'resident' ? MAX_RESIDENT_INLINE_BYTES : MAX_INLINE_EXPORT_BYTES
      if (exported.bytes <= inlineCap) {
        return {
          data: { files: result.files, report: result.report },
          note: `Write each file at its path in the project (for example under the app's src/). ${issuesNote}`,
        }
      }
      const listing = result.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') }))
      if (surface === 'resident') {
        return {
          data: { report: result.report, files: listing, too_large: true },
          note: `The files total ${Math.round(exported.bytes / 1024)} KB, too much to return here. Export a narrower scope (one page_id, fewer frame_ids or component_ids). ${issuesNote}`,
        }
      }
      let zip: Buffer
      try {
        zip = await zipExport(result, exported.rootDir)
      } catch (e) {
        console.error(`[react-export] zip failed on canvas ${canvas.id}: ${e instanceof Error ? e.message : String(e)}`)
        throw new ComponentError('The export failed')
      }
      if (zip.length > MAX_ZIP_BYTES) {
        throw new ComponentError(
          'The export is too large to return: narrow it with page_id, frame_ids or component_ids',
        )
      }
      return {
        data: { report: result.report, files: listing, zip: { file_name: exported.fileName, bytes: zip.length } },
        note: `The files total ${Math.round(exported.bytes / 1024)} KB, so they come as one zip: the embedded application/zip resource (base64). Save it as ${exported.fileName} and unzip it into the project; files is the listing of what is inside, under the folder ${exported.rootDir}/. ${issuesNote}`,
        attachment: {
          uri: `doop://canvas/${canvas.id}/${encodeURIComponent(exported.fileName)}`,
          mimeType: 'application/zip',
          bytes: zip,
        },
      }
    },
  },
]

export const COMPONENT_TOOL_NAMES = COMPONENT_TOOLS.map((tool) => tool.name)

/** Every string a call submits (markup, css, find/replace, prop values), for the base64 check. */
function submittedText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(submittedText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(submittedText).join('\n')
  return ''
}

/** What the call's targets already hold: the component (its stored template, styles and head, and
 *  its main frame) and the frame it writes to. Carrying those over is not a new upload. */
function currentMarkup(input: Record<string, unknown>, context: ToolContext): string {
  const parts: string[] = []
  const html = (frameId: unknown) => {
    if (typeof frameId !== 'string') return
    try {
      const frame = store.getFrame(frameId)
      if (frame?.canvasId === context.canvas.id) parts.push(frame.html)
    } catch {
      /* not loaded: nothing to compare against */
    }
  }
  if (typeof input.component === 'string') {
    const def = findComponent(context.canvas.id, input.component)
    if (def) {
      parts.push(def.template, def.css, def.rawCss, ...def.head)
      html(def.mainFrameId)
    }
  }
  html(input.frame_id)
  return parts.join('\n')
}

/** Run a tool's handler, turning a ComponentError into a message the agent can act on. */
export async function runComponentTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: true; result: ToolResult } | { ok: false; error: string }> {
  const tool = COMPONENT_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { ok: false, error: `unknown tool ${name}` }
  /* a bundle is sanitized by its importer, which strips base64 data and says so, rather than refused whole */
  const inline =
    name === 'import_components'
      ? null
      : inlineDataRefusal(submittedText(input), currentMarkup(input, context), context.surface)
  if (inline) return { ok: false, error: inline }
  try {
    /* one unit (server/journal.ts): a refusal comes back as this call's error, not as a
       throw out of the operation, so what the tool had changed is undone here. Awaited
       inside, so an async tool's ComponentError is caught like any other */
    return { ok: true, result: await transaction(() => tool.run(input, context)) }
  } catch (error) {
    if (error instanceof ComponentError || error instanceof WorkBudgetError) return { ok: false, error: error.message }
    throw error
  }
}

/** The usage event a library tool call counts as, if it did something: MCP and
 *  the resident agent report it on the person the agent works for. */
export function libraryFeatureEvent(name: string, input: Record<string, unknown>, data: unknown): string | undefined {
  const result = (data ?? {}) as { updated?: boolean; component?: { library?: unknown }; components?: string[] }
  if (name === 'publish_library')
    return input.dry_run === true || input.unpublish === true ? undefined : 'library_published'
  if (name === 'sync_component')
    return result.updated && result.component?.library ? 'library_update_pulled' : undefined
  if (name === 'import_component') return result.component?.library ? 'library_component_used' : undefined
  if (name === 'update_library_everywhere') return input.dry_run === true ? undefined : 'library_updated_everywhere'
  return undefined
}

/** What an agent should hear after writing a frame: what could not be done, and components it redrew by hand.
 *  `review` is a whole-frame write (create, replace, a finished stream), which also hears what it should
 *  have reused: blocks repeated by hand and colours the canvas has as tokens. */
export function componentWriteNotes(frame: Frame, { review = false }: { review?: boolean } = {}): string[] {
  const notes = actions.takeComponentIssues(frame.id).map((issue) => `COMPONENT: ${issue.message}`)
  const canvas = review ? store.getCanvas(frame.canvasId) : undefined
  if (canvas) notes.push(...(optional(() => frameReuseNotes(canvas, frame)) ?? []))
  /* said after a write that has landed: when the budget is spent, the note is simply not made */
  for (const lookalike of optional(() => lookalikesIn(frame)) ?? []) {
    notes.push(
      `COMPONENT: ${lookalike.occurrences} element${lookalike.occurrences === 1 ? '' : 's'} in this frame match${lookalike.occurrences === 1 ? 'es' : ''} “${lookalike.component}” but ${lookalike.occurrences === 1 ? 'is' : 'are'} not linked to it, so ${lookalike.occurrences === 1 ? 'it' : 'they'} will not follow changes. Use ${lookalike.usage} instead.`,
    )
  }
  return notes
}

/** Frames whose stream has already heard the component-system note: said once, not per chunk. */
const toldThisStream = new Set<string>()
const SYSTEM_NOTE = 'COMPONENT SYSTEM:'

/** The notes one chunk of a stream hears. Mid-stream, only the component-system note, the first
 *  time the screen's markup shows it is being drawn without components (the agent can still change
 *  course); the last chunk hears the whole review, without that note again. */
export function streamChunkNotes(frame: Frame, { start, done }: { start?: boolean; done?: boolean }): string[] {
  if (start) toldThisStream.delete(frame.id)
  const told = toldThisStream.has(frame.id)
  if (done) {
    toldThisStream.delete(frame.id)
    const notes = componentWriteNotes(frame, { review: true })
    return told ? notes.filter((note) => !note.startsWith(SYSTEM_NOTE)) : notes
  }
  if (told) return []
  const canvas = store.getCanvas(frame.canvasId)
  const notes = canvas ? (optional(() => componentSystemNotes(canvas, frame)) ?? []) : []
  if (notes.length) toldThisStream.add(frame.id)
  return notes
}
