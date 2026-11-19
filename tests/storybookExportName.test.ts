import { describe, expect, it } from 'vitest'
import { chooseExportName, pascalCase, resemblesTitle, titleLeaf } from '../shared/storybook/exportName.ts'
import { isAliasSpecifier, isBareSpecifier } from '../shared/componentCode.ts'

describe('chooseExportName', () => {
  it('rejects the one and two letter names a minifier leaves', () => {
    for (const functionName of ['l', 's', 'F', 'Kr', 'C', 'a']) {
      expect(chooseExportName({ functionName, title: 'Components/Alert Dialog' })).toBe('AlertDialog')
    }
  })

  it('rejects a function name that does not look like the title, even a long one', () => {
    expect(chooseExportName({ functionName: 'Kr', title: 'Components/Card' })).toBe('Card')
    expect(chooseExportName({ functionName: 'Wrapper', title: 'Components/Card' })).toBe('Card')
  })

  it('prefers the display name over the function name and the title', () => {
    expect(chooseExportName({ displayName: 'AlertDialog', functionName: 'Alert', title: 'Components/Alert' })).toBe(
      'AlertDialog',
    )
    expect(chooseExportName({ displayName: 'l', functionName: 'Button', title: 'Components/Button' })).toBe('Button')
  })

  it('takes a function name that resembles the title, either way round', () => {
    expect(chooseExportName({ functionName: 'Button', title: 'Components/Button' })).toBe('Button')
    expect(chooseExportName({ functionName: 'ButtonGroup', title: 'Button' })).toBe('ButtonGroup')
    expect(chooseExportName({ functionName: 'Dialog', title: 'Components/Alert Dialog' })).toBe('Dialog')
  })

  it('falls back to the title in PascalCase, and to nothing that is not an identifier', () => {
    expect(chooseExportName({ title: 'Components/Alert Dialog' })).toBe('AlertDialog')
    expect(chooseExportName({ title: 'Forms/date-picker' })).toBe('DatePicker')
    expect(chooseExportName({ title: 'Button' })).toBe('Button')
    expect(chooseExportName({ title: 'Components/3D' })).toBeUndefined()
    expect(chooseExportName({ title: 'Components/UI' })).toBeUndefined()
    expect(chooseExportName({ title: '' })).toBeUndefined()
    expect(chooseExportName({ displayName: 'not an identifier', title: 'Components/Card' })).toBe('Card')
  })

  it('has the pieces it is made of', () => {
    expect(titleLeaf('A/B/Alert Dialog')).toBe('Alert Dialog')
    expect(pascalCase('alert dialog_v2')).toBe('AlertDialogV2')
    expect(resemblesTitle('Kr', 'Components/Card')).toBe(false)
    expect(resemblesTitle('card', 'Components/Card')).toBe(true)
  })
})

describe('isBareSpecifier', () => {
  it('accepts packages, subpaths and @/ or ~/ aliases', () => {
    for (const value of [
      'react-ui',
      '@acme/ui',
      '@acme/ui/button',
      '@/components/ui',
      '@/components/ui/button',
      '~/ui/Button_v2',
      '@/a.b/c-d',
    ]) {
      expect(isBareSpecifier(value), value).toBe(true)
    }
  })

  it('refuses a path that climbs, doubles a slash or is not a safe segment', () => {
    for (const value of [
      '@/../x',
      '@//x',
      '~/a/../b',
      '~/a//b',
      '@/a/./b',
      '@/a:b',
      '@/a b',
      '@/a\\b',
      '@/a\tb',
      '@/',
      '~/',
      '@/a/',
      './x',
      '../x',
      '/x',
      'https://x.test/a',
      'node:fs',
      `@/${'a'.repeat(220)}`,
    ]) {
      expect(isBareSpecifier(value), value).toBe(false)
    }
  })

  it('knows an alias from a package', () => {
    expect(isAliasSpecifier('@/components/ui')).toBe(true)
    expect(isAliasSpecifier('~/ui')).toBe(true)
    expect(isAliasSpecifier('@acme/ui')).toBe(false)
    expect(isAliasSpecifier('@/../x')).toBe(false)
  })
})
