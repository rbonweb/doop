import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import * as actions from '../server/actions.ts'
import { importComponentBundle } from '../server/componentBundleImport.ts'
import { store } from '../server/store.ts'
import { runOperation } from '../server/workBudget.ts'
import { buildComponentBundle, type StoryPage } from '../shared/storybook/bundle.ts'
import { captureStory, settleStory, STYLE_PROPERTIES } from '../shared/storybook/capture.ts'
import { executableParts } from './executableParts.ts'

/* The end of the chain, with a compromised capture: a Storybook page (or a capture function a page has reached) hands back the worst markup and CSS it can. It goes through the shared bundle builder (schemas, CSS guard) and the importer, and every frame the canvas ends up with is parsed with parse5: nothing in it may run. */

const OWNER = 'owner-1'
const actor = actions.resolveActor({ name: 'Importer', kind: 'agent', userId: OWNER })

const HOSTILE_HTML =
  '<button class="btn" onclick="steal()" onmouseover="steal()" data-doop-prop="evil" data-doop-id="x">' +
  '<script>steal()</script><span data-doop-prop="label" onfocus="steal()">Save</span>' +
  '<a href="javascript:steal()">a</a><a href="  JaVaScRiPt:steal()">b</a><a href="vbscript:x">c</a><a href="data:text/html,<script>steal()</script>">d</a>' +
  '<img src="x" onerror="steal()" srcset="javascript:steal() 1x"><iframe src="https://evil.test/"></iframe><object data="javascript:steal()"></object>' +
  '<form action="javascript:steal()"><button formaction="javascript:steal()">go</button></form>' +
  '<svg><animate attributeName="href" values="javascript:steal()"></animate><set attributeName="onload" to="steal()"></set><a xlink:href="javascript:steal()"><text>t</text></a></svg>' +
  '<style>.x{color:red}</style><style>.y{}</style><script>steal()</script><math><mi xlink:href="javascript:steal()">x</mi></math></button>'

const HOSTILE_CSS = [
  '.btn { color: red; }',
  '.evil { background: url(javascript:steal()); }',
  '@import url(//evil.test/e.css);',
  '.x { color: blue } </style><script>steal()</script>',
].join('\n')

/** A page whose capture answers with whatever its "attacker" chose. */
function compromisedPage(html: string, css: string): StoryPage {
  return {
    installProbe: async () => {},
    goto: async () => {},
    waitForState: async () => 'ready',
    readMeta: async () =>
      JSON.stringify({ argTypes: { tone: { control: 'select', options: ['a', 'b'] } }, initialArgs: { tone: 'a' } }),
    evaluateSource: async () => undefined,
    evaluate: (async (fn: unknown) => {
      if (fn === settleStory) return undefined
      if (fn !== captureStory) throw new Error('unexpected evaluate')
      return JSON.stringify({
        ok: true,
        html,
        css,
        sharedRules: [
          '@import url(//evil.test/s.css);',
          'body { margin: 0 }',
          ':root { --x: 1 } </style><script>steal()</script>',
        ],
        shape: '0button',
        paths: ['button.btn'],
        styles: [STYLE_PROPERTIES.map(() => 'x')],
        issues: [],
      })
    }) as StoryPage['evaluate'],
  }
}

let canvasId: string

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.canvases.delete(canvas.id)
  canvasId = store.createCanvas('Hostile', OWNER).id
})

describe('a compromised capture, through the builder and the importer', () => {
  it('leaves no executable part in any frame, template or stylesheet the canvas ends up with', async () => {
    /* the check has teeth: the markup as the page sent it is full of them */
    expect(executableParts(HOSTILE_HTML).length).toBeGreaterThan(8)
    const { bundle } = await buildComponentBundle({
      entries: [{ id: 'a-hostile--default', title: 'A/Hostile', name: 'Default', type: 'story', tags: [] }],
      source: { kind: 'storybook', url: 'https://sb.test/' },
      baseUrl: 'https://sb.test/',
      withPage: async (use) => use(compromisedPage(HOSTILE_HTML, HOSTILE_CSS)),
    })
    /* the guard has already cut the CSS to whole, safe rules */
    expect(bundle.components[0]!.css).not.toMatch(/@import|javascript|<\/style|<script/i)
    expect(bundle.css).not.toMatch(/@import|javascript|<\/style|<script/i)

    const result = runOperation('test-import', canvasId, () =>
      importComponentBundle({ canvasId, actor }, bundle, { dryRun: false }),
    )
    expect(result.created.map((entry) => entry.name)).toEqual(['Hostile'])

    const canvas = store.getCanvas(canvasId)!
    expect(canvas.frames.length).toBeGreaterThan(0)
    for (const frame of canvas.frames) expect(executableParts(frame.html), `frame ${frame.name}`).toEqual([])
    for (const def of store.getComponents(canvasId)) {
      expect(executableParts(def.template), `template ${def.name}`).toEqual([])
      for (const sheet of [def.css, def.rawCss, ...def.head])
        expect(sheet).not.toMatch(/<\/style|<script|@import|javascript:/i)
    }
    const stored = canvas.frames.map((frame) => frame.html).join('\n')
    expect(stored).not.toMatch(/steal\(\)|onclick|onmouseover|onerror|onfocus|javascript:/i)
    expect(stored).toContain('Save')
  })
})
