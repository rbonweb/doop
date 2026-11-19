// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { componentBundleSchema } from '../shared/componentBundle.ts'
import { buildComponentBundle, type StoryPage } from '../shared/storybook/bundle.ts'
import {
  CAPTURE_PRELUDE,
  captureStory,
  settleStory,
  STYLE_PROPERTIES,
  type CapturedStory,
} from '../shared/storybook/capture.ts'
import type { StoryEntry } from '../shared/storybook/index.ts'
import { planCompound } from '../shared/storybook/compound.ts'
import { scopeVariantSelector } from '../server/bundleVariants.ts'

/** Shaped like the Tailwind v4 shadcn/ui stories of the Storybook the proof imported: parts named by `data-slot`, Radix state on `data-state` and `aria-checked`, and stories with no args at all. */
interface El {
  tag: string
  attrs?: Record<string, string>
  text?: string
  kids?: El[]
}

function flatten(root: El): { el: El; depth: number; parent: number }[] {
  const out: { el: El; depth: number; parent: number }[] = []
  const visit = (el: El, depth: number, parent: number) => {
    const index = out.length
    out.push({ el, depth, parent })
    for (const kid of el.kids ?? []) visit(kid, depth + 1, index)
  }
  visit(root, 0, -1)
  return out
}

/** The capture the page would hand back for this tree, written the way `captureStory` writes it. */
function capture(
  root: El,
  marker?: string,
  styleOf: (index: number) => Record<string, string> = () => ({}),
  textArgs: { prop: string; value: string }[] = [],
): CapturedStory {
  const flat = flatten(root)
  /* the page binds a text arg to the one element whose own text it is */
  const boundText = new Map<number, string>()
  for (const arg of textArgs) {
    const hits = flat.flatMap((entry, at) => (entry.el.text === arg.value ? [at] : []))
    if (hits.length === 1) boundText.set(hits[0]!, arg.prop)
  }
  const html = (index: number): string => {
    const { el } = flat[index]!
    const attrs = Object.entries(el.attrs ?? {})
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('')
    const kids = flat.flatMap((entry, at) => (entry.parent === index ? [html(at)] : [])).join('')
    return `<${el.tag}${attrs}${marker ? ` ${marker}="${index}"` : ''}${boundText.has(index) ? ` data-doop-prop="${boundText.get(index)}"` : ''}>${el.text ?? ''}${kids}</${el.tag}>`
  }
  const nth = new Map<number, number>()
  const counts = new Map<number, number>()
  flat.forEach((entry, index) => {
    if (entry.parent < 0) return
    counts.set(entry.parent, (counts.get(entry.parent) ?? 0) + 1)
    nth.set(index, counts.get(entry.parent)!)
  })
  const paths: string[] = []
  flat.forEach((entry, index) => {
    if (index === 0) paths.push(`${entry.el.tag}.root`)
    else {
      const step = `${entry.el.tag}:nth-child(${nth.get(index)})`
      paths.push(entry.parent === 0 ? step : `${paths[entry.parent]} > ${step}`)
    }
  })
  return {
    ok: true,
    html: html(0),
    css: '',
    sharedRules: [],
    shape: flat.map((entry) => `${entry.depth}${entry.el.tag}`).join(','),
    paths,
    styles: flat.map((_entry, index) => STYLE_PROPERTIES.map((property) => styleOf(index)[property] ?? '')),
    attrs: flat.map((entry) =>
      Object.fromEntries(Object.entries(entry.el.attrs ?? {}).filter(([name]) => name !== 'class' && name !== 'src')),
    ),
    texts: flat.map((entry) => entry.el.text ?? ''),
    srcs: flat.map((entry) => entry.el.attrs?.src ?? ''),
    ...(marker ? { marker } : {}),
    issues: [],
  }
}

