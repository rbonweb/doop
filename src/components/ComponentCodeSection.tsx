import { useState } from 'react'
import type { ComponentCode, ComponentDef } from '../../shared/components'
import { importLine, saveComponentCode } from '../lib/components'
import { useT } from '../lib/i18n'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { Button } from './ui/button'
import { Disclosure } from './ui/collapsible'
import { CheckIcon, CopyIcon } from './ui/icons'
import { IconButton } from './ui/icon-button'
import { PropertyRow, TextField } from './ui/property-field'

type PropMapping = NonNullable<ComponentCode['props']>[string]

/** One line of a prop mapping: `tone → variant`, `size: lg → "large"`, or `internal → omitted`. */
function mappingLine(name: string, mapping: PropMapping, omitted: string): string {
  if (mapping.omit) return `${name} → ${omitted}`
  const target = mapping.name ?? name
  const values = Object.entries(mapping.values ?? {})
    .map(([from, to]) => `${from} → ${JSON.stringify(to)}`)
    .join(', ')
  return values ? `${name} → ${target} (${values})` : `${name} → ${target}`
}

/** On a main: where the component lives in the team's code. Read-only mapping, with the import line
 *  to copy and an edit of the package and export it is imported from. */
export function ComponentCodeSection({ def }: { def: ComponentDef }) {
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const code = def.code
  const line = importLine(code)
  const mappedProps = Object.entries(code?.props ?? {})
  const mappedSlots = Object.entries(code?.slots ?? {})
  /* a library component is changed on its library canvas */
  const editable = canEdit && !def.source?.library

  const copy = () => {
    if (!line) return
    navigator.clipboard
      .writeText(line)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => useStore.getState().pushNotice(t('components.codeCopyFailed')))
  }

  return (
    <Disclosure
      data-slot="component-code"
      label={<span className="text-label text-ink-soft">{t('components.codeHeading')}</span>}
      contentClassName="mt-1.5 flex flex-col gap-2"
    >
      {editing ? (
        <CodeForm def={def} onDone={() => setEditing(false)} />
      ) : (
        <>
          {line ? (
            <div className="flex items-center gap-1 rounded-control bg-sub py-0.5 pr-0.5 pl-2">
              <code
                data-slot="import-line"
                className="min-w-0 flex-1 truncate font-mono text-micro text-ink"
                title={line}
              >
                {line}
              </code>
              <IconButton
                size="sm"
                aria-label={t('components.codeCopyImport')}
                title={t('components.codeCopyImport')}
                onClick={copy}
              >
                {copied ? <CheckIcon size="rail" /> : <CopyIcon size="rail" />}
              </IconButton>
            </div>
          ) : (
            <p className="text-caption text-ink-soft">{t('components.codeNone')}</p>
          )}
          {(mappedProps.length > 0 || mappedSlots.length > 0) && (
            <ul data-slot="code-mapping" className="flex flex-col gap-0.5 font-mono text-micro text-ink-soft">
              {mappedProps.map(([name, mapping]) => (
                <li
                  key={`p:${name}`}
                  className="truncate"
                  title={mappingLine(name, mapping, t('components.codeOmitted'))}
                >
                  {mappingLine(name, mapping, t('components.codeOmitted'))}
                </li>
              ))}
              {mappedSlots.map(([name, target]) => (
                <li key={`s:${name}`} className="truncate">
                  {t('components.codeSlot', { name, target })}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <Button size="inline" variant="link" className="self-start" onClick={() => setEditing(true)}>
              {line ? t('components.codeEdit') : t('components.codeMap')}
            </Button>
          )}
        </>
      )}
    </Disclosure>
  )
}

function CodeForm({ def, onDone }: { def: ComponentDef; onDone: () => void }) {
  const t = useT()
  const [importFrom, setImportFrom] = useState(def.code?.importFrom ?? '')
  const [exportName, setExportName] = useState(def.code?.exportName ?? '')
  const [busy, setBusy] = useState(false)
  const ready = importFrom.trim() !== '' && exportName.trim() !== ''
  const save = async () => {
    if (!ready || busy) return
    setBusy(true)
    const ok = await saveComponentCode(def, {
      ...def.code,
      importFrom: importFrom.trim(),
      exportName: exportName.trim(),
    })
    setBusy(false)
    if (ok) onDone()
  }
  const remove = async () => {
    setBusy(true)
    const ok = await saveComponentCode(def, null)
    setBusy(false)
    if (ok) onDone()
  }
  return (
    <div data-slot="code-form" className="flex flex-col gap-1">
      <PropertyRow label={t('components.codePackage')}>
        <TextField
          label={t('components.codePackageAria')}
          value={importFrom}
          placeholder="@acme/ui"
          onCommit={setImportFrom}
          onDraft={setImportFrom}
        />
      </PropertyRow>
      <PropertyRow label={t('components.codeExport')}>
        <TextField
          label={t('components.codeExportAria')}
          value={exportName}
          placeholder="Button"
          onCommit={setExportName}
          onDraft={setExportName}
        />
      </PropertyRow>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button size="sm" disabled={!ready || busy} onClick={() => void save()}>
          {t('components.codeSave')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          {t('components.codeCancel')}
        </Button>
        {def.code && (
          <Button size="inline" variant="link" className="ml-auto" disabled={busy} onClick={() => void remove()}>
            {t('components.codeRemove')}
          </Button>
        )}
      </div>
    </div>
  )
}
