import { describe, expect, it } from 'vitest'
import {
  NameAllocator,
  camelCase,
  componentName,
  fileBase,
  isIdentifier,
  pascalCase,
  propName,
} from '../server/reactExport/names.ts'

describe('isIdentifier', () => {
  it('accepts plain ASCII identifiers', () => {
    expect(isIdentifier('button')).toBe(true)
    expect(isIdentifier('_private')).toBe(true)
    expect(isIdentifier('$price')).toBe(true)
    expect(isIdentifier('c123')).toBe(true)
  })

  it('refuses reserved words and globals', () => {
    for (const word of ['class', 'let', 'await', 'enum', 'undefined', 'NaN', 'Infinity', 'arguments', 'eval']) {
      expect(isIdentifier(word)).toBe(false)
    }
  })

  it('refuses malformed names and non-ASCII letters', () => {
    expect(isIdentifier('1button')).toBe(false)
    expect(isIdentifier('')).toBe(false)
    expect(isIdentifier('na-me')).toBe(false)
    expect(isIdentifier('naïve')).toBe(false)
    expect(isIdentifier('naïveButton')).toBe(false)
  })
})

describe('pascalCase', () => {
  it('joins words from every separator', () => {
    expect(pascalCase('primary button')).toBe('PrimaryButton')
    expect(pascalCase('primary-button')).toBe('PrimaryButton')
    expect(pascalCase('primary_button')).toBe('PrimaryButton')
    expect(pascalCase('primaryButton')).toBe('PrimaryButton')
  })

  it('handles blank, numeric and non-ASCII input', () => {
    expect(pascalCase('  ')).toBe('Component')
    expect(pascalCase('123 go')).toBe('C123Go')
    expect(pascalCase('Ünicode café name')).toBe('NicodeCafName')
  })
})

describe('camelCase', () => {
  it('joins words with a lower-case first letter', () => {
    expect(camelCase('primary button')).toBe('primaryButton')
    expect(camelCase('primary-button')).toBe('primaryButton')
    expect(camelCase('primary_button')).toBe('primaryButton')
    expect(camelCase('primaryButton')).toBe('primaryButton')
  })

  it('handles blank, numeric and non-ASCII input', () => {
    expect(camelCase('  ')).toBe('prop')
    expect(camelCase('123 go')).toBe('c123Go')
    expect(camelCase('Ünicode café name')).toBe('nicodeCafName')
  })
})

describe('NameAllocator', () => {
  it('suffixes collisions in order', () => {
    const names = new NameAllocator()
    expect(names.take('Button')).toBe('Button')
    expect(names.take('Button')).toBe('Button2')
    expect(names.take('Button')).toBe('Button3')
  })

  it('starts from the reserved names it is given', () => {
    const names = new NameAllocator({ reserved: ['Root'] })
    expect(names.has('Root')).toBe(true)
    expect(names.take('Root')).toBe('Root2')
  })

  it('compares case-insensitively when asked', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    expect(names.take('Card')).toBe('Card')
    expect(names.take('card')).toBe('card2')
    expect(names.has('CARD')).toBe(true)
  })
})

describe('componentName', () => {
  it('returns a unique PascalCase component name', () => {
    const names = new NameAllocator()
    expect(componentName('primary button', names)).toBe('PrimaryButton')
    expect(componentName('Card', names)).toBe('Card')
    expect(componentName('Card', names)).toBe('Card2')
  })

  it('refuses names the component file already uses', () => {
    const names = new NameAllocator()
    const reserved = ['React', 'Fragment', 'styles', 'cx', 'Map']
    for (const raw of reserved) {
      const name = componentName(raw, names)
      expect(isIdentifier(name)).toBe(true)
      expect(name.toLowerCase()).not.toBe(raw.toLowerCase())
      expect(reserved.map((word) => word.toLowerCase())).not.toContain(name.toLowerCase())
    }
  })
})

describe('propName', () => {
  it('returns a unique camelCase prop name', () => {
    const names = new NameAllocator()
    expect(propName('label text', names)).toBe('labelText')
    expect(propName('label text', names)).toBe('labelText2')
  })

  it('refuses React-reserved and keyword names but keeps className', () => {
    const names = new NameAllocator()
    for (const raw of ['key', 'ref', 'class']) {
      const name = propName(raw, names)
      expect(name).not.toBe(raw)
      expect(isIdentifier(name)).toBe(true)
    }
    expect(propName('className', names)).toBe('className')
  })
})

describe('fileBase', () => {
  it('strips dots and path separators', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    const base = fileBase('../etc/passwd', names)
    expect(base).not.toContain('.')
    expect(base).not.toContain('/')
    expect(base).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never returns a Windows device name', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    for (const raw of ['CON', 'nul', 'com1']) {
      const base = fileBase(raw, names)
      expect(base.toLowerCase()).not.toBe(raw)
      expect(base).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('skips Windows device names when suffixing', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    const results = [
      ...Array.from({ length: 5 }, () => fileBase('com', names)),
      ...Array.from({ length: 5 }, () => fileBase('lpt', names)),
    ]
    const device = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i
    for (const base of results) {
      expect(base).not.toMatch(device)
      expect(base).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    expect(new Set(results.map((base) => base.toLowerCase())).size).toBe(results.length)
  })

  it('caps the length at 64 characters', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    const base = fileBase('a'.repeat(200), names)
    expect(base).toHaveLength(64)
    expect(base).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('falls back for empty input and stays unique case-insensitively', () => {
    const names = new NameAllocator({ caseInsensitive: true })
    expect(fileBase('', names)).not.toBe('')
    expect(fileBase('Card', names)).toBe('Card')
    expect(fileBase('card', names)).toBe('card2')
  })
})
