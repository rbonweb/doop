import { useEffect, useRef, useState } from 'react'
import { MAX_LIST_ITEMS, type ComponentProp, type ListItem } from '../../shared/components'
import { cn } from '@/lib/utils'
import {
  addListItem,
  listFieldNames,
  listItemTitle,
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

/**
 * A list prop as rows: one card per item with an input for each declared field (text, link, image, on/off), add, remove,
 * duplicate and reorder (drag the grip, ⌥↑ / ⌥↓ on a card, or the card's menu). Every edit hands the whole next list to
 * `onChange`, which saves it the way any other prop edit is saved, so one edit is one save and one undo step.
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
  onChange: (items: ListItem[]) => void
}) {
  const t = useT()
  const fields = listFieldNames(prop)
  const full = items.length >= MAX_LIST_ITEMS
  /* an image pick waits on an upload: it must write into the list as it is by then, not as it was */
  const latest = useRef(items)
  useEffect(() => {
    latest.current = items
  })
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
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
            onClick={() => onChange(addListItem(items, newListItem(prop)))}
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
        {items.length === 0 && (
          <li className="px-1 py-1 text-caption text-ink-faint">{t('componentFields.listEmpty')}</li>
        )}
        {items.map((item, at) => {
          const named = listItemTitle(prop, item)
          const title = named
            ? t('componentFields.itemTitleNamed', { n: at + 1, name: named })
            : t('componentFields.itemTitle', { n: at + 1 })
          return (
            <li
              key={at}
              data-slot="list-item"
              data-index={at}
              className={cn(
                'rounded-card bg-sub px-1.5 pb-1.5 shadow-ring',
                over === at && dragging !== null && dragging !== at && 'outline-2 outline-brand -outline-offset-1',
                dragging === at && 'opacity-50',
              )}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                setOver(at)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) onChange(moveListItem(items, dragging, at))
                endDrag()
              }}
              onKeyDown={(event) => {
                if (disabled || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                event.preventDefault()
                onChange(moveListItem(items, at, at + (event.key === 'ArrowUp' ? -1 : 1)))
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
                      setDragging(at)
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
                      <DropdownMenuItem disabled={at === 0} onSelect={() => onChange(moveListItem(items, at, at - 1))}>
                        {t('componentFields.moveUp')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={at === items.length - 1}
                        onSelect={() => onChange(moveListItem(items, at, at + 1))}
                      >
                        {t('componentFields.moveDown')}
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={full} onSelect={() => onChange(addListItem(items, { ...item }, at))}>
                        {t('componentFields.duplicateItem')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem tone="danger" onSelect={() => onChange(removeListItem(items, at))}>
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
                return (
                  <PropertyRow key={name} label={name}>
                    {type === 'boolean' ? (
                      <Switch
                        size="sm"
                        className="my-auto"
                        disabled={disabled}
                        checked={value === true}
                        onCheckedChange={(checked) => onChange(setListField(items, at, name, checked))}
                        aria-label={`${name}, ${at + 1}`}
                      />
                    ) : type === 'image' ? (
                      <ImagePicker
                        canvasId={canvasId}
                        src={text}
                        label={t('componentFields.fieldImageAria', { field: name, n: at + 1 })}
                        disabled={disabled}
                        className="h-[26px] min-w-0 flex-1 gap-1.5 rounded-row px-[3px] text-caption"
                        onPick={async (resolve) => {
                          const url = await resolve()
                          if (url !== text) onChange(setListField(latest.current, at, name, url))
                        }}
                        onClear={() => onChange(setListField(items, at, name, ''))}
                      />
                    ) : (
                      <TextField
                        label={`${name}, ${at + 1}`}
                        value={text}
                        disabled={disabled}
                        className={type === 'text' ? 'font-sans' : undefined}
                        placeholder={type === 'link' ? 'https://…' : undefined}
                        onCommit={(next) => {
                          if (next !== text) onChange(setListField(items, at, name, next))
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
