import { describe, expect, it } from 'vitest'
import type { ArgProp } from '../shared/storybook/argTypes.ts'
import type { StoryEntry } from '../shared/storybook/index.ts'
import {
  argsParam,
  groupStories,
  pickDefaultStory,
  planVariants,
  STORYBOOK_LIMITS,
  storybookBasePath,
  storyIframeUrl,
  variantAllowance,
} from '../shared/storybook/plan.ts'

const story = (title: string, name: string): StoryEntry => ({
  id: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  title,
  name,
  type: 'story',
  tags: [],
})

describe('pickDefaultStory', () => {
  it('prefers default, then primary, else the first', () => {
    expect(pickDefaultStory([story('B', 'Large'), story('B', 'Primary'), story('B', 'Default')])?.name).toBe('Default')
    expect(pickDefaultStory([story('B', 'Large'), story('B', 'Primary')])?.name).toBe('Primary')
    expect(pickDefaultStory([story('B', 'Large'), story('B', 'Small')])?.name).toBe('Large')
    expect(pickDefaultStory([])).toBeUndefined()
  })
})

describe('groupStories', () => {
  it('groups by title in index order and names a component by its last segment', () => {
    const { groups } = groupStories([
      story('Inputs/Button', 'Large'),
      story('Cards/Card', 'Basic'),
      story('Inputs/Button', 'Primary'),
    ])
    expect(groups.map((group) => [group.title, group.name, group.defaultStory.name, group.stories.length])).toEqual([
      ['Inputs/Button', 'Button', 'Primary', 2],
      ['Cards/Card', 'Card', 'Basic', 1],
    ])
  })

  it('keeps component names unique', () => {
    const { groups } = groupStories([
      story('Forms/Button', 'A'),
      story('Nav/Button', 'A'),
      story('Misc/Button', 'A'),
      story('Button', 'A'),
    ])
    const names = groups.map((group) => group.name.toLowerCase())
    expect(new Set(names).size).toBe(4)
    expect(groups[1]?.name).toBe('Nav Button')
  })

  it('filters by title prefix, case-insensitively', () => {
    const { groups, issues } = groupStories([story('Inputs/Button', 'A'), story('Cards/Card', 'A')], {
      include: ['inputs'],
    })
    expect(groups.map((group) => group.title)).toEqual(['Inputs/Button'])
    expect(issues).toEqual([])
    expect(groupStories([story('A', 'A')], { include: ['zzz'] }).issues[0]?.code).toBe('no_components')
  })

  it('folds Features, Examples and the like into the component above them', () => {
    const { groups, issues } = groupStories([
      story('Components/ActionMenu', 'Default'),
      story('Components/ActionMenu/Features', 'With Icons'),
      story('Components/ActionMenu/Examples', 'Playground'),
      story('Components/Button', 'Primary'),
      story('Components/Button/Examples/Docs', 'Large'),
      story('Orphans/Thing/Features', 'A'),
    ])
    expect(groups.map((group) => [group.name, group.stories.length, group.defaultStory.name])).toEqual([
      ['ActionMenu', 3, 'Default'],
      ['Button', 2, 'Primary'],
    ])
    expect(issues.map((issue) => issue.code)).toEqual(['collections_skipped'])
  })

  it('matches include on the merged component title, so a picked component brings its collections along', () => {
    const entries = [
      story('Components/ActionMenu', 'Default'),
      story('Components/ActionMenu/Features', 'With Icons'),
      story('Components/ActionMenu/Examples', 'Playground'),
      story('Components/Button', 'Primary'),
      story('Components/Button/Features', 'Large'),
    ]
    const picked = groupStories(entries, { include: ['Components/ActionMenu'] })
    expect(picked.groups.map((group) => [group.title, group.name, group.stories.length])).toEqual([
      ['Components/ActionMenu', 'ActionMenu', 3],
    ])
    expect(picked.issues).toEqual([])
    /* the titles of an unfiltered plan, handed back as include, select exactly the same components */
    const all = groupStories(entries)
    const again = groupStories(entries, { include: all.groups.map((group) => group.title) })
    expect(again.groups.map((group) => [group.title, group.stories.length])).toEqual(
      all.groups.map((group) => [group.title, group.stories.length]),
    )
    expect(groupStories(entries, { include: ['Components/ActionMenu/Features'] }).issues[0]?.code).toBe('no_components')
  })

  it('keeps a first segment that is a collection word and matches the words in any case', () => {
    const { groups } = groupStories([story('Examples', 'A'), story('Kit/Card/EXAMPLES', 'B'), story('Kit/Card', 'C')])
    expect(groups.map((group) => [group.name, group.stories.length])).toEqual([
      ['Examples', 1],
      ['Card', 2],
    ])
  })

  it('names how many components the cap left out', () => {
    const { groups, issues } = groupStories(Array.from({ length: 75 }, (_, i) => story(`G/C ${i}`, 'Default')))
    expect(groups).toHaveLength(STORYBOOK_LIMITS.components)
    expect(issues[0]?.message).toContain('15 were left out')
    expect(issues[0]?.message).toContain('include')
  })

  it('caps components and says so', () => {
    const entries = Array.from({ length: 75 }, (_, i) => story(`Group/Component ${i}`, 'Default'))
    const { groups, issues } = groupStories(entries)
    expect(groups).toHaveLength(STORYBOOK_LIMITS.components)
    expect(issues[0]?.code).toBe('components_capped')
  })
})

