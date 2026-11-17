import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { isFollowableAttribute } from '../shared/storybook/bindings.ts'
import { CAPTURE_PRELUDE, FOLLOWABLE_GLOBAL, captureStory } from '../shared/storybook/capture.ts'

/** The page gets the attribute rule as source text from `CAPTURE_PRELUDE`, never as an import. This runs that text in a bare vm context, the way the isolated world receives it, and compares its verdicts with the server's copy over names a page could forge. */
const corpus = [
  /* allowed */
  'data-variant',
  'aria-pressed',
  'disabled',
  'role',
  'type',
  'name',
  'data-size',
  /* refused families */
  'class',
  'style',
  'id',
  'onclick',
  'onerror',
  'onmouseover',
  'on',
  'onx',
  'data-doop-prop',
  'data-doop-id',
  'data-doop-',
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'srcset',
  'xlink:href',
  /* mixed case */
  'ONCLICK',
  'OnClick',
  'Href',
  'SRC',
  'Class',
  'Data-Doop-X',
  'Data-Variant',
  /* look-alikes and invisible characters */
  'оnclick',
  'ｏｎclick',
  'on‍click',
  'o​nclick',
  'data-‍doop-x',
  'data‍-doop-x',
  'K-x',
  'href ',
  ' href',
  'data-variant ',
  'data-variant‍',
  'clаss',
  'sрc',
  '',
  'a'.repeat(101),
  'a'.repeat(100),
  '1abc',
  '-abc',
  'a_b',
  'a.b',
]

function pageRule(): (name: string) => boolean {
  const context: Record<string, unknown> = {}
  runInNewContext(CAPTURE_PRELUDE, context)
  const rule = context[FOLLOWABLE_GLOBAL]
  if (typeof rule !== 'function') throw new Error('the prelude installed no attribute rule')
  return (name) => Boolean((rule as (value: string) => unknown)(name))
}

describe('the attribute rule on the page and on the server', () => {
  it('gives every name the same verdict', () => {
    const page = pageRule()
    const drift = corpus.filter((name) => page(name) !== isFollowableAttribute(name))
    expect(drift).toEqual([])
  })

  it('allows the plain names and refuses each family', () => {
    const page = pageRule()
    for (const name of ['data-variant', 'aria-pressed', 'disabled', 'role', 'type', 'name']) {
      expect(page(name), name).toBe(true)
    }
    for (const name of [
      'class',
      'style',
      'id',
      'onclick',
      'data-doop-x',
      'href',
      'src',
      'srcset',
      'ONCLICK',
      'оnclick',
    ]) {
      expect(page(name), name).toBe(false)
    }
  })

  it('has the capture call the installed rule instead of carrying a copy of its own', () => {
    const source = captureStory.toString()
    expect(source).toContain(FOLLOWABLE_GLOBAL)
    expect(source).not.toMatch(/\[a-z\]\[a-z0-9-\]/)
    expect(source).not.toContain("'data-doop-'")
  })
})
