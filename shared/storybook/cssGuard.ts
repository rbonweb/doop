/** Pure: no node or server imports, since the CLI bundles it. CSS that came out of a story page is text the page chose, so before it goes into a bundle it is cut into top-level rules and every rule must be one well-formed rule of a kind the capture emits: balanced, no top-level statements, no at-rule outside a short list, no `</style`, nothing that executes or fetches from anywhere but http(s). A rule that fails is dropped whole. The importer sanitizes again on its side; this is not the only guard, and it is not allowed to rely on the other. */

const ALLOWED_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'font-face',
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
])
const MAX_NESTING = 8
const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi
const FETCHABLE = /^(?:https?:\/\/|data:image\/|data:font\/|data:application\/(?:font|x-font)[\w.+-]*[;,])[^\\]*$/i

/** The top-level rules of `css`, and how many pieces were not rules. Strings are skipped over. A top-level statement (`@import x;`) is dropped; a stray brace, an unclosed string or an unfinished rule ends the reading, and the rest is dropped. */
export function splitRules(css: string): { rules: string[]; dropped: number } {
  const rules: string[] = []
  let dropped = 0
  let depth = 0
  let start = 0
  let i = 0
  while (i < css.length) {
    const ch = css[i]!
    /* CSSOM text never carries a comment, and a browser and this reader can disagree about where one ends (`url(a/*)`), so reading stops at the first */
    if (ch === '/' && css[i + 1] === '*') return { rules, dropped: dropped + 1 }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      for (; j < css.length && css[j] !== ch && css[j] !== '\n'; j++) if (css[j] === '\\') j++
      if (css[j] !== ch) return { rules, dropped: dropped + 1 }
      i = j + 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '{') {
      if (++depth > MAX_NESTING) return { rules, dropped: dropped + 1 }
    } else if (ch === '}') {
      if (--depth < 0) return { rules, dropped: dropped + 1 }
      if (depth === 0) {
        rules.push(css.slice(start, i + 1).trim())
        start = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      dropped++
      start = i + 1
    }
    i++
  }
  /* whatever is left is an unfinished rule or stray text */
  if (css.slice(start).trim()) dropped++
  return { rules: rules.filter(Boolean), dropped }
}

/** Every `@name` outside strings in a rule, lowercased. */
function atNames(rule: string): string[] {
  const names: string[] = []
  const bare = rule.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
  for (const match of bare.matchAll(/@([\w-]*)/g)) names.push((match[1] ?? '').toLowerCase())
  return names
}

/** Whether one top-level rule may go into a bundle. */
export function ruleIsSafe(rule: string): boolean {
  if (rule.length > 20_000 * 20) return false
  if (rule.includes('/*') || /<\/|<!--|-->|<\s*script/i.test(rule)) return false
  if (atNames(rule).some((name) => !ALLOWED_AT_RULES.has(name))) return false
  const plain = rule
  if (
    /expression\s*\(|javascript:|vbscript:|behaviou?r\s*:|-moz-binding|image-set\s*\(|(?<![\w-])src\s*\(/i.test(plain)
  )
    return false
  for (const token of plain.matchAll(URL_TOKEN)) {
    const target = token[1] ?? token[2] ?? token[3] ?? ''
    if (!FETCHABLE.test(target)) return false
  }
  return !/url\s*\(/i.test(plain.replace(URL_TOKEN, 'url_'))
}

/** `css` with every piece that is not a safe, whole rule dropped. */
export function guardCss(css: string): { css: string; dropped: number } {
  const split = splitRules(css)
  const kept = split.rules.filter(ruleIsSafe)
  return { css: kept.join('\n'), dropped: split.dropped + split.rules.length - kept.length }
}
