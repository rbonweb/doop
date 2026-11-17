import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import ts from 'typescript'
import type { ExportFile } from '../server/reactExport/index.ts'

const repo = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** A scratch directory the exported files are written to, with just enough node_modules for React and the typings. Never inside the repo. */
export interface Project {
  dir: string
  cleanup(): void
}

const LINKED = ['react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens', '@types']

export function writeProject(files: readonly ExportFile[], stubs: Record<string, string> = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), 'doop-react-export-'))
  for (const file of files) {
    const path = join(dir, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }
  const modules = join(dir, 'node_modules')
  mkdirSync(modules)
  for (const name of LINKED) symlinkSync(join(repo, 'node_modules', name), join(modules, name))
  for (const [path, content] of Object.entries(stubs)) {
    const target = join(modules, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** `tsc --noEmit` over every .ts and .tsx file of the project, strict, with the automatic JSX runtime. Returns the diagnostics as text. */
export function typecheck(project: Project): string[] {
  const roots: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name)) roots.push(path)
    }
  }
  walk(project.dir)
  const program = ts.createProgram(roots, {
    strict: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    isolatedModules: true,
  })
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file ? `${diagnostic.file.fileName.replace(project.dir, '')}: ` : ''
    return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  })
}

/** Bundles a generated entry that renders the named exports to static markup and returns what they rendered, keyed by the labels given. */
export async function renderAll(
  project: Project,
  renders: Record<string, { from: string; name: string; props?: Record<string, unknown> }>,
): Promise<Record<string, string>> {
  const imports = Object.values(renders).map(
    (r, index) => `import { ${r.name} as C${index} } from ${JSON.stringify(r.from)}`,
  )
  const body = Object.entries(renders).map(
    ([label, r], index) =>
      `  ${JSON.stringify(label)}: renderToStaticMarkup(createElement(C${index}, ${JSON.stringify(r.props ?? {})} as never)),`,
  )
  const entry = [
    "import { createElement } from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    ...imports,
    `export const out: Record<string, string> = {\n${body.join('\n')}\n}`,
  ].join('\n')
  writeFileSync(join(project.dir, 'entry.tsx'), entry)
  const result = await build({
    entryPoints: [join(project.dir, 'entry.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'css', '.module.css': 'local-css' },
    outdir: join(project.dir, 'out'),
    absWorkingDir: project.dir,
    logLevel: 'silent',
  })
  const code = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? ''
  const module = { exports: {} as { out?: Record<string, string> } }
  new Function('module', 'exports', 'require', code)(module, module.exports, require)
  return module.exports.out ?? {}
}

/** A DOM reduced to what the two renderers should agree on: tags, attributes sorted, text with whitespace collapsed. `class` and `data-doop-*` are left out (CSS Modules rename classes; Doop's markers are not exported). */
const canonicalStyle = (value: string): string =>
  value
    .split(';')
    .map((declaration) => declaration.replace(/\s*:\s*/, ':').trim())
    .filter(Boolean)
    .join(';')

export function normalize(html: string): string {
  const fragment = parseFragment(html)
  const out: string[] = []
  const visit = (nodes: Tree.ChildNode[]) => {
    for (const node of nodes) {
      if ('tagName' in node) {
        const attrs = node.attrs
          .filter((attr) => attr.name !== 'class' && !attr.name.startsWith('data-doop-'))
          .map((attr) => `${attr.name}="${attr.name === 'style' ? canonicalStyle(attr.value) : attr.value}"`)
          .sort()
        out.push(`<${node.tagName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`)
        visit(node.childNodes)
        out.push(`</${node.tagName}>`)
      } else if (node.nodeName === '#text') {
        const text = (node as Tree.TextNode).value.replace(/\s+/g, ' ').trim()
        if (text) out.push(text)
      }
    }
  }
  visit(fragment.childNodes)
  return out.join('\n')
}
