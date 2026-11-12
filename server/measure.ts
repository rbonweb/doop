import type { Frame } from '../shared/types.ts'
import type { FrameMeasurement, MeasureOptions } from './measureTypes.ts'
import type { FrameTarget } from './renderTypes.ts'
import { assertTargetsMatch } from './renderTargets.ts'
import { loadFramePage } from './screenshot.ts'
import { resolveFrameTargets } from './targetResolution.ts'

/** One target as the page sees it: a CSS selector, or a `data-doop-label` (outline and heading labels are resolved on the server first). */
interface PageTarget {
  kind: 'selector' | 'label'
  value: string
}

interface PageInput {
  targets: PageTarget[]
  lineQueries: string[]
}

/** What the one in-page pass returns: everything but the viewport width, which the caller knows. */
interface PageMeasurement {
  height: number
  sections: FrameMeasurement['sections']
  colors: string[]
  text: string
  queries: FrameMeasurement['queries']
}

function attrSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

function pageTargets(targets: FrameTarget[] | undefined): PageTarget[] {
  const out: PageTarget[] = []
  for (const target of targets ?? []) {
    if ('element_id' in target) out.push({ kind: 'selector', value: attrSelector('data-doop-id', target.element_id) })
    else if ('selector' in target) out.push({ kind: 'selector', value: target.selector })
    else out.push({ kind: 'label', value: target.label })
  }
  return out
}

