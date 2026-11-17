import type { ComponentDef } from '../../shared/components.ts'
import { tokensCss, tokensDtcg, tokensTailwind, type DesignToken } from '../../shared/designTokens.ts'
import { usedComponentIds } from '../componentEngine.ts'
import { ExportSession, emitComponent, type ComponentFiles } from './componentToReact.ts'
import { emitPage } from './pageToReact.ts'
import { fontsCss } from './fonts.ts'
import { jsString } from './issues.ts'
import { NameAllocator, componentName, fileBase } from './names.ts'
import { emptyReport, sortReport, type ExportReport, type ReactStyling } from './report.ts'
import { makeUrlRewriter } from './urls.ts'

export type { ExportReport, ReactStyling } from './report.ts'

export interface ReactExportInput {
  canvasName: string
  /** every active component of the canvas (soft-deleted ones excluded by the caller); the export emits the ones reachable from `frames` and `componentIds` */
  components: readonly ComponentDef[]
  /** frames to export as pages, stored HTML (full documents); may be empty */
  frames: readonly { id: string; name: string; html: string }[]
  /** components to export even when no exported frame uses them */
  componentIds?: readonly string[]
  tokens: readonly DesignToken[]
  themeOrder: readonly string[]
  styling: ReactStyling
  /** emit src/tokens.css and src/tokens.json (default true) */
  includeTokens?: boolean
  /** absolute origin root-relative Doop asset URLs are rewritten to, e.g. https://doop.design */
  assetOrigin: string
}

export interface ExportFile {
  path: string
  content: string
}

export interface ReactExportResult {
  files: ExportFile[]
  report: ExportReport
}

/** The one place a styling mode is checked: both modes are built. */
function stylingStrategy(styling: ReactStyling): ReactStyling {
  if (styling !== 'modules' && styling !== 'tailwind') throw new Error('styling must be "modules" or "tailwind"')
  return styling
}

/** Tailwind without Preflight: frames are designed under the browser's own defaults, so the reset would change how they look. */
const TAILWIND_IMPORTS =
  '@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);'

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const CX_TS = `export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}
`

const CSS_MODULES_D_TS = `declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.css'
`

function customElementsDts(tags: readonly string[]): string {
  const lines = [
    "import type { DetailedHTMLProps, HTMLAttributes } from 'react'",
    '',
    'type CustomElement = DetailedHTMLProps<HTMLAttributes<HTMLElement> & { class?: string }, HTMLElement> & Record<string, unknown>',
    '',
    "declare module 'react' {",
    '  namespace JSX {',
    '    interface IntrinsicElements {',
    ...tags.map((tag) => `      ${jsString(tag)}: CustomElement`),
    '    }',
    '  }',
    '}',
  ]
  return `${lines.join('\n')}\n`
}

function readme(styling: ReactStyling, hasTokens: boolean, hasFonts: boolean): string {
  const tailwind = styling === 'tailwind'
  return [
    '# Doop export',
    '',
    'React components and pages exported from a Doop canvas.',
    '',
    tailwind
      ? '- `src/components/` has one `.tsx` per component, styled with Tailwind utility classes. A `.module.css` sits beside a component only when some of its CSS (keyframes, complex selectors, `url()` images) has no utility. Components the canvas maps to your own package are imported from it and have no file here.'
      : '- `src/components/` has one `.tsx` per component and its `.module.css`. Components the canvas maps to your own package are imported from it and have no file here.',
    tailwind
      ? '- `src/pages/` has one `.tsx` per exported frame, and a `.css` only for rules that have no utility. A page `.css` is global and scoped by the page root class.'
      : '- `src/pages/` has one `.tsx` and `.css` per exported frame. The page `.css` is global and scoped by the page root class.',
    hasTokens
      ? tailwind
        ? "- `src/tokens.css` imports Tailwind's theme and utilities (no Preflight reset: the canvas was designed under browser defaults), then holds the canvas tokens as a Tailwind `@theme` block and as CSS custom properties. `src/tokens.json` has the same tokens as W3C design tokens."
        : '- `src/tokens.css` holds the canvas design tokens as CSS custom properties (import it once in your app) and `src/tokens.json` the same tokens as W3C design tokens.'
      : '- Design tokens were not exported.',
    ...(hasFonts
      ? [
          '- `src/fonts.css` imports the hosted Google Fonts stylesheets the canvas uses; the pages and components that need them import it.',
        ]
      : []),
    '- `src/cx.ts` joins class names, `src/css-modules.d.ts` types CSS Modules imports.',
    '- Dark themes: a page stands for the canvas `<body>`, and the canvas switches theme with `data-doop-theme="dark"` on `<html>`. Put that attribute on your app\'s `<html>` element to turn the dark rules on; they are kept as `html[data-doop-theme=dark] .page-… .x`.',
    '- `export-report.json` lists everything the export dropped or changed, and the instances whose markup was inlined.',
    '',
    ...(tailwind
      ? [
          '## Adding it to a Tailwind v4 app',
          '',
          '1. Copy `src` into your app. Tailwind v4 needs `tailwindcss` and its Vite plugin (`@tailwindcss/vite`) or PostCSS plugin (`@tailwindcss/postcss`) installed.',
          hasTokens
            ? '2. Import `src/tokens.css` once from your entry (`import "./tokens.css"`) in place of your own `@import "tailwindcss";`. If you already have a Tailwind stylesheet, copy the `@theme` block and the `:root` block from `src/tokens.css` into it instead. To add Preflight back (a reset that restyles headings, lists, images and buttons), add `@import "tailwindcss/preflight.css" layer(base);` after the theme import.'
            : '2. Import your Tailwind stylesheet (`@import "tailwindcss";`) once from your entry.',
          '3. The Vite plugin scans your source files for classes by itself. With the Tailwind CLI or PostCSS add `@source "./src";` to that stylesheet so the `.tsx` files are scanned.',
          '',
        ]
      : []),
    `Styling: ${tailwind ? 'Tailwind v4' : 'CSS Modules'}. The code is generated and deterministic: exporting the same canvas again gives the same files.`,
    '',
  ].join('\n')
}

