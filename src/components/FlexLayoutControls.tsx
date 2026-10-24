import { useId, useState } from 'react'
import type { ElementInfo, StylePatch } from '../lib/frameBridge'
import { flexAlignmentAt, flexAxes } from '../lib/flexLayout'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  FlipHorizontal2Icon,
  HorizontalPaddingIcon,
  SquareDashedIcon,
  VerticalPaddingIcon,
  WrapTextIcon,
} from './ui/icons'
import { NumberField, PropertyRow, PropertySection, SelectField } from './ui/property-field'
import { Segmented, SegmentedItem } from './ui/segmented'

const control = 'h-[26px] min-h-0 rounded-row bg-sub p-0 text-ink-soft'
const caption = 'mb-1 text-caption text-ink-faint'
const spacing = [
  ['fixed', 'Fixed gap'],
  ['space-between', 'Space between'],
  ['space-around', 'Space around'],
  ['space-evenly', 'Space evenly'],
] as const
const crossAlignments = [
  { value: 'flex-start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'flex-end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'baseline', label: 'Baseline' },
]

export function PaddingControls({ info, apply }: { info: ElementInfo; apply: (styles: StylePatch) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [top, right, bottom, left] = info.padding
  const sides = ['top', 'right', 'bottom', 'left'] as const
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-caption text-ink-faint">Padding</span>
        <Button
          variant="bare"
          size="icon-sm"
          className="size-5 rounded-tag text-ink-faint"
          aria-label="Individual padding"
          title="Edit padding on each side"
          aria-expanded={expanded}
          aria-pressed={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <SquareDashedIcon size="rail" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {expanded ? (
          sides.map((side, index) => (
            <NumberField
              key={side}
              label={`Padding ${side}`}
              prefix={side[0]!.toUpperCase()}
              value={info.padding[index] ?? null}
              unit="px"
              onCommit={(value) => apply({ [`padding-${side}`]: `${Math.max(0, value)}px` })}
            />
          ))
        ) : (
          <>
            <NumberField
              label="Vertical padding"
              prefix={<VerticalPaddingIcon size="rail" />}
              value={top === bottom ? top : null}
              placeholder="Mixed"
              unit="px"
              onCommit={(value) =>
                apply({ 'padding-top': `${Math.max(0, value)}px`, 'padding-bottom': `${Math.max(0, value)}px` })
              }
            />
            <NumberField
              label="Horizontal padding"
              prefix={<HorizontalPaddingIcon size="rail" />}
              value={left === right ? left : null}
              placeholder="Mixed"
              unit="px"
              onCommit={(value) =>
                apply({ 'padding-left': `${Math.max(0, value)}px`, 'padding-right': `${Math.max(0, value)}px` })
              }
            />
          </>
        )}
      </div>
    </div>
  )
}

export function FlexLayoutControls({ info, apply }: { info: ElementInfo; apply: (styles: StylePatch) => void }) {
  const spacingName = useId()
  const axes = flexAxes(info)
  const column = info.flexDirection.startsWith('column')
  const reverse = info.flexDirection.endsWith('-reverse')
  const wrapping = info.flexWrap !== 'nowrap'
  const distributed = info.justifyContent.startsWith('space-')
  const mode = distributed ? info.justifyContent : 'fixed'
  const gap = column ? info.rowGap : info.columnGap
  const crossGap = column ? info.columnGap : info.rowGap
  const align = info.alignItems === 'normal' ? 'stretch' : info.alignItems
  const justify = info.justifyContent === 'normal' ? 'flex-start' : info.justifyContent

  return (
    <PropertySection
      title="Flex layout"
      action={
        <Button
          variant="bare"
          size="icon-sm"
          className={cn('size-6 rounded-row text-ink-faint', wrapping && 'bg-paper-deep text-ink')}
          aria-label="Wrap children"
          title={info.flexWrap === 'wrap-reverse' ? 'Wrapping in reverse order' : 'Wrap children'}
          aria-pressed={wrapping}
          onClick={() => apply({ 'flex-wrap': wrapping ? 'nowrap' : 'wrap' })}
        >
          <WrapTextIcon size="rail" />
        </Button>
      }
    >
      <div className="flex gap-1.5">
        <Segmented
          className="min-w-0 flex-1 rounded-row bg-sub p-0.5"
          aria-label="Flex direction"
          value={column ? 'column' : 'row'}
          onValueChange={(value) => apply({ 'flex-direction': `${value}${reverse ? '-reverse' : ''}` })}
        >
          {[
            { value: 'row', label: 'Row direction', Icon: ArrowRightIcon },
            { value: 'column', label: 'Column direction', Icon: ArrowDownIcon },
          ].map(({ value, label, Icon }) => (
            <SegmentedItem
              key={value}
              value={value}
              aria-label={label}
              title={label}
              className="grid h-[22px] min-h-0 flex-1 place-items-center rounded-tag p-0 sm:flex-1"
            >
              <Icon size="rail" />
            </SegmentedItem>
          ))}
        </Segmented>
        <Button
          variant="bare"
          size="icon-sm"
          className={cn(control, 'w-[30px]', reverse && 'bg-paper-deep text-ink')}
          aria-label="Reverse direction"
          title="Reverse direction"
          aria-pressed={reverse}
          onClick={() => apply({ 'flex-direction': `${column ? 'column' : 'row'}${reverse ? '' : '-reverse'}` })}
        >
          <FlipHorizontal2Icon size="rail" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-2">
        <div>
          <div className={caption}>Alignment</div>
          <div
            role="group"
            aria-label="Flex alignment"
            className="grid size-[84px] grid-cols-3 grid-rows-3 rounded-row bg-sub p-1"
          >
            {[0, 1, 2].flatMap((y) =>
              [0, 1, 2].map((x) => {
                const target = flexAlignmentAt(info, x, y)
                const active = align === target.align && (distributed || justify === target.justify)
                const label = `Align children ${['top', 'middle', 'bottom'][y]} ${['left', 'center', 'right'][x]}`
                return (
                  <Pressable
                    key={`${x}-${y}`}
                    type="button"
                    aria-label={label}
                    aria-pressed={active}
                    title={distributed ? `${label} (keep ${info.justifyContent.replace('space-', 'space ')})` : label}
                    className="group grid place-items-center rounded-tag hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-ink"
                    onClick={() =>
                      apply({ 'align-items': target.align, ...(!distributed && { 'justify-content': target.justify }) })
                    }
                  >
                    <span
                      className={cn(
                        'size-[3px] rounded-none bg-ink-faint group-hover:size-2',
                        active && 'size-2 rounded-tag bg-brand',
                      )}
                    />
                  </Pressable>
                )
              }),
            )}
          </div>
          <div className="mt-1.5 flex">
            <SelectField
              label="Cross-axis alignment"
              value={align}
              options={
                crossAlignments.some(({ value }) => value === align)
                  ? crossAlignments
                  : [...crossAlignments, { value: align, label: align }]
              }
              onChange={(value) => apply({ 'align-items': value })}
            />
          </div>
        </div>
        <div>
          <div className={caption}>Gap</div>
          <div role="radiogroup" aria-label="Flex spacing" className="space-y-1">
            {spacing.map(([value, label]) => (
              <div key={value} className="flex h-[26px] items-center gap-1.5">
                <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-caption text-ink-soft">
                  <Input
                    variant="bare"
                    inputSize="auto"
                    type="radio"
                    className="size-3 shrink-0 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    name={spacingName}
                    aria-label={label}
                    checked={mode === value}
                    onChange={() => apply({ 'justify-content': value === 'fixed' ? 'flex-start' : value })}
                  />
                  {value !== 'fixed' && label}
                </label>
                {value === 'fixed' && (
                  <NumberField
                    label="Gap"
                    value={gap ?? 0}
                    unit="px"
                    onCommit={(value) => apply({ [axes.gap]: `${Math.max(0, value)}px` })}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {wrapping && (
        <PropertyRow label="Line gap">
          <NumberField
            label="Line gap"
            value={crossGap ?? 0}
            unit="px"
            onCommit={(value) => apply({ [axes.crossGap]: `${Math.max(0, value)}px` })}
          />
        </PropertyRow>
      )}
      <PaddingControls info={info} apply={apply} />
    </PropertySection>
  )
}
