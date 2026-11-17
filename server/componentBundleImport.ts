import { componentBundleSchema, type BundleComponent, type ComponentBundle } from '../shared/componentBundle.ts'
import type { ComponentCode } from '../shared/componentCode.ts'
import {
  activeComponents,
  MAX_COMPONENTS,
  USE_TAG,
  type ComponentDef,
  type ComponentProp,
} from '../shared/components.ts'
import { MAX_TOKEN_VALUE, normalizeTokenName, type TokenType } from '../shared/designTokens.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import type { Actor } from '../shared/types.ts'
import * as actions from './actions.ts'
import { prepareComponent } from './bundleVariants.ts'
import { unsafeCssValue } from './bundleSanitize.ts'
import { ComponentError, createComponentFromHtml, updateComponent } from './componentActions.ts'
import { parseCss, splitTopLevel, type CssNode } from './componentCss.ts'
import { savepoint, transaction } from './journal.ts'
import { store } from './store.ts'
import { WorkBudgetError } from './workBudget.ts'

/**
 * The one importer every way into a canvas goes through (a published Storybook, the CLI, an agent): a ComponentBundle
 * (shared/componentBundle.ts) in, Doop components out, through the ordinary component create and update paths, so
 * history, revisions, instances and the room all behave as they do for a component made by hand.
 * Everything in the bundle is untrusted: it is validated with the schema and sanitized (server/bundleSanitize.ts)
 * before it is written. Spec: .context/specs/components.md ("Importing a React library").
 */

export const IMPORT_PAGE = 'Imported components'

/** Components written per unit of work when the caller can open one (each gets its own work budget). */
const BATCH_SIZE = 6
/** The default main frame and the space between mains on the import page. */
const MAIN_WIDTH = 480
const MAIN_HEIGHT = 240
const MAIN_GAP = 120
const MAINS_PER_ROW = 5
/** The most issues one answer lists; the rest are counted. */
const MAX_ISSUES = 200

export interface ImportIssue {
  component?: string
  code: string
  message: string
}

export interface ImportResult {
  created: { name: string; id: string }[]
  updated: { name: string; id: string }[]
  unchanged: { name: string; id: string }[]
  skipped: { name: string; reason: string }[]
  tokens: { created: string[]; skipped: string[] }
  pageId: string | null
  issues: ImportIssue[]
}

export interface ImportContext {
  canvasId: string
  actor: Actor
  /** Run a unit of writes as an operation of its own, so a long import is not one budget (the upload route). Default: in place. */
  batch?: <T>(work: () => T) => T
}

class DryRunDone extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run')
  }
}

