import { compile } from '@tailwindcss/node'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { splitComponentCss } from '../server/reactExport/cssSplit.ts'
import { CONVERTED_PROPERTIES, cssToTailwind, tailwindClassName } from '../server/reactExport/tailwind.ts'

const flat = (css: string) => css.replace(/\s+/g, ' ').trim()

const ENTRY = '@import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);'

async function compiler() {
  return compile(ENTRY, { base: process.cwd(), onDependency: () => undefined })
}

/** Tailwind's own output for a utility list: a class that Tailwind does not recognise produces nothing. */
async function build(utilities: string[]): Promise<string> {
  return flat((await compiler()).build(utilities))
}

function utilitiesOf(css: string, className = 'x', options?: Parameters<typeof cssToTailwind>[1]): string[] {
  return cssToTailwind(css, options).utilities.get(className) ?? []
}

/** `[css declarations, expected utilities, a fragment Tailwind must produce for them]` */
const CASES: [string, string[], string][] = [
  /* spacing, on and off the scale */
  ['padding: 16px', ['p-4'], 'padding: calc(var(--spacing) * 4)'],
  ['padding: 1rem 2rem', ['py-4', 'px-8'], 'padding-block: calc(var(--spacing) * 4)'],
  ['padding: 13px', ['p-[13px]'], 'padding: 13px'],
  ['padding: 1px 2px 3px 4px', ['pt-px', 'pr-0.5', 'pb-[3px]', 'pl-1'], 'padding-top: 1px'],
  ['padding-left: 12px', ['pl-3'], 'padding-left: calc(var(--spacing) * 3)'],
  ['margin: 0 auto', ['my-0', 'mx-auto'], 'margin-inline: auto'],
  ['margin-top: -8px', ['-mt-2'], 'margin-top: calc(var(--spacing) * -2)'],
  ['margin-top: -13px', ['mt-[-13px]'], 'margin-top: -13px'],
  ['margin-left: 5%', ['ml-[5%]'], 'margin-left: 5%'],
  ['gap: 8px', ['gap-2'], 'gap: calc(var(--spacing) * 2)'],
  ['gap: 8px 20px', ['gap-y-2', 'gap-x-5'], 'column-gap: calc(var(--spacing) * 5)'],
  ['row-gap: 7px', ['gap-y-[7px]'], 'row-gap: 7px'],
  ['padding: var(--space-4)', ['p-(--space-4)'], 'padding: var(--space-4)'],
  ['width: calc(100% - 20px)', ['w-[calc(100%_-_20px)]'], 'width: calc(100% - 20px)'],
  /* sizing */
  ['width: 100%', ['w-full'], 'width: 100%'],
  ['width: 50%', ['w-1/2'], 'width: calc(1 / 2 * 100%)'],
  ['width: 37%', ['w-[37%]'], 'width: 37%'],
  ['width: 240px', ['w-60'], 'width: calc(var(--spacing) * 60)'],
  ['width: 241px', ['w-[241px]'], 'width: 241px'],
  ['width: auto', ['w-auto'], 'width: auto'],
  ['width: fit-content', ['w-fit'], 'width: fit-content'],
  ['height: 100vh', ['h-screen'], 'height: 100vh'],
  ['min-height: 100vh', ['min-h-screen'], 'min-height: 100vh'],
  ['max-width: 48rem', ['max-w-3xl'], 'max-width: var(--container-3xl)'],
  ['max-width: 1200px', ['max-w-[1200px]'], 'max-width: 1200px'],
  ['max-width: none', ['max-w-none'], 'max-width: none'],
  ['aspect-ratio: 16 / 9', ['aspect-video'], 'aspect-ratio: var(--aspect-video)'],
  ['aspect-ratio: 4 / 3', ['aspect-[4/3]'], 'aspect-ratio: 4/3'],
  ['box-sizing: border-box', ['box-border'], 'box-sizing: border-box'],
  /* colour and background */
  ['color: white', ['text-white'], 'color: var(--color-white)'],
  ['color: #111', ['text-[#111]'], 'color: #111'],
  ['color: rgb(10 20 30 / 50%)', ['text-[rgb(10_20_30/50%)]'], 'color: rgb(10 20 30/50%)'],
  ['color: tomato', ['text-[color:tomato]'], 'color: tomato'],
  ['color: var(--color-primary)', ['text-(--color-primary)'], 'color: var(--color-primary)'],
  ['color: var(--brand, #fff)', ['text-[color:var(--brand,#fff)]'], 'color: var(--brand,#fff)'],
  ['color: currentColor', ['text-current'], 'color: currentcolor'],
  ['background-color: transparent', ['bg-transparent'], 'background-color: transparent'],
  ['background-color: var(--color-primary)', ['bg-(--color-primary)'], 'background-color: var(--color-primary)'],
  ['background: #f5f5f5', ['bg-[#f5f5f5]'], 'background-color: #f5f5f5'],
  [
    'background-image: linear-gradient(to right, #fff, #000)',
    ['bg-[linear-gradient(to_right,#fff,#000)]'],
    'background-image: linear-gradient(to right,#fff,#000)',
  ],
  ['background-size: cover', ['bg-cover'], 'background-size: cover'],
  ['background-position: center', ['bg-center'], 'background-position: center'],
  ['object-fit: cover', ['object-cover'], 'object-fit: cover'],
  /* border and radius */
  ['border: 1px solid #ccc', ['border', 'border-solid', 'border-[#ccc]'], 'border-style: var(--tw-border-style)'],
  ['border: 2px dashed var(--line)', ['border-2', 'border-dashed', 'border-(--line)'], 'border-color: var(--line)'],
  ['border: none', ['border-0'], 'border-style: var(--tw-border-style)'],
  ['border-top: 3px solid red', ['border-t-[3px]', 'border-solid', 'border-t-[color:red]'], 'border-top-width: 3px'],
  ['border-bottom-width: 4px', ['border-b-4'], 'border-bottom-width: 4px'],
  ['border-color: #abc', ['border-[#abc]'], 'border-color: #abc'],
  ['border-radius: 8px', ['rounded-lg'], 'border-radius: var(--radius-lg)'],
  ['border-radius: 5px', ['rounded-[5px]'], 'border-radius: 5px'],
  ['border-radius: 0', ['rounded-none'], 'border-radius: 0'],
  ['border-radius: 9999px', ['rounded-full'], 'border-radius: calc(infinity * 1px)'],
  ['border-radius: 4px 8px', ['rounded-[4px_8px]'], 'border-radius: 4px 8px'],
  ['border-top-left-radius: 12px', ['rounded-tl-xl'], 'border-top-left-radius: var(--radius-xl)'],
  /* typography */
  ['font-size: 14px; line-height: 20px', ['text-sm', 'leading-5'], 'font-size: var(--text-sm)'],
  ['font-size: 14px', ['text-[length:14px]'], 'font-size: 14px'],
  ['font-size: 15px', ['text-[length:15px]'], 'font-size: 15px'],
  ['font-size: var(--size-body)', ['text-(length:--size-body)'], 'font-size: var(--size-body)'],
  ['font-weight: 600', ['font-semibold'], 'font-weight: var(--font-weight-semibold)'],
  ['font-weight: 550', ['font-[550]'], 'font-weight: 550'],
  ['font-weight: bold', ['font-bold'], 'font-weight: var(--font-weight-bold)'],
  ['line-height: 1.5', ['leading-normal'], 'line-height: var(--leading-normal)'],
  ['line-height: 1.7', ['leading-[1.7]'], 'line-height: 1.7'],
  ['line-height: 24px', ['leading-6'], 'line-height: calc(var(--spacing) * 6)'],
  ['letter-spacing: 0.05em', ['tracking-wider'], 'letter-spacing: var(--tracking-wider)'],
  ['letter-spacing: 0.2em', ['tracking-[0.2em]'], 'letter-spacing: 0.2em'],
  ['font-family: Inter, sans-serif', ['font-[family-name:Inter,sans-serif]'], 'font-family: Inter,sans-serif'],
  ['font-family: var(--font-body)', ['font-(family-name:--font-body)'], 'font-family: var(--font-body)'],
  ['text-align: center', ['text-center'], 'text-align: center'],
  ['text-transform: uppercase', ['uppercase'], 'text-transform: uppercase'],
  ['text-decoration: none', ['no-underline'], 'text-decoration-line: none'],
  ['font-style: italic', ['italic'], 'font-style: italic'],
  ['white-space: nowrap', ['whitespace-nowrap'], 'white-space: nowrap'],
  ['text-overflow: ellipsis', ['text-ellipsis'], 'text-overflow: ellipsis'],
  ['cursor: pointer', ['cursor-pointer'], 'cursor: pointer'],
  /* flex and grid */
  ['display: flex', ['flex'], 'display: flex'],
  ['display: none', ['hidden'], 'display: none'],
  ['flex-direction: column', ['flex-col'], 'flex-direction: column'],
  ['flex-wrap: wrap', ['flex-wrap'], 'flex-wrap: wrap'],
  ['justify-content: space-between', ['justify-between'], 'justify-content: space-between'],
  ['align-items: flex-start', ['items-start'], 'align-items: flex-start'],
  ['align-self: center', ['self-center'], 'align-self: center'],
  ['flex: 1', ['flex-1'], 'flex: 1'],
  ['flex: 1 1 0%', ['flex-1'], 'flex: 1'],
  ['flex: 2 1 0%', ['flex-[2_1_0%]'], 'flex: 2 1 0%'],
  ['flex-grow: 1', ['grow'], 'flex-grow: 1'],
  ['flex-shrink: 0', ['shrink-0'], 'flex-shrink: 0'],
  ['flex-basis: 50%', ['basis-1/2'], 'flex-basis: calc(1 / 2 * 100%)'],
  ['order: 3', ['order-3'], 'order: 3'],
  [
    'grid-template-columns: repeat(3, minmax(0, 1fr))',
    ['grid-cols-3'],
    'grid-template-columns: repeat(3, minmax(0, 1fr))',
  ],
  ['grid-template-columns: 200px 1fr', ['grid-cols-[200px_1fr]'], 'grid-template-columns: 200px 1fr'],
  ['grid-auto-flow: dense', ['grid-flow-dense'], 'grid-auto-flow: dense'],
  /* position and inset */
  ['position: absolute', ['absolute'], 'position: absolute'],
  ['top: 0', ['top-0'], 'top: 0px'],
  ['left: 50%', ['left-1/2'], 'left: calc(1 / 2 * 100%)'],
  ['right: -4px', ['-right-1'], 'right: calc(var(--spacing) * -1)'],
  ['bottom: 7px', ['bottom-[7px]'], 'bottom: 7px'],
  ['inset: 0', ['inset-0'], 'inset: 0px'],
  ['z-index: 10', ['z-10'], 'z-index: 10'],
  ['z-index: 999', ['z-[999]'], 'z-index: 999'],
  ['overflow: hidden', ['overflow-hidden'], 'overflow: hidden'],
  ['overflow-y: auto', ['overflow-y-auto'], 'overflow-y: auto'],
  ['visibility: hidden', ['invisible'], 'visibility: hidden'],
  /* opacity */
  ['opacity: 0.5', ['opacity-50'], 'opacity: 50%'],
  ['opacity: 0.35', ['opacity-35'], 'opacity: 35%'],
  ['opacity: 0.33', ['opacity-[0.33]'], 'opacity: 0.33'],
  ['opacity: 80%', ['opacity-80'], 'opacity: 80%'],
  /* shadow */
  [
    'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1)',
    ['shadow-[0_1px_2px_rgba(0,0,0,0.1)]'],
    'box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',
  ],
  ['box-shadow: none', ['shadow-none'], '--tw-shadow: 0 0 #0000'],
  ['box-shadow: var(--shadow-card)', ['shadow-(--shadow-card)'], '--tw-shadow: var(--shadow-card)'],
  /* transition */
  [
    'transition: opacity 200ms ease-out',
    ['transition-[opacity]', 'duration-200', 'ease-out'],
    'transition-duration: 200ms',
  ],
  ['transition: all 0.3s', ['transition-all', 'duration-300'], 'transition-property: all'],
  ['transition: color 1s, opacity 2s', ['[transition:color_1s,opacity_2s]'], 'transition: color 1s,opacity 2s'],
  ['transition-duration: 150ms', ['duration-150'], 'transition-duration: 150ms'],
  [
    'transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)',
    ['ease-[cubic-bezier(0.4,0,0.2,1)]'],
    'cubic-bezier(0.4,0,0.2,1)',
  ],
  [
    'transition-property: opacity,transform',
    ['transition-[opacity,transform]'],
    'transition-property: opacity,transform',
  ],
  ['transition-delay: 100ms', ['delay-100'], 'transition-delay: 100ms'],
  /* important */
  ['padding: 16px !important', ['p-4!'], 'padding: calc(var(--spacing) * 4) !important'],
]