const prop = (extra: Partial<ArgProp> & Pick<ArgProp, 'name' | 'type'>): ArgProp => ({ arg: extra.name, ...extra })

describe('planVariants', () => {
  it('renders every enum option but the default, then the other value of each boolean', () => {
    const { renders } = planVariants(
      [
        prop({ name: 'disabled', type: 'boolean', default: 'false' }),
        prop({ name: 'tone', type: 'enum', options: ['primary', 'secondary', 'danger'], default: 'primary' }),
        prop({ name: 'label', type: 'text' }),
        prop({ name: 'loading', type: 'boolean', default: 'true' }),
      ],
      100,
    )
    expect(renders.map((render) => `${render.prop}=${render.value}`)).toEqual([
      'tone=secondary',
      'tone=danger',
      'disabled=true',
      'loading=false',
    ])
    expect(renders[2]?.argValue).toBe(true)
    expect(renders[3]?.argValue).toBe(false)
  })

  it('keeps numeric option values numeric in the URL', () => {
    const { renders } = planVariants([prop({ name: 'size', type: 'enum', options: ['1', '2', '3x'] })], 10)
    expect(renders.map((render) => render.argValue)).toEqual([1, 2, '3x'])
  })

  it('says so when an option cannot be written in a story URL, and does not render it as the default', () => {
    const { renders, skipped } = planVariants(
      [prop({ name: 'size', type: 'enum', options: ['a.b', 'full/width', 'x+', 'ok'] })],
      10,
    )
    expect(renders.map((render) => render.value)).toEqual(['ok'])
    expect(skipped).toHaveLength(3)
    expect(skipped[0]).toContain('size: "a.b" cannot be written in a story URL')
  })

  it('stops at 4 axes and 8 values per axis', () => {
    const axes = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      prop({ name, type: 'enum', options: Array.from({ length: 12 }, (_, i) => `v${i}`), default: 'v0' }),
    )
    const { renders, skipped } = planVariants(axes, 1000)
    expect(new Set(renders.map((render) => render.prop)).size).toBe(STORYBOOK_LIMITS.axes)
    expect(renders.filter((render) => render.prop === 'a')).toHaveLength(STORYBOOK_LIMITS.values)
    expect(skipped.join()).toContain('e: only 4 props are varied')
    expect(skipped.join()).toContain('a: only 8 values are rendered')
  })

  it('stays inside the render budget', () => {
    const { renders, skipped } = planVariants(
      [prop({ name: 'tone', type: 'enum', options: ['a', 'b', 'c', 'd'] }), prop({ name: 'on', type: 'boolean' })],
      3,
    )
    expect(renders).toHaveLength(3)
    expect(skipped.join()).toContain('over the render budget')
    expect(planVariants([prop({ name: 'on', type: 'boolean' })], 0).renders).toEqual([])
  })
})

describe('variantAllowance', () => {
  it('shares what is left after the defaults still to render', () => {
    expect(variantAllowance(60, 60)).toBe(Math.floor((400 - 60 - 60) / 60))
    expect(variantAllowance(400, 0)).toBe(0)
    expect(variantAllowance(10, 1)).toBe(389)
    expect(variantAllowance(500, 3)).toBe(0)
  })

  it('never lets 60 components pass 400 renders in all', () => {
    let used = 0
    for (let left = 60; left > 0; left--) {
      used += 1
      used += Math.min(8, variantAllowance(used, left - 1))
    }
    expect(used).toBeLessThanOrEqual(STORYBOOK_LIMITS.renders)
  })
})

describe('story URLs', () => {
  it('writes Storybook args syntax', () => {
    expect(argsParam({ tone: 'primary', disabled: true, size: 2, off: false })).toBe(
      'tone:primary;disabled:!true;size:2;off:!false',
    )
    expect(argsParam({ tone: 'a;b' })).toBeUndefined()
    expect(argsParam({ 'bad name': 'x' })).toBeUndefined()
    expect(argsParam({})).toBe('')
  })

  it('builds iframe.html under the Storybook directory', () => {
    expect(storyIframeUrl('https://x.test/sb/', 'a--b', { tone: 'x' })).toBe(
      'https://x.test/sb/iframe.html?id=a--b&viewMode=story&args=tone%3Ax',
    )
    expect(storyIframeUrl('https://x.test/sb/index.html?path=/story/x', 'a--b')).toBe(
      'https://x.test/sb/iframe.html?id=a--b&viewMode=story',
    )
    expect(storyIframeUrl('https://x.test', 'a--b')).toBe('https://x.test/iframe.html?id=a--b&viewMode=story')
    expect(storybookBasePath('/sb')).toBe('/sb/')
  })
})
