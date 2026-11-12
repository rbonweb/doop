import { describe, expect, it } from 'vitest'
import { lintMeasurement } from '../server/lint.ts'
import type { FrameMeasurement, LintRules, MeasuredSection, TextBlock } from '../server/measureTypes.ts'

function text(over: Partial<TextBlock> = {}): TextBlock {
  return {
    element_id: '#body-copy',
    selector: 'section:nth-of-type(2) p:nth-of-type(1)',
    tag: 'p',
    text: 'A line of body copy',
    lines: 2,
    font_size: 16,
    line_height: 24,
    overflow: false,
    clipped: false,
    color: '#111111',
    background: '#ffffff',
    contrast: 12.63,
    large: false,
    ...over,
  }
}

function section(over: Partial<MeasuredSection> = {}): MeasuredSection {
  return {
    element_id: '#hero',
    label: 'Hero',
    selector: 'section:nth-of-type(1)',
    tag: 'section',
    box: { x: 0, y: 0, width: 1200, height: 800 },
    overflow: false,
    clipped: false,
    colors: ['#ffffff', '#111111'],
    texts: [],
    ...over,
  }
}

function measurement(over: Partial<FrameMeasurement> = {}): FrameMeasurement {
  const sections: MeasuredSection[] = [
    section({
      element_id: '#hero',
      texts: [text({ element_id: '#hero-title', tag: 'h1', text: 'Build faster.', lines: 2, large: true })],
    }),
    section({
      element_id: '#features',
      label: 'Features',
      selector: 'section:nth-of-type(2)',
      box: { x: 0, y: 800, width: 1200, height: 1200 },
      texts: [text(), text({ element_id: '#feature-note', text: 'Note', lines: 1, contrast: null })],
    }),
    section({
      element_id: '#footer',
      label: 'Footer',
      selector: 'section:nth-of-type(3)',
      box: { x: 0, y: 2000, width: 1200, height: 400 },
      texts: [text({ element_id: '#footer-note', text: 'Small print', lines: 1, contrast: 4.9 })],
    }),
  ]
  return {
    width: 1200,
    height: 2400,
    sections,
    colors: ['#ffffff', '#111111', '#e5e7eb'],
    text: 'Build faster. Ship with confidence. We scale teams.',
    queries: [],
    ...over,
  }
}

const rules = (over: LintRules): LintRules => over

describe('max_section_height', () => {
  it('passes when every section fits', () => {
    const report = lintMeasurement(measurement(), rules({ max_section_height: 1200 }))
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ rule: 'max_section_height', pass: true, offenders: [], details: [] })
    expect(report.pass).toBe(true)
  })

  it('names each tall section with its height', () => {
    const report = lintMeasurement(measurement(), rules({ max_section_height: 900 }))
    const result = report.results[0]
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#features'])
    expect(result?.details).toEqual(['#features is 1200px tall (max 900)'])
    expect(report.pass).toBe(false)
  })

  it('rounds the height and falls back to the selector without an element id', () => {
    const m = measurement({
      sections: [section({ element_id: null, box: { x: 0, y: 0, width: 1200, height: 901.4 } })],
    })
    const result = lintMeasurement(m, rules({ max_section_height: 900 })).results[0]
    expect(result?.offenders).toEqual(['section:nth-of-type(1)'])
    expect(result?.details).toEqual(['section:nth-of-type(1) is 901px tall (max 900)'])
  })
})

