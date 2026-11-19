import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ComponentDef } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { onFrameChange, previewVariant } from '../lib/frameBridge'
import { useT } from '../lib/i18n'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { combinationLabel, previewOf, useVariantPreview, variantDefault, variantPropsOf } from '../lib/variantPreview'
import type { VariantOp, VariantProp, VariantRule } from '../lib/variantTypes'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { IconButton } from './ui/icon-button'
import { MoreHorizontalIcon, PlusIcon } from './ui/icons'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import { PropertyRow, SelectField } from './ui/property-field'

/** What is being typed inline: a new value for a prop, or a new name for a value or a prop. */
type Entry = { kind: 'add-value' | 'rename-value' | 'rename-prop'; prop: string; value?: string }

/** A removal waiting for its confirm, with what the dry run said it would touch. */
interface Removal {
  prop: string
  value?: string
  instances: number
  wasDefault: boolean
  newDefault: string
}

/** The name a variant is given: lowercase, as it becomes `data-<name>` on every instance. */
const propName = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '-')

/**
 * The Variants group of a main's Design tab: the component's enum and boolean variants (values as chips) with the
 * edits to them, and "Preview variant", which shows one combination on the main and sends the Design panel's style
 * edits to that combination (`variantPreview.ts`). Every edit is one `POST …/variants`, one write of the main:
 * the editor's undo history holds frame edits only, so none of these can be undone from it.
 */
