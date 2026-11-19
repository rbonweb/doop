// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  editComponentVariants: vi.fn(),
  setComponentLocal: vi.fn(),
  notices: [] as string[],
  components: [] as unknown[],
  frames: [] as unknown[],
}))
vi.mock('../src/lib/api', () => ({
  api: { editComponentVariants: mocks.editComponentVariants },
  errorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}))
vi.mock('../src/lib/history', () => ({ recordCreate: () => {}, recordUpdate: () => {}, recordUpdates: () => {} }))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: 'canvas1', components: mocks.components, frames: mocks.frames }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: mocks.setComponentLocal,
  }
  return { useStore: { getState: () => state }, canEditOpenCanvas: () => true, pickedSelectors: () => [] }
})
import {
  combinationLabel,
  flushVariantStyles,
  previewOf,
  refuseWhileVariantPreview,
  useVariantPreview,
  variantEditTarget,
  variantPropsOf,
  variantStyleOp,
  writeVariantStyle,
} from '../src/lib/variantPreview'

/* The style redirect: while a non-default combination is previewed, a Design panel patch for the main or an element
   inside it becomes a set_style op for that combination, and anything else stays an inline edit. */

const component = {
  id: 'cbutton',
  name: 'Button',
  template: '<button data-doop-part="r"><span data-doop-part="l"></span></button>',
  props: [
    { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'quiet', type: 'boolean', default: 'false', reflect: true },
    { name: 'label', type: 'text' },
  ],
} as unknown as ComponentDef

const frame = {
  id: 'main1',
  canvasId: 'canvas1',
  name: 'Components',
  html: '<!doctype html><html><head></head><body><button data-doop-component="cbutton" data-doop-part="r" data-doop-id="main01"><span data-doop-part="l" data-doop-id="lab01">Buy</span><i data-doop-id="bare01"></i></button><p id="outside"></p></body></html>',
} as unknown as Frame

const props = variantPropsOf(component.props)
const previewing = (picks: Record<string, string>) =>
  useVariantPreview.getState().setPreview(previewOf('main1', 'cbutton', props, picks))

beforeEach(() => {
  vi.useFakeTimers()
  mocks.components = [component]
  mocks.frames = [frame]
  mocks.notices.length = 0
  mocks.editComponentVariants.mockReset()
  mocks.editComponentVariants.mockImplementation(async () => ({ component }))
  mocks.setComponentLocal.mockReset()
  useVariantPreview.getState().setPreview(null)
})
afterEach(() => vi.useRealTimers())

it('reads only enum and reflected boolean props as variants', () => {
  expect(props).toEqual([
    { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'quiet', type: 'boolean', options: ['true', 'false'], default: 'false' },
  ])
})

it('a combination keeps only the props that are not at their default, and falls back for a value that is gone', () => {
  expect(previewOf('f', 'c', props, {}).when).toEqual({})
  expect(previewOf('f', 'c', props, { size: 'lg', quiet: 'false' }).when).toEqual({ size: 'lg' })
  expect(previewOf('f', 'c', props, { size: 'gone', quiet: 'true' })).toMatchObject({
    values: { size: 'md', quiet: 'true' },
    when: { quiet: 'true' },
  })
  expect(combinationLabel({ size: 'lg', quiet: 'true' })).toBe('size=lg, quiet=true')
})

it('turns a patch into a set_style op, a null or empty value clearing the property', () => {
  expect(variantStyleOp({ size: 'lg' }, 'root', { padding: '12px', gap: '', color: null, 'font-size': ' ' })).toEqual({
    op: 'set_style',
    element: 'root',
    when: { size: 'lg' },
    declarations: { padding: '12px', gap: null, color: null, 'font-size': null },
  })
})

