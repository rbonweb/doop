import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

/** Which browser renders the Storybook: the one the person names, else one found on this machine. */

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserNotFoundError'
  }
}

export interface FoundBrowser {
  path: string
  /** where the choice came from, for the log line */
  source: '--browser' | 'DOOP_IMPORT_BROWSER' | 'CHROME_PATH' | 'installed'
}

export interface BrowserLookup {
  /** the `--browser` flag */
  flag?: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  /** whether a file can be run; swapped in tests */
  isExecutable?: (file: string) => boolean
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The places a Chromium-based browser usually lives, in the order tried. */
export function installedBrowserPaths(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (root): root is string => !!root,
    )
    return roots.flatMap((root) => [
      path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
    ])
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ]
}

const HOW_TO_POINT =
  'Install Chromium or Edge, or point doop-import at the browser you use: pass --browser <path>, or set DOOP_IMPORT_BROWSER (or CHROME_PATH) to its executable.'

/**
 * `--browser`, else `DOOP_IMPORT_BROWSER`, else `CHROME_PATH`, else the first browser found at a usual install path. A path that was named but cannot be run is an error, never a quiet fall back to a different browser.
 */
export function findBrowser(lookup: BrowserLookup): FoundBrowser {
  const runnable = lookup.isExecutable ?? executable
  const named: [FoundBrowser['source'], string | undefined][] = [
    ['--browser', lookup.flag],
    ['DOOP_IMPORT_BROWSER', lookup.env.DOOP_IMPORT_BROWSER],
    ['CHROME_PATH', lookup.env.CHROME_PATH],
  ]
  for (const [source, value] of named) {
    if (!value?.trim()) continue
    const file = path.resolve(value.trim())
    if (!runnable(file)) {
      throw new BrowserNotFoundError(
        `${source} is "${file}", which is not an executable file (a relative path is taken from the current directory). ${HOW_TO_POINT}`,
      )
    }
    return { path: file, source }
  }
  for (const file of installedBrowserPaths(lookup.platform, lookup.env)) {
    if (runnable(file)) return { path: file, source: 'installed' }
  }
  throw new BrowserNotFoundError(`No Chromium or Edge was found on this machine. ${HOW_TO_POINT}`)
}