/** Measure a frame's layout in headless Chrome: its sections, text blocks, colours and line counts. */
export async function measureFrame(input: Frame, opts?: MeasureOptions): Promise<FrameMeasurement> {
  const { frame, targets } = await resolveFrameTargets(input, opts?.targets ?? [], { stampAs: opts?.stampAs })
  const width = Math.max(1, Math.round(opts?.width ?? frame.width))
  const loaded = await loadFramePage(frame, {
    width,
    height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
    deviceScaleFactor: 1,
  })
  const { page } = loaded
  try {
    /* tsx annotates nested functions with __name, which the page does not have; see inspectFrame */
    await page.evaluate('globalThis.__name = (target) => target')
    await assertTargetsMatch(page, targets)
    const measured = await page.evaluate(
      (input: PageInput): PageMeasurement => {
        interface Rgba {
          r: number
          g: number
          b: number
          a: number
        }

        const SKIPPED = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template'])

        /* ---- colour maths (WCAG 2.x, inlined: server/colorMath.ts is for Node) ---- */

        const parseColor = (value: string): Rgba | null => {
          const match = /^rgba?\(([^)]*)\)$/.exec(value.trim())
          if (!match || !match[1]) return null
          const [r = 0, g = 0, b = 0, a = 1] = match[1].split(',').map((part) => Number.parseFloat(part))
          if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
          return { r, g, b, a: Number.isFinite(a) ? a : 1 }
        }

        const channel = (n: number): string =>
          Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0')

        const rgbHex = (color: Rgba): string => `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`

        const rgbaHex = (color: Rgba): string =>
          color.a < 1 ? `${rgbHex(color)}${channel(color.a * 255)}` : rgbHex(color)

        const linear = (value: number): number => {
          const c = value / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        }

        const luminance = (color: Rgba): number =>
          0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)

        const over = (fg: Rgba, bg: Rgba): Rgba => ({
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        })

        const contrastRatio = (fg: Rgba, bg: Rgba): number => {
          const a = luminance(fg)
          const b = luminance(bg)
          return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
        }

        /* ---- selectors and visibility ---- */

        const attr = (name: string, value: string): string =>
          `[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`

        const pathSelector = (start: Element): string => {
          const parts: string[] = []
          let node: Element | null = start
          while (node && node !== document.body && node !== document.documentElement) {
            const parent: Element | null = node.parentElement
            if (!parent) break
            parts.unshift(`:nth-child(${Array.from(parent.children).indexOf(node) + 1})`)
            node = parent
          }
          return ['body', ...parts].join(' > ')
        }

        const selectorOf = (el: Element): string => {
          const id = el.getAttribute('data-doop-id')
          return id === null ? pathSelector(el) : attr('data-doop-id', id)
        }

        const isVisible = (el: Element): boolean =>
          el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'

        const hasOwnText = (el: Element): boolean =>
          Array.from(el.childNodes).some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          )

        const lineCount = (el: Element): number => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = Array.from(range.getClientRects())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .sort((a, b) => a.top - b.top)
          let groups = 0
          let lastTop = Number.NEGATIVE_INFINITY
          for (const rect of rects) {
            const top = Math.round(rect.top)
            if (groups === 0 || top - lastTop > 2) {
              groups += 1
              lastTop = top
            }
          }
          return groups
        }

        /* ---- overflow ---- */

        const spills = (el: Element): boolean =>
          el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1

        const extendsPast = (rect: DOMRect, box: DOMRect, axis: 'x' | 'y'): boolean =>
          axis === 'x'
            ? rect.left < box.left - 0.5 || rect.right > box.right + 0.5
            : rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5

        const ancestorClips = (el: Element): boolean => {
          const rect = el.getBoundingClientRect()
          for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node)
            const box = node.getBoundingClientRect()
            if (style.overflowX !== 'visible' && extendsPast(rect, box, 'x')) return true
            if (style.overflowY !== 'visible' && extendsPast(rect, box, 'y')) return true
          }
          return false
        }

        const overflowState = (el: Element, style: CSSStyleDeclaration): { overflow: boolean; clipped: boolean } => {
          const clipped = ancestorClips(el)
          if (!spills(el)) return { overflow: false, clipped }
          if (style.overflowX === 'visible' && style.overflowY === 'visible') return { overflow: true, clipped }
          return { overflow: false, clipped: true }
        }

        /* ---- backgrounds ---- */

        const backgroundOf = (el: Element): Rgba | null => {
          const chain: Element[] = []
          for (let node: Element | null = el; node; node = node.parentElement) {
            chain.push(node)
            if (node === document.documentElement) break
          }
          for (const node of chain) {
            const style = getComputedStyle(node)
            if (style.backgroundImage !== 'none') return null
            const color = parseColor(style.backgroundColor)
            if (color && color.a >= 1) break
          }
          let acc: Rgba = { r: 255, g: 255, b: 255, a: 1 }
          for (let i = chain.length - 1; i >= 0; i--) {
            const style = getComputedStyle(chain[i]!)
            const layer = parseColor(style.backgroundColor)
            if (layer && layer.a > 0) acc = over(layer, acc)
          }
          return acc
        }

        /* ---- text blocks ---- */

        const textBlock = (el: Element) => {
          const style = getComputedStyle(el)
          const font = Number.parseFloat(style.fontSize) || 16
          const rawLineHeight = Number.parseFloat(style.lineHeight)
          const parsedWeight = Number.parseInt(style.fontWeight, 10)
          const weight = Number.isFinite(parsedWeight) ? parsedWeight : style.fontWeight === 'bold' ? 700 : 400
          const fg = parseColor(style.color) ?? { r: 0, g: 0, b: 0, a: 1 }
          const bg = backgroundOf(el)
          const state = overflowState(el, style)
          const text = ((el instanceof HTMLElement ? el.innerText : el.textContent) ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
          return {
            element_id: el.getAttribute('data-doop-id'),
            selector: selectorOf(el),
            tag: el.tagName.toLowerCase(),
            text,
            lines: lineCount(el),
            font_size: Math.round(font * 100) / 100,
            line_height: Math.round((Number.isFinite(rawLineHeight) ? rawLineHeight : font * 1.2) * 100) / 100,
            overflow: state.overflow,
            clipped: state.clipped,
            color: rgbaHex(fg),
            background: bg ? rgbHex(bg) : null,
            contrast: bg ? contrastRatio(fg.a < 1 ? over(fg, bg) : fg, bg) : null,
            large: font >= 24 || (font >= 18.66 && weight >= 700),
          }
        }

        /* ---- sections ---- */

        const palette = (section: Element): string[] => {
          const seen = new Set<string>()
          const add = (value: string): void => {
            const color = parseColor(value)
            if (!color || color.a <= 0) return
            seen.add(rgbHex(color))
          }
          const borders = [
            ['borderTopWidth', 'borderTopColor'],
            ['borderRightWidth', 'borderRightColor'],
            ['borderBottomWidth', 'borderBottomColor'],
            ['borderLeftWidth', 'borderLeftColor'],
          ] as const
          for (const el of [section, ...Array.from(section.querySelectorAll('*'))]) {
            const style = getComputedStyle(el)
            if (hasOwnText(el)) add(style.color)
            add(style.backgroundColor)
            for (const [width, color] of borders) {
              if ((Number.parseFloat(style[width]) || 0) > 0) add(style[color])
            }
          }
          return [...seen]
        }

        const measureSection = (el: Element) => {
          const style = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          const state = overflowState(el, style)
          const texts: ReturnType<typeof textBlock>[] = []
          if (isVisible(el) && hasOwnText(el)) texts.push(textBlock(el))
          for (const child of Array.from(el.querySelectorAll('*'))) {
            if (texts.length >= 60) break
            if (!hasOwnText(child) || !isVisible(child)) continue
            texts.push(textBlock(child))
          }
          const label = el.getAttribute('data-doop-label')
          const heading = el.querySelector('h1, h2, h3')
          const headingText = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim()
          return {
            element_id: el.getAttribute('data-doop-id'),
            label: label !== null ? label : headingText || null,
            selector: selectorOf(el),
            tag: el.tagName.toLowerCase(),
            box: {
              x: Math.round(rect.left + scrollX),
              y: Math.round(rect.top + scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            overflow: state.overflow,
            clipped: state.clipped,
            colors: palette(el),
            texts,
          }
        }

        const topLevel = (): Element[] => {
          const body = document.body
          if (!body) return []
          let container: Element = body
          const mains = Array.from(body.querySelectorAll('main'))
          if (mains.length === 1 && mains[0]) container = mains[0]
          else {
            const children = Array.from(body.children)
            const only = children.length === 1 ? children[0] : undefined
            if (only && only.tagName.toLowerCase() === 'div') container = only
          }
          return Array.from(container.children).filter(
            (el) => !SKIPPED.has(el.tagName.toLowerCase()) && el.getBoundingClientRect().height > 0,
          )
        }

        const sections = topLevel()
        const firstMatch = (selector: string): Element | null => {
          try {
            return document.querySelector(selector)
          } catch {
            return null
          }
        }

        const chosen = (): Element[] => {
          if (input.targets.length === 0) return sections
          const found: Element[] = []
          for (const target of input.targets) {
            if (target.kind === 'selector') {
              const el = firstMatch(target.value)
              if (el) found.push(el)
              continue
            }
            const labelled = firstMatch(attr('data-doop-label', target.value))
            if (labelled) found.push(labelled)
          }
          return found
        }

        const measuredSections = chosen().map(measureSection)
        const colors = [...new Set(measuredSections.flatMap((section) => section.colors))]
        const queries = input.lineQueries.map((selector) => {
          let matches: Element[] = []
          try {
            matches = Array.from(document.querySelectorAll(selector))
          } catch {
            matches = []
          }
          return {
            selector,
            matches: matches.map((el) => ({
              element_id: el.getAttribute('data-doop-id'),
              selector: selectorOf(el),
              lines: lineCount(el),
            })),
          }
        })

        return {
          height: document.documentElement.scrollHeight,
          sections: measuredSections,
          colors,
          text: (document.body?.innerText ?? '').slice(0, 200_000),
          queries,
        }
      },
      { targets: pageTargets(targets), lineQueries: opts?.lineQueries ?? [] },
    )

    return {
      width,
      height: measured.height,
      sections: measured.sections,
      colors: measured.colors,
      text: measured.text,
      queries: measured.queries,
    }
  } finally {
    await loaded.close()
  }
}
