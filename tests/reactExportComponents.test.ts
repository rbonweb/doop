import { selectAll } from 'css-select'
import { parse } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'
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
    expect(home).toMatch(/<Button kind=\{"outline"\} active=\{"yes"\}>\s*Save\s*<\/Button>/)
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

describe('children and component props of a mapped export', () => {
  const OCTICONS = '@primer/octicons-react'
  const ICON_OPTIONS = ['EyeIcon', 'HeartIcon', 'XIcon']
  const button = (code: NonNullable<ComponentDef['code']>, extra: Partial<ComponentDef> = {}) =>
    def('Btn', '<button data-doop-part="r"><span data-doop-part="l" data-doop-prop="label">Go</span></button>', {
      props: [
        { name: 'label', type: 'text' },
        { name: 'variant', type: 'enum', options: ['default', 'primary'], default: 'default' },
        { name: 'trailing-visual', type: 'enum', options: ICON_OPTIONS },
      ],
      code: { importFrom: '@primer/react', exportName: 'Button', props: { label: { name: 'children' } }, ...code },
      ...extra,
    })
  const use = (target: ComponentDef, attrs: string) => `<doop-use component="${target.id}" ${attrs}></doop-use>`
  const homeOf = (target: ComponentDef, body: string, extra: ComponentDef[] = []) => {
    const out = exportOf([target, ...extra], frame(body))
    return { out, home: fileOf(out, 'src/pages/Home.tsx') }
  }

  it('passes a label mapped to children as JSX text, and the design text when the instance sets none', () => {
    const btn = button({})
    const { home } = homeOf(btn, `${use(btn, 'label="Buy now" variant="primary"')}${use(btn, '')}`)
    expect(home).toMatch(/<Button variant=\{"primary"\}>\s*Buy now\s*<\/Button>/)
    expect(home).toMatch(/<Button>\s*Go\s*<\/Button>/)
  })

  it('keeps anything that is not plain text a string literal: braces, tags, quotes, ampersands, edge spaces', () => {
    const btn = button({})
    for (const label of ['a {b}', '<b>x</b>', 'say "hi"', 'Tom & Jerry', ' padded ', "it's", 'back\\slash']) {
      const { home } = homeOf(btn, use(btn, `label="${label.replace(/"/g, '&quot;')}"`))
      expect(home).toMatch(/<Button>\s*\{"/)
      expect(home).not.toMatch(/<Button>\s*[^{\s]/)
    }
    const { home } = homeOf(btn, use(btn, 'label="</Button><script>alert(1)</script>"'))
    expect(home).not.toContain('<script')
    expect(home).toContain('\\u003c/Button>')
  })

  it('leaves an empty label out and self-closes', () => {
    const btn = button({})
    const { home } = homeOf(btn, use(btn, 'label=""'))
    expect(home).toContain('<Button />')
  })

  it('passes an icon enum as the imported component, once per package however often it is used', () => {
    const btn = button({
      props: {
        label: { name: 'children' },
        'trailing-visual': { name: 'trailingVisual', component: { importFrom: OCTICONS } },
      },
    })
    const { out, home } = homeOf(
      btn,
      `${use(btn, 'label="A" trailing-visual="HeartIcon"')}${use(btn, 'label="B" trailing-visual="HeartIcon"')}${use(btn, 'label="C" trailing-visual="XIcon"')}`,
    )
    expect(home).toMatch(/<Button trailingVisual=\{HeartIcon\}>\s*A\s*<\/Button>/)
    expect(home).toMatch(/<Button trailingVisual=\{XIcon\}>\s*C\s*<\/Button>/)
    expect(home).not.toContain('"HeartIcon"')
    expect(home.match(/from "@primer\/octicons-react"/g)).toHaveLength(1)
    expect(home).toContain('import { HeartIcon, XIcon } from "@primer/octicons-react"')
    expect(out.report.issues).toEqual([])
  })

  it('takes the export name from values when it differs from the option', () => {
    const btn = button({
      props: {
        'trailing-visual': {
          name: 'trailingVisual',
          component: { importFrom: OCTICONS },
          values: { HeartIcon: 'HeartFillIcon' },
        },
      },
    })
    const { home } = homeOf(btn, use(btn, 'trailing-visual="HeartIcon"'))
    expect(home).toContain('trailingVisual={HeartFillIcon}')
  })

  it('looks a runtime value up over every option and imports them all', () => {
    const btn = button({
      props: { 'trailing-visual': { name: 'trailingVisual', component: { importFrom: OCTICONS } } },
    })
    const wrap = def('Wrap', `<div data-doop-part="r">${use(btn, 'data-doop-prop="trailing-visual:glyph"')}</div>`, {
      props: [{ name: 'glyph', type: 'enum', options: ICON_OPTIONS }],
    })
    const out = exportOf([btn, wrap], [], { componentIds: [wrap.id] })
    const tsx = componentOf(out, 'Wrap')
    expect(tsx).toContain(
      'trailingVisual={glyph === undefined ? undefined : ({ "EyeIcon": EyeIcon, "HeartIcon": HeartIcon, "XIcon": XIcon } as const)[glyph]}',
    )
    expect(tsx).toContain('import { EyeIcon, HeartIcon, XIcon } from "@primer/octicons-react"')
  })

  it("names a different local when a component of the export already has the icon's name", () => {
    const btn = button({
      props: { 'trailing-visual': { name: 'trailingVisual', component: { importFrom: OCTICONS } } },
    })
    const clash = def('HeartIcon', '<i data-doop-part="r"></i>')
    const { home } = homeOf(btn, `${use(clash, '')}${use(btn, 'trailing-visual="HeartIcon"')}`, [clash])
    expect(home).toContain('import { HeartIcon as HeartIcon2 } from "@primer/octicons-react"')
    expect(home).toContain('trailingVisual={HeartIcon2}')
  })

  it('never writes a string for a component it cannot import: undefined with the value in a comment, and a report line', () => {
    const btn = button({ props: { 'trailing-visual': { name: 'trailingVisual', component: {} } } })
    const { out, home } = homeOf(
      btn,
      `${use(btn, 'trailing-visual="HeartIcon"')}${use(btn, 'trailing-visual="HeartIcon"')}`,
    )
    expect(home).toContain('trailingVisual={undefined /* TODO: pass HeartIcon */}')
    expect(home).not.toContain('"HeartIcon"')
    expect(home).not.toContain('octicons')
    const lines = out.report.issues.filter((issue) => issue.detail.includes('HeartIcon'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toContain('Button:')
    expect(lines[0]?.detail).toContain('"trailing-visual"')
  })

  it('refuses a package that is a path, and passes values that are not identifiers as nothing', () => {
    const btn = button({
      props: { 'trailing-visual': { name: 'trailingVisual', component: { importFrom: '../../etc/icons' } } },
    })
    const { out, home } = homeOf(btn, use(btn, 'trailing-visual="EyeIcon"'))
    expect(home).not.toContain('../../etc')
    expect(home).toContain('trailingVisual={undefined /* TODO: pass EyeIcon */}')
    expect(out.report.issues.some((issue) => issue.detail.includes('not a package name'))).toBe(true)
    const odd = button({
      props: {
        'trailing-visual': { name: 'trailingVisual', component: { importFrom: OCTICONS }, values: { EyeIcon: 'a-b' } },
      },
    })
    expect(homeOf(odd, use(odd, 'trailing-visual="EyeIcon"')).home).toContain('trailingVisual={undefined}')
  })

  it('gives a lowercase export a capitalized local so a prop of a generated component cannot shadow it', () => {
    const btn = button({
      props: { 'trailing-visual': { name: 'trailingVisual', component: { importFrom: OCTICONS } } },
    })
    const wrap = def(
      'Wrap',
      `<div data-doop-part="r"><span data-doop-part="t" data-doop-prop="heart">x</span>${use(btn, 'trailing-visual="heart"')}</div>`,
      {
        props: [{ name: 'heart', type: 'text' }],
      },
    )
    const odd = {
      ...btn,
      props: btn.props.map((prop) =>
        prop.name === 'trailing-visual' ? { ...prop, options: ['heart', 'XIcon'] } : prop,
      ),
    }
    const out = exportOf([odd, wrap], [], { componentIds: [wrap.id] })
    const tsx = componentOf(out, 'Wrap')
    expect(tsx).toContain('import { heart as Heart } from "@primer/octicons-react"')
    expect(tsx).toContain('trailingVisual={Heart}')
  })

  it('reports two props mapped to children', () => {
    const btn = button({ props: { label: { name: 'children' }, variant: { name: 'children' } } })
    const { out } = homeOf(btn, use(btn, 'label="A" variant="primary"'))
    expect(out.report.issues.some((issue) => /all passed as the children of "Button"/.test(issue.detail))).toBe(true)
  })

  it('leaves a plain enum a string', () => {
    const btn = button({ props: { label: { name: 'children' }, 'trailing-visual': { name: 'trailingVisual' } } })
    const { home } = homeOf(btn, use(btn, 'trailing-visual="HeartIcon"'))
    expect(home).toContain('trailingVisual={"HeartIcon"}')
  })

  it('leaves out a hyphenated enum the mapping does not rename, and says so', () => {
    const btn = button({})
    const { out, home } = homeOf(btn, use(btn, 'trailing-visual="HeartIcon"'))
    expect(home).not.toContain('trailing-visual')
    expect(out.report.issues.map((issue) => issue.detail)).toEqual([
      expect.stringContaining('Button: prop "trailing-visual" was set to "HeartIcon" on an instance and left out'),
    ])
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
    expect(fileOf(out, 'src/components/Widget.module.css')).toContain('url("https://doop.example/a/bg.png")')
  })

  it('is byte-identical across runs and independent of the order components arrive in', () => {
    const list = [KITCHEN, ICON, STAR, TAG]
    const a = exportOf(list, frame(instance(KITCHEN, list)), { componentIds: [TAG.id] })
    const b = exportOf([...list].reverse(), frame(instance(KITCHEN, list)), { componentIds: [TAG.id] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('refuses an unknown styling and a bad asset origin', () => {
    expect(() => exportOf([STAR], [], { styling: 'sass' as never })).toThrow('styling')
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

describe('attributes the intrinsic type does not accept', () => {
  const ODD = def(
    'Odd',
    '<div data-doop-part="r" align="center" foo="1"><i data-doop-part="i" data-doop-prop="size:size,data-foo:foo" size="3" bar="x">t</i><a data-doop-part="a" href="/a/z.png" target="_blank" wibble="y">k</a></div>',
    {
      props: [
        { name: 'size', type: 'text' },
        { name: 'foo', type: 'text' },
      ],
    },
  )

  it('passes them as a spread so strict type-checking still holds, and keeps the values', async () => {
    const out = exportOf([ODD], frame(instance(ODD, [ODD], { props: { size: '7' } })), { componentIds: [ODD.id] })
    const tsx = componentOf(out, 'Odd')
    expect(tsx).toContain('{...{')
    expect(tsx).toContain('"size": size')
    expect(tsx).toContain('"bar": "x"')
    expect(tsx).toContain('data-foo={foo}')
    expect(tsx).toContain('wibble')
    expect(tsx).not.toMatch(/ size=/)
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
      const rendered = await renderAll(project, {
        odd: { from: './src/components/Odd', name: 'Odd', props: { size: '9' } },
      })
      expect(rendered.odd).toContain('size="9"')
      expect(rendered.odd).toContain('bar="x"')
      expect(rendered.odd).toContain('wibble="y"')
      expect(rendered.odd).toContain('align="center"')
    } finally {
      project.cleanup()
    }
  })
})

describe('review fixes', () => {
  const plain = (name: string, extra: Partial<ComponentDef> = {}) => def(name, '<i data-doop-part="r"></i>', extra)
  const mappedTo = (name: string, code: NonNullable<ComponentDef['code']>, extra: Partial<ComponentDef> = {}) =>
    plain(name, { code, ...extra })
  const callIt = (target: ComponentDef) => exportOf([target], frame(`<doop-use component="${target.id}"></doop-use>`))

  it('reads value maps and tables by own keys only', () => {
    const target = mappedTo(
      'Btn',
      { importFrom: '@acme/ui', exportName: 'Button', props: { tone: { values: { a: 'x', b: 3 } } } },
      { props: [{ name: 'tone', type: 'enum', options: ['toString', 'constructor', 'valueOf', 'a'], default: 'a' }] },
    )
    const wrap = def(
      'Wrap',
      `<div data-doop-part="r"><doop-use component="${target.id}" data-doop-part="u" data-doop-prop="tone:t"></doop-use></div>`,
      {
        props: [{ name: 't', type: 'enum', options: ['toString', 'constructor', 'valueOf', 'a'], default: 'a' }],
      },
    )
    const tsx = componentOf(exportOf([target, wrap], [], { componentIds: [wrap.id] }), 'Wrap')
    expect(tsx).not.toContain('native code')
    expect(tsx).toContain('"toString": "toString"')
    expect(tsx).toContain('"constructor": "constructor"')
    expect(tsx).toContain('"a": "x"')
  })

  it('keeps a class named __proto__ out of the module lookup', () => {
    const odd = def('Odd', '<div class="__proto__ ok" data-doop-part="r"></div>', {
      rawCss: '.__proto__ { color: red } .ok { color: blue }',
    })
    const tsx = componentOf(exportOf([odd], [], { componentIds: [odd.id] }), 'Odd')
    expect(tsx).not.toContain('styles["__proto__"]')
    expect(tsx).toContain('styles["ok"]')
  })

  it('cuts instance-prop default cycles, reports them and renders', async () => {
    const ph = def('Ph', '<b data-doop-part="r">ph</b>')
    const j1 = def(
      'J1',
      `<div data-doop-part="r"><doop-use component="${ph.id}" data-doop-part="u" data-doop-prop="component:y"></doop-use></div>`,
      {
        props: [{ name: 'y', type: 'instance', default: 'J2' }],
      },
    )
    const j2 = def(
      'J2',
      `<div data-doop-part="r"><doop-use component="${ph.id}" data-doop-part="u" data-doop-prop="component:z"></doop-use></div>`,
      {
        props: [{ name: 'z', type: 'instance', default: 'J1' }],
      },
    )
    const out = exportOf([ph, j1, j2], [], { componentIds: [j1.id] })
    expect(
      out.report.issues.some(
        (issue) => issue.kind === 'dropped-attribute' && issue.detail.includes('renders this component again'),
      ),
    ).toBe(true)
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
      const rendered = await renderAll(project, {
        j1: { from: './src/components/J1', name: 'J1' },
        j2: { from: './src/components/J2', name: 'J2' },
      })
      expect(rendered.j1).toContain('ph')
      expect(rendered.j2).toContain('ph')
    } finally {
      project.cleanup()
    }
  })

  it('puts every page selector under the page root class', () => {
    const css = [
      'html, body { margin: 0 }',
      'body:not(.a) { color: red }',
      'body::before { content: "" }',
      'body * { box-sizing: border-box }',
      'BODY { padding: 0 }',
      'body > .a { gap: 1px }',
      'body.dark .x { color: white }',
      'html.dark { color: white }',
      '.card { padding: 4px }',
      'nav a.active { color: red }',
      '::selection { color: red }',
      ':root { --x: 1 }',
      '@media (min-width: 600px) { .card { padding: 8px } body { margin: 1px } }',
      '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }',
    ].join('\n')
    const out = exportOf([], frame('<p class="card">x</p>', `<style>${css}</style>`))
    const sheet = fileOf(out, 'src/pages/Home.css')
    const selectors = [...sheet.matchAll(/^([^\s@}{][^{]*)\{/gm)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()))
    for (const selector of selectors) {
      expect(
        selector === ':root' ||
          selector.startsWith('.page-Home') ||
          selector === 'html.dark .page-Home' ||
          /^(from|to)$/.test(selector),
      ).toBe(true)
    }
    expect(sheet).toContain('.page-Home:not(.a)')
    expect(sheet).toContain('.page-Home > .a')
    expect(sheet).toContain('.page-Home.dark .x')
    expect(sheet).toContain('.page-Home .card')
    expect(sheet).toContain('.page-Home nav a.active')
    expect(sheet).toContain(':root')
    expect(sheet).toContain('@keyframes spin')
    expect(sheet).not.toMatch(/^(body|html)\s*[,{]/im)
    expect(sheet).not.toMatch(/^body/im)
  })

  it('suffixes component names that are Windows device names', () => {
    const names = ['Con', 'Aux', 'Nul', 'Com1', 'Lpt9', 'Prn']
    const defs = names.map((name) => plain(name))
    const out = exportOf(defs, [], { componentIds: defs.map((d) => d.id) })
    const paths = out.files.map((file) => file.path)
    for (const name of names) expect(paths).toContain(`src/components/${name}View.tsx`)
    expect(paths.some((path) => /components\/(Con|Aux|Nul|Com1|Lpt9|Prn)\./.test(path))).toBe(false)
  })

  it('refuses bad prop renames, duplicates and reserved names, and says so', () => {
    const target = mappedTo(
      'Btn',
      {
        importFrom: '@acme/ui',
        exportName: 'Button',
        props: {
          a: { name: 'x' },
          b: { name: 'x' },
          c: { name: 'dangerouslySetInnerHTML' },
          d: { name: 'not valid' },
          e: { values: { nope: 'z', a: 'y' } },
        },
        slots: { body: 'x', foot: 'children' },
      },
      {
        props: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text' },
          { name: 'c', type: 'text' },
          { name: 'd', type: 'text' },
          { name: 'e', type: 'enum', options: ['a', 'b'] },
          { name: 'key', type: 'text' },
        ],
        slots: [
          { name: 'body', suggested: [] },
          { name: 'foot', suggested: [] },
        ],
      },
    )
    const html = instance(target, [target], { props: { a: '1', b: '2', c: '3', d: '4', e: 'a', key: 'k' } })
    const out = exportOf([target], frame(html))
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toContain('x={"1"}')
    expect(home).not.toContain('x={"2"}')
    expect(home).not.toContain('dangerouslySetInnerHTML')
    expect(home).not.toContain('not valid')
    expect(home).not.toContain('key=')
    const details = out.report.issues.map((issue) => issue.detail).join('\n')
    expect(details).toContain('already uses')
    expect(details).toContain('React reserves')
    expect(details).toContain('not a prop name')
    expect(details).toContain('"nope", which is not one of its values')
  })

  it('imports only from a bare package specifier and generates the component otherwise', () => {
    for (const importFrom of [
      '../../secret',
      './x',
      '/abs/x',
      'file:///x',
      'https://x.example/a',
      'node:fs',
      '@a/b/../../c',
      'a b',
    ]) {
      const target = mappedTo('Btn', { importFrom, exportName: 'Button' })
      const out = callIt(target)
      expect(out.files.some((file) => file.path === 'src/components/Btn.tsx')).toBe(true)
      expect(fileOf(out, 'src/pages/Home.tsx')).not.toContain(importFrom)
      expect(out.report.issues.some((issue) => issue.detail.includes('package name'))).toBe(true)
    }
    const good = mappedTo('Btn', { importFrom: '@acme/ui/button', exportName: 'Button' })
    expect(fileOf(callIt(good), 'src/pages/Home.tsx')).toContain('from "@acme/ui/button"')
    expect(
      fileOf(callIt(mappedTo('Btn', { importFrom: 'acme-ui', exportName: 'Button' })), 'src/pages/Home.tsx'),
    ).toContain('from "acme-ui"')
  })

  it('keeps the html ancestor of a dark theme rule and matches the page it styles', () => {
    const css = [
      'html[data-doop-theme=dark] .x { color: white }',
      '[data-doop-theme=dark] body { background: black }',
      'html.dark body .x { color: red }',
      'body.dark .x { color: blue }',
      'html > body > .x { margin: 0 }',
      'body:not(.a) .x { padding: 0 }',
    ].join('\n')
    const out = exportOf([], frame('<p class="x">x</p>', `<style>${css}</style>`))
    const sheet = fileOf(out, 'src/pages/Home.css')
    expect(sheet).toContain('html[data-doop-theme=dark] .page-Home .x')
    expect(sheet).toContain('[data-doop-theme=dark] .page-Home')
    expect(sheet).toContain('html.dark .page-Home .x')
    expect(sheet).toContain('.page-Home.dark .x')
    expect(sheet).toContain('html > .page-Home > .x')
    expect(sheet).toContain('.page-Home:not(.a) .x')
    expect(sheet).not.toMatch(/^[^\n]*\bbody\b[^\n]*\{/m)
    // the app's DOM: the theme on <html>, the page's root inside the app's body
    const dom = parse(
      '<!doctype html><html data-doop-theme="dark" class="dark"><body><div class="page-Home dark"><p class="x">x</p></div></body></html>',
      { treeAdapter: adapter },
    )
    const matches = (selector: string) => selectAll(selector, dom as never).length
    expect(matches('html[data-doop-theme=dark] .page-Home .x')).toBe(1)
    expect(matches('[data-doop-theme=dark] .page-Home')).toBe(1)
    expect(matches('html.dark .page-Home .x')).toBe(1)
    expect(matches('.page-Home.dark .x')).toBe(1)
    expect(fileOf(out, 'README.md')).toContain('data-doop-theme="dark"')
  })

  it('turns a Google Fonts stylesheet link into src/fonts.css instead of dropping it', () => {
    const link =
      '<link rel="stylesheet" data-doop-webfonts href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;display=swap">'
    const font =
      '<style data-doop-fonts>@font-face{font-family:"Brand";src:url(/a/brand.woff2) format("woff2")}</style>'
    const evil = '<link rel="stylesheet" href="https://evil.example/x.css">'
    for (const styling of ['modules', 'tailwind'] as const) {
      const out = exportOf([], frame('<p>x</p>', `${link}${font}${evil}`), { styling })
      const fonts = fileOf(out, 'src/fonts.css')
      expect(fonts).toBe('@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap");\n')
      expect(fileOf(out, 'src/pages/Home.tsx')).toContain("import '../fonts.css'")
      expect(fileOf(out, 'src/pages/Home.css')).toContain('url("https://doop.example/a/brand.woff2")')
      expect(fileOf(out, 'README.md')).toContain('src/fonts.css')
      const details = out.report.issues.map((issue) => issue.detail).join('\n')
      expect(details).not.toContain('googleapis')
      expect(details).toContain('evil.example')
    }
    const none = exportOf([], frame('<p>x</p>'))
    expect(none.files.some((file) => file.path === 'src/fonts.css')).toBe(false)
  })

  it('does not follow a link that is not Google Fonts', () => {
    for (const href of [
      'http://fonts.googleapis.com/css2?family=X',
      'https://fonts.googleapis.com.evil.example/css2',
      'https://user@fonts.googleapis.com/css2',
      'https://fonts.googleapis.com/other',
      'javascript:alert(1)',
    ]) {
      const out = exportOf([], frame('<p>x</p>', `<link rel="stylesheet" href="${href}">`))
      expect(out.files.some((file) => file.path === 'src/fonts.css')).toBe(false)
    }
    const quote = exportOf(
      [],
      frame('<p>x</p>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A&quot;);body{x:y}">'),
    )
    expect(fileOf(quote, 'src/fonts.css')).toContain('%22')
  })

  it('stops two templates that use each other from rendering forever', async () => {
    const k1 = def('K1', '<div data-doop-part="r">k1<doop-use component="c-k2" data-doop-part="u"></doop-use></div>')
    const k2 = def('K2', '<div data-doop-part="r">k2<doop-use component="c-k1" data-doop-part="u"></doop-use></div>')
    const out = exportOf([k1, k2], [], { componentIds: [k1.id, k2.id] })
    const dropped = out.report.issues.filter((issue) => issue.detail.includes('never stop'))
    expect(dropped).toHaveLength(1)
    const project = writeProject(out.files)
    try {
      expect(typecheck(project)).toEqual([])
      const rendered = await renderAll(project, {
        k1: { from: './src/components/K1', name: 'K1' },
        k2: { from: './src/components/K2', name: 'K2' },
      })
      expect(rendered.k1).toContain('k1')
      expect(rendered.k2).toContain('k2')
    } finally {
      project.cleanup()
    }
    const three = [
      def('A', '<div data-doop-part="r"><doop-use component="c-b" data-doop-part="u"></doop-use></div>'),
      def('B', '<div data-doop-part="r"><doop-use component="c-c" data-doop-part="u"></doop-use></div>'),
      def('C', '<div data-doop-part="r"><doop-use component="c-a" data-doop-part="u"></doop-use></div>'),
    ]
    expect(() => exportOf(three, [], { componentIds: three.map((entry) => entry.id) })).not.toThrow()
  })

  it('renames a class called __proto__ in the CSS and the markup alike', () => {
    const odd = def('Odd', '<div class="__proto__ ok" data-doop-part="r"></div>', {
      rawCss: '.__proto__ { color: red } .ok { color: blue }',
    })
    for (const styling of ['modules', 'tailwind'] as const) {
      const out = exportOf([odd], [], { styling, componentIds: [odd.id] })
      const tsx = componentOf(out, 'Odd')
      expect(tsx).not.toContain('__proto__')
      const css = out.files
        .filter((file) => file.path.endsWith('.css'))
        .map((file) => file.content)
        .join('\n')
      expect(css).not.toContain('__proto__')
      if (styling === 'modules') {
        expect(css).toContain('.doop-proto')
        expect(tsx).toContain('doop-proto')
      }
    }
    const pageOut = exportOf([], frame('<p class="__proto__">x</p>', '<style>.__proto__ { color: red }</style>'))
    expect(fileOf(pageOut, 'src/pages/Home.tsx')).not.toContain('__proto__')
    expect(fileOf(pageOut, 'src/pages/Home.css')).toContain('.doop-proto')
    expect(fileOf(pageOut, 'src/pages/Home.tsx')).toContain('doop-proto')
  })

  it('accepts an @/ or ~/ alias and nothing that climbs or doubles a slash', () => {
    for (const importFrom of ['@/components/ui/button', '~/ui/Button_v2']) {
      const out = callIt(mappedTo('Btn', { importFrom, exportName: 'Button' }))
      expect(fileOf(out, 'src/pages/Home.tsx')).toContain(`from "${importFrom}"`)
      expect(out.files.some((file) => file.path === 'src/components/Btn.tsx')).toBe(false)
    }
    for (const importFrom of ['@/../x', '@//x', '~/a//b', '@/a b', '@/', '~/../../etc', '@/a/./b']) {
      const out = callIt(mappedTo('Btn', { importFrom, exportName: 'Button' }))
      expect(fileOf(out, 'src/pages/Home.tsx')).not.toContain(importFrom)
      expect(out.files.some((file) => file.path === 'src/components/Btn.tsx')).toBe(true)
    }
  })

  it('keeps :root and html theme rules as ancestors of the page root', () => {
    const css = [
      ':root[data-doop-theme=dark] .x { color: white }',
      ':root.dark .x { color: red }',
      'html[data-doop-theme=dark] { background: black }',
      'html.dark { color: white }',
      ':root[data-doop-theme=dark] { --bg: black }',
      ':root.dark { color: white }',
      ':root { --x: 1 }',
    ].join('\n')
    const out = exportOf([], frame('<p class="x">x</p>', `<style>${css}</style>`))
    const sheet = fileOf(out, 'src/pages/Home.css')
    expect(sheet).toContain(':root[data-doop-theme=dark] .page-Home .x')
    expect(sheet).toContain(':root.dark .page-Home .x')
    expect(sheet).toContain('html[data-doop-theme=dark] .page-Home {')
    expect(sheet).toContain('html.dark .page-Home {')
    expect(sheet).toContain(':root[data-doop-theme=dark] {\n  --bg')
    expect(sheet).toContain(':root.dark .page-Home {')
    expect(sheet).toMatch(/^:root \{/m)
    const dom = parse(
      '<!doctype html><html data-doop-theme="dark" class="dark"><body><div class="page-Home"><p class="x">x</p></div></body></html>',
      { treeAdapter: adapter },
    )
    const matches = (selector: string) => selectAll(selector, dom as never).length
    expect(matches(':root[data-doop-theme=dark] .page-Home .x')).toBe(1)
    expect(matches('html.dark .page-Home')).toBe(1)
  })

  it('reports a <style> in a component head that the export ignores', () => {
    const styled = def('Styled', '<div data-doop-part="r"></div>', {
      head: ['<style>.x{color:red}</style>', '<style data-doop-tokens>:root{--a:1}</style>'],
    })
    const out = exportOf([styled], [], { componentIds: [styled.id] })
    const hits = out.report.issues.filter((issue) => issue.detail.includes('<style> in the component head'))
    expect(hits).toHaveLength(1)
  })

  it('writes src/fonts.css for a roster family named in CSS with no link at all', () => {
    const card = def('Card', '<div class="c" data-doop-part="r">hi</div>', {
      rawCss: '.c { font-family: "Inter", sans-serif }',
    })
    for (const styling of ['modules', 'tailwind'] as const) {
      const out = exportOf([card], [], { styling, componentIds: [card.id] })
      expect(fileOf(out, 'src/fonts.css')).toMatch(
        /^@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Inter:/,
      )
      expect(componentOf(out, 'Card')).toContain("import '../fonts.css'")
    }
    const own = def('Own', '<div class="c" data-doop-part="r">hi</div>', {
      rawCss: '@font-face { font-family: "Inter"; src: url(/a/i.woff2) } .c { font-family: "Inter" }',
    })
    expect(exportOf([own], [], { componentIds: [own.id] }).files.some((f) => f.path === 'src/fonts.css')).toBe(false)
    const pageOut = exportOf([], frame('<p style="font-family: Inter">x</p>'))
    expect(fileOf(pageOut, 'src/fonts.css')).toContain('family=Inter')
    expect(fileOf(pageOut, 'src/pages/Home.tsx')).toContain("import '../fonts.css'")
  })

  it('makes a page with a background fill the screen', () => {
    for (const styling of ['modules', 'tailwind'] as const) {
      const painted = exportOf([], frame('<p>x</p>', '<style>body { background: #111; color: #fff }</style>'), {
        styling,
      })
      expect(fileOf(painted, 'src/pages/Home.css')).toMatch(
        /\.page-Home \{\n {2}min-height: 100vh;\n {2}min-height: 100dvh;/,
      )
      const bare = exportOf([], frame('<p>x</p>', '<style>body { color: #fff }</style>'), { styling })
      expect(bare.files.find((f) => f.path === 'src/pages/Home.css')?.content ?? '').not.toContain('min-height')
    }
    const inline = exportOf(
      [],
      [{ id: 'f1', name: 'Home', html: '<html><body style="background:#000"><p>x</p></body></html>' }],
    )
    expect(fileOf(inline, 'src/pages/Home.css')).toContain('min-height: 100vh')
    expect(fileOf(inline, 'README.md')).toContain('full screen')
  })
})

describe('empty stylesheets', () => {
  const PLAIN = def('Plain', '<div data-doop-part="r">plain</div>')
  const INKED = def('Inked', '<div class="i" data-doop-part="r">inked</div>', {
    rawCss: '.i { animation: pulse 1s infinite }\n@keyframes pulse { from { opacity: .4 } to { opacity: 1 } }',
  })
  const spin = '<style>@keyframes spin { from { opacity: 0 } to { opacity: 1 } }</style>'

  for (const styling of ['modules', 'tailwind'] as const) {
    it(`writes and imports a stylesheet only when there are styles (${styling})`, () => {
      const bare = exportOf([PLAIN], frame(instance(PLAIN, [PLAIN])), { styling, componentIds: [PLAIN.id] })
      const paths = bare.files.map((file) => file.path)
      expect(paths).not.toContain('src/components/Plain.module.css')
      expect(paths).not.toContain('src/pages/Home.css')
      expect(fileOf(bare, 'src/pages/Home.tsx')).not.toContain('Home.css')
      expect(componentOf(bare, 'Plain')).not.toContain('.module.css')

      const styled = exportOf([PLAIN], frame(instance(PLAIN, [PLAIN]), spin), { styling, componentIds: [PLAIN.id] })
      const styledPaths = styled.files.map((file) => file.path)
      expect(styledPaths).toContain('src/pages/Home.css')
      expect(fileOf(styled, 'src/pages/Home.tsx')).toContain("import './Home.css'")
      expect(styledPaths).not.toContain('src/components/Plain.module.css')

      const inked = exportOf([INKED], [], { styling, componentIds: [INKED.id] })
      expect(inked.files.map((file) => file.path)).toContain('src/components/Inked.module.css')
      expect(componentOf(inked, 'Inked')).toContain("import styles from './Inked.module.css'")
    })
  }
})

describe('data-doop-attr-if', () => {
  const BUTTON = def(
    'Pbutton',
    `<button class="b" data-no-visuals="true" data-doop-part="r" data-doop-attr-if="data-no-visuals: trailing-visual!=SearchIcon &amp; trailing-visual!=EyeIcon"><span data-doop-part="l">Go</span><i data-doop-part="e" hidden title="x" data-doop-attr-if="hidden: !quiet; title: quiet &amp; tone=ghost; data-gone: tone=none">e</i></button>`,
    {
      props: [
        { name: 'trailing-visual', type: 'enum', options: ['none', 'SearchIcon', 'EyeIcon'], default: 'none' },
        { name: 'quiet', type: 'boolean', default: 'false' },
        { name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' },
      ],
    },
  )

  it('writes each attribute under its conditions, a boolean attribute as the condition itself', () => {
    const tsx = componentOf(exportOf([BUTTON], [], { componentIds: [BUTTON.id] }), 'Pbutton')
    expect(tsx).toContain(
      `data-no-visuals={trailingVisual !== "SearchIcon" && trailingVisual !== "EyeIcon" ? "true" : undefined}`,
    )
    expect(tsx).toContain('hidden={!quiet}')
    expect(tsx).toMatch(/title=\{quiet && tone === "ghost" \? "x" : undefined\}/)
    expect(tsx).not.toContain('data-doop-attr-if')
    expect(tsx).not.toContain('data-gone')
  })

  it('type-checks and renders the DOM Doop renders for each option', async () => {
    const result = exportOf([BUTTON], [], { componentIds: [BUTTON.id] })
    const project = writeProject(result.files)
    try {
      expect(typecheck(project)).toEqual([])
      const cases: Record<string, Record<string, string | boolean>> = {
        plain: {},
        search: { trailingVisual: 'SearchIcon' },
        quietGhost: { trailingVisual: 'EyeIcon', quiet: true, tone: 'ghost' },
      }
      const out = await renderAll(
        project,
        Object.fromEntries(
          Object.entries(cases).map(([key, props]) => [
            key,
            { from: './src/components/Pbutton', name: 'Pbutton', props },
          ]),
        ),
      )
      const doop = (props: Record<string, string>) => normalize(instance(BUTTON, [BUTTON], { props }))
      expect(normalize(out.plain!)).toBe(doop({}))
      expect(normalize(out.search!)).toBe(doop({ 'trailing-visual': 'SearchIcon' }))
      expect(normalize(out.quietGhost!)).toBe(doop({ 'trailing-visual': 'EyeIcon', quiet: 'true', tone: 'ghost' }))
      expect(normalize(out.plain!)).toContain('data-no-visuals="true"')
      expect(normalize(out.search!)).not.toContain('data-no-visuals')
    } finally {
      project.cleanup()
    }
  })

  it('still calls a component with a package mapping from its package', () => {
    const mapped = def('Mapped', BUTTON.template, {
      props: BUTTON.props,
      code: { importFrom: '@acme/ui', exportName: 'Button' },
    })
    const out = exportOf([mapped], frame(`<doop-use component="${mapped.id}"></doop-use>`))
    expect(fileOf(out, 'src/pages/Home.tsx')).toContain('from "@acme/ui"')
    expect(fileOf(out, 'src/pages/Home.tsx')).toMatch(/<Button\b[^>]*\/>/)
  })
})

describe('props a mapped component cannot receive', () => {
  const CARD = (code: NonNullable<ComponentDef['code']> = {}) =>
    def(
      'Card',
      '<div data-doop-part="r"><h3 data-doop-part="h" data-doop-prop="text">Sign in</h3><p data-doop-part="p" data-doop-prop="text-2">Welcome</p></div>',
      {
        props: [
          { name: 'text', type: 'text' },
          { name: 'text-2', type: 'text' },
          { name: 'variant', type: 'enum', options: ['default', 'outline'], default: 'default' },
        ],
        code: { importFrom: '@acme/ui', exportName: 'Card', ...code },
      },
    )
  const body = (card: ComponentDef, attrs: string) => `<doop-use component="${card.id}" ${attrs}></doop-use>`
  const STUB = {
    '@acme/ui/package.json': '{"name":"@acme/ui","main":"index.js","types":"index.d.ts"}\n',
    '@acme/ui/index.d.ts':
      "import type { ReactNode } from 'react'\nexport declare function Card(props: { variant?: 'default' | 'outline'; children?: ReactNode }): JSX.Element\n",
    '@acme/ui/index.js': 'exports.Card = () => null\n',
  }

  it('passes a prop whose name is an identifier, leaves the rest out and reports each one with its value', () => {
    const card = CARD({ props: { text: { omit: true } } })
    const out = exportOf([card], frame(body(card, 'variant="outline" text="Join us" text-2="Welcome back"')))
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toMatch(/<Card variant=\{"outline"\} \/>/)
    expect(home).not.toContain('text-2')
    expect(home).not.toContain('text=')
    const details = out.report.issues.map((issue) => issue.detail)
    expect(details).toHaveLength(2)
    expect(details.find((detail) => detail.includes('"text-2"'))).toMatch(
      /Card: prop "text-2" was set to "Welcome back"/,
    )
    expect(details.find((detail) => detail.includes('"text"'))).toMatch(
      /Card: prop "text" was set to "Join us".*omits it/,
    )
    expect(out.report.issues.every((issue) => issue.file === 'src/pages/Home.tsx')).toBe(true)
  })

  it('stays quiet when an instance leaves the prop alone or sets its default', () => {
    const card = CARD({ props: { text: { omit: true } } })
    const out = exportOf([card], frame(`${body(card, 'variant="outline"')}${body(card, 'text="Sign in"')}`))
    expect(out.report.issues).toEqual([])
  })

  it('type-checks the generated page against a component that declares only variant and children', () => {
    const card = CARD({ props: { text: { name: 'children' } } })
    const out = exportOf([card], frame(body(card, 'variant="outline" text="Join us" text-2="Welcome back"')))
    const home = fileOf(out, 'src/pages/Home.tsx')
    expect(home).toMatch(/<Card variant=\{"outline"\}>\s*Join us\s*<\/Card>/)
    expect(out.report.issues.map((issue) => issue.detail)).toEqual([
      expect.stringContaining('Card: prop "text-2" was set to "Welcome back"'),
    ])
    const project = writeProject(out.files, STUB)
    try {
      expect(typecheck(project)).toEqual([])
    } finally {
      project.cleanup()
    }
  })

  it('reports from a generated component that nests the mapped one, and the report keeps it', () => {
    const card = CARD({ props: { text: { name: 'children' } } })
    const wrap = def(
      'Wrap',
      `<div data-doop-part="r"><doop-use component="${card.id}" data-doop-part="u" text-2="x"></doop-use></div>`,
    )
    const out = exportOf([card, wrap], [], { componentIds: [wrap.id] })
    expect(
      out.report.issues.some((issue) => issue.file === 'src/components/Wrap.tsx' && issue.detail.includes('"text-2"')),
    ).toBe(true)
  })
})
