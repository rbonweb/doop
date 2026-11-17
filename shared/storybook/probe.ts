/** Pure: no node or server imports, since the CLI bundles it. The one thing read from the page's own JavaScript world: Storybook's preview object (its argTypes, initial args and display name, and the phase of the story's render). The page controls that world, so the reader is installed before any page script runs (`page.evaluateOnNewDocument`), captures the builtins it needs while they are still the browser's, and hangs itself on `window` under a random name as a non-writable, non-configurable property. It copies primitives only, never runs a getter or `toJSON`, treats anything that throws as missing, and answers with one string whose length is bounded by construction. Everything else about the story (its DOM and CSS) is read in an isolated world (see capture.ts), which page script cannot reach. */

/** The longest answer the probe gives, in characters. */
export const MAX_PROBE_CHARS = 262_144

/** A name no page can guess ahead of time: one per render. */
export function probeName(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return '__doop_probe_' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The attribute on the document element where the probe leaves its verdict once the story has rendered or failed, so the wait can run in the isolated world, where page script cannot interfere with it. */
export function probeAttribute(name: string): string {
  return 'data-' + name.slice(2).replace(/_/g, '-')
}

/** The attribute where the probe leaves the outcome of `apply`: `ready` once the story has rendered again with the new args, `error` if it failed or could not be asked. */
export function probeAppliedAttribute(name: string): string {
  return probeAttribute(name) + '-applied'
}

/** The source to give `page.evaluateOnNewDocument`: the probe's installer with a stand-in for the `__name` helper that tsx adds to nested functions. */
export function probeInstallSource(name: string): string {
  return `(() => { const __name = (target) => target; (${installStoryProbe.toString()})(${JSON.stringify(name)}) })()`
}

/** Self-contained; runs at document start in the page's main world. Uses no iteration protocol, no method of a page-reachable prototype and no spread, since all of those can be replaced by page script once it runs. */
export function installStoryProbe(name: string): void {
  const call = Function.prototype.call
  const apply = Reflect.apply
  const stringify = JSON.stringify
  const getDescriptor = Object.getOwnPropertyDescriptor
  const ownKeys = Reflect.ownKeys
  const isArray = Array.isArray
  const isFinite = Number.isFinite
  const slice = call.bind(String.prototype.slice) as (text: string, from: number, to: number) => string
  const hasOwn = call.bind(Object.prototype.hasOwnProperty) as (target: object, key: string) => boolean
  const win = window
  const setTimer = setInterval
  const clearTimer = clearInterval
  const setAttribute = call.bind(Element.prototype.setAttribute) as (
    target: Element,
    key: string,
    value: string,
  ) => void
  const attribute = 'data-' + name.slice(2).replace(/_/g, '-')
  const appliedAttribute = attribute + '-applied'
  const parse = JSON.parse
  const removeAttribute = call.bind(Element.prototype.removeAttribute) as (target: Element, key: string) => void

  const MAX_CHARS = 262144
  const MAX_DEPTH = 4
  const MAX_KEYS = 300
  const MAX_ITEMS = 60
  const MAX_STRING = 400
  const MAX_KEY = 100
  const OBJECT = 'object'
  const FUNCTION = 'function'

  /** an own data property, or undefined: no getter runs, no prototype is consulted, a trap that throws is a missing field */
  const field = (target: unknown, key: string): unknown => {
    if ((typeof target !== OBJECT && typeof target !== FUNCTION) || target === null) return undefined
    try {
      const descriptor = getDescriptor(target as object, key)
      return descriptor !== undefined && hasOwn(descriptor, 'value') ? descriptor.value : undefined
    } catch {
      return undefined
    }
  }

  let remaining = MAX_CHARS
  const encode = (value: unknown, depth: number): string | undefined => {
    if (value === null) return 'null'
    const kind = typeof value
    if (kind === 'boolean') return value ? 'true' : 'false'
    if (kind === 'number') return isFinite(value as number) ? stringify(value) : undefined
    if (kind === 'string') {
      const text = stringify(slice(value as string, 0, MAX_STRING))
      remaining -= text.length
      return remaining >= 0 ? text : undefined
    }
    if (kind !== OBJECT || depth >= MAX_DEPTH) return undefined
    try {
      let out: string
      if (isArray(value)) {
        out = '['
        const length = field(value, 'length')
        const count = typeof length === 'number' && length < MAX_ITEMS ? length : MAX_ITEMS
        for (let index = 0; index < count; index++) {
          const item = field(value, index + '')
          const text = item === undefined ? undefined : encode(item, depth + 1)
          out += (index ? ',' : '') + (text === undefined ? 'null' : text)
          remaining -= 1
        }
        return out + ']'
      }
      out = '{'
      const keys = ownKeys(value as object)
      let written = 0
      for (let index = 0; index < keys.length && index < MAX_KEYS; index++) {
        const key = keys[index]
        if (typeof key !== 'string') continue
        const text = encode(field(value, key), depth + 1)
        if (text === undefined) continue
        const head = stringify(slice(key, 0, MAX_KEY)) + ':'
        remaining -= head.length + 1
        if (remaining < 0) break
        out += (written++ ? ',' : '') + head + text
      }
      return out + '}'
    } catch {
      return undefined
    }
  }

  /* the phases of a render still under way (a render that is aborted is followed by the one that replaces it) */
  const PENDING = ' preparing loading beforeEach rendering playing completing aborted '

  const preview = (): unknown => field(win, '__STORYBOOK_PREVIEW__')

  const textOf = (getDescriptor(HTMLElement.prototype, 'innerText') || {}).get as (() => string) | undefined
  const indexOf = call.bind(String.prototype.indexOf) as (text: string, search: string) => number
  /* an error display that is about a service worker (MSW and the like) is a story the hardened renderer cannot run: it has no service workers, by design. The verdict stays one of two fixed words whatever the page says. */
  const errorKind = (): string => {
    try {
      const text = textOf ? apply(textOf, document.body, []) : ''
      if (typeof text === 'string' && /* only the head of the display names the cause */ text.length > 0) {
        const head = slice(text, 0, 600)
        if (indexOf(head, 'Service Worker') !== -1 || indexOf(head, 'ServiceWorker') !== -1) return 'needs_worker'
      }
    } catch {
      /* a plain error */
    }
    return 'error'
  }

  const state = (): string => {
    try {
      const phase = field(field(preview(), 'currentRender'), 'phase')
      const body = document.body
      if (!body) return 'pending'
      const classes = ' ' + body.className + ' '
      if (classes.indexOf(' sb-show-errordisplay ') !== -1 || phase === 'errored') return errorKind()
      const root = document.querySelector('#storybook-root') || document.querySelector('#root')
      const hasContent = !!(root && root.firstElementChild)
      /* every phase but the ones that come before the story is on screen is a finished render: Storybook 7 ends on completed, 8 and 9 on completed or afterEach, 10 on finished, and a phase a later version adds counts as done too, rather than timing out */
      if (typeof phase === 'string')
        return PENDING.indexOf(' ' + phase + ' ') === -1 && hasContent ? 'ready' : 'pending'
      return classes.indexOf(' sb-show-main ') !== -1 && hasContent ? 'ready' : 'pending'
    } catch {
      return 'pending'
    }
  }

  const meta = async (storyId: string): Promise<string | null> => {
    try {
      const p = preview()
      let story: unknown = field(field(p, 'currentRender'), 'story')
      if (field(story, 'id') !== storyId) {
        story = undefined
        const store = field(p, 'storyStoreValue') || field(p, 'storyStore')
        try {
          const load = store ? (store as { loadStory?: unknown }).loadStory : undefined
          if (typeof load === FUNCTION)
            story = await apply(load as (...args: unknown[]) => unknown, store, [{ storyId }])
        } catch {
          /* try the older store */
        }
        if (!story) {
          try {
            const legacy = field(win, '__STORYBOOK_STORY_STORE__') as { fromId?: unknown } | undefined
            const fromId = legacy ? legacy.fromId : undefined
            if (typeof fromId === FUNCTION) story = apply(fromId as (...args: unknown[]) => unknown, legacy, [storyId])
          } catch {
            /* no store */
          }
        }
      }
      if (!story || typeof story !== OBJECT) return null
      remaining = MAX_CHARS
      const argTypes = encode(field(story, 'argTypes'), 0)
      const initialArgs = encode(field(story, 'initialArgs'), 0)
      const component = field(story, 'component')
      const display = field(component, 'displayName')
      const fallback = field(component, 'name')
      const shown = typeof display === 'string' ? display : fallback
      const displayName = typeof shown === 'string' && shown.length < 100 ? stringify(slice(shown, 0, 100)) : undefined
      const text =
        '{"argTypes":' +
        (argTypes ?? '{}') +
        ',"initialArgs":' +
        (initialArgs ?? '{}') +
        (displayName ? ',"displayName":' + displayName : '') +
        '}'
      return text.length <= MAX_CHARS + 1024 ? text : null
    } catch {
      return null
    }
  }

  /* the verdict goes in the DOM, which the isolated world can watch; page script can write it too, which only fools its own import */
  const timer = setTimer(() => {
    try {
      const verdict = state()
      const root = document.documentElement
      if (verdict === 'pending' || !root) return
      clearTimer(timer)
      setAttribute(root, attribute, verdict)
    } catch {
      /* try again on the next tick */
    }
  }, 50)

  /**
   * Sets args on the story through Storybook's own channel (`updateStoryArgs`), as its controls panel does, and leaves `ready` on the document element once the story has rendered again. The `args` in a story URL are not enough: Storybook drops one whose argType has no `type.name`, which is what react-docgen leaves for many components.
   */
  const applyArgs = (storyId: string, argsJson: string): void => {
    const root = document.documentElement
    const done = (verdict: string) => {
      try {
        setAttribute(root, appliedAttribute, verdict)
      } catch {
        /* nothing to tell */
      }
    }
    try {
      removeAttribute(root, appliedAttribute)
      const channel = field(preview(), 'channel') as
        | {
            on?: (event: string, listener: () => void) => void
            emit?: (event: string, payload: unknown) => void
          }
        | undefined
      const on = channel ? channel.on : undefined
      const emit = channel ? channel.emit : undefined
      /* no channel to ask (an old or odd Storybook): the args in the story URL stand */
      if (!channel || typeof on !== 'function' || typeof emit !== 'function') return done('unsupported')
      /* the render that follows the update announces itself; listeners are added first so a quick one is not missed */
      apply(on, channel, ['storyRendered', () => done('ready')])
      apply(on, channel, ['storyErrored', () => done('error')])
      apply(on, channel, ['storyThrewException', () => done('error')])
      apply(emit, channel, ['updateStoryArgs', { storyId, updatedArgs: parse(argsJson) }])
    } catch {
      done('error')
    }
  }

  Object.defineProperty(win, name, {
    value: Object.freeze({ state, meta, applyArgs }),
    writable: false,
    configurable: false,
    enumerable: false,
  })
}