describe('cssToTailwind: declarations and Tailwind itself', () => {
  it.each(CASES)('%s', async (declarations, expected, fragment) => {
    const out = cssToTailwind(`.x { ${declarations} }`)
    const utilities = out.utilities.get('x') ?? []
    expect(utilities).toEqual(expected)
    expect(out.leftover.moduleCss).toBe('')
    const built = await build(utilities)
    expect(built).toContain(fragment)
  })

  it('every utility of every case is a candidate Tailwind accepts, one class at a time', async () => {
    const all = new Set(CASES.flatMap(([, expected]) => expected))
    const built = await Promise.all([...all].map(async (utility) => [utility, await build([utility])] as const))
    for (const [utility, css] of built) expect(css, utility).toContain('@layer utilities')
  })
})

describe('cssToTailwind: variants', () => {
  it.each([
    ['.x:hover', 'hover:', 'hover'],
    ['.x:focus-visible', 'focus-visible:', 'focus-visible'],
    ['.x:active', 'active:', 'active'],
    ['.x:disabled', 'disabled:', 'disabled'],
  ])('maps %s', async (selector, prefix, pseudo) => {
    const utilities = utilitiesOf(`${selector} { color: #111 }`)
    expect(utilities).toEqual([`${prefix}text-[#111]`])
    const built = await build(utilities)
    expect(built).toContain(`:${pseudo}`)
    expect(built).toContain('color: #111')
  })

  it('maps ::before and ::after, with the content utility', async () => {
    const out = cssToTailwind('.x::before { content: ""; display: block } .x:after { top: 0 }')
    expect(out.utilities.get('x')).toEqual(["before:content-['']", 'before:block', 'after:top-0'])
    const built = await build(out.utilities.get('x')!)
    expect(built).toContain('::before')
    expect(built).toContain('::after')
    expect(built).toContain('--tw-content: ')
  })

  it('maps a data attribute on the element', async () => {
    const utilities = utilitiesOf('.x[data-tone="ghost"] { background: none; color: red }')
    expect(utilities).toEqual(['data-[tone=ghost]:text-[color:red]'])
    const built = await build(utilities)
    expect(built).toContain('[data-tone="ghost"]')
    expect(built).toContain('color: red')
  })

  it('maps a bare data attribute and stacks it with a pseudo class', async () => {
    const utilities = utilitiesOf('.x[data-open]:hover { color: #111 }')
    expect(utilities).toEqual(['data-[open]:hover:text-[#111]'])
    expect(await build(utilities)).toContain('[data-open]')
  })

  it("maps the root's attribute on an ancestor with in-data", async () => {
    const out = cssToTailwind(
      '[data-tone="ghost"] .label { opacity: .6 } .root[data-size=lg] .label:hover { top: 1px }',
    )
    expect(out.utilities.get('label')).toEqual(['in-data-[tone=ghost]:opacity-60', 'in-data-[size=lg]:hover:top-px'])
    const built = await build(out.utilities.get('label')!)
    expect(built).toContain('[data-tone="ghost"]')
    expect(built).toContain('opacity: 60%')
    expect(built).toContain('[data-size="lg"]')
  })

  it('an ancestor that is not the root stays CSS', () => {
    const out = cssToTailwind('.card .label { opacity: .6 }')
    expect(out.utilities.size).toBe(0)
    expect(flat(out.leftover.moduleCss)).toBe('.card .label { opacity: .6; }')
  })

  it('honours a custom rootClass', () => {
    const out = cssToTailwind('[data-tone=a] .label { opacity: 1 }', { rootClass: 'Button_root' })
    expect(out.utilities.get('label')).toEqual(['in-data-[tone=a]:opacity-100'])
  })

  it.each([
    ['(min-width: 40rem)', 'sm'],
    ['(min-width: 768px)', 'md'],
    ['(min-width:64rem)', 'lg'],
    ['(min-width: 1280px)', 'xl'],
    ['(min-width: 96rem)', '2xl'],
  ])('maps @media %s to %s:', async (query, breakpoint) => {
    const out = cssToTailwind(`.x { padding: 4px } @media ${query} { .x { padding: 8px } }`)
    expect(out.utilities.get('x')).toEqual(['p-1', `${breakpoint}:p-2`])
    expect(out.leftover.moduleCss).toBe('')
    const rem = { sm: 40, md: 48, lg: 64, xl: 80, '2xl': 96 }[breakpoint]
    expect(await build(out.utilities.get('x')!)).toContain(`@media (width >= ${rem}rem)`)
  })

  it('stacks a breakpoint with a state and a pseudo-element', async () => {
    const out = cssToTailwind('@media (min-width: 48rem) { .x:hover::after { top: 0 } }')
    expect(out.utilities.get('x')).toEqual(['md:hover:after:top-0'])
    const built = await build(out.utilities.get('x')!)
    expect(built).toContain('@media (width >= 48rem)')
    expect(built).toContain('::after')
  })
})

