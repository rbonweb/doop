import { clientIntegrations } from '@/integrations'
import { GithubIcon, RadioTowerIcon, WebIcon } from './ui/icons'
import type { ImportSource } from './ImportSources'

/** The sources the import picker offers, in order — the canvas page's modal
 *  and Home's Import button show the same cards, so the list lives once. */
export function importSources(): ImportSource[] {
  return [
    {
      id: 'website',
      title: 'Website',
      blurb: 'One page, or discover a whole site.',
      icon: <WebIcon className="size-5 text-ink" />,
    },
    ...clientIntegrations
      .filter((i) => i.ImportSection && i.importSource)
      .map((i) => ({ id: i.id, ...i.importSource! })),
    {
      id: 'liveapp',
      title: 'Live app',
      blurb: 'Behind a login, a VPN or localhost.',
      icon: <RadioTowerIcon className="size-5 text-ink" />,
    },
    {
      id: 'github',
      title: 'GitHub repo',
      blurb: 'Screens read from the repo’s routes.',
      icon: <GithubIcon width={21} height={21} />,
    },
  ]
}
