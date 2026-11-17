import { describe, expect, it } from 'vitest'
import { tokensDtcg, type DesignToken } from '../shared/designTokens.ts'

/**
 * The W3C Design Tokens (DTCG) export: one group per Doop type, `$value` and
 * `$type` per token, aliases as `{group.key}`, themes in `$extensions`.
 */

function token(
  name: string,
  type: DesignToken['type'],
  value: string,
  order: number,
  extra: Partial<DesignToken> = {},
): DesignToken {
  return { name, type, value, order, updatedAt: 0, updatedBy: 'u', ...extra }
}

const TOKENS = [
  token('--color-primary', 'color', '#111', 1),
  token('--color-primary-hover', 'color', 'var(--color-primary)', 2),
  token('--color-missing', 'color', 'var(--nope)', 3),
  token('--color-night', 'color', '#222', 4, { themes: { dark: '#000' }, description: 'Night colour' }),
  token('--color.accent', 'color', '#333', 5),
  token('--opacity-muted', 'opacity', '0.5', 6),
  token('--radius-md', 'radius', '8px', 7),
  token('--spacing-4', 'spacing', '16px', 8),
  token('--container-page', 'container', '1200px', 9),
  token('--breakpoint-md', 'breakpoint', '768px', 10),
  token('--font-sans', 'fontFamily', '"Inter", ui-sans-serif, sans-serif', 11),
  token('--font-weight-bold', 'fontWeight', '700', 12),
  token('--font-size-lg', 'fontSize', '18px', 13),
  token('--line-height-tight', 'lineHeight', '1.3', 14),
  token('--letter-spacing-wide', 'letterSpacing', '0.02em', 15),
]

describe('tokensDtcg', () => {
  it('groups the tokens by type, in TOKEN_TYPES order', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(Object.keys(tree)).toEqual([
      'color',
      'opacity',
      'radius',
      'spacing',
      'container',
      'breakpoint',
      'fontFamily',
      'fontWeight',
      'fontSize',
      'lineHeight',
      'letterSpacing',
    ])
  })

  it('writes $value and $type for a literal token', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.color['color-primary']).toEqual({ $value: '#111', $type: 'color' })
    expect(tree.spacing['spacing-4']).toEqual({ $value: '16px', $type: 'dimension' })
    expect(tree.fontSize['font-size-lg']).toEqual({ $value: '18px', $type: 'dimension' })
    expect(tree.fontWeight['font-weight-bold']).toEqual({ $value: 700, $type: 'fontWeight' })
  })

  it('rewrites a whole-value var() naming a token as a DTCG alias', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.color['color-primary-hover'].$value).toBe('{color.color-primary}')
  })

  it('keeps a var() that names no token as written', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.color['color-missing'].$value).toBe('var(--nope)')
  })

  it('puts theme values in $extensions, with the description', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.color['color-night']).toEqual({
      $value: '#222',
      $type: 'color',
      $description: 'Night colour',
      $extensions: { 'design.doop': { themes: { dark: '#000' } } },
    })
  })

  it('numbers opacity and lineHeight, and splits fontFamily into names', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.opacity['opacity-muted'].$value).toBe(0.5)
    expect(tree.opacity['opacity-muted'].$type).toBe('number')
    expect(tree.lineHeight['line-height-tight'].$value).toBe(1.3)
    expect(tree.lineHeight['line-height-tight'].$type).toBe('number')
    expect(tree.fontFamily['font-sans'].$value).toEqual(['Inter', 'ui-sans-serif', 'sans-serif'])
    expect(tree.fontFamily['font-sans'].$type).toBe('fontFamily')
    expect(tree.letterSpacing['letter-spacing-wide']).toEqual({ $value: '0.02em', $type: 'dimension' })
  })

  it('replaces dots in a token key', () => {
    const tree = JSON.parse(tokensDtcg(TOKENS))
    expect(tree.color['color-accent'].$value).toBe('#333')
  })

  it('orders themes by themeOrder first, then by name', () => {
    const tokens = [
      token('--color-a', 'color', '#111', 1, { themes: { light: '#aaa', dark: '#000' } }),
      token('--color-b', 'color', '#222', 2, { themes: { light: '#bbb' } }),
    ]
    const tree = JSON.parse(tokensDtcg(tokens, ['dark']))
    expect(Object.keys(tree.color['color-a'].$extensions['design.doop'].themes)).toEqual(['dark', 'light'])
    expect(Object.keys(tree.color['color-b'].$extensions['design.doop'].themes)).toEqual(['light'])
  })

  it('returns an empty object for no tokens', () => {
    expect(tokensDtcg([])).toBe('{}\n')
  })

  it('serialises the full list', () => {
    expect(tokensDtcg(TOKENS, ['dark'])).toMatchInlineSnapshot(`
      "{
        "color": {
          "color-primary": {
            "$value": "#111",
            "$type": "color"
          },
          "color-primary-hover": {
            "$value": "{color.color-primary}",
            "$type": "color"
          },
          "color-missing": {
            "$value": "var(--nope)",
            "$type": "color"
          },
          "color-night": {
            "$value": "#222",
            "$type": "color",
            "$description": "Night colour",
            "$extensions": {
              "design.doop": {
                "themes": {
                  "dark": "#000"
                }
              }
            }
          },
          "color-accent": {
            "$value": "#333",
            "$type": "color"
          }
        },
        "opacity": {
          "opacity-muted": {
            "$value": 0.5,
            "$type": "number"
          }
        },
        "radius": {
          "radius-md": {
            "$value": "8px",
            "$type": "dimension"
          }
        },
        "spacing": {
          "spacing-4": {
            "$value": "16px",
            "$type": "dimension"
          }
        },
        "container": {
          "container-page": {
            "$value": "1200px",
            "$type": "dimension"
          }
        },
        "breakpoint": {
          "breakpoint-md": {
            "$value": "768px",
            "$type": "dimension"
          }
        },
        "fontFamily": {
          "font-sans": {
            "$value": [
              "Inter",
              "ui-sans-serif",
              "sans-serif"
            ],
            "$type": "fontFamily"
          }
        },
        "fontWeight": {
          "font-weight-bold": {
            "$value": 700,
            "$type": "fontWeight"
          }
        },
        "fontSize": {
          "font-size-lg": {
            "$value": "18px",
            "$type": "dimension"
          }
        },
        "lineHeight": {
          "line-height-tight": {
            "$value": 1.3,
            "$type": "number"
          }
        },
        "letterSpacing": {
          "letter-spacing-wide": {
            "$value": "0.02em",
            "$type": "dimension"
          }
        }
      }
      "
    `)
  })
})