describe('max_heading_lines', () => {
  it('passes when headings stay within the line limit', () => {
    const report = lintMeasurement(measurement(), rules({ max_heading_lines: 2 }))
    expect(report.results[0]).toMatchObject({ rule: 'max_heading_lines', pass: true })
  })

  it('flags a long heading and quotes the first 40 characters', () => {
    const longText = 'A headline that is far too long for its column, wrapped'
    const m = measurement({
      sections: [
        section({
          texts: [text({ element_id: '#hero-title', tag: 'h1', text: longText, lines: 4 })],
        }),
      ],
    })
    const result = lintMeasurement(m, rules({ max_heading_lines: 2 })).results[0]
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#hero-title'])
    expect(result?.details).toEqual([`#hero-title "${longText.slice(0, 40)}" runs 4 lines (max 2)`])
  })

  it('ignores non-heading tags', () => {
    const m = measurement({
      sections: [section({ texts: [text({ tag: 'div', lines: 9 }), text({ tag: 'h2', lines: 1 })] })],
    })
    expect(lintMeasurement(m, rules({ max_heading_lines: 2 })).results[0]?.pass).toBe(true)
  })
})

describe('max_text_lines', () => {
  const query = {
    selector: '.card p',
    matches: [{ element_id: null, selector: '.card p:nth-of-type(1)', lines: 4 }],
  }

  it('passes when every match fits', () => {
    const m = measurement({ queries: [{ ...query, matches: [{ element_id: '#card', selector: '.card', lines: 2 }] }] })
    const report = lintMeasurement(m, rules({ max_text_lines: [{ selector: '.card p', max: 3 }] }))
    expect(report.results[0]).toMatchObject({ rule: 'max_text_lines', pass: true, offenders: [] })
  })

  it('flags every match over the limit, by id or selector', () => {
    const m = measurement({
      queries: [
        {
          selector: '.card p',
          matches: [
            { element_id: '#card-a', selector: '.card-a p', lines: 5 },
            { element_id: null, selector: '.card-b p', lines: 4 },
          ],
        },
      ],
    })
    const result = lintMeasurement(m, rules({ max_text_lines: [{ selector: '.card p', max: 3 }] })).results[0]
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#card-a', '.card-b p'])
    expect(result?.details).toEqual(['#card-a runs 5 lines (max 3)', '.card-b p runs 4 lines (max 3)'])
  })

  it('fails with a note when a selector matches nothing', () => {
    const m = measurement({ queries: [{ selector: '.card p', matches: [] }] })
    const result = lintMeasurement(m, rules({ max_text_lines: [{ selector: '.card p', max: 3 }] })).results[0]
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual([])
    expect(result?.details).toEqual(['.card p matches nothing'])
  })

  it('fails with a note when the measurement has no entry for the selector', () => {
    const result = lintMeasurement(measurement(), rules({ max_text_lines: [{ selector: '.ghost', max: 1 }] }))
      .results[0]
    expect(result).toMatchObject({ pass: false, offenders: [], details: ['.ghost matches nothing'] })
  })
})

