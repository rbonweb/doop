import { useEffect, useRef, useState } from 'react'
import { MAX_LIST_ITEMS, type ComponentProp, type ListItem } from '../../shared/components'
import { cn } from '@/lib/utils'
import {
  addListItem,
  listFieldNames,
  listItemTitle,
  listValue,
  moveListItem,
  newListItem,
  removeListItem,
  setListField,
} from '../lib/listProps'
import { useT } from '../lib/i18n'
import { ImagePicker } from './ImageFill'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { IconButton } from './ui/icon-button'
import { GripVerticalIcon, MoreHorizontalIcon, PlusIcon } from './ui/icons'
import { PropertyBlock, PropertyRow, TextField } from './ui/property-field'
import { Switch } from './ui/switch'

/** One item with an identity of its own, so a half-typed field and the keyboard focus stay with the item when the rows move. */
interface Row {
  id: string
  item: ListItem
}

let nextRowId = 0
const rowOf = (item: ListItem): Row => ({ id: `row${++nextRowId}`, item })
const sameRows = (a: readonly Row[], b: readonly Row[]) => a.length === b.length && a.every((row, at) => row === b[at])

/**
 * A list prop as rows: one card per item with an input for each declared field (text, link, image, on/off), add, remove,
 * duplicate and reorder (drag the grip, ⌥↑ / ⌥↓ on a card, or the card's menu). Every edit builds the next list from the
 * rows as they are now (not as the last save left them), shows it at once and hands it to `onChange`; saves run one after
 * another, so quick edits (a double click on add, a held ⌥↓) all land, each as one save and one undo step.
 */