describe('cssToTailwind: what does not convert', () => {
  it('keeps keyframes, other media queries and complex selectors as leftover', () => {
    const css = [
      '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }',
      '@media (max-width: 600px) { .x { padding: 4px } }',
      '@media (min-width: 777px) { .x { padding: 4px } }',
      '@media (prefers-reduced-motion: reduce) { .x { color: red } }',
      '.x > .y { color: red }',
      '.x + .y { color: red }',
      '.x:nth-child(2) { color: red }',
      '.x .y .z { color: red }',
      '.x:not(.y) { color: red }',
    ].join('\n')
    const out = cssToTailwind(css)
    expect(out.utilities.size).toBe(0)
    const left = flat(out.leftover.moduleCss)
    expect(left).toContain('@keyframes spin')
    expect(left).toContain('@media (max-width: 600px)')
    expect(left).toContain('@media (min-width: 777px)')
    expect(left).toContain('@media (prefers-reduced-motion: reduce)')
    expect(left).toContain('.x > .y')
    expect(left).toContain('.x + .y')
    expect(left).toContain('.x:nth-child(2)')
    expect(left).toContain('.x .y .z')
    expect(left).toContain('.x:not(.y)')
    expect(out.leftover.classes).toEqual(expect.arrayContaining(['x', 'y', 'z']))
  })

  it('splits a partly converted rule between utilities and leftover', () => {
    const out = cssToTailwind('.x { padding: 16px; backdrop-filter: blur(4px); color: #111; scroll-snap-type: x }')
    expect(out.utilities.get('x')).toEqual(['p-4', 'text-[#111]'])
    expect(flat(out.leftover.moduleCss)).toBe('.x { backdrop-filter: blur(4px); scroll-snap-type: x; }')
    expect(out.leftover.classes).toEqual(['x'])
  })

  it('keeps a property that appears twice (a fallback) in the leftover untouched', () => {
    const out = cssToTailwind('.x { width: 100%; width: -webkit-fill-available; color: #111 }')
    expect(out.utilities.get('x')).toEqual(['text-[#111]'])
    expect(flat(out.leftover.moduleCss)).toBe('.x { width: 100%; width: -webkit-fill-available; }')
  })

  it('keeps nested blocks in the leftover and converts the plain declarations', () => {
    const out = cssToTailwind('.x { padding: 4px; &:hover { color: red } }')
    expect(out.utilities.get('x')).toEqual(['p-1'])
    expect(flat(out.leftover.moduleCss)).toContain('&:hover')
  })

  it('converts only the convertible selectors of a list', () => {
    const out = cssToTailwind('.a, .b > .c { padding: 4px; mask-image: none }')
    expect(out.utilities.get('a')).toEqual(['p-1'])
    expect(out.utilities.has('b')).toBe(false)
    expect(flat(out.leftover.moduleCss)).toContain('.b > .c { padding: 4px; mask-image: none; }')
    expect(flat(out.leftover.moduleCss)).toContain('.a { mask-image: none; }')
  })

  it('leaves values Tailwind cannot carry safely in the leftover', () => {
    const out = cssToTailwind(
      [
        '.x { content: "hello" }',
        '.x { font-family: "Helvetica Neue", Arial }',
        '.x { margin: 4px calc(1px * var(--a_b)) }',
        '.x { padding: 4px;color: red; background: url(/a/b.png) }',
        '.x { width: 5px; width: 6px }',
        '.y { width: [1px] }',
        '.y { margin: 10px 1px; transform: rotate(5deg) }',
      ].join('\n'),
    )
    const utilities = [...out.utilities.values()].flat()
    expect(utilities.join(' ')).not.toMatch(/hello|Helvetica|a_b|url/)
    const left = flat(out.leftover.moduleCss)
    expect(left).toContain('content: "hello"')
    expect(left).toContain('"Helvetica Neue"')
    expect(left).toContain('--a_b')
    expect(left).toContain('url(/a/b.png)')
    expect(left).toContain('transform: rotate(5deg)')
  })

  it('does not convert unknown properties', () => {
    const out = cssToTailwind('.x { frobnicate: 3px }')
    expect(out.utilities.size).toBe(0)
    expect(flat(out.leftover.moduleCss)).toBe('.x { frobnicate: 3px; }')
  })

  it('sends :root and @font-face to globalCss and prefixes classless rules with the root class', () => {
    const out = cssToTailwind(
      ':root { --a: 1px } @font-face { font-family: F; src: local(F) } [data-x=a] { color: #111 } a { color: red }',
    )
    expect(flat(out.leftover.globalCss)).toContain(':root { --a: 1px; }')
    expect(flat(out.leftover.globalCss)).toContain('@font-face')
    expect(out.utilities.get('root')).toEqual(['data-[x=a]:text-[#111]'])
    expect(flat(out.leftover.moduleCss)).toBe('.root a { color: red; }')
  })
})

