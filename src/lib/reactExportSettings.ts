import { useSyncExternalStore } from 'react'

export type ReactStyling = 'modules' | 'tailwind'

/** The last React export picked: how it is styled and whether tokens ride along. The scope is not kept, it depends on what is open. */
export interface ReactExportSettings {
  styling: ReactStyling
  tokens: boolean
}

/* Per browser, like the image export's pick: a team on Tailwind picks it once. */
export const REACT_EXPORT_STORAGE_KEY = 'doop:react-export'

const DEFAULTS: ReactExportSettings = { styling: 'modules', tokens: true }

/** A stored pick, each field falling back to the default on its own. */
export function readReactExportSettings(raw: string | null): ReactExportSettings {
  if (!raw) return DEFAULTS
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof ReactExportSettings, unknown>>
    return {
      styling: parsed.styling === 'tailwind' || parsed.styling === 'modules' ? parsed.styling : DEFAULTS.styling,
      tokens: typeof parsed.tokens === 'boolean' ? parsed.tokens : DEFAULTS.tokens,
    }
  } catch {
    return DEFAULTS
  }
}

/* A pick storage would not take holds for this session; the snapshot is kept per stored string so React sees one object until the pick changes. */
let unsaved: ReactExportSettings | null = null
let cached: { raw: string | null; settings: ReactExportSettings } | null = null
const listeners = new Set<() => void>()

export function getReactExportSettings(): ReactExportSettings {
  if (unsaved) return unsaved
  let raw: string | null = null
  try {
    raw = localStorage.getItem(REACT_EXPORT_STORAGE_KEY)
  } catch {
    /* storage unavailable: the default stands */
  }
  if (cached?.raw !== raw) cached = { raw, settings: readReactExportSettings(raw) }
  return cached.settings
}

export function setReactExportSettings(patch: Partial<ReactExportSettings>): void {
  const next = { ...getReactExportSettings(), ...patch }
  try {
    localStorage.setItem(REACT_EXPORT_STORAGE_KEY, JSON.stringify(next))
    unsaved = null
  } catch {
    unsaved = next
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== REACT_EXPORT_STORAGE_KEY) return
    unsaved = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useReactExportSettings(): ReactExportSettings {
  return useSyncExternalStore(subscribe, getReactExportSettings)
}
