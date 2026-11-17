import { useMemo, useState } from 'react'
import type { ComponentDef } from '../../shared/components'
import { instanceSites, jumpToInstance } from '../lib/components'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { Disclosure } from './ui/collapsible'
import { Pressable } from './ui/pressable'

/** On a main: where its instances are, a row per frame. A click selects the next instance in that
 *  frame (the first, then the one after), bringing its page and frame into view. */
export function InstanceList({ def }: { def: ComponentDef }) {
  const t = useT()
  const frames = useStore((s) => s.canvas?.frames)
  const sites = useMemo(() => instanceSites(frames ?? [], def.id), [frames, def.id])
  /* which instance of a frame the next click lands on */
  const [turn, setTurn] = useState<Record<string, number>>({})
  const total = sites.reduce((sum, site) => sum + site.selectors.length, 0)
  if (total === 0) return null
  return (
    <Disclosure
      data-slot="instance-list"
      label={<span className="text-label text-ink-soft">{t('components.instancesHeading', { count: total })}</span>}
      contentClassName="mt-1"
    >
      <ul className="flex flex-col">
        {sites.map(({ frame, selectors }) => {
          const next = (turn[frame.id] ?? 0) % selectors.length
          return (
            <li key={frame.id}>
              <Pressable
                focus="ring"
                data-frame={frame.id}
                className="flex min-h-[26px] items-center gap-2 rounded-row px-1.5 hover:bg-paper-deep"
                title={t('components.jumpToInstance', { name: frame.name })}
                onClick={() => {
                  jumpToInstance(frame.id, selectors[next]!)
                  setTurn((prev) => ({ ...prev, [frame.id]: next + 1 }))
                }}
              >
                <span className="min-w-0 flex-1 truncate text-caption text-ink">{frame.name}</span>
                <span className="flex-none font-mono text-micro text-ink-faint">
                  {selectors.length > 1 ? `${next + 1}/${selectors.length}` : '1'}
                </span>
              </Pressable>
            </li>
          )
        })}
      </ul>
    </Disclosure>
  )
}