export function VariantsSection({ frame, def }: { frame: Frame; def: ComponentDef }) {
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const props = useMemo(() => variantPropsOf(def.props), [def.props])
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [entry, setEntry] = useState<Entry | null>(null)
  const [text, setText] = useState('')
  const [adding, setAdding] = useState<'enum' | 'boolean' | null>(null)
  const [newName, setNewName] = useState('')
  const [newValues, setNewValues] = useState('')
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [rules, setRules] = useState<VariantRule[]>([])

  const preview = useMemo(() => previewOf(frame.id, def.id, props, picks), [frame.id, def.id, props, picks])
  const editing = Object.keys(preview.when).length > 0

  /* the rules written under each combination, read again whenever the main's revision moves (a collaborator's edit too) */
  useEffect(() => {
    let live = true
    api
      .componentVariants(frame.canvasId, def.id)
      .then((read) => live && setRules(read.rules))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [frame.canvasId, def.id, def.rev])

  /* the previewed combination: what the Design panel writes style edits to, and what the live frame shows */
  useEffect(() => {
    useVariantPreview.getState().setPreview(preview)
    const attrs = Object.keys(preview.when).length
      ? Object.fromEntries(Object.entries(preview.values).map(([name, value]) => [`data-${name}`, value]))
      : null
    void previewVariant(frame.id, def.id, attrs)
    /* the runtime keeps it across renders; a frame that mounts again, or a document that reloads, gets it back */
    const off = attrs ? onFrameChange(frame.id, () => void previewVariant(frame.id, def.id, attrs)) : () => {}
    return off
  }, [preview, frame.id, def.id])
  /* the preview ends with the selection: leaving the component, or the frame, puts the base back */
  useEffect(
    () => () => {
      const { preview: current, setPreview } = useVariantPreview.getState()
      if (current?.frameId === frame.id && current.componentId === def.id) setPreview(null)
      void previewVariant(frame.id, def.id, null)
    },
    [frame.id, def.id],
  )

  const styled = useMemo(
    () =>
      rules
        .filter(
          (rule) =>
            Object.keys(rule.when).length === Object.keys(preview.when).length &&
            Object.entries(preview.when).every(([name, value]) => rule.when[name] === value),
        )
        .reduce((total, rule) => total + Object.keys(rule.declarations).length, 0),
    [rules, preview.when],
  )

  const fail = (error: unknown) => useStore.getState().pushNotice(errorMessage(error, t('componentVariants.failed')))

  /** One `POST …/variants`: the main is written once and its instances follow. */
  async function run(ops: VariantOp[]): Promise<boolean> {
    setBusy(true)
    try {
      const result = await api.editComponentVariants(frame.canvasId, def.id, { ops })
      if (useStore.getState().canvas?.id === frame.canvasId) {
        useStore.getState().setComponentLocal(result.component.id, result.component)
      }
      setRules(result.rules)
      return true
    } catch (error) {
      fail(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  /** What an op would rewrite, without writing it. */
  async function instancesAffected(ops: VariantOp[]): Promise<number | null> {
    setBusy(true)
    try {
      return (await api.editComponentVariants(frame.canvasId, def.id, { ops, dryRun: true })).instances_updated
    } catch (error) {
      fail(error)
      return null
    } finally {
      setBusy(false)
    }
  }

  /* An open menu holds focus, and hands it back to its trigger as it closes: an entry opened from it takes the focus once
     the menu is gone, instead of being blurred (which cancels it) by either. */
  const entryInput = useRef<HTMLInputElement | null>(null)
  const enteringFromMenu = useRef(false)
  const keepEntryFocus = (event: Event) => {
    if (!enteringFromMenu.current) return
    enteringFromMenu.current = false
    event.preventDefault()
    entryInput.current?.focus()
  }

  function startEntry(next: Entry, initial = '') {
    enteringFromMenu.current = true
    setEntry(next)
    setText(initial)
  }

  async function commitEntry() {
    if (!entry) return
    const value = text.trim()
    const { kind, prop } = entry
    setEntry(null)
    if (!value) return
    if (kind === 'add-value') await run([{ op: 'add_value', prop, value }])
    else if (kind === 'rename-value' && entry.value !== value) {
      await run([{ op: 'rename_value', prop, from: entry.value ?? '', to: value }])
    } else if (kind === 'rename-prop' && prop !== propName(value)) {
      await run([{ op: 'rename_prop', prop, to: propName(value) }])
    }
  }

  const entryKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void commitEntry()
    if (event.key === 'Escape') setEntry(null)
  }

  async function submitNew() {
    const name = propName(newName)
    if (!name) return
    const values = newValues
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (adding === 'enum' && values.length === 0) return
    const ok = await run([
      adding === 'boolean' ? { op: 'add_boolean', prop: name } : { op: 'add_enum', prop: name, options: values },
    ])
    if (ok) {
      setAdding(null)
      setNewName('')
      setNewValues('')
    }
  }

  async function askRemoval(prop: VariantProp, value?: string) {
    const wasDefault = value !== undefined && variantDefault(prop) === value
    /* the server wants a default named whenever the prop has none written, so the current one rides along otherwise */
    const newDefault =
      value === undefined ? '' : wasDefault ? (fallbackDefault(prop, value) ?? '') : variantDefault(prop)
    const instances = await instancesAffected([removalOp(prop.name, value, newDefault)])
    if (instances === null) return
    setRemoval({ prop: prop.name, value, instances, wasDefault, newDefault })
  }

  async function confirmRemoval() {
    if (!removal) return
    const { prop, value, newDefault } = removal
    setRemoval(null)
    await run([removalOp(prop, value, newDefault)])
  }

  const removalProp = removal ? props.find((prop) => prop.name === removal.prop) : undefined
  const removalOptions = removalProp?.options.filter((option) => option !== removal?.value) ?? []

  return (
    <div data-slot="variants-section" className="flex flex-col gap-2 border-t border-line-soft pt-2.5">
      <div className="flex min-h-6 items-center gap-1.5">
        <span className="text-body font-medium text-ink">{t('componentVariants.heading')}</span>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="ml-auto" disabled={busy} data-variant-add>
                <PlusIcon size="rail" aria-hidden />
                {t('componentVariants.addVariant')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width="sm">
              <DropdownMenuItem onSelect={() => setAdding('enum')}>{t('componentVariants.addChoice')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('boolean')}>
                {t('componentVariants.addBoolean')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {adding && (
        <div data-slot="variant-new" className="flex flex-col gap-1.5">
          <Input
            variant="field"
            inputSize="auto"
            autoFocus
            value={newName}
            placeholder={t('componentVariants.namePlaceholder')}
            aria-label={t('componentVariants.nameLabel')}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submitNew()}
          />
          {adding === 'enum' && (
            <Input
              variant="field"
              inputSize="auto"
              value={newValues}
              placeholder={t('componentVariants.valuesPlaceholder')}
              aria-label={t('componentVariants.valuesLabel')}
              onChange={(event) => setNewValues(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void submitNew()}
            />
          )}
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void submitNew()}>
              {t('componentVariants.add')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {props.length === 0 && !adding && <p className="text-caption text-ink-soft">{t('componentVariants.empty')}</p>}

      {props.map((prop) => (
        <div key={prop.name} data-slot="variant-prop" data-prop={prop.name} className="flex flex-col gap-1">
          <div className="flex min-h-6 items-center gap-1.5">
            {entry?.kind === 'rename-prop' && entry.prop === prop.name ? (
              <Input
                ref={entryInput}
                variant="field"
                inputSize="auto"
                value={text}
                aria-label={t('componentVariants.renamePropAria', { prop: prop.name })}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={entryKeys}
                onBlur={() => setEntry(null)}
              />
            ) : (
              <span className="min-w-0 truncate font-mono text-caption text-ink">{prop.name}</span>
            )}
            {prop.type === 'boolean' && <Badge>{t('componentVariants.booleanTag')}</Badge>}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    size="sm"
                    className="ml-auto flex-none"
                    aria-label={t('componentVariants.propMenuAria', { prop: prop.name })}
                    disabled={busy}
                  >
                    <MoreHorizontalIcon size="rail" aria-hidden />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width="sm" onCloseAutoFocus={keepEntryFocus}>
                  <DropdownMenuItem onSelect={() => startEntry({ kind: 'rename-prop', prop: prop.name }, prop.name)}>
                    {t('componentVariants.renameProp')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void askRemoval(prop)}>
                    {t('componentVariants.removeProp')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {prop.options.map((value) => {
              const isDefault = variantDefault(prop) === value
              const chip = (
                <Badge tone={isDefault ? 'brand' : 'outline'} interactive={canEdit && prop.type === 'enum'}>
                  {value}
                </Badge>
              )
              if (entry?.kind === 'rename-value' && entry.prop === prop.name && entry.value === value) {
                return (
                  <Input
                    key={value}
                    ref={entryInput}
                    variant="field"
                    inputSize="auto"
                    className="w-20"
                    value={text}
                    aria-label={t('componentVariants.renameValueAria', { value })}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={entryKeys}
                    onBlur={() => setEntry(null)}
                  />
                )
              }
              /* a boolean's two values are fixed: the only thing to change on it is its default */
              if (!canEdit) return <span key={value}>{chip}</span>
              return (
                <DropdownMenu key={value}>
                  <DropdownMenuTrigger asChild>
                    <Pressable
                      focus="ring"
                      layout="inline"
                      className="rounded-tag"
                      aria-label={t('componentVariants.valueAria', { prop: prop.name, value })}
                      disabled={busy}
                      onDoubleClick={() =>
                        prop.type === 'enum' && startEntry({ kind: 'rename-value', prop: prop.name, value }, value)
                      }
                    >
                      {chip}
                    </Pressable>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" width="sm" onCloseAutoFocus={keepEntryFocus}>
                    {!isDefault && (
                      <DropdownMenuItem onSelect={() => void run([{ op: 'set_default', prop: prop.name, value }])}>
                        {t('componentVariants.makeDefault')}
                      </DropdownMenuItem>
                    )}
                    {prop.type === 'enum' && (
                      <>
                        <DropdownMenuItem
                          onSelect={() => startEntry({ kind: 'rename-value', prop: prop.name, value }, value)}
                        >
                          {t('componentVariants.renameValue')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => void askRemoval(prop, value)}>
                          {t('componentVariants.removeValue')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            })}
            {canEdit && prop.type === 'enum' && entry?.kind === 'add-value' && entry.prop === prop.name ? (
              <Input
                variant="field"
                inputSize="auto"
                autoFocus
                className="w-20"
                value={text}
                placeholder={t('componentVariants.newValuePlaceholder')}
                aria-label={t('componentVariants.newValueAria', { prop: prop.name })}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={entryKeys}
                onBlur={() => setEntry(null)}
              />
            ) : (
              canEdit &&
              prop.type === 'enum' && (
                <IconButton
                  size="sm"
                  aria-label={t('componentVariants.addValueAria', { prop: prop.name })}
                  disabled={busy}
                  onClick={() => startEntry({ kind: 'add-value', prop: prop.name })}
                >
                  <PlusIcon size="rail" aria-hidden />
                </IconButton>
              )
            )}
          </div>
        </div>
      ))}

      {props.length > 0 && (
        <div data-slot="variant-preview" className="flex flex-col gap-0.5 pt-1">
          <span className="text-caption font-medium text-ink">{t('componentVariants.previewHeading')}</span>
          <span className="text-caption text-ink-faint">{t('componentVariants.previewHint')}</span>
          {props.map((prop) => (
            <PropertyRow key={prop.name} label={prop.name}>
              <SelectField
                value={preview.values[prop.name] ?? variantDefault(prop)}
                options={prop.options.map((option) => ({
                  value: option,
                  label: variantDefault(prop) === option ? `${option} (${t('componentVariants.defaultTag')})` : option,
                }))}
                label={t('componentVariants.previewAria', { prop: prop.name })}
                onChange={(value) => setPicks((current) => ({ ...current, [prop.name]: value }))}
              />
            </PropertyRow>
          ))}
          {editing && (
            <div
              data-slot="variant-editing"
              role="status"
              className="mt-1.5 flex flex-col gap-1 rounded-row bg-brand/10 px-2 py-1.5"
            >
              <span className="text-label font-medium text-brand">
                {t('componentVariants.editing', { combination: combinationLabel(preview.when) })}
              </span>
              <span className="text-caption text-ink-soft">{t('componentVariants.editingHint')}</span>
              {styled > 0 && (
                <span className="text-caption text-ink-soft">
                  {t('componentVariants.styledProperties', { count: styled })}
                </span>
              )}
              <Button size="sm" className="self-start" onClick={() => setPicks({})}>
                {t('componentVariants.backToBase')}
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removal !== null}
        onOpenChange={(open) => !open && setRemoval(null)}
        destructive
        title={
          removal?.value === undefined
            ? t('componentVariants.removePropTitle', { prop: removal?.prop ?? '' })
            : t('componentVariants.removeValueTitle', { value: removal.value, prop: removal.prop })
        }
        confirmLabel={t('componentVariants.confirmRemove')}
        onConfirm={() => void confirmRemoval()}
        description={
          removal && (
            <span className="flex flex-col gap-2">
              <span>
                {removal.instances === 0
                  ? t('componentVariants.noInstancesUse')
                  : removal.value === undefined
                    ? t('componentVariants.instancesUseProp', { count: removal.instances })
                    : t('componentVariants.instancesUse', { count: removal.instances })}
              </span>
              <span>{t('componentVariants.removeGoesWith')}</span>
              {removal.wasDefault && removalOptions.length > 0 && (
                <SelectField
                  value={removal.newDefault}
                  label={t('componentVariants.newDefaultLabel')}
                  options={removalOptions.map((option) => ({ value: option, label: option }))}
                  onChange={(value) => setRemoval({ ...removal, newDefault: value })}
                />
              )}
            </span>
          )
        }
      />
    </div>
  )
}

const removalOp = (prop: string, value: string | undefined, newDefault: string): VariantOp =>
  value === undefined ? { op: 'remove_prop', prop } : { op: 'remove_value', prop, value, new_default: newDefault }

/** The value a prop falls back to when `removed` goes: its first other value, undefined when none is left. */
function fallbackDefault(prop: VariantProp, removed: string): string | undefined {
  return prop.options.find((option) => option !== removed)
}