/** The bundle, checked: what the schema refuses is named by path, never trusted from the caller's typing. */
export function parseBundle(raw: unknown): ComponentBundle {
  const parsed = componentBundleSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'bundle'}: ${issue.message}`)
  const more = parsed.error.issues.length - lines.length
  throw new ComponentError(`not a component bundle — ${lines.join('; ')}${more > 0 ? `; and ${more} more` : ''}`)
}

/* ------------------------------------------------------------------ */
/* Matching and capacity                                               */
/* ------------------------------------------------------------------ */

function codeOf(bundle: ComponentBundle, component: BundleComponent): ComponentCode {
  const { origin, ...rest } = component.code ?? {}
  const importFrom = rest.importFrom ?? bundle.package
  return {
    ...rest,
    ...(importFrom ? { importFrom } : {}),
    origin: { ...origin, kind: origin?.kind ?? bundle.source.kind },
  } as ComponentCode
}

/** The live component a bundle entry is a new version of: the same package export, else the same name from the same kind of import. */
function matchOf(code: ComponentCode, name: string, defs: readonly ComponentDef[]): ComponentDef | undefined {
  if (code.importFrom && code.exportName)
    return defs.find((def) => def.code?.importFrom === code.importFrom && def.code?.exportName === code.exportName)
  return defs.find(
    (def) => def.name.toLowerCase() === name.trim().toLowerCase() && def.code?.origin?.kind === code.origin?.kind,
  )
}

interface Plan {
  component: BundleComponent
  code: ComponentCode
  match: ComponentDef | undefined
}

function planFor(bundle: ComponentBundle, defs: readonly ComponentDef[]): Plan[] {
  const plans = bundle.components.map((component) => {
    const code = codeOf(bundle, component)
    return { component, code, match: matchOf(code, component.name, defs) }
  })
  /* nesting needs the nested one first: a component that names others goes after those that name none */
  return [...plans].sort(
    (a, b) => Number(a.component.html.includes(`<${USE_TAG}`)) - Number(b.component.html.includes(`<${USE_TAG}`)),
  )
}

function checkCapacity(plans: Plan[], defs: readonly ComponentDef[]) {
  const matched = new Set<string>()
  const fresh = plans.filter((plan) => {
    if (!plan.match) return true
    return matched.has(plan.match.id) ? false : (matched.add(plan.match.id), false)
  }).length
  if (defs.length + fresh > MAX_COMPONENTS)
    throw new ComponentError(
      `this canvas holds at most ${MAX_COMPONENTS} components and has ${defs.length}: the bundle would add ${fresh}, which makes ${defs.length + fresh}. Delete components or import fewer; nothing was imported`,
    )
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

interface TokenCandidate {
  name: string
  value: string
  type: TokenType | undefined
}

/** A token's type from what its value and name say, or undefined when neither does. */
export function guessTokenType(name: string, value: string): TokenType | undefined {
  const text = value.trim().toLowerCase()
  const label = name.toLowerCase()
  if (/^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color|color-mix)\()/.test(text)) return 'color'
  if (/^(transparent|currentcolor)$/.test(text)) return 'color'
  if (/font-family|font-stack|typeface|\bfont\b/.test(label) && !/size|weight|height/.test(label)) return 'fontFamily'
  if (/^["'][^"']+["']/.test(text) || /,\s*(sans-serif|serif|monospace|system-ui|cursive|fantasy)$/.test(text))
    return 'fontFamily'
  if (/weight/.test(label) && /^\d{3}$|^(normal|bold|bolder|lighter)$/.test(text)) return 'fontWeight'
  if (/opacity|alpha/.test(label) && /^[\d.]+%?$/.test(text)) return 'opacity'
  if (/line-height|leading/.test(label) && /^[\d.]+(px|rem|em|%)?$/.test(text)) return 'lineHeight'
  if (/letter-spacing|tracking/.test(label) && /^-?[\d.]+(px|rem|em)?$/.test(text)) return 'letterSpacing'
  if (/^-?[\d.]+(px|rem|em|vw|vh|ch)$/.test(text) || text === '0') {
    if (/radius|rounded|corner/.test(label)) return 'radius'
    if (/font-size|text-size|\bsize\b|fs-/.test(label) && /font|text|size/.test(label) && !/space|gap/.test(label))
      return 'fontSize'
    if (/breakpoint|screen/.test(label)) return 'breakpoint'
    if (/container|max-width|width/.test(label)) return 'container'
    return 'spacing'
  }
  return undefined
}

function declarationsOf(body: string): { name: string; value: string }[] {
  return splitTopLevel(body, ';').flatMap((declaration) => {
    const at = declaration.indexOf(':')
    if (at === -1) return []
    return [
      {
        name: declaration.slice(0, at).trim(),
        value: declaration
          .slice(at + 1)
          .replace(/!important\s*$/i, '')
          .trim(),
      },
    ]
  })
}

function rootVariables(nodes: CssNode[]): { name: string; value: string }[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'group') return rootVariables(node.nodes)
    if (node.kind !== 'rule') return []
    const onRoot = splitTopLevel(node.selector, ',').some((selector) => /^(:root|html)$/i.test(selector.trim()))
    return onRoot ? declarationsOf(node.body).filter((declaration) => declaration.name.startsWith('--')) : []
  })
}

function tokenCandidates(bundle: ComponentBundle, issues: ImportIssue[]): TokenCandidate[] {
  const found = new Map<string, TokenCandidate>()
  const add = (name: string, value: string, type: TokenType | undefined, explicit: boolean) => {
    const token = normalizeTokenName(name)
    if (!value || value.length > MAX_TOKEN_VALUE) return
    if (unsafeCssValue(value)) {
      issues.push({ code: 'unsafe_token', message: `token ${token} was left out: its value is not a plain css value` })
      return
    }
    const known = found.get(token)
    if (known && !explicit) return
    found.set(token, { name: token, value, type: type ?? guessTokenType(token, value) })
  }
  if (bundle.css)
    for (const variable of rootVariables(parseCss(bundle.css))) add(variable.name, variable.value, undefined, false)
  for (const token of bundle.tokens ?? []) add(token.name, token.value, token.type, true)
  return [...found.values()]
}

/** A value that names another token takes that token's type when it has none of its own. */
function withAliasTypes(candidates: TokenCandidate[]): TokenCandidate[] {
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
  return candidates.map((candidate) => {
    if (candidate.type) return candidate
    const target = /^var\(\s*(--[\w-]+)\s*\)$/.exec(candidate.value.trim())?.[1]
    return { ...candidate, type: target ? byName.get(target)?.type : undefined }
  })
}

function importTokens(
  canvasId: string,
  candidates: TokenCandidate[],
  actor: Actor,
  dryRun: boolean,
): ImportResult['tokens'] {
  const have = new Set(store.getTokens(canvasId).map((token) => token.name))
  const out: ImportResult['tokens'] = { created: [], skipped: [] }
  const fresh: TokenCandidate[] = []
  for (const candidate of withAliasTypes(candidates)) {
    if (have.has(candidate.name) || !candidate.type) out.skipped.push(candidate.name)
    else fresh.push(candidate)
  }
  if (dryRun) {
    out.created = fresh.map((candidate) => candidate.name)
    return out
  }
  const ordered = aliasesLast(fresh)
  const results = ordered.length ? actions.createTokens(canvasId, ordered, actor) : []
  for (const result of results ?? []) (result.result === 'created' ? out.created : out.skipped).push(result.name)
  return out
}

/** Tokens ordered so each comes after the one its value names: an alias is refused until its target exists. */
function aliasesLast(tokens: TokenCandidate[]): TokenCandidate[] {
  const names = new Set(tokens.map((token) => token.name))
  const reads = (token: TokenCandidate) =>
    [...token.value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!).filter((name) => names.has(name))
  const placed = new Set<string>()
  const ordered: TokenCandidate[] = []
  let waiting = tokens
  while (waiting.length) {
    const ready = waiting.filter((token) => reads(token).every((name) => placed.has(name)))
    const next = ready.length ? ready : waiting
    for (const token of next) {
      placed.add(token.name)
      ordered.push(token)
    }
    waiting = waiting.filter((token) => !placed.has(token.name))
  }
  return ordered
}

/* ------------------------------------------------------------------ */
/* Page and layout                                                     */
/* ------------------------------------------------------------------ */

function importPageId(canvasId: string, actor: Actor, create: boolean): string | null {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new ComponentError('canvas not found')
  const existing = canvasPages(canvas).find((page) => page.name === IMPORT_PAGE)
  if (existing) return existing.id
  if (!create) return null
  try {
    const created = actions.createCanvasPage(canvasId, IMPORT_PAGE, actor)
    if (!created) throw new ComponentError('canvas not found')
    return created.page.id
  } catch (error) {
    if (error instanceof ComponentError) throw error
    throw new ComponentError(error instanceof Error ? error.message : 'could not add the Imported components page')
  }
}

/** Where each new main goes: a row per group (the part of a Storybook title before the component), five to a row, below what the page holds. */
function layout(canvasId: string, pageId: string, plans: Plan[]): Map<Plan, { x: number; y: number }> {
  const canvas = store.getCanvas(canvasId)
  const occupied = canvas ? pageFrames(canvas, pageId) : []
  const top = occupied.length ? Math.max(...occupied.map((box) => box.y + box.height)) + MAIN_GAP : 0
  const rows = new Map<string, Plan[]>()
  for (const plan of plans) {
    const group = plan.component.group?.trim() ?? ''
    const key = group.includes('/') ? group.slice(0, group.lastIndexOf('/')) : group
    rows.set(key, [...(rows.get(key) ?? []), plan])
  }
  const spots = new Map<Plan, { x: number; y: number }>()
  let row = 0
  for (const members of rows.values())
    for (let start = 0; start < members.length; start += MAINS_PER_ROW, row++)
      members.slice(start, start + MAINS_PER_ROW).forEach((plan, column) => {
        spots.set(plan, { x: column * (MAIN_WIDTH + MAIN_GAP), y: top + row * (MAIN_HEIGHT + MAIN_GAP) })
      })
  return spots
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

const fingerprint = (def: ComponentDef) =>
  JSON.stringify([
    def.name,
    def.description,
    def.template,
    def.rawCss,
    def.css,
    def.head,
    def.props,
    def.slots,
    def.code,
    def.rev,
  ])

/** The props a re-import sends: the bundle's, plus the text-like props an earlier import inferred from the markup, which the bundle never named. */
function propsForUpdate(bundled: BundleComponent['props'], existing: readonly ComponentProp[]): ComponentProp[] {
  const named = new Set((bundled ?? []).map((prop) => prop.name))
  const inferred = existing.filter((prop) => !named.has(prop.name) && ['text', 'image', 'link'].includes(prop.type))
  return [...(bundled ?? []), ...inferred] as ComponentProp[]
}

/** The components a new main names in a <doop-use> that resolved to nothing. */
function missingNested(def: ComponentDef): string[] {
  if (!def.mainFrameId) return []
  const refs = actions
    .peekComponentIssues(def.mainFrameId)
    .filter((issue) => issue.code === 'unknown_component')
    .map((issue) => /“([^”]*)”/.exec(issue.message)?.[1] ?? '')
  return [...new Set(refs)]
}

type Outcome =
  { kind: 'created' | 'updated' | 'unchanged'; id: string; name: string } | { kind: 'skipped'; reason: string }

function writeOne(
  ctx: ImportContext,
  plan: Plan,
  where: { x: number; y: number } | undefined,
  pageId: string | null,
  issues: ImportIssue[],
  dryRun: boolean,
): Outcome {
  const { component, code, match } = plan
  const prepared = prepareComponent(component)
  for (const issue of prepared.issues) issues.push({ component: component.name, ...issue })
  if (match) {
    const before = fingerprint(match)
    const mark = savepoint()
    const result = updateComponent(
      ctx.canvasId,
      match.id,
      {
        description: component.description,
        props: propsForUpdate(prepared.props, match.props),
        code,
        html: prepared.html,
        css: prepared.css,
      },
      ctx.actor,
    )
    const same = fingerprint(result.component) === before
    if (same || dryRun) mark.undo()
    return { kind: same ? 'unchanged' : 'updated', id: match.id, name: match.name }
  }
  const taken = activeComponents(store.getComponents(ctx.canvasId)).some(
    (def) => def.name.toLowerCase() === component.name.replace(/["<>]/g, '').trim().toLowerCase(),
  )
  if (taken)
    return {
      kind: 'skipped',
      reason: `a component named “${component.name}” is already on this canvas and was not imported from ${code.origin?.kind ?? 'a bundle'}: rename one of them`,
    }
  if (dryRun) return { kind: 'created', id: '', name: component.name }
  const { component: def } = createComponentFromHtml(
    ctx.canvasId,
    {
      name: component.name,
      description: component.description,
      props: prepared.props as ComponentProp[] | undefined,
      code,
      html: prepared.html,
      css: prepared.css,
      width: MAIN_WIDTH,
      height: MAIN_HEIGHT,
      ...(where && pageId ? { place: { pageId, ...where } } : {}),
    },
    ctx.actor,
  )
  const missing = missingNested(def)
  if (missing.length)
    throw new ComponentError(
      `it nests ${missing.map((ref) => (ref ? `“${ref}”` : 'a <doop-use> that could not be read')).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not on this canvas`,
    )
  /* what the write had to say about the main (CSS it did not keep, ignored attributes) rides in the answer */
  if (def.mainFrameId)
    for (const issue of actions.takeComponentIssues(def.mainFrameId))
      issues.push({ component: component.name, code: issue.code, message: issue.message })
  return { kind: 'created', id: def.id, name: def.name }
}

function runUnit(
  ctx: ImportContext,
  plan: Plan,
  where: { x: number; y: number } | undefined,
  pageId: string | null,
  issues: ImportIssue[],
  dryRun: boolean,
): Outcome {
  const own: ImportIssue[] = []
  try {
    /* each entry is its own unit: a refused one leaves nothing behind and the rest go on */
    const outcome = transaction(() => writeOne(ctx, plan, where, pageId, own, dryRun))
    issues.push(...own)
    return outcome
  } catch (error) {
    if (!(error instanceof ComponentError)) throw error
    return { kind: 'skipped', reason: error.message }
  }
}

function emptyResult(): ImportResult {
  return {
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    tokens: { created: [], skipped: [] },
    pageId: null,
    issues: [],
  }
}

function record(result: ImportResult, plan: Plan, outcome: Outcome) {
  if (outcome.kind === 'skipped') result.skipped.push({ name: plan.component.name, reason: outcome.reason })
  else result[outcome.kind].push({ name: outcome.name, id: outcome.id })
}

const sourceLabel = (bundle: ComponentBundle): string => {
  if (bundle.source.name) return bundle.source.name
  if (bundle.source.url) {
    try {
      return new URL(bundle.source.url).host
    } catch {
      return bundle.source.url
    }
  }
  return bundle.source.kind
}

/**
 * Import a component bundle into a canvas. `dryRun` answers exactly what a real run would (what would be created, updated,
 * left alone or refused, which tokens) and writes nothing; the ids of components that would be created are empty.
 * Call it inside an operation (an MCP or REST handler), or give `ctx.batch` to run the writes in units of their own.
 */
export function importComponentBundle(
  ctx: ImportContext,
  raw: unknown,
  { dryRun = false }: { dryRun?: boolean } = {},
): ImportResult {
  const bundle = parseBundle(raw)
  if (!store.getCanvas(ctx.canvasId)) throw new ComponentError('canvas not found')
  const defs = activeComponents(store.getComponents(ctx.canvasId))
  const plans = planFor(bundle, defs)
  checkCapacity(plans, defs)

  const result = emptyResult()
  const issues: ImportIssue[] = []
  const claimed = new Set<string>()
  const runnable = plans.filter((plan) => {
    if (!plan.match) return true
    if (!claimed.has(plan.match.id)) return !!claimed.add(plan.match.id)
    result.skipped.push({
      name: plan.component.name,
      reason: `it maps to the same export as an earlier entry (“${plan.match.name}”)`,
    })
    return false
  })

  const writes = () => {
    const toCreate = runnable.filter((plan) => !plan.match)
    result.pageId = importPageId(ctx.canvasId, ctx.actor, !dryRun && toCreate.length > 0)
    result.tokens = importTokens(ctx.canvasId, tokenCandidates(bundle, issues), ctx.actor, dryRun)
    return toCreate
  }

  const finish = (): ImportResult => {
    result.issues = issues.slice(0, MAX_ISSUES)
    if (issues.length > MAX_ISSUES)
      result.issues.push({ code: 'more_issues', message: `${issues.length - MAX_ISSUES} more issues were left out` })
    return result
  }

  if (dryRun) {
    try {
      transaction(() => {
        writes()
        for (const plan of runnable) record(result, plan, runUnit(ctx, plan, undefined, result.pageId, issues, true))
        throw new DryRunDone(finish())
      })
    } catch (error) {
      if (error instanceof DryRunDone) return error.result
      throw error
    }
    return finish()
  }

  const batch = ctx.batch ?? (<T>(work: () => T): T => work())
  const toCreate = batch(writes)
  const spots = result.pageId ? batch(() => layout(ctx.canvasId, result.pageId!, toCreate)) : new Map()
  for (let start = 0; start < runnable.length; start += BATCH_SIZE) {
    const chunk = runnable.slice(start, start + BATCH_SIZE)
    const local = emptyResult()
    const found: ImportIssue[] = []
    try {
      batch(() => {
        for (const plan of chunk) record(local, plan, runUnit(ctx, plan, spots.get(plan), result.pageId, found, false))
      })
    } catch (error) {
      /* a spent work budget undoes this unit only: the rest of the import goes on in a fresh one */
      if (!(error instanceof WorkBudgetError) || !ctx.batch) throw error
      for (const plan of chunk)
        result.skipped.push({
          name: plan.component.name,
          reason:
            'the server ran out of working time for this part of the import: import it again, or in a smaller bundle',
        })
      continue
    }
    result.created.push(...local.created)
    result.updated.push(...local.updated)
    result.unchanged.push(...local.unchanged)
    result.skipped.push(...local.skipped)
    issues.push(...found)
  }

  const changed = result.created.length + result.updated.length
  if (changed)
    batch(() =>
      actions.logComponent(
        ctx.canvasId,
        ctx.actor,
        `imported ${changed} component${changed === 1 ? '' : 's'} from ${sourceLabel(bundle)}`,
      ),
    )
  return finish()
}
