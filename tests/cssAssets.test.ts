import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/* createAsset writes bytes and a row; neither matters for type decisions, so both are stubbed and the sniffing runs for real. */
vi.mock('../server/db/index.ts', () => ({ db: { insert: () => ({ values: async () => {} }) } }))
vi.mock('../server/storage.ts', () => ({ putObject: async () => {} }))

const { assetResponseHeaders, assetUsage, createAsset, looksLikeCss, sniffMime } = await import('../server/assets.ts')

const css = (s: string) => Buffer.from(s, 'utf8')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const META = { canvasId: 'c1', uploadedBy: 'Test' }

describe('looksLikeCss', () => {
  it.each([
    ['a plain rule', 'body { margin: 0; color: #111; }'],
    ['minified output', ':root{--brand:#2743ee}.btn{padding:8px 12px;border-radius:999px}.btn:hover{opacity:.9}'],
    ['@charset first', '@charset "UTF-8";\n.card { box-shadow: 0 1px 2px rgba(0,0,0,.1) }'],
    ['a comment first', '/*! theme v1 */\n/* tokens */\nh1{font-size:64px}'],
    ['a byte-order mark first', '﻿.x{color:red}'],
    ['only an @import', '@import url("https://fonts.googleapis.com/css2?family=Lexend");'],
    ['only @font-face', '@font-face { font-family: X; src: url(/a/abc.woff2) }'],
    ['a layered build', '@layer theme, base, components;\n@layer base { *{box-sizing:border-box} }'],
    ['an empty rule', '.reset {}'],
    ['custom properties', '.t{--space-1:4px;--space-2:8px}'],
    [
      'an inline svg data URI',
      ".chk{background-image:url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>\")}",
    ],
    ['nested rules', '.card{ .title{ font-weight:700 } }'],
    ['an attribute selector', '[data-theme=dark]{color-scheme:dark}'],
    ['Windows line endings and tabs', '.a {\r\n\tcolor: red;\r\n}\r\n'],
  ])('accepts %s', (_name, source) => {
    expect(looksLikeCss(css(source))).toBe(true)
  })

  it.each([
    ['an HTML document', '<!doctype html><html><head><style>a{}</style></head></html>'],
    ['markup after whitespace and a BOM', '﻿  \n<style>a{color:red}</style>'],
    ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'],
    ['CSS that smuggles a script', 'a{color:red}</style><script>alert(1)</script>'],
    ['CSS that smuggles an iframe', 'a{color:red} <IFRAME src="https://example.com">'],
    ['CSS with a body tag', '.x{color:red}\n<body onload="x()">'],
    ['CSS with a doctype', '.x{color:red}<!DOCTYPE html>'],
    ['JSON with markup', '{"html":"<script>alert(1)</script>"}'],
    ['a JSON object', '{"color": "red", "size": 12}'],
    ['a JSON array of objects', '[{"color": "red"}, {"color": "blue"}]'],
    ['plain prose', 'Hello, this is a readme file.\nNothing to see here.'],
    ['a NUL byte', '.a{color:red}\u0000'],
    ['a binary control byte', '.a{color:red}\u0007'],
    ['an empty file', ''],
    ['only whitespace', '   \n\t  '],
    ['only a comment', '/* nothing here */'],
    ['an unterminated block', '.a { color: red'],
  ])('rejects %s', (_name, source) => {
    expect(looksLikeCss(css(source))).toBe(false)
  })

  it('rejects invalid UTF-8', () => {
    expect(looksLikeCss(Buffer.from([0x2e, 0x61, 0x7b, 0x63, 0x3a, 0xff, 0xfe, 0x7d]))).toBe(false)
  })

  it('rejects binary image bytes', () => {
    expect(looksLikeCss(PNG)).toBe(false)
  })

  it('decides a pathological 5 MB upload in linear time', () => {
    const inputs = [
      'a'.repeat(5 * 1024 * 1024 - 1),
      '/*'.repeat(2.5 * 1024 * 1024 - 1),
      '{'.repeat(5 * 1024 * 1024 - 1),
      ` ${'@'.repeat(5 * 1024 * 1024 - 2)}`,
      `x{${' '.repeat(5 * 1024 * 1024 - 4)}a`,
      `x{${' a'.repeat(2.5 * 1024 * 1024 - 2)}}`,
      `x{${'a'.repeat(5 * 1024 * 1024 - 3)}}`,
    ]
    for (const input of inputs) {
      const started = performance.now()
      looksLikeCss(css(input))
      expect(performance.now() - started).toBeLessThan(1500)
    }
  })
})