const entry = (title: string): StoryEntry => ({
  id: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--default`,
  title,
  name: 'Default',
  type: 'story',
  tags: [],
})

/** A page that answers every story with the tree and meta `tell` gives for its story id and args. */
function pageFor(
  tell: (
    storyId: string,
    args: string,
  ) => { tree: El; meta?: unknown; styles?: (index: number) => Record<string, string> },
): StoryPage {
  let url = ''
  return {
    installProbe: async () => {},
    goto: async (next) => {
      url = next
    },
    waitForState: async () => 'ready',
    readMeta: async () =>
      JSON.stringify(tell(new URL(url).searchParams.get('id') ?? '', '').meta ?? { argTypes: {}, initialArgs: {} }),
    evaluateSource: async () => undefined,
    evaluate: (async (fn: unknown, options: { marker?: string; textArgs?: { prop: string; value: string }[] }) => {
      if (fn === settleStory) return undefined
      if (fn !== captureStory) throw new Error('unexpected evaluate')
      const params = new URL(url).searchParams
      const made = tell(params.get('id') ?? '', params.get('args') ?? '')
      return JSON.stringify(capture(made.tree, options.marker, made.styles, options.textArgs))
    }) as StoryPage['evaluate'],
  }
}

const build = (titles: string[], tell: Parameters<typeof pageFor>[0]) =>
  buildComponentBundle({
    entries: titles.map(entry),
    source: { kind: 'storybook', url: 'https://sb.test/' },
    baseUrl: 'https://sb.test/',
    withPage: async (use) => use(pageFor(tell)),
  })

const card: El = {
  tag: 'div',
  attrs: { 'data-slot': 'card', class: 'bg-card' },
  kids: [
    {
      tag: 'div',
      attrs: { 'data-slot': 'card-header' },
      kids: [
        { tag: 'div', attrs: { 'data-slot': 'card-title' }, text: 'Card Title' },
        { tag: 'div', attrs: { 'data-slot': 'card-description' }, text: 'Card Description' },
      ],
    },
    {
      tag: 'div',
      attrs: { 'data-slot': 'card-content' },
      kids: [{ tag: 'p', text: 'Card Content' }],
    },
    {
      tag: 'div',
      attrs: { 'data-slot': 'card-footer' },
      kids: [{ tag: 'p', text: 'Card Footer' }],
    },
  ],
}

describe('parts of a compound component', () => {
  it('makes the parts that hold markup slots named by their identity, with the captured content as their default', async () => {
    const { bundle, issues } = await build(['Components/Card'], () => ({ tree: card }))
    expect(componentBundleSchema.safeParse(bundle).success).toBe(true)
    const html = bundle.components[0]!.html
    expect(html).toContain('<div data-slot="card-header" data-doop-slot="header">')
    expect(html).toContain('<div data-slot="card-content" data-doop-slot="content"><p>Card Content</p></div>')
    expect(html).toContain('<div data-slot="card-footer" data-doop-slot="footer"><p>Card Footer</p></div>')
    expect(html).toContain('Card Title')
    expect(html).not.toContain('data-doop-prop')
    expect(html).not.toContain('data-doop-m-')
    expect(issues.some((issue) => issue.code === 'slots_from_parts')).toBe(true)
  })

  it('makes a part that is one plain text a text prop named for it, and leaves it out of the React props', async () => {
    const alert: El = {
      tag: 'div',
      attrs: { 'data-slot': 'alert', role: 'alert' },
      kids: [
        { tag: 'div', attrs: { 'data-slot': 'alert-title' }, text: 'Heads up!' },
        { tag: 'div', attrs: { 'data-slot': 'alert-description' }, text: 'You can add components.' },
      ],
    }
    const { bundle } = await build(['Components/Alert'], () => ({ tree: alert }))
    const component = bundle.components[0]!
    expect(component.html).toContain('data-slot="alert-title" data-doop-prop="title"')
    expect(component.html).toContain('data-slot="alert-description" data-doop-prop="description"')
    expect(component.html).not.toContain('data-doop-slot')
    expect(component.props?.map((prop) => prop.name)).toEqual(['title', 'description'])
    expect(component.code?.props?.title).toEqual({ omit: true })
  })

  it('leaves a decorative part alone and names a lone text part (an avatar fallback)', async () => {
    const avatar: El = {
      tag: 'span',
      attrs: { 'data-slot': 'avatar' },
      kids: [{ tag: 'span', attrs: { 'data-slot': 'avatar-fallback' }, text: 'CN' }],
    }
    const { bundle } = await build(['Components/Avatar'], () => ({ tree: avatar }))
    expect(bundle.components[0]!.html).toContain('data-slot="avatar-fallback" data-doop-prop="fallback">CN<')
    expect(bundle.components[0]!.props?.[0]).toMatchObject({ name: 'fallback', type: 'text' })

    const thumb: El = {
      tag: 'button',
      attrs: { 'data-slot': 'switch' },
      kids: [{ tag: 'span', attrs: { 'data-slot': 'switch-thumb' } }],
    }
    const plain = await build(['Components/Switch'], () => ({ tree: thumb }))
    expect(plain.bundle.components[0]!.html).not.toContain('data-doop')
  })

  it('does not slot a region that already follows a text arg', async () => {
    const meta = { argTypes: { heading: { control: 'text' } }, initialArgs: { heading: 'Card Title' } }
    const { bundle } = await build(['Components/Card'], () => ({ tree: card, meta }))
    const html = bundle.components[0]!.html
    expect(html).not.toContain('data-doop-slot="header"')
    expect(html).toContain('data-doop-slot="content"')
  })

  it('names the other components of the Storybook that a render holds, once', async () => {
    const form: El = {
      tag: 'div',
      attrs: { 'data-slot': 'tabs' },
      kids: [
        {
          tag: 'div',
          attrs: { 'data-slot': 'tabs-content' },
          kids: [{ tag: 'input', attrs: { 'data-slot': 'input', placeholder: 'Name' } }],
        },
      ],
    }
    const input: El = { tag: 'input', attrs: { 'data-slot': 'input', placeholder: 'Name' } }
    const { issues } = await build(['Components/Tabs', 'Components/Input'], (id) => ({
      tree: id.startsWith('components-tabs') ? form : input,
    }))
    const composite = issues.filter((issue) => issue.code === 'composite_story')
    expect(composite).toHaveLength(1)
    expect(composite[0]).toMatchObject({ component: 'Tabs' })
    expect(composite[0]!.message).toContain('Input')
  })
})

describe('props that are native attributes', () => {
  it('binds a text arg to the attribute that shows its value, and an image arg to the src', async () => {
    const input: El = {
      tag: 'div',
      attrs: { 'data-slot': 'field' },
      kids: [
        { tag: 'input', attrs: { 'data-slot': 'input', placeholder: 'Enter text here...' } },
        { tag: 'img', attrs: { alt: 'avatar', src: 'https://sb.test/avatar.png' } },
      ],
    }
    const meta = {
      argTypes: { placeholder: { control: 'text' }, photo: { control: 'text' } },
      initialArgs: { placeholder: 'Enter text here...', photo: '/avatar.png' },
    }
    const { bundle } = await build(['Components/Field'], () => ({ tree: input, meta }))
    const component = bundle.components[0]!
    expect(component.html).toContain('placeholder="Enter text here..." data-doop-prop="placeholder:placeholder"')
    expect(component.html).toContain('data-doop-prop="src:photo,alt:alt"')
    const props = Object.fromEntries((component.props ?? []).map((prop) => [prop.name, prop.type]))
    expect(props).toMatchObject({ placeholder: 'text', photo: 'image' })
    /* an alt nothing names is still content: its own prop */
    expect(props).toHaveProperty('alt', 'text')
  })

  it('makes a prop for a placeholder in a story with no args at all', async () => {
    const input: El = { tag: 'input', attrs: { 'data-slot': 'input', placeholder: 'Enter text here...' } }
    const { bundle } = await build(['Components/Input'], () => ({ tree: input }))
    const component = bundle.components[0]!
    expect(component.html).toContain('data-doop-prop="placeholder:placeholder"')
    expect(component.props).toEqual([{ name: 'placeholder', type: 'text' }])
    expect(component.code?.props?.placeholder).toBeUndefined()
  })

  it('binds a presence boolean to the one control that can carry it, even when it is off in the default', async () => {
    const field: El = {
      tag: 'label',
      kids: [
        { tag: 'input', attrs: { type: 'checkbox' } },
        { tag: 'span', text: 'Accept' },
      ],
    }
    const meta = { argTypes: { checked: { control: 'boolean' } }, initialArgs: { checked: false } }
    const { bundle } = await build(['Components/Check'], () => ({ tree: field, meta }))
    const component = bundle.components[0]!
    expect(component.html).toContain('<input type="checkbox" data-doop-prop="checked:checked">')
    expect(component.props?.find((prop) => prop.name === 'checked')).toMatchObject({
      type: 'boolean',
      default: 'false',
    })
  })

  it('follows a Radix state: aria-checked is the prop, and the look data-state carries comes along as the value’s CSS', async () => {
    const make = (on: boolean): El => ({
      tag: 'button',
      attrs: {
        role: 'switch',
        'aria-checked': String(on),
        'data-state': on ? 'checked' : 'unchecked',
        'data-slot': 'switch',
      },
      kids: [{ tag: 'span', attrs: { 'data-slot': 'switch-thumb', 'data-state': on ? 'checked' : 'unchecked' } }],
    })
    const meta = { argTypes: { checked: { control: 'boolean' } }, initialArgs: { checked: false } }
    const { bundle } = await build(['Components/Switch'], (_id, args) => {
      const on = args.includes('checked:!true')
      return {
        tree: make(on),
        meta,
        styles: (index): Record<string, string> => (index === 0 && on ? { 'background-color': 'rgb(0, 0, 0)' } : {}),
      }
    })
    const component = bundle.components[0]!
    expect(component.html).toContain('aria-checked="false"')
    expect(component.html).toContain('data-doop-prop="aria-checked:checked"')
    expect(component.props?.find((prop) => prop.name === 'checked')).toMatchObject({ type: 'boolean', reflect: true })
    expect(component.variants?.checked?.true?.css).toContain('background-color: rgb(0, 0, 0)')
  })
})

describe('a state the markup says twice, in a story with no args', () => {
  const switchEl: El = {
    tag: 'button',
    attrs: { role: 'switch', 'aria-checked': 'false', 'data-state': 'unchecked', 'data-slot': 'switch' },
    kids: [{ tag: 'span', attrs: { 'data-state': 'unchecked', 'data-slot': 'switch-thumb' } }],
  }
  const css =
    '.on\\:bg[data-state="checked"] { background-color: black; }\n.off\\:bg[data-state="unchecked"] { background-color: grey; }\n.on\\:move[data-state="checked"] { translate: 14px; }'

  it('makes a boolean that follows aria-checked, and gives its on state the library rules keyed to data-state="checked"', async () => {
    const page = pageFor(() => ({ tree: switchEl }))
    const inner = page.evaluate
    page.evaluate = (async (fn: unknown, options: unknown) => {
      const raw = (await inner(fn as never, options as never)) as unknown
      return typeof raw === 'string' ? JSON.stringify({ ...JSON.parse(raw), css }) : raw
    }) as StoryPage['evaluate']
    const { bundle } = await buildComponentBundle({
      entries: [entry('Components/Switch')],
      source: { kind: 'storybook', url: 'https://sb.test/' },
      baseUrl: 'https://sb.test/',
      withPage: async (use) => use(page),
    })
    const component = bundle.components[0]!
    expect(component.html).toContain('data-doop-prop="aria-checked:checked"')
    expect(component.props).toEqual([{ name: 'checked', type: 'boolean', default: 'false', reflect: true }])
    const on = component.variants?.checked?.true?.css ?? ''
    expect(on).toContain('.on\\:bg {')
    expect(on).toContain('.on\\:move {')
    expect(on).not.toContain('grey')
    expect(component.code?.props?.checked).toBeUndefined()
  })

  it('names an image source after the attribute, so it passes through to the element', async () => {
    const avatar: El = {
      tag: 'span',
      attrs: { 'data-slot': 'avatar' },
      kids: [{ tag: 'img', attrs: { 'data-slot': 'avatar-image', alt: '@shadcn', src: 'https://sb.test/a.png' } }],
    }
    const { bundle } = await build(['Components/Avatar'], () => ({ tree: avatar }))
    const component = bundle.components[0]!
    expect(component.html).toContain('data-doop-prop="alt:alt,src:src"')
    expect(component.props?.find((prop) => prop.name === 'src')).toMatchObject({ type: 'image' })
  })
})

describe('a story that shows the component among others', () => {
  const pageWith = (html: string, focus: string): Promise<CapturedStory | { ok: false }> => {
    document.body.innerHTML = `<div id="storybook-root">${html}</div>`
    const parsed = captureStory({
      textArgs: [],
      marker: 'data-doop-m-test',
      styleProperties: STYLE_PROPERTIES,
      maxBytes: 2_000_000,
      maxElements: 300,
      focus,
    })
    return Promise.resolve(JSON.parse(parsed as string) as CapturedStory)
  }
  const labelStory =
    '<div class="grid w-full"><label data-slot="label" for="email">Email</label><input data-slot="input" id="email" placeholder="Enter your email"></div>'

  it('captures the part that names itself after the component, and says the story was a composite', async () => {
    new Function(CAPTURE_PRELUDE)()
    const shot = (await pageWith(labelStory, 'Label')) as CapturedStory
    expect(shot.html.startsWith('<label')).toBe(true)
    expect(shot.html).not.toContain('<input')
    expect(shot.texts?.[0]).toBe('Email')
    expect(shot.issues.map((issue) => issue.code)).toContain('composite_story')
  })

  it('keeps the whole render when no part names itself so, or the root already does', async () => {
    const whole = (await pageWith(labelStory, 'Form')) as CapturedStory
    expect(whole.html.startsWith('<div')).toBe(true)
    expect(whole.issues.map((issue) => issue.code)).not.toContain('composite_story')
    const own = (await pageWith('<label data-slot="label">Email</label>', 'Label')) as CapturedStory
    expect(own.issues).toEqual([])
  })
})

describe('planCompound', () => {
  it('does nothing for a capture that has no texts or whose shape does not line up', () => {
    const shot = capture(card)
    const base = {
      props: [],
      bound: new Set<string>(),
      occupied: new Set<number>(),
      boundAttrs: new Set<string>(),
      taken: new Set<string>(),
      bundleNames: new Set<string>(),
    }
    expect(planCompound({ ...base, capture: { ...shot, texts: undefined } }).slots.size).toBe(0)
    expect(planCompound({ ...base, capture: { ...shot, shape: '0div' } }).slots.size).toBe(0)
    expect(planCompound({ ...base, capture: shot }).slots.size).toBe(3)
  })

  it('refuses a part whose derived name reads as an event handler', () => {
    const tree: El = {
      tag: 'div',
      attrs: { 'data-slot': 'card' },
      kids: [{ tag: 'div', attrs: { 'data-slot': 'card-on-click' }, kids: [{ tag: 'p', text: 'hi' }] }],
    }
    const plan = planCompound({
      capture: capture(tree),
      props: [],
      bound: new Set(),
      occupied: new Set(),
      boundAttrs: new Set(),
      taken: new Set(),
      bundleNames: new Set(),
    })
    expect([...plan.slots.values()]).not.toContain('on-click')
    expect(plan.added.map((prop) => prop.name)).not.toContain('on-click')
  })

  it('refuses an identity that is not a plain name, so a page cannot put markup in a slot name', () => {
    const hostile: El = {
      tag: 'div',
      attrs: { 'data-slot': 'x' },
      kids: [{ tag: 'div', attrs: { 'data-slot': 'x-"><script>' }, kids: [{ tag: 'p', text: 'hi' }] }],
    }
    const plan = planCompound({
      capture: capture(hostile),
      props: [],
      bound: new Set(),
      occupied: new Set(),
      boundAttrs: new Set(),
      taken: new Set(),
      bundleNames: new Set(),
    })
    expect(plan.slots.size).toBe(0)
  })
})

describe('scoping a Tailwind class to the root', () => {
  const root = { tag: 'button', id: undefined, classes: new Set(['data-[state=checked]:bg-primary', 'size-4']) }

  it('compounds an escaped utility class onto the root that carries it, and nests one the root lacks', () => {
    expect(scopeVariantSelector('.data-\\[state\\=checked\\]\\:bg-primary', '[data-checked="true"]', root)).toBe(
      '.data-\\[state\\=checked\\]\\:bg-primary[data-checked="true"]',
    )
    expect(scopeVariantSelector('.data-\\[state\\=checked\\]\\:x', '[data-checked="true"]', root)).toBe(
      '[data-checked="true"] .data-\\[state\\=checked\\]\\:x',
    )
  })
})