it('names the element by part key, the main root as root, and sends nothing at the base', () => {
  expect(variantEditTarget(frame, '[data-doop-id="main01"]')).toBeNull()
  previewing({ size: 'lg' })
  expect(variantEditTarget(frame, '[data-doop-id="main01"]')).toMatchObject({ element: 'root', canvasId: 'canvas1' })
  expect(variantEditTarget(frame, '[data-doop-id="lab01"]')?.element).toBe('l')
  expect(variantEditTarget(frame, '[data-doop-id="bare01"]')?.element).toBeNull()
  /* outside the main, or another frame, stays an ordinary edit */
  expect(variantEditTarget(frame, '#outside')).toBeNull()
  expect(variantEditTarget({ ...frame, id: 'other' } as Frame, '[data-doop-id="main01"]')).toBeNull()
  previewing({})
  expect(variantEditTarget(frame, '[data-doop-id="main01"]')).toBeNull()
})

it('writes a previewed edit as one set_style under the non-default combination, merging a burst into one call', async () => {
  previewing({ size: 'lg', quiet: 'true' })
  expect(writeVariantStyle(frame, '[data-doop-id="lab01"]', { color: 'red' })).toBe(true)
  expect(writeVariantStyle(frame, '[data-doop-id="lab01"]', { color: 'blue', gap: null })).toBe(true)
  expect(writeVariantStyle(frame, '[data-doop-id="main01"]', { padding: '12px' })).toBe(true)
  expect(mocks.editComponentVariants).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300)
  expect(mocks.editComponentVariants).toHaveBeenCalledTimes(1)
  expect(mocks.editComponentVariants.mock.calls[0]).toEqual([
    'canvas1',
    'cbutton',
    {
      ops: [
        {
          op: 'set_style',
          element: 'l',
          when: { size: 'lg', quiet: 'true' },
          declarations: { color: 'blue', gap: null },
        },
        { op: 'set_style', element: 'root', when: { size: 'lg', quiet: 'true' }, declarations: { padding: '12px' } },
      ],
    },
  ])
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('cbutton', component)
})

it('leaves an edit at the base to the caller, and refuses an element with no key', async () => {
  expect(writeVariantStyle(frame, '[data-doop-id="lab01"]', { color: 'red' })).toBe(false)
  previewing({ size: 'sm' })
  expect(writeVariantStyle(frame, '[data-doop-id="bare01"]', { color: 'red' })).toBe(true)
  await flushVariantStyles()
  expect(mocks.editComponentVariants).not.toHaveBeenCalled()
  expect(mocks.notices[0]).toContain('no key')
})

it('says what the server refused', async () => {
  mocks.editComponentVariants.mockRejectedValue(new Error('url() is not allowed'))
  previewing({ size: 'lg' })
  writeVariantStyle(frame, '[data-doop-id="lab01"]', { background: 'url(x)' })
  await flushVariantStyles()
  expect(mocks.notices).toEqual(['url() is not allowed'])
})

it('works the target out once for the steps of a scrub', () => {
  previewing({ size: 'lg' })
  const first = variantEditTarget(frame, '[data-doop-id="lab01"]')
  expect(variantEditTarget(frame, '[data-doop-id="lab01"]')).toBe(first)
  /* a new preview, or a new document, asks again */
  previewing({ size: 'sm' })
  expect(variantEditTarget(frame, '[data-doop-id="lab01"]')).not.toBe(first)
})

it('refuses a writer that cannot go to a variant, only for the main and what is inside it, and only while previewing', () => {
  expect(refuseWhileVariantPreview('main1', '[data-doop-id="main01"]')).toBe(false)
  previewing({ size: 'lg' })
  expect(refuseWhileVariantPreview('main1', ['#outside'])).toBe(false)
  expect(refuseWhileVariantPreview('other', '[data-doop-id="main01"]')).toBe(false)
  expect(mocks.notices).toEqual([])
  expect(refuseWhileVariantPreview('main1', ['#outside', '[data-doop-id="lab01"]'])).toBe(true)
  expect(mocks.notices).toHaveLength(1)
  expect(mocks.notices[0]).toContain('go back to the base')
})