describe('sniffMime acceptance', () => {
  const sheet = css('.theme{color:#111}')

  it('keeps stylesheets out unless the caller opts in', () => {
    expect(sniffMime(sheet)).toBeUndefined()
    expect(sniffMime(sheet, { stylesheets: true })).toBe('text/css')
  })

  it('decides images by their bytes either way', () => {
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(PNG, { stylesheets: true })).toBe('image/png')
    const svg = css('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(sniffMime(svg, { stylesheets: true })).toBe('image/svg+xml')
  })
})

describe('createAsset acceptance', () => {
  it('stores an opted-in stylesheet as text/css with a css extension', async () => {
    const asset = await createAsset(css('@charset "UTF-8"; .a{color:red}'), META, { stylesheets: true })
    expect(asset.mime).toBe('text/css')
    expect(asset.ext).toBe('css')
  })

  it('refuses a stylesheet with the images-only message when the caller did not opt in', async () => {
    await expect(createAsset(css('.a{color:red}'), META)).rejects.toThrow(
      'unsupported file type — png, jpg, webp, gif and svg are accepted',
    )
  })

  it('names css in the message when the caller accepts stylesheets', async () => {
    await expect(createAsset(css('<html></html>'), META, { stylesheets: true })).rejects.toThrow(
      'unsupported file type — png, jpg, webp, gif, svg and css are accepted',
    )
  })

  it('keeps the 5 MB cap for stylesheets', async () => {
    const big = css(`.a{color:red}${' '.repeat(5 * 1024 * 1024)}`)
    await expect(createAsset(big, META, { stylesheets: true })).rejects.toThrow('the limit is 5 MB')
  })
})

describe('serving and usage', () => {
  it('serves stylesheets as UTF-8 CSS that cannot run as a document', () => {
    expect(assetResponseHeaders('text/css')).toEqual({
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Access-Control-Allow-Origin': '*',
    })
  })

  it('serves images as before', () => {
    expect(assetResponseHeaders('image/png')).toEqual({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    expect(assetResponseHeaders('image/svg+xml')['Content-Security-Policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    )
  })

  it('hands agents a link tag for a stylesheet and an img tag for an image', () => {
    expect(assetUsage('text/css', 'https://d.test/a/x.css')).toBe(
      '<link rel="stylesheet" href="https://d.test/a/x.css">',
    )
    expect(assetUsage('image/png', 'https://d.test/a/x.png')).toBe('<img src="https://d.test/a/x.png" alt="">')
  })
})

describe('who accepts stylesheets', () => {
  /* Stylesheet acceptance is opt-in per caller. Only the two agent upload paths take it: the ticket route (PUT /u/:token) and upload_asset's data/source_url path. The browser upload route, the GitHub recon transplant, the Meta image copy and image generation must stay images-only, so a new opt-in has to be a deliberate change to this list. */
  it('is limited to the ticket route and upload_asset', () => {
    const serverDir = path.join(process.cwd(), 'server')
    const optedIn = readdirSync(serverDir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => {
        const source = readFileSync(path.join(serverDir, file), 'utf8')
        return Array.from(source.matchAll(/stylesheets: true/g), () => file)
      })
    expect(optedIn.sort()).toEqual(['index.ts', 'mcp.ts'])
    const index = readFileSync(path.join(serverDir, 'index.ts'), 'utf8')
    const ticketRoute = index.slice(index.indexOf("app.put('/u/:token'"), index.indexOf("app.put('/u/:token'") + 2500)
    expect(ticketRoute).toContain('stylesheets: true')
    const mcp = readFileSync(path.join(serverDir, 'mcp.ts'), 'utf8')
    const uploadTool = mcp.slice(mcp.indexOf("'upload_asset',"), mcp.indexOf("'generate_image',"))
    expect(uploadTool).toContain('stylesheets: true')
  })
})
