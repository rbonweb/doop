/** A Primer-shaped Storybook Button as the importer folds it: the default render is the Button with no trailing visual and `data-no-visuals` on its root, and each `trailing-visual` option is a whole render that adds the icon span after the label and drops that attribute. */

export const TRAILING_OPTIONS = ['none', 'SearchIcon', 'EyeIcon']

const ICON_PATHS: Record<string, string> = { SearchIcon: 'M1 1h14', EyeIcon: 'M2 8h12' }

const label = '<span data-component="text">Button</span>'

const withIcon = (icon: string) =>
  `<button class="btn" data-component="Button">${label}<span data-component="trailingVisual"><svg width="16" height="16" viewBox="0 0 16 16"><path d="${ICON_PATHS[icon]}"/></svg></span></button>`

export function primerButton() {
  return {
    name: 'Button',
    html: `<button data-no-visuals="true" class="btn" data-component="Button">${label}</button>`,
    css: '.btn { padding: 8px 16px; }',
    props: [{ name: 'trailing-visual', type: 'enum' as const, options: TRAILING_OPTIONS, default: 'none' }],
    variants: {
      'trailing-visual': {
        SearchIcon: { html: withIcon('SearchIcon') },
        EyeIcon: { html: withIcon('EyeIcon') },
      },
    },
  }
}

/** A Primer Button as a capture leaves it: the root follows a `variant` enum through its own data-variant attribute, so the markup already holds a data-doop-prop, and the label is a text nothing binds. */
export function primerCapturedButton(html?: string) {
  return {
    name: 'Button',
    html:
      html ??
      '<button class="btn" data-variant="default" data-doop-prop="data-variant:variant"><span data-component="text">Button</span></button>',
    css: '.btn { padding: 8px 16px; }',
    props: [{ name: 'variant', type: 'enum' as const, options: ['default', 'primary'], default: 'default' }],
    code: { exportName: 'Button' },
  }
}
