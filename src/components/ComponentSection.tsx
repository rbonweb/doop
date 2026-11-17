import { useMemo, useState } from 'react'
import {
  BIND_ATTR,
  PART_ATTR,
  SLOT_ATTR,
  activeComponents,
  isDeleted,
  propValueProblem,
  type ComponentDef,
  type ComponentLookup,
  type ComponentProp,
} from '../../shared/components'
import { aliasOf, frameTheme, resolveToken } from '../../shared/designTokens'
import type { Frame } from '../../shared/types'
import { cn } from '@/lib/utils'
import { api } from '../lib/api'
import {
  changeInstance,
  componentContextOf,
  exposeOnMain,
  resetInstanceParts,
  resetInstanceProp,
  restoreDeletedComponent,
  templateValue,
  type ComponentContext,
} from '../lib/components'
import { useT } from '../lib/i18n'
import { isLayerLocked } from '../lib/layerEdits'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { Button } from './ui/button'
import { Dot } from './ui/dot'
import { IconButton } from './ui/icon-button'
import { ComponentIcon, UndoIcon } from './ui/icons'
import { ImagePicker } from './ImageFill'
import { ColorField, NumberField, PropertyRow, SelectField, TextField } from './ui/property-field'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
import { TokenMenu, fieldToken } from './TokenMenu'
import { InstanceList } from './InstanceList'
import { ComponentCodeSection } from './ComponentCodeSection'

/** The Design panel's head when the selection belongs to a component. */
export function ComponentSection({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const defs = useStore((s) => s.canvas?.components)
  const context = useMemo(() => componentContextOf(frame.html, selector, defs ?? []), [frame.html, selector, defs])
  if (!context) return null
  return (
    <section data-slot="component-section" className="flex flex-col border-b border-line-soft px-3 pt-3 pb-2.5">
      <header className="mb-[5px] flex min-h-5 min-w-0 items-center gap-1.5 text-body font-medium text-ink">
        <ComponentIcon size="rail" className="flex-none text-brand" />
        <span className="truncate">{context.def.name}</span>
        <span className="ml-auto flex-none text-caption font-normal text-ink-faint">
          {context.kind === 'main' ? t('components.main') : t('components.instance')}
        </span>
      </header>
      {context.kind === 'main' ? (
        <MainControls key={context.def.id} frame={frame} context={context} />
      ) : isDeleted(context.def) ? (
        <DeletedInstanceControls frame={frame} context={context} />
      ) : (
        <InstanceControls frame={frame} context={context} />
      )}
    </section>
  )
}

/** An instance whose component was deleted: it keeps its look and follows nothing, until the
 *  component is restored (every instance is linked again) or this one is detached. */
function DeletedInstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, rootSelector } = context
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const locked = isLayerLocked(frame, rootSelector)
  return (
    <div data-slot="deleted-component" className="flex flex-col gap-2">
      <p className="text-caption font-medium text-ink">{t('components.mainDeleted')}</p>
      <p className="text-caption text-ink-soft">{t('components.mainDeletedHint')}</p>
      {canEdit && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void restoreDeletedComponent(def)}>
            {t('components.restoreComponent')}
          </Button>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => {
              const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
              if (current) void changeInstance(current, { instanceId, detach: true })
            }}
          >
            {t('components.detach')}
          </Button>
        </div>
      )}
    </div>
  )
}

function InstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, isRoot, rootSelector, selector, overriddenParts, swaps } = context
  const locked = isLayerLocked(frame, selector)
  const t = useT()
  const components = useStore((s) => s.canvas?.components)
  const active = useMemo(() => activeComponents(components), [components])
  /* the frame as it is now: an image pick waits on an upload, and undo's baseline
     and the lock check must not be the design from before it */
  const live = () => {
    const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    return current && !isLayerLocked(current, selector) ? current : undefined
  }
  const fallbackOf = (prop: ComponentProp) =>
    prop.default ?? (prop.type === 'boolean' ? 'true' : templateValue(def, prop.name))
  const overriddenProps = def.props.filter((prop) => {
    const value = context.props[prop.name]
    return value !== undefined && value !== fallbackOf(prop)
  })
  const resettable = overriddenProps.length + overriddenParts.length
  return (
    <>
      {!isRoot && (
        <Button
          size="inline"
          variant="link"
          className="self-start"
          onClick={() => useStore.getState().setSelectedElement({ frameId: frame.id, selector: rootSelector })}
        >
          {t('components.selectInstance')}
        </Button>
      )}
      {def.props.map((prop) => (
        <PropField
          key={`${instanceId}:${prop.name}`}
          canvasId={frame.canvasId}
          theme={frameTheme(frame.html) ?? undefined}
          prop={prop}
          selfId={def.id}
          components={active}
          disabled={locked}
          value={context.props[prop.name]}
          fallback={fallbackOf(prop)}
          onChange={(value) => {
            const current = live()
            if (!current) return
            /* "" clears the prop back to the main's value, which is how a cleared field resets */
            void (value === ''
              ? resetInstanceProp(current, instanceId, prop.name)
              : changeInstance(current, { instanceId, props: { [prop.name]: value } }))
          }}
        />
      ))}
      {resettable > 0 && (
        <div data-slot="overrides" className="mt-2.5 flex flex-col gap-1 border-t border-line-soft pt-2">
          <div className="flex min-h-5 items-center justify-between gap-2">
            <span className="text-label text-ink-soft">{t('components.overridesHeading')}</span>
            {!locked && (
              <Button
                size="inline"
                variant="link"
                onClick={() => {
                  const current = live()
                  if (current) void resetInstanceParts(current, instanceId)
                }}
              >
                {t('components.resetAllCount', { count: resettable })}
              </Button>
            )}
          </div>
          {overriddenParts.map((part) => {
            const swapId = swaps[part]
            const swapped = swapId ? (active.find((candidate) => candidate.id === swapId)?.name ?? swapId) : null
            const name = partLabel(def, part)
            return (
              <div
                key={part}
                data-slot="part-override"
                data-part={part}
                className="flex min-h-[26px] items-center gap-1.5"
              >
                <Dot size="sm" className="bg-brand" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-caption',
                    context.part === part ? 'font-medium text-ink' : 'text-ink-soft',
                  )}
                >
                  <span className="text-ink">{name}</span>{' '}
                  {swapped ? t('components.swappedTo', { name: swapped }) : t('components.partOverridden')}
                </span>
                {!locked && (
                  <IconButton
                    size="sm"
                    aria-label={t('components.resetPart', { name })}
                    title={t('components.resetPart', { name })}
                    onClick={() => {
                      const current = live()
                      if (current) void resetInstanceParts(current, instanceId, [part])
                    }}
                  >
                    <UndoIcon size="rail" />
                  </IconButton>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function PropField({
  canvasId,
  theme,
  prop,
  selfId,
  components,
  value,
  fallback,
  disabled,
  onChange,
}: {
  canvasId: string
  theme: string | undefined
  prop: ComponentProp
  /** the component being edited: it cannot hold itself */
  selfId: string
  /** the canvas's active components, for an `instance` prop */
  components: ComponentDef[]
  disabled: boolean
  value: string | undefined
  fallback: string
  /** "" puts the main's value back */
  onChange: (value: string) => void
}) {
  const t = useT()
  const tokens = useStore((s) => s.canvas?.tokens)
  const shown = value ?? fallback
  const overridden = value !== undefined && value !== fallback
  const [error, setError] = useState<string>()
  /* a new value from outside (undo, a collaborator, an agent) clears an old refusal */
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setError(undefined)
  }
  const lookup: ComponentLookup = (ref) =>
    components.find((def) => def.id === ref || def.name.toLowerCase() === ref.trim().toLowerCase())
  /* what a typed or picked value must pass before it is saved: the same check the server runs */
  const commit = (next: string) => {
    const problem = next === '' ? undefined : propValueProblem(prop, next, lookup)
    setError(problem)
    if (!problem) onChange(next)
  }
  return (
    <PropertyRow
      label={prop.name}
      error={error}
      overridden={
        overridden
          ? { label: t('components.resetProp', { name: prop.name }), onReset: () => commit(''), disabled }
          : undefined
      }
    >
      {propControl()}
    </PropertyRow>
  )

  function propControl() {
    switch (prop.type) {
      case 'boolean':
        return (
          <Switch
            size="sm"
            className="my-auto"
            disabled={disabled}
            checked={shown !== 'false'}
            onCheckedChange={(checked) => commit(checked ? 'true' : 'false')}
            aria-label={prop.name}
          />
        )
      case 'enum':
        return (
          <SelectField
            label={prop.name}
            value={shown}
            disabled={disabled}
            options={(prop.options ?? []).map((option) => ({ value: option, label: option }))}
            onChange={commit}
          />
        )
      case 'image':
        return (
          <ImagePicker
            canvasId={canvasId}
            src={shown}
            label={prop.name}
            disabled={disabled}
            className="h-[26px] min-w-0 flex-1 gap-1.5 rounded-row px-[3px] text-caption"
            onPick={async (resolve) => {
              const url = await resolve()
              if (url !== shown) commit(url)
            }}
            onClear={() => commit('')}
          />
        )
      case 'number': {
        const number = Number(shown)
        return (
          <NumberField
            label={prop.name}
            unit=""
            value={shown.trim() !== '' && Number.isFinite(number) ? number : null}
            min={prop.min ?? -Infinity}
            max={prop.max ?? Infinity}
            step={prop.step}
            disabled={disabled}
            onCommit={(next) => commit(String(next))}
            onInvalid={commit}
          />
        )
      }
      case 'color': {
        const named = aliasOf(shown)
        const bound = named ? tokens?.find((token) => token.name === named) : undefined
        const literal = (tokens && named ? resolveToken(tokens, named, theme) : null) ?? bound?.value ?? null
        return (
          <ColorField
            label={prop.name}
            value={shown === '' ? null : shown}
            token={bound && tokens ? fieldToken(bound, tokens, theme, () => commit(literal ?? '')) : undefined}
            trailing={
              disabled ? undefined : (
                <TokenMenu
                  canvasId={canvasId}
                  types={['color']}
                  tokens={tokens ?? []}
                  theme={theme}
                  literal={shown === '' || named ? literal : shown}
                  onPick={(name) => commit(`var(${name})`)}
                />
              )
            }
            onCommit={(next) => commit(next ?? '')}
            onInvalid={commit}
          />
        )
      }
      case 'instance': {
        const accepted = prop.accepts?.length
          ? prop.accepts.map((entry) => lookup(entry)?.name ?? entry)
          : components.filter((def) => def.id !== selfId).map((def) => def.name)
        const current = shown.trim() === '' ? null : (lookup(shown)?.name ?? shown)
        /* a value outside the list (a renamed or removed component) is still shown, so the field never lies */
        const names = [...new Set(current && !accepted.includes(current) ? [current, ...accepted] : accepted)]
        return (
          <SelectField
            label={prop.name}
            value={current}
            placeholder={t('components.instanceNone')}
            disabled={disabled}
            options={names.map((name) => ({ value: name, label: name }))}
            onChange={commit}
          />
        )
      }
      case 'text':
      case 'link':
        return (
          <TextField
            label={prop.name}
            value={shown}
            disabled={disabled}
            className={prop.type === 'text' ? 'font-sans' : undefined}
            placeholder={prop.type === 'link' ? 'https://…' : undefined}
            onCommit={commit}
          />
        )
    }
  }
}

/** A part's name for people: the template element's own name, else its tag. */
function partLabel(def: ComponentDef, key: string): string {
  const root = new DOMParser()
    .parseFromString(`<template>${def.template}</template>`, 'text/html')
    .querySelector('template')
  const el = root?.content.querySelector(`[${PART_ATTR}="${CSS.escape(key)}"]`)
  return el?.getAttribute('data-doop-name') ?? el?.getAttribute('data-name') ?? el?.tagName.toLowerCase() ?? key
}

function MainControls({ frame, context }: { frame: Frame; context: Extract<ComponentContext, { kind: 'main' }> }) {
  const { def, isRoot, selector } = context
  const t = useT()
  const locked = isLayerLocked(frame, selector)
  const [description, setDescription] = useState(def.description)
  /* a collaborator's or agent's change to the description takes the field
     over, so a blur here never writes the older text back over it */
  const [seen, setSeen] = useState(def.description)
  if (seen !== def.description) {
    setSeen(def.description)
    setDescription(def.description)
  }
  const instances = useStore(
    (s) =>
      s.canvas?.frames.reduce((total, f) => total + (f.html.split(` data-doop-instance="${def.id}"`).length - 1), 0) ??
      0,
  )
  const save = () => {
    if (description === def.description) return
    api
      .updateComponent(frame.canvasId, def.id, { description })
      .catch(() => useStore.getState().pushNotice(t('components.descriptionFailed')))
  }
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-caption text-ink-soft">
        {instances === 0 ? t('components.noInstances') : t('components.reachesInstances', { count: instances })}
      </p>
      <Textarea
        value={description}
        placeholder={t('components.descriptionPlaceholder')}
        aria-label={t('components.descriptionAria')}
        rows={2}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={save}
      />
      <InstanceList def={def} />
      {def.props.length > 0 && (
        <p className="text-caption text-ink-soft">
          {t('components.propsLabel')}{' '}
          <span className="font-mono text-ink">{def.props.map((prop) => prop.name).join(', ')}</span>
        </p>
      )}
      <ComponentCodeSection def={def} />
      {!isRoot && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, BIND_ATTR)}>
            {t('components.makeProp')}
          </Button>
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, SLOT_ATTR)}>
            {t('components.makeSlot')}
          </Button>
        </div>
      )}
    </div>
  )
}