export function ListPropEditor({
  canvasId,
  prop,
  items,
  disabled,
  overridden,
  error,
  onChange,
}: {
  canvasId: string
  prop: ComponentProp
  items: ListItem[]
  disabled: boolean
  overridden?: { label: string; onReset: () => void; disabled?: boolean }
  error?: string
  /** saves the whole next list; resolves when it is stored (or refused) */
  onChange: (items: ListItem[]) => Promise<void> | void
}) {
  const t = useT()
  const fields = listFieldNames(prop)
  const [rows, setRows] = useState<Row[]>(() => items.map(rowOf))
  /* the list as the last edit left it: every handler starts from this, never from what was last rendered */
  const base = useRef(rows)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const [saving, setSaving] = useState(0)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  /* what is stored (undo, a collaborator, an agent, a refused save) replaces the rows once no save of ours is under way */
  const [seen, setSeen] = useState({ value: listValue(items), saving })
  const value = listValue(items)
  if (seen.value !== value || seen.saving !== saving) {
    setSeen({ value, saving })
    if (saving === 0 && listValue(rows.map((row) => row.item)) !== value) {
      /* the same count keeps each row's identity: only its values changed */
      setRows((now) =>
        now.length === items.length ? now.map((row, at) => ({ id: row.id, item: items[at]! })) : items.map(rowOf),
      )
    }
  }
  useEffect(() => {
    base.current = rows
  }, [rows])

  const emit = (next: Row[]) => {
    if (sameRows(next, base.current)) return
    base.current = next
    setRows(next)
    setSaving((count) => count + 1)
    const stored = next.map((row) => row.item)
    chain.current = chain.current
      .then(() => onChange(stored))
      .catch(() => {})
      .then(() => setSaving((count) => count - 1))
  }
  const indexOf = (id: string) => base.current.findIndex((row) => row.id === id)
  const edit = (id: string, apply: (at: number) => Row[]) => {
    const at = indexOf(id)
    if (at >= 0) emit(apply(at))
  }
  const setField = (id: string, name: string, value: string | boolean) =>
    edit(id, (at) => {
      const next = setListField(
        base.current.map((row) => row.item),
        at,
        name,
        value,
      )
      return base.current.map((row, index) => (index === at ? { ...row, item: next[at]! } : row))
    })
  const move = (id: string, by: number) => edit(id, (at) => moveListItem(base.current, at, at + by))
  const full = rows.length >= MAX_LIST_ITEMS
  const endDrag = () => {
    setDragging(null)
    setOver(null)
  }

  return (
    <PropertyBlock
      label={prop.name}
      overridden={overridden}
      error={error}
      actions={
        disabled ? undefined : (
          <IconButton
            size="sm"
            aria-label={t('componentFields.addItem')}
            title={full ? t('componentFields.listFull', { max: MAX_LIST_ITEMS }) : t('componentFields.addItem')}
            disabled={full}
            onClick={() => emit(addListItem(base.current, rowOf(newListItem(prop))))}
          >
            <PlusIcon size="rail" aria-hidden />
          </IconButton>
        )
      }
    >
      <ol
        data-slot="list-prop"
        aria-label={t('componentFields.listAria', { name: prop.name })}
        className="flex flex-col gap-1.5"
      >
        {rows.length === 0 && (
          <li className="px-1 py-1 text-caption text-ink-faint">{t('componentFields.listEmpty')}</li>
        )}
        {rows.map(({ id, item }, at) => {
          const named = listItemTitle(prop, item)
          const title = named
            ? t('componentFields.itemTitleNamed', { n: at + 1, name: named })
            : t('componentFields.itemTitle', { n: at + 1 })
          return (
            <li
              key={id}
              data-slot="list-item"
              data-index={at}
              className={cn(
                'rounded-card bg-sub px-1.5 pb-1.5 shadow-ring',
                over === id && dragging !== null && dragging !== id && 'outline-2 outline-brand -outline-offset-1',
                dragging === id && 'opacity-50',
              )}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                setOver(id)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null && dragging !== id) {
                  const from = indexOf(dragging)
                  if (from >= 0) emit(moveListItem(base.current, from, indexOf(id)))
                }
                endDrag()
              }}
              onKeyDown={(event) => {
                if (disabled || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                event.preventDefault()
                move(id, event.key === 'ArrowUp' ? -1 : 1)
              }}
            >
              <div className="flex min-h-6 items-center gap-1">
                {!disabled && (
                  <span
                    data-slot="list-grip"
                    draggable
                    role="img"
                    aria-label={t('componentFields.dragItemAria', { n: at + 1 })}
                    className="grid size-5 flex-none cursor-grab place-items-center text-ink-faint hover:text-ink active:cursor-grabbing"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', String(at))
                      setDragging(id)
                    }}
                    onDragEnd={endDrag}
                  >
                    <GripVerticalIcon size={12} aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink-soft">{title}</span>
                {!disabled && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton size="sm" aria-label={t('componentFields.itemMenuAria', { n: at + 1 })}>
                        <MoreHorizontalIcon size="rail" aria-hidden />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" width="sm">
                      <DropdownMenuItem disabled={at === 0} onSelect={() => move(id, -1)}>
                        {t('componentFields.moveUp')}
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={at === rows.length - 1} onSelect={() => move(id, 1)}>
                        {t('componentFields.moveDown')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={full}
                        onSelect={() =>
                          edit(id, (index) => addListItem(base.current, rowOf({ ...base.current[index]!.item }), index))
                        }
                      >
                        {t('componentFields.duplicateItem')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        tone="danger"
                        onSelect={() => edit(id, (index) => removeListItem(base.current, index))}
                      >
                        {t('componentFields.removeItem')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {fields.map((name) => {
                const type = prop.fields?.[name]?.type ?? 'text'
                const value = item[name]
                const text = typeof value === 'string' ? value : ''
                const label = t('componentFields.fieldAria', { field: name, n: at + 1 })
                return (
                  <PropertyRow key={name} label={name}>
                    {type === 'boolean' ? (
                      <Switch
                        size="sm"
                        className="my-auto"
                        disabled={disabled}
                        checked={value === true}
                        onCheckedChange={(checked) => setField(id, name, checked)}
                        aria-label={label}
                      />
                    ) : type === 'image' ? (
                      <ImagePicker
                        canvasId={canvasId}
                        src={text}
                        label={label}
                        disabled={disabled}
                        className="h-[26px] min-w-0 flex-1 gap-1.5 rounded-row px-[3px] text-caption"
                        onPick={async (resolve) => {
                          const url = await resolve()
                          if (url !== text) setField(id, name, url)
                        }}
                        onClear={() => setField(id, name, '')}
                      />
                    ) : (
                      <TextField
                        label={label}
                        value={text}
                        disabled={disabled}
                        className={type === 'text' ? 'font-sans' : undefined}
                        placeholder={type === 'link' ? t('componentFields.linkPlaceholder') : undefined}
                        onCommit={(next) => {
                          if (next !== text) setField(id, name, next)
                        }}
                      />
                    )}
                  </PropertyRow>
                )
              })}
            </li>
          )
        })}
      </ol>
    </PropertyBlock>
  )
}