describe('allowed_colors', () => {
  it('passes when every document colour is in the palette, ignoring case and alpha', () => {
    const m = measurement({ colors: ['#ffffff', '#111111'] })
    const report = lintMeasurement(m, rules({ allowed_colors: ['#FFFFFF', 'rgba(17, 17, 17, 1)'] }))
    expect(report.results[0]).toMatchObject({ rule: 'allowed_colors', pass: true })
    expect(report.pass).toBe(true)
  })

  it('flags an off-palette colour and names the sections using it', () => {
    const m = measurement({
      colors: ['#111111', '#ff0000'],
      sections: [
        section({ element_id: '#cta', colors: ['#ff0000'] }),
        section({ element_id: '#footer', colors: ['#ff0000', '#111111'] }),
      ],
    })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#111111'] })).results[0]
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#ff0000'])
    expect(result?.details).toEqual(['#ff0000 is not in the palette (used in #cta, #footer)'])
  })

  it('compares on #rrggbb, dropping alpha from both sides', () => {
    const m = measurement({ colors: ['#111111cc'] })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#111111'] })).results[0]
    expect(result?.offenders).toEqual([])
    expect(result?.pass).toBe(true)
  })

  it('lists unreadable palette entries without failing on them alone', () => {
    const m = measurement({ colors: ['#111111'] })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#111111', 'brand-teal'] })).results[0]
    expect(result?.pass).toBe(true)
    expect(result?.details).toEqual(['unreadable colour brand-teal'])
  })

  it('accepts tints, shades and alpha versions of an allowed colour', () => {
    const m = measurement({ colors: ['#0177d3', '#e6f1fb', '#80bbe9', '#014a84', '#0177d380', '#ffffff', '#000000'] })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#0177d3'] })).results[0]
    expect(result).toMatchObject({ pass: true, offenders: [] })
  })

  it('names the first element a flagged colour appears on', () => {
    const m = measurement({
      colors: ['#ff0000', '#00ff00'],
      color_sources: { '#ff0000': 'cta-button', '#00ff00': 'body > :nth-child(2)' },
      sections: [section({ element_id: '#cta', colors: ['#ff0000'] })],
    })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#111111'] })).results[0]
    expect(result?.details).toEqual([
      '#ff0000 is not in the palette (used in #cta; first on cta-button)',
      '#00ff00 is not in the palette (first on body > :nth-child(2))',
    ])
  })

  it('lists a duplicate offender once', () => {
    const m = measurement({ colors: ['#111111', '#ff0000', '#ff0000'] })
    const result = lintMeasurement(m, rules({ allowed_colors: ['#111111'] })).results[0]
    expect(result?.offenders).toEqual(['#ff0000'])
  })
})

describe('banned_words', () => {
  it('matches whole words case-insensitively and counts occurrences', () => {
    const m = measurement({ text: 'We scale. Scaling is not scale. Move fast and ship. move fast.' })
    const result = lintMeasurement(m, rules({ banned_words: ['scale', 'move fast'] })).results[0]
    expect(result?.rule).toBe('banned_words')
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['scale', 'move fast'])
    expect(result?.details).toEqual(['"scale" appears 2 times', '"move fast" appears 2 times'])
  })

  it('passes when nothing is found', () => {
    const report = lintMeasurement(measurement(), rules({ banned_words: ['synergy', 'move fast'] }))
    expect(report.results[0]).toMatchObject({ pass: true, offenders: [], details: [] })
  })

  it('escapes regex characters in the word', () => {
    const m = measurement({ text: 'axb a.b today.' })
    const result = lintMeasurement(m, rules({ banned_words: ['a.b'] })).results[0]
    expect(result?.offenders).toEqual(['a.b'])
    expect(result?.details).toEqual(['"a.b" appears 1 times'])
  })
})

describe('no_overflow', () => {
  it('reports overflowing sections and clipped text blocks', () => {
    const m = measurement({
      sections: [
        section({ element_id: '#hero', overflow: true }),
        section({
          element_id: '#footer',
          texts: [text({ element_id: '#footer-note', clipped: true })],
        }),
      ],
    })
    const result = lintMeasurement(m, rules({ no_overflow: true })).results[0]
    expect(result?.rule).toBe('no_overflow')
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#hero', '#footer-note'])
    expect(result?.details).toEqual(['#hero overflows', '#footer-note is clipped'])
  })

  it('passes on a clean frame', () => {
    expect(lintMeasurement(measurement(), rules({ no_overflow: true })).results[0]?.pass).toBe(true)
  })

  it('is omitted when switched off', () => {
    expect(lintMeasurement(measurement(), rules({ no_overflow: false })).results).toEqual([])
  })
})

