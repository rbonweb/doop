import { describe, expect, it } from 'vitest'
import { renderInstanceHtml } from '../server/componentEngine.ts'
import { buildReactExport, type ReactExportInput, type ReactExportResult } from '../server/reactExport/index.ts'
import type { ComponentDef } from '../shared/components.ts'
import { normalize, renderAll, typecheck, writeProject } from './reactExportHarness'

function def(name: string, template: string, extra: Partial<ComponentDef> = {}): ComponentDef {
  return {
    id: `c-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    description: '',
    template,
    css: '',
    rawCss: '',
    head: [],
    props: [],
    slots: [],
    rev: 1,
    mainFrameId: null,
    history: [],
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'test',
    ...extra,
  }
}

const exportOf = (
  components: ComponentDef[],
  frames: ReactExportInput['frames'] = [],
  extra: Partial<ReactExportInput> = {},
): ReactExportResult =>
  buildReactExport({
    canvasName: 'test',
    components,
    frames,
    tokens: [],
    themeOrder: [],
    styling: 'modules',
    assetOrigin: 'https://doop.example',
    ...extra,
  })

const fileOf = (result: ReactExportResult, path: string): string => {
  const file = result.files.find((entry) => entry.path === path)
  if (!file) throw new Error(`no file ${path} in ${result.files.map((entry) => entry.path).join(', ')}`)
  return file.content
}
const componentOf = (result: ReactExportResult, name: string) => fileOf(result, `src/components/${name}.tsx`)

const engine = (defs: ComponentDef[]) => ({
  find: (ref: string) => defs.find((entry) => entry.id === ref || entry.name === ref),
  atRev: (id: string) => defs.find((entry) => entry.id === id),
  issues: [],
})
const instance = (target: ComponentDef, defs: ComponentDef[], overrides: object = {}) =>
  renderInstanceHtml(target, { instanceId: 'abcdef', overrides }, engine(defs))
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const frame = (body: string, head = '') => [{ id: 'f1', name: 'Home', html: page(body, head) }]

const KITCHEN = def(
  'Kitchen',
  `<div class="k" data-doop-part="r">
    <h2 data-doop-part="h" data-doop-prop="title">Hello</h2>
    <img data-doop-part="i" data-doop-prop="photo" src="/a/p.png" alt="">
    <a data-doop-part="a" data-doop-prop="href:link,label" href="#">Go</a>
    <button data-doop-part="b" data-doop-prop="disabled:off">X</button>
    <span data-doop-part="s" data-doop-prop="--accent:color,style.opacity:amount">n</span>
    <p data-doop-part="p1" data-doop-if="tone=ghost">ghost</p>
    <p data-doop-part="p2" data-doop-if="!flag">no flag</p>
    <p data-doop-part="p3" data-doop-if="tone!=ghost">not ghost</p>
    <p data-doop-part="p4" data-doop-if="flag">flag</p>
    <p data-doop-part="p5" data-doop-if="missing">never</p>
  </div>`,
  {
    rawCss: '.k { display: grid }\n.k[data-tone="ghost"] { opacity: 0.5 }',
    props: [
      { name: 'title', type: 'text' },
      { name: 'photo', type: 'image' },
      { name: 'link', type: 'link' },
      { name: 'label', type: 'text' },
      { name: 'off', type: 'boolean' },
      { name: 'color', type: 'color' },
      { name: 'amount', type: 'number', min: 0, max: 1, step: 0.1 },
      { name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
      { name: 'flag', type: 'boolean', default: 'false', reflect: true },
    ],
  },
)

describe('prop types, attributes and conditions', () => {
  const result = exportOf([KITCHEN], [], { componentIds: [KITCHEN.id] })
  const tsx = componentOf(result, 'Kitchen')

  it('types each prop from its definition', () => {
    expect(tsx).toContain('title?: string')
    expect(tsx).toContain('photo?: string')
    expect(tsx).toContain('link?: string')
    expect(tsx).toContain('color?: string')
    expect(tsx).toContain('off?: boolean')
    expect(tsx).toContain('amount?: number')
    expect(tsx).toContain('tone?: "primary" | "ghost"')
    expect(tsx).toContain('flag?: boolean')
  })

  it('destructures declared defaults and the template content of text-like props', () => {
    expect(tsx).toContain('tone = "primary"')
    expect(tsx).toContain('flag = false')
    expect(tsx).toContain('title = "Hello"')
    expect(tsx).toContain('label = "Go"')
    expect(tsx).toContain('photo = "https://doop.example/a/p.png"')
  })

  it('writes bindings as expressions, boolean HTML attributes bare and styles as an object', () => {
    expect(tsx).toContain('{title}')
    expect(tsx).toContain('src={photo}')
    expect(tsx).toContain('href={link}')
    expect(tsx).toContain('disabled={off}')
    expect(tsx).toMatch(/style=\{\{ "--accent": .*opacity: /)
  })

  it('reflects enum and reflected boolean props as data attributes on the root', () => {
    expect(tsx).toContain('data-tone={tone}')
    expect(tsx).toContain('data-flag={String(flag)}')
    expect(tsx).not.toContain('data-title')
  })

  it('turns data-doop-if into && with the right comparison for each prop kind', () => {
    expect(tsx).toContain('{tone === "ghost" && (')
    expect(tsx).toContain('{!flag && (')
    expect(tsx).toContain('{tone !== "ghost" && (')
    expect(tsx).toContain('{flag && (')
    expect(tsx).not.toContain('never')
  })

  it('keeps variant selectors in the module so the CSS carries over, and scopes classless rules under the root', () => {
    expect(fileOf(result, 'src/components/Kitchen.module.css')).toContain('.k[data-tone="ghost"]')
    expect(tsx).toContain('className={styles["k"]}')
  })

  it('type-checks strictly and renders the same DOM as Doop for given props', async () => {
    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
      const props = {
        title: 'T',
        tone: 'ghost',
        flag: true,
        off: true,
        amount: 1,
        color: 'red',
        link: '/x',
        label: 'L',
      }
      const out = await renderAll(project, {
        plain: { from: './src/components/Kitchen', name: 'Kitchen' },
        given: { from: './src/components/Kitchen', name: 'Kitchen', props },
      })
      const overrides = (values: Record<string, string>) => normalize(instance(KITCHEN, [KITCHEN], { props: values }))
      expect(normalize(out.given!)).toBe(
        overrides({
          title: 'T',
          tone: 'ghost',
          flag: 'true',
          off: 'true',
          amount: '1',
          color: 'red',
          link: '/x',
          label: 'L',
        }).replace('src="/a/p.png"', 'src="https://doop.example/a/p.png"'),
      )
      expect(normalize(out.plain!)).toContain('Hello')
    } finally {
      project.cleanup()
    }
  })
})

const ICON = def('Icon', '<i class="icon" data-doop-part="r" data-doop-prop="data-size:size"></i>', {
  props: [{ name: 'size', type: 'number', min: 1, max: 9, step: 1 }],
})
const STAR = def('Star', '<b class="star" data-doop-part="r">*</b>')
const TAG = def('Tag', '<em data-doop-part="r" data-doop-prop="text">t</em>', {
  props: [
    { name: 'kind', type: 'enum', options: ['a', 'b'] },
    { name: 'text', type: 'text' },
  ],
})

describe('nested instances, forwarding and slots', () => {
  const ROW = def(
    'Row',
    `<section data-doop-part="r">
      <doop-use component="${ICON.id}" data-doop-part="u1" data-doop-prop="component:icon,size:gap" size="3"></doop-use>
      <doop-use component="${TAG.id}" data-doop-part="u2" data-doop-prop="text:count,kind:tone"></doop-use>
      <div data-doop-part="body" data-doop-slot="body"><p data-doop-part="d">Default body</p></div>
      <div data-doop-part="foot" data-doop-slot="foot"></div>
    </section>`,
    {
      props: [
        { name: 'icon', type: 'instance', default: 'Star' },
        { name: 'gap', type: 'number', min: 1, max: 9, step: 1, default: '2' },
        { name: 'count', type: 'number', default: '1' },
        { name: 'tone', type: 'enum', options: ['a', 'b'] },
      ],
      slots: [
        { name: 'body', suggested: [] },
        { name: 'foot', suggested: [] },
      ],
    },
  )
  const result = exportOf([ROW, ICON, STAR, TAG], [], { componentIds: [ROW.id] })
  const tsx = componentOf(result, 'Row')

  it('passes forwarded props through, converting types where the two sides differ', () => {
    expect(tsx).toContain('text={String(count)}')
    expect(tsx).toContain('kind={tone}')
    expect(tsx).toContain('size={gap}')
  })

  it('renders a component:icon prop as the passed node, falling back to the nested component, and reaches the default one', () => {
    expect(tsx).toContain('icon = <Star />')
    expect(tsx).toMatch(/\{icon \?\? <Icon size=\{gap\} \/>\}/)
    expect(result.files.some((file) => file.path === 'src/components/Star.tsx')).toBe(true)
    expect(tsx).toContain("import { Icon } from './Icon'")
  })

  it('makes a slot a ReactNode prop with its default content, and an empty slot just the node', () => {
    expect(tsx).toContain('body?: ReactNode')
    expect(tsx).toContain('{body ?? (')
    expect(tsx).toContain('{"Default body"}')
    expect(tsx).toContain('{foot}')
  })

  it('passes slot content and prop values from an instance in a page, and nothing for default slot content', async () => {
    const withSlot = instance(ROW, [ROW, ICON, STAR, TAG], {
      props: { tone: 'b' },
      parts: { body: { slot: '<span>custom</span>' } },
    })
    const plain = instance(ROW, [ROW, ICON, STAR, TAG], {})
    const out = exportOf([ROW, ICON, STAR, TAG], frame(`${withSlot}${plain}`))
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain('<Row tone={"b"} body={')
    expect(home).toContain('{"custom"}')
    expect(home).toMatch(/<Row \/>/)
    expect(home).toContain("import { Row } from '../components'")
    expect(out.report.inlined).toEqual([])
  })

  it('type-checks', () => {
    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
    } finally {
      project.cleanup()
    }
  })
})

describe('components mapped to code', () => {
  const BTN = def(
    'Btn',
    '<button data-doop-part="r"><span data-doop-part="l" data-doop-prop="label">Go</span><i data-doop-part="ic" data-doop-slot="icon"></i><i data-doop-part="re" data-doop-slot="rest"></i></button>',
    {
      props: [
        { name: 'label', type: 'text' },
        { name: 'variant', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
        { name: 'size', type: 'enum', options: ['s', 'm'] },
        { name: 'on', type: 'boolean' },
      ],
      slots: [
        { name: 'icon', suggested: [] },
        { name: 'rest', suggested: [] },
      ],
      code: {
        importFrom: '@acme/ui',
        exportName: 'Button',
        props: {
          label: { name: 'children' },
          variant: { name: 'kind', values: { primary: 'solid', ghost: 'outline' } },
          size: { omit: true },
          on: { name: 'active', values: { true: 'yes', false: 'no' } },
        },
        slots: { icon: 'startIcon', rest: 'children' },
      },
    },
  )
  const WRAP = def(
    'Wrap',
    `<div data-doop-part="r"><doop-use component="${BTN.id}" data-doop-part="u" data-doop-prop="label:cta,variant:tone,on:pressed,size:big"></doop-use></div>`,
    {
      props: [
        { name: 'cta', type: 'text' },
        { name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
        { name: 'pressed', type: 'boolean', default: 'false' },
        { name: 'big', type: 'enum', options: ['s', 'm'] },
      ],
    },
  )

  it('imports the export from its package, renames props, maps values and omits the omitted', () => {
    const result = exportOf([BTN, WRAP], [], { componentIds: [WRAP.id] })
    const tsx = componentOf(result, 'Wrap')
    expect(tsx).toContain('import { Button } from "@acme/ui"')
    expect(tsx).toContain('kind={({ "primary": "solid", "ghost": "outline" } as const)[tone]}')
    expect(tsx).toContain('active={(pressed) ? "yes" : "no"}')
    expect(tsx).toContain('{cta}')
    expect(tsx).not.toContain('size=')
    expect(tsx).not.toContain('size={')
    expect(result.files.some((file) => file.path.startsWith('src/components/Btn'))).toBe(false)
    expect(result.report.components.find((entry) => entry.id === BTN.id)).toEqual({
      id: BTN.id,
      name: 'Btn',
      importedFrom: '@acme/ui',
      exportName: 'Button',
    })
  })

  it('maps literal values in a page and puts slots in children or a renamed prop', () => {
    const html = instance(BTN, [BTN], {
      props: { label: 'Save', variant: 'ghost', size: 'm', on: 'true' },
      parts: {},
    })
    const out = exportOf(
      [BTN],
      frame(`${html}<doop-use component="${BTN.id}"><span slot="icon">i</span><span slot="rest">r</span></doop-use>`),
    )
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain('import { Button } from "@acme/ui"')
    expect(home).toMatch(/<Button kind=\{"outline"\} active=\{"yes"\}>\s*\{"Save"\}\s*<\/Button>/)
    expect(home).toMatch(/startIcon=\{<span>/)
    expect(home).toContain('{"r"}')
    expect(home).not.toContain('size')
  })

  it('imports a default export, and aliases a second export of the same name', () => {
    const one = def('One', '<i data-doop-part="r"></i>', {
      code: { importFrom: '@a/ui', exportName: 'Thing', defaultExport: true },
    })
    const two = def('Two', '<i data-doop-part="r"></i>', { code: { importFrom: '@b/ui', exportName: 'Thing' } })
    const three = def('Three', '<i data-doop-part="r"></i>', { code: { importFrom: '@c/ui', exportName: 'Thing' } })
    const out = exportOf(
      [one, two, three],
      frame(
        `<doop-use component="${one.id}"></doop-use><doop-use component="${two.id}"></doop-use><doop-use component="${three.id}"></doop-use>`,
      ),
    )
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain('import Thing from "@a/ui"')
    expect(home).toContain('import { Thing as Thing2 } from "@b/ui"')
    expect(home).toContain('import { Thing as Thing3 } from "@c/ui"')
    expect(home).toContain('<Thing />')
    expect(home).toContain('<Thing2 />')
  })
})

describe('part overrides in pages', () => {
  const BOX = def(
    'Box',
    '<div class="box" data-doop-part="r"><p data-doop-part="t" data-doop-prop="text">Hi</p></div>',
    {
      rawCss: '.box { padding: 4px }',
      props: [{ name: 'text', type: 'text' }],
    },
  )

  it('inlines the markup of an instance with deep overrides and says so in the report', () => {
    const html = instance(BOX, [BOX], {
      props: { text: 'Yo' },
      parts: { t: { attrs: { title: 'tip' }, style: { color: 'red' } } },
    })
    const out = exportOf([BOX], frame(`${html}${instance(BOX, [BOX], { props: { text: 'Plain' } })}`))
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain("import BoxStyles from '../components/Box.module.css'")
    expect(home).toContain('className={BoxStyles["box"]}')
    expect(home).toContain('title="tip"')
    expect(home).toContain('{"Yo"}')
    expect(home).toContain('<Box text={"Plain"} />')
    expect(out.report.inlined).toEqual([
      { file: 'src/pages/Home.tsx', component: 'Box', reason: expect.stringContaining('t: attributes, styles') },
    ])
  })

  it('renders the inlined markup with the same DOM as the instance', async () => {
    const html = instance(BOX, [BOX], { props: { text: 'Yo' }, parts: { t: { attrs: { title: 'tip' } } } })
    const out = exportOf([BOX], frame(html))
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
      const rendered = await renderAll(project, { page: { from: './src/pages/Home', name: 'Home' } })
      const inner = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(rendered.page!)![1]!
      expect(normalize(inner)).toBe(normalize(html))
    } finally {
      project.cleanup()
    }
  })
})

describe('custom elements, URLs and determinism', () => {
  const WIDGET = def(
    'Widget',
    '<my-chart class="w" data-doop-part="r" series="3"><x-axis data-doop-part="a"></x-axis></my-chart>',
    {
      rawCss: '.w { background: url(/a/bg.png) }',
    },
  )

  it('declares every custom element so strict type-checking passes', () => {
    const out = exportOf([WIDGET], [], { componentIds: [WIDGET.id] })
    const dts = fileOf(out, 'src/custom-elements.d.ts')
    expect(dts).toContain('"my-chart": CustomElement')
    expect(dts).toContain('"x-axis": CustomElement')
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
    } finally {
      project.cleanup()
    }
  })

  it('leaves out the custom elements file when none is used', () => {
    expect(
      exportOf([STAR], [], { componentIds: [STAR.id] }).files.some((file) =>
        file.path.endsWith('custom-elements.d.ts'),
      ),
    ).toBe(false)
  })

  it('makes root-relative Doop URLs absolute in attributes, srcset, styles and stylesheets', () => {
    const out = exportOf(
      [WIDGET],
      frame(
        '<img src="/a/x.png" srcset="/a/x.png 1x, /photos/pexels/1.jpeg?w=2 2x"><div style="background:url(/icons/iconify/a/b.svg)"></div><a href="/other">k</a>',
        '<style>.hero{background:url("/a/h.png")}</style>',
      ),
      { componentIds: [WIDGET.id] },
    )
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain('src="https://doop.example/a/x.png"')
    expect(home).toContain('https://doop.example/photos/pexels/1.jpeg?w=2 2x')
    expect(home).toContain('https://doop.example/icons/iconify/a/b.svg')
    expect(home).toContain('href="/other"')
    expect(fileOf(out, 'src/pages/Home.css')).toContain('url("https://doop.example/a/h.png")')
    expect(fileOf(out, 'src/components/Widget.module.css')).toContain('url(https://doop.example/a/bg.png)')
  })

  it('is byte-identical across runs and independent of the order components arrive in', () => {
    const list = [KITCHEN, ICON, STAR, TAG]
    const a = exportOf(list, frame(instance(KITCHEN, list)), { componentIds: [TAG.id] })
    const b = exportOf([...list].reverse(), frame(instance(KITCHEN, list)), { componentIds: [TAG.id] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('refuses a Tailwind export until styling lands and a bad asset origin', () => {
    expect(() => exportOf([STAR], [], { styling: 'tailwind' })).toThrow('tailwind styling lands with S9')
    expect(() => exportOf([STAR], [], { assetOrigin: 'javascript:alert(1)' })).toThrow('assetOrigin')
  })
})

describe('hostile names and text stay data', () => {
  const EVIL = '"}</div><script>globalThis.pwned = 1</script>{`${process.exit()}`}*/ evil() /* '
  const HOSTILE = def(
    `Evil ${EVIL}`,
    `<div class="a b" data-doop-part="r" title="${EVIL.replace(/"/g, '&quot;')}">
      <p data-doop-part="t" data-doop-prop="text">${EVIL.replace(/</g, '&lt;')}</p>
      <div data-doop-part="s" data-doop-slot="slot ${EVIL.replace(/"/g, '&quot;')}">${EVIL.replace(/</g, '&lt;')}</div>
    </div>`,
    {
      props: [
        { name: 'text', type: 'text' },
        { name: 'tone', type: 'enum', options: [EVIL, 'b'], default: EVIL },
      ],
      slots: [{ name: `slot ${EVIL}`, suggested: [] }],
      rawCss: `.a { content: "${EVIL.replace(/[\\"]/g, '')}" }`,
    },
  )

  it('compiles and renders the hostile text as text', async () => {
    const frameHtml = page(
      `<p class="${EVIL.replace(/"/g, '&quot;')}">${EVIL.replace(/</g, '&lt;')}</p>` +
        instance(HOSTILE, [HOSTILE], { props: { text: EVIL } }),
    )
    const out = exportOf([HOSTILE], [{ id: 'f1', name: `Home ${EVIL}`, html: frameHtml }])
    const all = out.files.map((file) => file.content).join('\n')
    expect(all).not.toContain('dangerouslySetInnerHTML')
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
      const pagePath = out.report.pages[0]!.file.replace(/\.tsx$/, '')
      const pageExport = /export function (\w+)\(/.exec(fileOf(out, out.report.pages[0]!.file))![1]!
      const rendered = await renderAll(project, { page: { from: `./${pagePath}`, name: pageExport } })
      expect(rendered.page).not.toContain('<script>')
      expect(rendered.page).toContain('globalThis.pwned = 1')
      expect(rendered.page).toContain('&lt;script&gt;')
    } finally {
      project.cleanup()
    }
  })
})
