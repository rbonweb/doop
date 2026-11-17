/** ECMAScript keywords, strict-mode reserved words and the globals a binding must never shadow. */
const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
  'undefined',
  'NaN',
  'Infinity',
  'arguments',
  'eval',
])

/** Identifiers the generated component file already declares or relies on, so a component must not take their name. */
const COMPONENT_RESERVED = new Set(
  [
    'React',
    'Fragment',
    'Component',
    'styles',
    'cx',
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'Map',
    'Set',
    'Promise',
    'Error',
    'Date',
    'JSON',
    'Math',
    'window',
    'document',
  ].map((name) => name.toLowerCase()),
)

/** Props React owns; a generated prop may not shadow them. */
const PROP_RESERVED = new Set(['key', 'ref'])

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** Anything that is not an ASCII letter or digit separates words; non-ASCII letters are dropped here. */
const WORD_SEPARATORS = /[^A-Za-z0-9]+/
const FILE_SEPARATORS = /[^A-Za-z0-9]+/g
const LOWER_THEN_UPPER = /([a-z0-9])([A-Z])/g
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g
const LEADING_DIGIT = /^[0-9]/
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i
const MAX_FILE_BASE = 64

/** A valid JS binding name: ASCII letters, digits, `_` and `$`, not starting with a digit, and not a reserved word or global. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)
}

/** Split on spaces, hyphens, underscores, slashes, dots and camelCase boundaries; everything non-ASCII is dropped. */
function splitWords(raw: string): string[] {
  return raw
    .split(WORD_SEPARATORS)
    .flatMap((part) => part.replace(ACRONYM_BOUNDARY, '$1 $2').replace(LOWER_THEN_UPPER, '$1 $2').split(' '))
    .filter((word) => word.length > 0)
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** `primary button`, `primary-button`, `primary_button` and `primaryButton` all become `PrimaryButton`; empty input gives `Component`. */
export function pascalCase(raw: string): string {
  const words = splitWords(raw)
  if (words.length === 0) return 'Component'
  const name = words.map(capitalize).join('')
  return LEADING_DIGIT.test(name) ? `C${name}` : name
}

/** The same words as `pascalCase` with a lower-case first letter; empty input gives `prop`. */
export function camelCase(raw: string): string {
  const words = splitWords(raw)
  const first = words[0]
  if (!first) return 'prop'
  const name = first.toLowerCase() + words.slice(1).map(capitalize).join('')
  return LEADING_DIGIT.test(name) ? `c${name}` : name
}

export interface NameAllocatorOptions {
  /** names that are taken before the first `take` */
  reserved?: Iterable<string>
  /** compare names case-insensitively, as file systems do */
  caseInsensitive?: boolean
}

/** Hands out unique names in one namespace, suffixing `2`, `3`, ... on collision. */
export class NameAllocator {
  readonly #used = new Set<string>()
  readonly #caseInsensitive: boolean

  constructor(options: NameAllocatorOptions = {}) {
    this.#caseInsensitive = options.caseInsensitive ?? false
    for (const name of options.reserved ?? []) this.#used.add(this.#key(name))
  }

  /** A unique name for `wanted`; the returned name is recorded. */
  take(wanted: string): string {
    if (!this.#used.has(this.#key(wanted))) {
      this.#used.add(this.#key(wanted))
      return wanted
    }
    for (let suffix = 2; suffix < 100_000; suffix += 1) {
      const candidate = `${wanted}${suffix}`
      if (!this.#used.has(this.#key(candidate))) {
        this.#used.add(this.#key(candidate))
        return candidate
      }
    }
    throw new Error(`NameAllocator could not find a free name for ${wanted}`)
  }

  has(name: string): boolean {
    return this.#used.has(this.#key(name))
  }

  #key(name: string): string {
    return this.#caseInsensitive ? name.toLowerCase() : name
  }
}

/** A PascalCase component name that is a valid identifier, is not one of the names the component file owns, and is unique. */
export function componentName(raw: string, names: NameAllocator): string {
  const name = pascalCase(raw)
  const safe = COMPONENT_RESERVED.has(name.toLowerCase()) || WINDOWS_DEVICE.test(name) ? `${name}View` : name
  return names.take(safe)
}

/** A camelCase prop name that is a valid identifier, is not `key` or `ref`, and is unique. */
export function propName(raw: string, names: NameAllocator): string {
  const name = camelCase(raw)
  const safe = !isIdentifier(name) || PROP_RESERVED.has(name.toLowerCase()) ? `${name}Prop` : name
  return names.take(safe)
}

/** A safe file base name: ASCII letters, digits, `_` and `-` only, no dots or path separators, at most 64 characters, not a Windows device name, unique case-insensitively. */
export function fileBase(raw: string, names: NameAllocator): string {
  const cleaned = raw
    .replace(FILE_SEPARATORS, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[-_]+$/, '')
  let base = cleaned.length > 0 ? cleaned : 'component'
  if (WINDOWS_DEVICE.test(base)) base = `${base}-file`
  base = base.slice(0, MAX_FILE_BASE).replace(/[-_]+$/, '')
  if (base.length === 0) base = 'component'
  return allocateFileBase(base, names)
}

function allocateFileBase(base: string, names: NameAllocator): string {
  if (!WINDOWS_DEVICE.test(base) && !names.has(base)) return names.take(base)
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const tail = String(suffix)
    const candidate = `${base.slice(0, MAX_FILE_BASE - tail.length).replace(/[-_]+$/, '')}${tail}`
    if (!WINDOWS_DEVICE.test(candidate) && !names.has(candidate)) return names.take(candidate)
  }
  throw new Error(`fileBase could not find a free name for ${base}`)
}
