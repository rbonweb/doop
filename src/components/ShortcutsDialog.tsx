import { useStore } from '../lib/store'
import { listShortcuts, shortcutKeycaps, type Shortcut, type ShortcutGroup } from '../lib/shortcuts'
import { Kbd } from './ui/kbd'
import { Modal, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'

const GROUPS: ShortcutGroup[] = ['Tools', 'Canvas', 'Selection', 'View', 'Modes']

function Keycaps({ shortcut }: { shortcut: Shortcut }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shortcutKeycaps(shortcut).map((cap, i) => (
        <Kbd key={i}>{cap}</Kbd>
      ))}
    </span>
  )
}

/** The Keyboard shortcuts dialog: every registered shortcut, grouped. Opened with ? and from the canvas toolbar. */
export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen)
  const setOpen = useStore((s) => s.setShortcutsOpen)
  if (!open) return null
  /* read when the dialog opens, so shortcuts other features registered since show up */
  const all = listShortcuts()
  return (
    <Modal size="lg" onClose={() => setOpen(false)}>
      <ModalEyebrow>Reference</ModalEyebrow>
      <ModalTitle className="mt-2">Keyboard shortcuts</ModalTitle>
      <ModalLede>Letter keys work whenever you are not typing in a field.</ModalLede>
      <div className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {GROUPS.map((group) => {
          const rows = all.filter((s) => (s.group ?? 'Canvas') === group)
          if (!rows.length) return null
          return (
            <section key={group} aria-label={group}>
              <h3 className="mb-2 text-caption font-medium text-ink-faint">{group}</h3>
              <ul className="divide-y divide-line-soft">
                {rows.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-copy text-ink">
                    <span className="min-w-0">{s.label}</span>
                    <Keycaps shortcut={s} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