describe('min_contrast', () => {
  it('flags text below the minimum with the ratio and the limit', () => {
    const m = measurement({
      sections: [section({ texts: [text({ element_id: '#body', text: 'Low contrast', contrast: 3.2 })] })],
    })
    const result = lintMeasurement(m, rules({ min_contrast: 4.5 })).results[0]
    expect(result?.rule).toBe('min_contrast')
    expect(result?.pass).toBe(false)
    expect(result?.offenders).toEqual(['#body'])
    expect(result?.details).toEqual(['#body "Low contrast" contrast 3.2:1 (min 4.5)'])
  })

  it('passes text at or above the minimum', () => {
    const m = measurement({ sections: [section({ texts: [text({ contrast: 4.5 })] })] })
    expect(lintMeasurement(m, rules({ min_contrast: 4.5 })).results[0]?.pass).toBe(true)
  })

  it('allows large text down to 3:1 when the minimum is 4.5', () => {
    const m = measurement({
      sections: [section({ texts: [text({ element_id: '#big', large: true, contrast: 3.1 })] })],
    })
    const report = lintMeasurement(m, rules({ min_contrast: 4.5 }))
    expect(report.results[0]).toMatchObject({ pass: true, offenders: [] })

    const low = measurement({
      sections: [section({ texts: [text({ element_id: '#big', large: true, contrast: 2.9 })] })],
    })
    const failed = lintMeasurement(low, rules({ min_contrast: 4.5 })).results[0]
    expect(failed?.offenders).toEqual(['#big'])
    expect(failed?.details).toEqual(['#big "A line of body copy" contrast 2.9:1 (min 3)'])
  })

  it('keeps the stated minimum for large text at other thresholds', () => {
    const m = measurement({
      sections: [section({ texts: [text({ element_id: '#big', large: true, contrast: 3.1 })] })],
    })
    const result = lintMeasurement(m, rules({ min_contrast: 4 })).results[0]
    expect(result?.pass).toBe(false)
    expect(result?.details).toEqual(['#big "A line of body copy" contrast 3.1:1 (min 4)'])
  })

  it('notes unchecked blocks once without failing', () => {
    const m = measurement({
      sections: [
        section({ texts: [text({ element_id: '#a', contrast: null })] }),
        section({ texts: [text({ element_id: '#b', contrast: null })] }),
      ],
    })
    const result = lintMeasurement(m, rules({ min_contrast: 4.5 })).results[0]
    expect(result?.pass).toBe(true)
    expect(result?.offenders).toEqual([])
    expect(result?.details).toEqual(['2 text blocks sit on images or gradients and were not checked'])
  })

  it('omits the note when every block was checked', () => {
    const m = measurement({ sections: [section({ texts: [text({ element_id: '#checked' })] })] })
    expect(lintMeasurement(m, rules({ min_contrast: 4.5 })).results[0]?.details).toEqual([])
  })
})

describe('report', () => {
  it('runs only the rules present, in the fixed order', () => {
    const report = lintMeasurement(
      measurement(),
      rules({
        min_contrast: 3,
        banned_words: ['synergy'],
        max_text_lines: [{ selector: '.none', max: 1 }],
        allowed_colors: ['#ffffff', '#111111', '#e5e7eb'],
        no_overflow: true,
        max_heading_lines: 3,
        max_section_height: 2000,
      }),
    )
    expect(report.results.map((result) => result.rule)).toEqual([
      'max_section_height',
      'max_heading_lines',
      'max_text_lines',
      'allowed_colors',
      'banned_words',
      'no_overflow',
      'min_contrast',
    ])
  })

  it('passes only when every result passes', () => {
    const allPass = lintMeasurement(
      measurement(),
      rules({ max_section_height: 2000, banned_words: ['synergy'], allowed_colors: ['#ffffff', '#111111', '#e5e7eb'] }),
    )
    expect(allPass.pass).toBe(true)
    expect(allPass.results.every((result) => result.pass)).toBe(true)

    const oneFails = lintMeasurement(
      measurement(),
      rules({ max_section_height: 2000, banned_words: ['synergy'], allowed_colors: ['#ffffff'] }),
    )
    expect(oneFails.pass).toBe(false)
    expect(oneFails.results.map((result) => result.pass)).toEqual([true, false, true])
  })

  it('returns an empty passing report for no rules', () => {
    expect(lintMeasurement(measurement(), {})).toEqual({ pass: true, results: [] })
  })
})
