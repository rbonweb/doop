import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { INSTANCE_ATTR } from '../shared/components.ts'
import {
  extractComponentCss,
  frameHeadTags,
  frameStylesheets,
  prepareSectionSheet,
  summarizeCss,
} from './componentCss.ts'

/**
 * A new document from sections of several frames (the core of `compose_frame`). Each section keeps the CSS it
 * needs, scoped to a `data-doop-section` attribute on its root so rules of different sources cannot collide;
 * what cannot be carried faithfully is reported, never guessed. Pure: no store, no I/O.
 */

export const SECTION_ATTR = 'data-doop-section'
export const COMPOSE_STYLE_ATTR = 'data-doop-compose'
export const COMPOSE_BASE_ATTR = 'data-doop-compose-base'

type Element = Tree.Element

export interface ComposeSource {
  frameId: string
  frameName: string
  /** the source frame's document as agents read it (compact form) */
  html: string
  /** `[start, end)` is the section's outer HTML in `html` */
  start: number
  end: number
}

export interface DroppedRule {
  selector: string
  reason: string
}

export interface ComposeSectionReport {
  frameId: string
  index: number
  scope: string
  carriedRules: number
  dropped: DroppedRule[]
  fonts: string[]
  keyframes: string[]
}

export interface ComposeResult {
  html: string
  sections: ComposeSectionReport[]
  headTags: string[]
  /** the frame whose `body`, `html`, `:root` and reset rules the document takes */
  documentRulesFrom?: string
}

export const sectionScopeId = (index: number, frameId: string) => `s${index}-${frameId}`.replace(/[^\w-]/g, '-')

/** The element whose start tag opens at `start`, found by source offset. */
function elementAt(html: string, start: number, end: number): Element {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const stack: Tree.ParentNode[] = [doc]
  for (let node = stack.pop(); node; node = stack.pop()) {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue
      const location = child.sourceCodeLocation
      if (location?.startTag?.startOffset === start && location.endOffset === end) return child
      stack.push(child)
    }
  }
  throw new Error(`compose: [${start}, ${end}) is not the outer HTML of one element`)
}

/** The section's markup with the scope attribute in its start tag, written by source offset so nothing else
 *  is re-serialized; an attribute of the same name left by an earlier compose is replaced. */
function stampSection(html: string, root: Element, scopeId: string): string {
  const tag = root.sourceCodeLocation?.startTag
  const location = root.sourceCodeLocation
  if (!tag || !location) throw new Error('compose: the section root has no source location')
  const attrs = Object.values(location.attrs ?? {})
  const insertAt = attrs.length ? Math.max(...attrs.map((a) => a.endOffset)) : tag.startOffset + 1 + root.tagName.length
  let open = `${html.slice(tag.startOffset, insertAt)} ${SECTION_ATTR}="${scopeId}"${html.slice(insertAt, tag.endOffset)}`
  const stale = location.attrs?.[SECTION_ATTR]
  if (stale) {
    const from = stale.startOffset - tag.startOffset
    const to = stale.endOffset - tag.startOffset
    open = open.slice(0, from).replace(/\s+$/, '') + open.slice(to)
  }
  return open + html.slice(tag.endOffset, location.endOffset)
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function composeDocument(sources: ComposeSource[], opts: { title?: string } = {}): ComposeResult {
  const headTags: string[] = []
  const styles: string[] = []
  const bodies: string[] = []
  const sections: ComposeSectionReport[] = []
  let base = ''
  let documentRulesFrom: string | undefined

  sources.forEach((source, index) => {
    const root = elementAt(source.html, source.start, source.end)
    const scopeId = sectionScopeId(index, source.frameId)
    const prepared = prepareSectionSheet(frameStylesheets(source.html), root, index === 0)
    if (index === 0 && prepared.base.trim()) {
      base = prepared.base
      documentRulesFrom = source.frameId
    }
    const css = extractComponentCss(prepared.sheet, root, scopeId).css.replaceAll(
      `[${INSTANCE_ATTR}="${scopeId}"]`,
      `[${SECTION_ATTR}="${scopeId}"]`,
    )
    const summary = summarizeCss(css)
    /* the one rule that only carries the root's custom and inherited properties is not a rule of the design */
    const rootSelector = `:where([${SECTION_ATTR}="${scopeId}"]) {`
    const rootRule = css.split('\n').some((line) => line.trimStart().startsWith(rootSelector)) ? 1 : 0
    if (css.trim()) styles.push(`<style ${COMPOSE_STYLE_ATTR}="${scopeId}">\n${css}\n</style>`)
    for (const tag of frameHeadTags(source.html)) if (!headTags.includes(tag)) headTags.push(tag)
    bodies.push(stampSection(source.html, root, scopeId))
    sections.push({
      frameId: source.frameId,
      index,
      scope: scopeId,
      carriedRules: summary.rules - rootRule,
      dropped: prepared.dropped,
      fonts: summary.fonts,
      keyframes: summary.keyframes,
    })
  })

  const head = [
    '<meta charset="utf-8">',
    ...(opts.title ? [`<title>${escapeText(opts.title)}</title>`] : []),
    ...headTags,
    ...(base.trim() ? [`<style ${COMPOSE_BASE_ATTR}>\n${base}\n</style>`] : []),
    ...styles,
  ]
  const html = `<!doctype html><html><head>${head.join('\n')}</head><body>\n${bodies.join('\n')}\n</body></html>`
  return { html, sections, headTags, ...(documentRulesFrom ? { documentRulesFrom } : {}) }
}