/** Every component reachable from the seeds: through frames' instances, nested uses and instance-prop defaults and values. */
function closureOf(
  session: ExportSession,
  seeds: Iterable<ComponentDef>,
  frames: readonly { html: string }[],
): ComponentDef[] {
  const seen = new Map<string, ComponentDef>()
  const queue: ComponentDef[] = []
  const add = (def: ComponentDef | undefined) => {
    if (def && !seen.has(def.id)) {
      seen.set(def.id, def)
      queue.push(def)
    }
  }
  for (const def of seeds) add(def)
  for (const frame of frames) {
    for (const id of [...usedComponentIds(frame.html)].sort()) add(session.find(id))
    for (const match of frame.html.matchAll(/\scomponent="([^"]+)"/g)) add(session.find(match[1] ?? ''))
    for (const match of frame.html.matchAll(/\sdata-doop-props="([^"]*)"/g)) {
      for (const value of propValues(match[1] ?? '')) add(session.find(value))
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const def = queue[i]
    if (!def) continue
    for (const match of def.template.matchAll(/\scomponent="([^"]+)"/g)) add(session.find(match[1] ?? ''))
    for (const prop of def.props) if (prop.type === 'instance' && prop.default) add(session.find(prop.default))
  }
  return [...seen.values()]
}

function propValues(attr: string): string[] {
  try {
    const json: unknown = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    return json && typeof json === 'object'
      ? Object.values(json).filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

interface Built {
  session: ExportSession
  report: ExportReport
  components: { files: ComponentFiles; planId: string }[]
  pages: { path: string; cssPath: string; tsx: string; css: string }[]
  componentFiles: Map<string, ComponentFiles>
}

function run(input: ReactExportInput, seedIds: readonly string[]): Built {
  stylingStrategy(input.styling)
  const urls = makeUrlRewriter(input.assetOrigin)
  const sorted = [...input.components].sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id))
  const session = new ExportSession({ components: sorted, urls, styling: input.styling })
  const report = emptyReport(input.styling)

  const seeds = seedIds
    .map((id) => sorted.find((def) => def.id === id))
    .filter((def): def is ComponentDef => def !== undefined)
  for (const def of closureOf(session, seeds, input.frames)) session.plan(def)

  const pageNames = new NameAllocator({ caseInsensitive: true })
  const pages: Built['pages'] = []
  for (const frame of input.frames) {
    const base = fileBase(frame.name, pageNames)
    const fn = componentName(frame.name, session.names)
    const page = emitPage(session, frame, base, fn)
    const path = `src/pages/${base}.tsx`
    pages.push({ path, cssPath: `src/pages/${base}.css`, tsx: page.tsx, css: page.css })
    report.pages.push({ frameId: frame.id, name: frame.name, file: path })
    for (const issue of page.fc.issues) report.issues.push({ ...issue, file: path })
    for (const line of page.fc.inlined) report.inlined.push({ file: path, ...line })
  }

  const componentFiles = new Map<string, ComponentFiles>()
  const components: Built['components'] = []
  for (let i = 0; i < session.order.length; i++) {
    const plan = session.order[i]
    if (!plan) continue
    if (plan.mapped) {
      report.components.push({
        id: plan.def.id,
        name: plan.def.name,
        importedFrom: plan.mapped.importFrom,
        exportName: plan.mapped.exportName,
      })
      continue
    }
    const files = emitComponent(session, plan)
    componentFiles.set(plan.def.id, files)
    components.push({ files, planId: plan.def.id })
    const path = plan.file ?? ''
    report.components.push({ id: plan.def.id, name: plan.def.name, file: path })
    for (const issue of files.fc.issues) report.issues.push({ ...issue, file: path })
    for (const line of files.fc.inlined) report.inlined.push({ file: path, ...line })
  }
  return { session, report, components, pages, componentFiles }
}

