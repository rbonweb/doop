/* A small markdown reader for sticky notes. It produces a tree, never HTML:
   the note component maps the tree to React elements, so text a person or an
   agent wrote can only ever be text. Raw tags show as literal characters, and
   a link survives only when its scheme is on the short list below. */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'br' }
  | { t: 'link'; href: string; children: Inline[] }
  /** `goto:<frameId>`: flies the camera to that frame instead of navigating */
  | { t: 'goto'; frameId: string; children: Inline[] }

export interface ListItem {
  depth: number
  checked?: boolean
  children: Inline[]
}

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'code'; text: string }
  | { t: 'hr' }

const GOTO = /^goto:([A-Za-z0-9_-]{1,64})$/

/** The target of a link as the note will use it, or null when the scheme is
 *  not one a note may link to (javascript:, data:, file: and the rest). */
export function safeLink(url: string): { href: string } | { frameId: string } | null {
  const target = url.trim()
  const goto = GOTO.exec(target)
  if (goto) return { frameId: goto[1]! }
  if (/^(https?:\/\/|mailto:)[^\s]+$/i.test(target)) return { href: target }
  return null
}

const INLINE_RULES: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
  { re: /`([^`\n]+)`/y, make: (m) => ({ t: 'code', text: m[1]! }) },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/y,
    make: (m) => {
      const children = parseInline(m[1]!)
      const link = safeLink(m[2]!)
      if (!link) return { t: 'text', text: m[0] }
      return 'frameId' in link
        ? { t: 'goto', frameId: link.frameId, children }
        : { t: 'link', href: link.href, children }
    },
  },
  { re: /\*\*(?=\S)([^\n]+?)\*\*/y, make: (m) => ({ t: 'strong', children: parseInline(m[1]!) }) },
  { re: /__(?=\S)([^\n]+?)__/y, make: (m) => ({ t: 'strong', children: parseInline(m[1]!) }) },
  { re: /~~(?=\S)([^\n]+?)~~/y, make: (m) => ({ t: 'del', children: parseInline(m[1]!) }) },
  { re: /\*(?=[^\s*])([^\n*]+?)\*/y, make: (m) => ({ t: 'em', children: parseInline(m[1]!) }) },
  { re: /_(?=[^\s_])([^\n_]+?)_(?![A-Za-z0-9])/y, make: (m) => ({ t: 'em', children: parseInline(m[1]!) }) },
  {
    re: /https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"]/y,
    make: (m) => ({ t: 'link', href: m[0], children: [{ t: 'text', text: m[0] }] }),
  },
]

/** Markers that can open an inline span; everything between them is text. */
const OPENERS = /[`[*_~h]/g

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', text })
    text = ''
  }
  let i = 0
  while (i < source.length) {
    OPENERS.lastIndex = i
    const next = OPENERS.exec(source)
    const at = next ? next.index : source.length
    text += source.slice(i, at)
    i = at
    if (i >= source.length) break
    /* a word-internal underscore (snake_case) is not emphasis, nor is an `h`
       that does not start a URL; both fall through as plain text */
    const before = source[i - 1] ?? ''
    let hit: { node: Inline; end: number } | null = null
    if (!(source[i] === '_' && /[A-Za-z0-9]/.test(before))) {
      for (const rule of INLINE_RULES) {
        rule.re.lastIndex = i
        const m = rule.re.exec(source)
        if (m) {
          hit = { node: rule.make(m), end: i + m[0].length }
          break
        }
      }
    }
    if (hit) {
      flush()
      out.push(hit.node)
      i = hit.end
    } else {
      text += source[i]
      i += 1
    }
  }
  flush()
  return out
}

/** Soft line breaks inside a paragraph stay visible: a note is closer to a
 *  scribble than to a document. */
function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = []
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' })
    out.push(...parseInline(line.trim()))
  })
  return out
}

const FENCE = /^\s{0,3}```/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i += 1
      continue
    }
    if (FENCE.test(line)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!)
      i += 1 /* the closing fence; an unclosed one runs to the end */
      blocks.push({ t: 'code', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        t: 'heading',
        level: Math.min(3, heading[1]!.length) as 1 | 2 | 3,
        children: parseInline(heading[2]!),
      })
      i += 1
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!)
      blocks.push({ t: 'quote', blocks: parseMarkdown(inner.join('\n')) })
      continue
    }
    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = []
      const ordered = /^\s*\d/.test(line)
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        const m = LIST_ITEM.exec(lines[i++]!)!
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!)
        items.push({
          depth: Math.min(3, Math.floor(m[1]!.replace(/\t/g, '  ').length / 2)),
          ...(task ? { checked: task[1] !== ' ' } : {}),
          children: parseInline(task ? task[2]! : m[3]!),
        })
      }
      blocks.push({ t: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !FENCE.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !HR.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!)
    )
      para.push(lines[i++]!)
    blocks.push({ t: 'paragraph', children: inlineLines(para) })
  }
  return blocks
}