describe('cssToTailwind: safety', () => {
  it('drops unsafe CSS the way splitComponentCss does and reports it', () => {
    const out = cssToTailwind(
      '@import "x.css"; .x { background: url(javascript:alert(1)); color: expression(alert(1)); padding: 4px; behavior: url(x.htc) } .y { composes: a from "./b.css"; margin: 0 }',
    )
    expect(out.utilities.get('x')).toEqual(['p-1'])
    expect(out.utilities.get('y')).toEqual(['m-0'])
    expect(out.leftover.moduleCss).toBe('')
    expect(out.issues.map((issue) => issue.kind)).toEqual(Array(out.issues.length).fill('css'))
    expect(out.issues.length).toBeGreaterThanOrEqual(4)
  })

  /* `rewriteUrl` lands on splitComponentCss with the parent's S7 work; the case switches on once it is there */
  const hasRewriteUrl = splitComponentCss('.a { background-image: url(/a/b.png) }', {
    rewriteUrl: () => 'https://x/y',
  } as never).moduleCss.includes('https://x/y')
  it.skipIf(!hasRewriteUrl)('passes rewriteUrl to the leftover url()s', () => {
    const out = cssToTailwind('.x { background-image: url(/a/pic.png); padding: 4px }', {
      rewriteUrl: (url) => `https://cdn.example${url}`,
    })
    expect(out.utilities.get('x')).toEqual(['p-1'])
    expect(out.leftover.moduleCss).toContain('https://cdn.example/a/pic.png')
  })

  const HOSTILE = [
    '.x { color: red" onfocus="alert(1) }',
    ".x { color: #fff' }",
    '.x { width: 1px 2px }',
    '.x { padding: 4px</script> }',
    '.x { margin: 1px\\22 }',
    '.x { width: calc(1px + 2px) ] }',
    '.x { width: [1px] }',
    '.x { color: rgb(0, 0, 0)} .y {}',
    '.x { box-shadow: 0 0 0 1px red; } .x { top: 1px; left: `x` }',
    '.x { height: 1px;2px }',
    '.x { color: #fff; background: red\\;x }',
    '.x { box-shadow: 0 0 1px rgb(0,0,0),0 0 {} }',
    '.a\\.b { color: red } .x\\:y { top: 0 }',
    '.x[data-a="b c"] { top: 0 } .x[data-a="b\\"] { top: 0 } .x[data-a="b]c"] { top: 0 }',
  ]

  it.each(HOSTILE)('every utility is a safe token for %j', (css) => {
    const out = cssToTailwind(css)
    const all = [...out.utilities.values()].flat()
    for (const utility of all) {
      expect(utility, utility).not.toMatch(/[\s"`\\<>{};]/)
      expect(utility === "content-['']" || !utility.includes("'")).toBe(true)
      expect(utility).not.toMatch(/\[[^\]]*\[/)
    }
    for (const name of out.utilities.keys()) expect(name).toMatch(/^[A-Za-z_][\w-]*$/)
  })

  it('never emits a quote or space from a value', () => {
    const utilities = utilitiesOf('.x { font-family: "A B"; content: "q"; width: calc(1px + 2px); margin: 1px 2px }')
    for (const utility of utilities) expect(utility).not.toMatch(/["\s]/)
    expect(utilities).toContain('w-[calc(1px_+_2px)]')
  })
})

describe('tailwindClassName', () => {
  const split = cssToTailwind(
    '.btn { padding: 4px; backdrop-filter: blur(2px) } .label { color: #111 } .legacy { mask: none }',
  )

  function diagnostics(value: string): ts.Diagnostic[] {
    const output = ts.transpileModule(`const x = <div className=${value} />`, {
      reportDiagnostics: true,
      fileName: 'x.tsx',
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    })
    return output.diagnostics ?? []
  }

  it('writes utilities as one string literal', () => {
    expect(tailwindClassName(['label'], split)).toBe('{"text-[#111]"}')
  })

  it('adds a partly converted class both ways', () => {
    expect(tailwindClassName(['btn'], split)).toBe('{cx("p-1", styles["btn"])}')
  })

  it('writes a leftover-only class as styles["x"] and unknown classes inside the literal', () => {
    expect(tailwindClassName(['legacy'], split)).toBe('{styles["legacy"]}')
    expect(tailwindClassName(['label', 'unknown'], split)).toBe('{"text-[#111] unknown"}')
    expect(tailwindClassName(['legacy', 'unknown'], split)).toBe('{cx("unknown", styles["legacy"])}')
  })

  it('honours custom names and returns an empty literal for no classes', () => {
    expect(tailwindClassName(['btn'], split, { styles: 's', cx: 'clsx' })).toBe('{clsx("p-1", s["btn"])}')
    expect(tailwindClassName([], split)).toBe('{""}')
  })

  it.each([[['btn', 'label', 'legacy', 'x"y', 'a\nb', '</script>', ' ']], [['label']], [['btn']]])(
    'is valid JSX for %j',
    (classes) => {
      const value = tailwindClassName(classes, split)
      expect(diagnostics(value)).toEqual([])
      expect(value).not.toContain('</script>')
      expect(value).not.toMatch(/[\u2028\u2029\n]/)
    },
  )

  it('utility strings with arbitrary values are valid JSX', () => {
    const out = cssToTailwind(
      '.x { width: calc(100% - 20px); box-shadow: 0 1px 2px rgba(0,0,0,.1); transition: a 1s, b 2s }',
    )
    const value = tailwindClassName(['x'], out)
    expect(diagnostics(value)).toEqual([])
  })
})

describe('end to end with Tailwind', () => {
  it('a whole component sheet converts, compiles and leaves only what Tailwind cannot say', async () => {
    const css = `
      .root { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: var(--color-primary); color: #fff; transition: background-color 150ms ease-in-out }
      .root:hover { background: #0a5fb4 }
      .root:focus-visible { outline: 2px solid var(--color-focus) }
      .root[data-tone="ghost"] { background: transparent; color: var(--color-primary) }
      [data-tone="ghost"] .label { opacity: .6 }
      .label { font-size: 14px; line-height: 20px; font-weight: 500 }
      .label::before { content: ""; display: inline-block; width: 6px; height: 6px }
      @media (min-width: 48rem) { .root { padding: 12px 24px } }
      @keyframes pulse { 0% { opacity: .5 } 100% { opacity: 1 } }
      .root:not(:disabled):active { transform: scale(.98) }
    `
    const out = cssToTailwind(css)
    const all = [...out.utilities.values()].flat()
    const built = await build(all)
    for (const utility of all) expect(await build([utility]), utility).toContain('@layer utilities')
    expect(built).toContain('background-color: var(--color-primary)')
    expect(built).toContain('@media (width >= 48rem)')
    const left = flat(out.leftover.moduleCss)
    expect(left).toContain('@keyframes pulse')
    expect(left).toContain('.root:not(:disabled):active')
    expect(left).toContain('outline: 2px solid var(--color-focus)')
    expect(left).not.toContain('border-radius')
  })
})

describe('cssToTailwind: guards', () => {
  const VALUES = [
    '0',
    '1px',
    '4px',
    '13px',
    '-4px',
    '-13px',
    '8px',
    '16px',
    '24px',
    '12px',
    '9999px',
    '100%',
    '50%',
    '33.3333%',
    'auto',
    'none',
    '100vh',
    '100vw',
    '100dvh',
    'fit-content',
    'min-content',
    'max-content',
    'calc(1px + 2px)',
    'var(--x)',
    'var(--x, #fff)',
    '#fff',
    '#abc',
    '#000',
    'rgb(0 0 0 / 50%)',
    'red',
    'transparent',
    'currentColor',
    'inherit',
    '1',
    '0.5',
    '0.35',
    '600',
    'bold',
    '1.5',
    '1.7',
    '0.05em',
    '1px 2px',
    '1px 2px 3px',
    '1px 2px 3px 4px',
    '4px auto',
    '1px solid red',
    '2px dashed #ccc',
    'solid',
    'dashed',
    'center',
    'flex-start',
    'flex-end',
    'start',
    'end',
    'stretch',
    'baseline',
    'space-between',
    'row',
    'column',
    'wrap',
    'nowrap',
    'wrap-reverse',
    '150ms',
    '1s',
    '1s ease',
    'opacity 1s',
    'all 0.3s',
    'color 1s, opacity 2s',
    'opacity, transform',
    'cubic-bezier(0.4, 0, 0.2, 1)',
    'ease-in',
    'linear',
    'repeat(3, minmax(0, 1fr))',
    '200px 1fr',
    '16 / 9',
    '4 / 3',
    '1 / 1',
    'hidden',
    'visible',
    'absolute',
    'relative',
    'sticky',
    'pointer',
    'uppercase',
    'underline',
    'line-through',
    'italic',
    'ellipsis',
    'clip',
    'cover',
    'contain',
    'fill',
    'scale-down',
    'left',
    'right',
    'top',
    'bottom',
    'justify',
    '0 1px 2px rgba(0, 0, 0, .1)',
    'Inter, sans-serif',
    '1 1 0%',
    '2 1 0%',
    'dense',
    'column dense',
    'linear-gradient(to right, #fff, #000)',
    'border-box',
    'content-box',
    'scroll',
    'block',
    'inline-block',
    'flex',
    'inline-flex',
    'grid',
    'contents',
    'normal',
    'break-spaces',
    'pre-wrap',
    'no-repeat',
    'repeat-x',
    'text',
    'all',
    '""',
    '10',
    '999',
    '2.25rem',
    '0.875rem',
    '48rem',
    '1200px',
    '40rem',
    '5px',
    '3px',
    '1.25rem',
  ]

  it('every utility the mapper emits for any property and value compiles to CSS in Tailwind', async () => {
    const emitted = new Map<string, string>()
    for (const property of CONVERTED_PROPERTIES) {
      for (const value of VALUES) {
        const out = cssToTailwind(`.x { ${property}: ${value}; line-height: 1.5 }`)
        for (const utility of out.utilities.get('x') ?? []) emitted.set(utility, `${property}: ${value}`)
      }
    }
    expect(emitted.size).toBeGreaterThan(400)
    const built = flat((await compiler()).build([...emitted.keys()]))
    const escape = (utility: string) => utility.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`)
    const missing = [...emitted].filter(
      ([utility]) => !built.includes(`.${escape(utility)} {`) && !built.includes(`.${escape(utility)}:`),
    )
    expect(missing).toEqual([])
  })

  it("writes box shorthands with Tailwind's own names", async () => {
    const out = cssToTailwind(
      '.x { inset: 4px 8px } .y { inset: 4px 8px 12px 16px } .z { margin: 4px 8px 12px } .w { padding: 1px 2px 3px 4px }',
    )
    expect(out.utilities.get('x')).toEqual(['inset-y-1', 'inset-x-2'])
    expect(out.utilities.get('y')).toEqual(['top-1', 'right-2', 'bottom-3', 'left-4'])
    expect(out.utilities.get('z')).toEqual(['mt-1', 'mr-2', 'mb-3', 'ml-2'])
    const built = await build([...out.utilities.values()].flat())
    expect(built).toContain('inset-block: var(--spacing)')
    expect(built).toContain('top: var(--spacing)')
  })

  it('leaves max-width and max-height auto, which Tailwind has no utility for, in the leftover', () => {
    const out = cssToTailwind('.x { max-width: auto; max-height: auto; color: #111 }')
    expect(out.utilities.get('x')).toEqual(['text-[#111]'])
    expect(flat(out.leftover.moduleCss)).toBe('.x { max-width: auto; max-height: auto; }')
  })

  it('keeps the last declaration of a property across rules of one class, per variant', async () => {
    const out = cssToTailwind(
      '.x { color: red; padding: 4px } .x { color: blue } .x:hover { color: red } .x:hover { color: green } @media (min-width: 48rem) { .x { color: #111 } }',
    )
    expect(out.utilities.get('x')).toEqual(['p-1', 'text-[color:blue]', 'hover:text-[color:green]', 'md:text-[#111]'])
    expect(await build(out.utilities.get('x')!)).not.toContain('color: red')
  })

  it('an earlier !important declaration is not replaced by a later plain one', () => {
    const out = cssToTailwind('.x { color: red !important } .x { color: blue }')
    expect(out.utilities.get('x')).toEqual(['text-[color:red]!'])
  })
})
