// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

/* The frame runtime is the script FRAME_BOOTSTRAP carries into every frame iframe. It runs here against happy-dom's document, driven the way FrameView drives it: a doop:html message from the parent. */

declare global {
  interface Window {
    happyDOM?: {
      settings: {
        disableCSSFileLoading: boolean
        disableJavaScriptFileLoading: boolean
        handleDisabledFileLoadingAsSuccess: boolean
      }
    }
  }
}

function render(html: string) {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'doop:html', html }, source: window }))
}

const SHEET = 'https://doop.test/a/theme.css'
const page = (head: string, body: string) =>
  `<!doctype html><html><head>${head}</head><body><main>${body}</main></body></html>`

beforeAll(() => {
  /* the sheet's URL is fictional; only the element's fate matters */
  if (window.happyDOM) {
    window.happyDOM.settings.disableCSSFileLoading = true
    window.happyDOM.settings.disableJavaScriptFileLoading = true
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
  }
  const boot = /<script data-v-boot>([\s\S]*)<\/script>/.exec(FRAME_BOOTSTRAP)?.[1]
  if (!boot) throw new Error('bootstrap script not found')
  new Function(boot)()
})

describe('frame runtime morph and stylesheet links', () => {
  it('adds the link on first render and keeps the same node across body edits', () => {
    render(page(`<meta charset="utf-8"><link rel="stylesheet" href="${SHEET}">`, 'one'))
    const link = document.head.querySelector('link[rel="stylesheet"]')
    expect(link?.getAttribute('href')).toBe(SHEET)

    render(page(`<meta charset="utf-8"><link rel="stylesheet" href="${SHEET}">`, 'two'))
    expect(document.querySelector('main')?.textContent).toBe('two')
    expect(document.head.querySelector('link[rel="stylesheet"]')).toBe(link)
  })

  it('moves the existing link instead of replacing it when head nodes are inserted before it', () => {
    const link = document.head.querySelector('link[rel="stylesheet"]')
    render(
      page(
        `<meta charset="utf-8"><meta name="theme-color" content="#fff"><style>.x{}</style><link rel="stylesheet" href="${SHEET}">`,
        'three',
      ),
    )
    const links = document.head.querySelectorAll('link[rel="stylesheet"]')
    expect(links).toHaveLength(1)
    expect(links[0]).toBe(link)
    expect(Array.from(document.head.children, (el) => el.tagName)).toEqual(['META', 'META', 'STYLE', 'LINK'])
  })

  it('keeps the link when the inserted nodes are removed again', () => {
    const link = document.head.querySelector('link[rel="stylesheet"]')
    render(page(`<meta charset="utf-8"><link rel="stylesheet" href="${SHEET}">`, 'four'))
    expect(document.head.querySelector('link[rel="stylesheet"]')).toBe(link)
    expect(Array.from(document.head.children, (el) => el.tagName)).toEqual(['META', 'LINK'])
    expect(document.querySelector('main')?.textContent).toBe('four')
  })

  it('keeps every sheet when two links swap order', () => {
    const other = 'https://doop.test/a/other.css'
    render(page(`<link rel="stylesheet" href="${SHEET}"><link rel="stylesheet" href="${other}">`, 'five'))
    const [first, second] = Array.from(document.head.querySelectorAll('link'))
    render(page(`<link rel="stylesheet" href="${other}"><link rel="stylesheet" href="${SHEET}">`, 'six'))
    const swapped = Array.from(document.head.querySelectorAll('link'))
    expect(swapped.map((l) => l.getAttribute('href'))).toEqual([other, SHEET])
    expect(swapped[0]).toBe(second)
    expect(swapped[1]).toBe(first)
  })

  it('drops a link whose href is gone from the document', () => {
    render(page('<meta charset="utf-8">', 'seven'))
    expect(document.head.querySelector('link')).toBeNull()
    expect(document.querySelector('main')?.textContent).toBe('seven')
  })
})