/** The files of an export, and what it did. Deterministic: the same input gives byte-identical files in a fixed order. */
export function buildReactExport(input: ReactExportInput): ReactExportResult {
  const built = run(input, input.componentIds ?? [])
  const { session } = built
  const files: ExportFile[] = []
  const includeTokens = input.includeTokens !== false

  for (const plan of session.order) {
    const generated = built.componentFiles.get(plan.def.id)
    if (!generated || !plan.file) continue
    files.push({ path: plan.file, content: generated.tsx })
    if (generated.css) files.push({ path: `src/components/${plan.name}.module.css`, content: generated.css })
  }
  const exported = session.order.filter((plan) => plan.file).sort((a, b) => byText(a.name, b.name))
  files.push({
    path: 'src/components/index.ts',
    content: exported.length
      ? `${exported.map((plan) => `export { ${plan.name} } from './${plan.name}'\nexport type { ${plan.propsName} } from './${plan.name}'`).join('\n')}\n`
      : 'export {}\n',
  })
  for (const page of built.pages) {
    files.push({ path: page.path, content: page.tsx })
    if (page.css) files.push({ path: page.cssPath, content: page.css })
  }
  files.push({ path: 'src/cx.ts', content: CX_TS })
  files.push({ path: 'src/css-modules.d.ts', content: CSS_MODULES_D_TS })
  if (session.customElements.size) {
    files.push({ path: 'src/custom-elements.d.ts', content: customElementsDts([...session.customElements].sort()) })
  }
  if (includeTokens) {
    const tokens =
      input.styling === 'tailwind'
        ? [TAILWIND_IMPORTS, tokensTailwind(input.tokens, input.themeOrder), tokensCss(input.tokens, input.themeOrder)]
            .filter(Boolean)
            .join('\n\n')
        : tokensCss(input.tokens, input.themeOrder)
    files.push({ path: 'src/tokens.css', content: tokens.endsWith('\n') ? tokens : `${tokens}\n` })
    files.push({ path: 'src/tokens.json', content: tokensDtcg(input.tokens, input.themeOrder) })
  }
  if (session.fontLinks.size) files.push({ path: 'src/fonts.css', content: fontsCss(session.fontLinks) })
  files.push({ path: 'README.md', content: readme(input.styling, includeTokens, session.fontLinks.size > 0) })
  const report = sortReport(built.report)
  files.push({ path: 'export-report.json', content: `${JSON.stringify(report, null, 2)}\n` })
  files.sort((a, b) => byText(a.path, b.path))
  return { files, report }
}

/** "Copy as React": one component's own files (its `.tsx` and `.module.css`, plus `src/cx.ts` when it uses `cx`). Components it nests are imported from `./<Name>`, and a component mapped to a package has no files. */
export function componentReactFiles(input: ReactExportInput & { componentId: string }): ReactExportResult {
  const built = run({ ...input, frames: [] }, [input.componentId])
  const plan = built.session.order.find((candidate) => candidate.def.id === input.componentId)
  const files: ExportFile[] = []
  const report = emptyReport(input.styling)
  if (plan) {
    const generated = built.componentFiles.get(plan.def.id)
    if (generated && plan.file) {
      files.push({ path: plan.file, content: generated.tsx })
      if (generated.css) files.push({ path: `src/components/${plan.name}.module.css`, content: generated.css })
      if (generated.fc.usesCx) files.push({ path: 'src/cx.ts', content: CX_TS })
      report.components.push({ id: plan.def.id, name: plan.def.name, file: plan.file })
      for (const issue of generated.fc.issues) report.issues.push({ ...issue, file: plan.file })
      for (const line of generated.fc.inlined) report.inlined.push({ file: plan.file, ...line })
    } else if (plan.mapped) {
      report.components.push({
        id: plan.def.id,
        name: plan.def.name,
        importedFrom: plan.mapped.importFrom,
        exportName: plan.mapped.exportName,
      })
    }
  }
  files.sort((a, b) => byText(a.path, b.path))
  return { files, report: sortReport(report) }
}
