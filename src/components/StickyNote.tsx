import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CanvasNote } from '../../shared/types'
import { colorFor } from '../../shared/types'
import {
  clampNoteHeight,
  clampNoteWidth,
  MAX_NOTE_CHARS,
  NOTE_COLORS,
  noteColorOf,
  noteExcerpt,
  type NoteColor,
} from '../../shared/notes'
import { gesture } from '../lib/gesture'
import { discardEmptyNote, removeNote, saveNote } from '../lib/notes'
import { parseMarkdown, type Block, type Inline } from '../lib/noteMarkdown'
import { useCanEdit } from '../lib/role'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { cn } from '../lib/utils'
import { MOD_KEY } from '../lib/keys'
import { CollapseAllIcon, NoteIcon, TrashIcon } from './ui/icons'
import { IconButton } from './ui/icon-button'
import { Pressable } from './ui/pressable'
import { Textarea } from './ui/textarea'

/* Same counter-scaling the frame labels use: the `--zoom` variable is set by
   the Stage, so a pan or zoom never re-renders a note. */
const COUNTER_SCALE = '[transform:scale(min(calc(1/var(--zoom,1)),2.4))]'

/* the brand blue pulled toward the ink, so it reads on every tint in both themes */
const LINK_INK = '[color:color-mix(in_srgb,var(--brand)_62%,var(--ink))]'

const SWATCH: Record<NoteColor, string> = {
  yellow: 'Yellow',
  pink: 'Pink',
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
  gray: 'Gray',
}

function hueOf(color: NoteColor): CSSProperties {
  return { '--note': `var(--note-${color})` } as CSSProperties
}

/* ---- markdown → elements (the tree comes from lib/noteMarkdown.ts; nothing
   here ever builds an HTML string) ---- */

function flyToFrame(frameId: string) {
  const s = useStore.getState()
  if (s.canvas?.frames.some((f) => f.id === frameId)) s.requestFlyTo(frameId)
  else s.pushNotice('That frame is no longer on this canvas')
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.t) {
          case 'text':
            return <Fragment key={i}>{node.text}</Fragment>
          case 'br':
            return <br key={i} />
          case 'strong':
            return (
              <strong key={i} className="font-medium">
                <Inlines nodes={node.children} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={node.children} />
              </em>
            )
          case 'del':
            return (
              <del key={i} className="opacity-70">
                <Inlines nodes={node.children} />
              </del>
            )
          case 'code':
            return (
              <code key={i} className="rounded-tag bg-ink/8 px-1 py-px font-mono text-label">
                {node.text}
              </code>
            )
          case 'link':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(LINK_INK, 'underline decoration-current/40 underline-offset-2 hover:decoration-current')}
              >
                <Inlines nodes={node.children} />
              </a>
            )
          case 'goto':
            return (
              <a
                key={i}
                href={`#frame-${node.frameId}`}
                title="Fly to this frame"
                onClick={(e) => {
                  e.preventDefault()
                  flyToFrame(node.frameId)
                }}
                className={cn(LINK_INK, 'cursor-pointer rounded-tag bg-ink/10 px-1 no-underline hover:bg-ink/15')}
              >
                <Inlines nodes={node.children} />
              </a>
            )
        }
      })}
    </>
  )
}

const HEADING_CLASS = {
  1: 'mb-1.5 mt-0.5 text-heading font-semibold',
  2: 'mb-1 mt-0.5 text-lead font-semibold',
  3: 'mb-1 mt-0.5 text-copy font-semibold',
} as const

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.t) {
          case 'heading': {
            const Tag = `h${block.level}` as const
            return (
              <Tag key={i} className={HEADING_CLASS[block.level]}>
                <Inlines nodes={block.children} />
              </Tag>
            )
          }
          case 'paragraph':
            return (
              <p key={i} className="mb-1.5 last:mb-0">
                <Inlines nodes={block.children} />
              </p>
            )
          case 'hr':
            return <hr key={i} className="my-2 border-0 border-t border-ink/15" />
          case 'code':
            return (
              <pre
                key={i}
                className="mb-1.5 overflow-x-auto rounded-row bg-ink/8 px-2 py-1.5 font-mono text-label leading-snug last:mb-0"
              >
                {block.text}
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={i} className="mb-1.5 border-l-2 border-ink/25 pl-2 text-ink-soft last:mb-0">
                <Blocks blocks={block.blocks} />
              </blockquote>
            )
          case 'list': {
            let n = 0
            return (
              <ul key={i} className="mb-1.5 list-none p-0 last:mb-0">
                {block.items.map((item, j) => {
                  if (item.depth === 0) n += 1
                  return (
                    <li key={j} className="flex gap-1.5" style={{ paddingLeft: item.depth * 14 }}>
                      <span
                        aria-hidden
                        className={cn(
                          'flex-none text-ink-soft',
                          block.ordered ? 'min-w-[1.1em] text-right tabular-nums' : 'w-[1em] text-center',
                        )}
                      >
                        {item.checked === undefined ? (block.ordered ? `${n}.` : '•') : item.checked ? '☑' : '☐'}
                      </span>
                      <span className={cn('min-w-0', item.checked && 'text-ink-soft line-through')}>
                        <Inlines nodes={item.children} />
                      </span>
                    </li>
                  )
                })}
              </ul>
            )
          }
        }
      })}
    </>
  )
}

/** Markdown as the notes render it, for other surfaces that show markdown (the presenter's speaker notes). */
export function MarkdownText({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown])
  return <Blocks blocks={blocks} />
}

function NoteBody({ markdown, mayEdit }: { markdown: string; mayEdit: boolean }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown])
  if (!blocks.length) return <p className="text-ink-faint">{mayEdit ? 'Double-click to write…' : 'Empty note'}</p>
  return <Blocks blocks={blocks} />
}

/* ---- the editor ---- */

function NoteEditor({ note }: { note: CanvasNote }) {
  const [draft, setDraft] = useState(note.markdown)
  const ref = useRef<HTMLTextAreaElement>(null)
  /* Esc and a finished save both unmount the field, which can still report a
     blur; whichever came first has already decided */
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  function finish(save: boolean) {
    if (settled.current) return
    settled.current = true
    useStore.getState().setEditingNote(null)
    const text = save ? draft : note.markdown
    if (!text.trim() && !note.markdown.trim()) discardEmptyNote(note)
    else if (save && draft !== note.markdown) saveNote(note, { markdown: draft })
  }

  return (
    <Textarea
      ref={ref}
      variant="bare"
      value={draft}
      maxLength={MAX_NOTE_CHARS}
      spellCheck
      placeholder="Write in markdown…  [label](goto:frameId) flies to a frame"
      data-stage-scroll=""
      aria-label="Note text"
      className="block size-full font-mono text-label md:text-label"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          finish(true)
        }
      }}
    />
  )
}

/* ---- the note ---- */

/** A sticky note on the stage. It lives in the world layer, so it shares the
 *  frames' coordinate space and scales with them. Moving and resizing write
 *  straight to the element while the pointer is down and commit once on
 *  release, so a drag never re-renders anything. */
export const StickyNote = memo(function StickyNote({ note, frameName }: { note: CanvasNote; frameName?: string }) {
  /* below edit a note is read-only: no drag, resize, colours, delete or editor (the server refuses those writes too) */
  const mayEdit = useCanEdit()
  const editing = useStore((s) => mayEdit && s.editingNoteId === note.id)
  const folded = useStore((s) => !!s.foldedNotes[note.id])
  const color = noteColorOf(note)
  const cardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  /* a committed move replaces the drag's transform with the new left/top */
  useLayoutEffect(() => {
    if (cardRef.current) cardRef.current.style.transform = ''
  }, [note.x, note.y])

  /* a body that overflows scrolls on wheel; one that fits lets the wheel pan the canvas */
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body) body.toggleAttribute('data-stage-scroll', body.scrollHeight > body.clientHeight + 1)
  }, [note.markdown, note.width, note.height, editing, folded])

  function press(
    e: React.PointerEvent,
    onDrag: (dx: number, dy: number, el: HTMLDivElement) => void,
    onDone: (dx: number, dy: number, el: HTMLDivElement) => void,
  ) {
    /* space held: let the press reach the Stage, which pans */
    if (!mayEdit || e.button !== 0 || useStore.getState().panMode) return
    const el = cardRef.current
    if (!el) return
    e.stopPropagation()
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    let delta = { x: 0, y: 0 }
    el.dataset.active = ''
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId || gesture.pinching || !el) return
      const zoom = useStore.getState().viewport.zoom
      delta = { x: (ev.clientX - start.x) / zoom, y: (ev.clientY - start.y) / zoom }
      onDrag(delta.x, delta.y, el)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (!el) return
      delete el.dataset.active
      onDone(delta.x, delta.y, el)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function startMove(e: React.PointerEvent) {
    if (editing) return
    press(
      e,
      (dx, dy, el) => {
        el.style.transform = `translate(${dx}px, ${dy}px)`
      },
      (dx, dy, el) => {
        const x = Math.round(note.x + dx)
        const y = Math.round(note.y + dy)
        if (x === note.x && y === note.y) el.style.transform = ''
        else saveNote(note, { x, y })
      },
    )
  }

  function startResize(e: React.PointerEvent) {
    press(
      e,
      (dx, dy, el) => {
        el.style.width = `${clampNoteWidth(note.width + dx)}px`
        el.style.height = `${clampNoteHeight(note.height + dy)}px`
      },
      (dx, dy) => {
        const width = clampNoteWidth(note.width + dx)
        const height = clampNoteHeight(note.height + dy)
        if (width !== note.width || height !== note.height) saveNote(note, { width, height })
      },
    )
  }

  if (folded) {
    return (
      <Pressable
        layout="inline"
        focus="ring"
        title={noteExcerpt(note.markdown, 120) || 'Empty note'}
        aria-label="Unfold note"
        data-note-id={note.id}
        data-folded=""
        style={{ left: note.x, top: note.y, ...hueOf(color) }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useStore.getState().toggleNoteFolded(note.id)}
        className={cn(
          'absolute z-10 grid size-7 origin-top-left place-items-center rounded-control border border-[color-mix(in_srgb,var(--note)_45%,var(--line))] bg-[color-mix(in_srgb,var(--note)_34%,var(--surface))] text-ink shadow-card transition-transform hover:scale-110',
          'animate-in fade-in zoom-in-90 duration-200',
          COUNTER_SCALE,
        )}
      >
        <NoteIcon width={15} height={15} />
      </Pressable>
    )
  }

  const author = note.createdBy
  return (
    <div
      ref={cardRef}
      data-note-id={note.id}
      data-color={color}
      style={{ left: note.x, top: note.y, width: note.width, height: note.height, ...hueOf(color) }}
      className={cn(
        'group absolute z-10 flex flex-col overflow-visible rounded-control border border-[color-mix(in_srgb,var(--note)_42%,var(--line))] bg-[color-mix(in_srgb,var(--note)_17%,var(--surface))] text-ink shadow-card',
        'animate-in fade-in zoom-in-95 duration-200 data-[active]:shadow-pop data-[active]:ring-1 data-[active]:ring-[color-mix(in_srgb,var(--note)_60%,transparent)]',
        editing && 'ring-2 ring-brand/60',
      )}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* hover toolbar: colours, fold, delete */}
      <div
        className={cn(
          'pointer-events-none absolute bottom-full left-0 origin-bottom-left pb-1.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          COUNTER_SCALE,
        )}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          role="toolbar"
          aria-label="Note actions"
          className="flex items-center gap-1 rounded-control bg-surface p-1 shadow-pop"
        >
          {mayEdit &&
            NOTE_COLORS.map((c) => (
              <Pressable
                key={c}
                layout="inline"
                focus="ring"
                aria-label={`${SWATCH[c]} note`}
                aria-pressed={c === color}
                title={SWATCH[c]}
                style={hueOf(c)}
                onClick={() => c !== color && saveNote(note, { color: c })}
                className={cn(
                  'size-4 flex-none rounded-full border border-[color-mix(in_srgb,var(--note)_55%,var(--line))] bg-[color-mix(in_srgb,var(--note)_70%,var(--surface))] transition-transform hover:scale-125',
                  c === color && 'ring-2 ring-ink/70 ring-offset-1 ring-offset-surface',
                )}
              />
            ))}
          {mayEdit && <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />}
          <IconButton
            size="sm"
            aria-label="Fold note"
            title="Fold to a corner"
            onClick={() => useStore.getState().toggleNoteFolded(note.id)}
          >
            <CollapseAllIcon size="rail" />
          </IconButton>
          {mayEdit && (
            <IconButton
              size="sm"
              variant="danger"
              aria-label="Delete note"
              title="Delete note"
              onClick={() => removeNote(note)}
            >
              <TrashIcon size="rail" />
            </IconButton>
          )}
        </div>
      </div>

      <header
        onPointerDown={startMove}
        onDoubleClick={() => mayEdit && useStore.getState().setEditingNote(note.id)}
        className={cn(
          'flex h-6 flex-none items-center gap-1.5 rounded-t-row border-b border-[color-mix(in_srgb,var(--note)_30%,var(--line-soft))] bg-[color-mix(in_srgb,var(--note)_30%,var(--surface))] px-2 text-micro font-medium text-ink-soft select-none',
          mayEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
      >
        <NoteIcon width={11} height={11} className="flex-none" />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {frameName ? `On ${frameName}` : 'Note'}
        </span>
      </header>

      <div
        ref={bodyRef}
        onDoubleClick={(e) => {
          if (mayEdit && !editing && !(e.target as HTMLElement).closest('a'))
            useStore.getState().setEditingNote(note.id)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-sans text-copy [overflow-wrap:anywhere]"
      >
        {editing ? <NoteEditor note={note} /> : <NoteBody markdown={note.markdown} mayEdit={mayEdit} />}
      </div>

      <footer className="flex h-6 flex-none items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--note)_22%,var(--line-soft))] px-3 text-caption text-ink-soft select-none">
        {editing ? (
          <span className="font-mono text-micro">{MOD_KEY}↵ save · Esc cancel</span>
        ) : (
          <>
            <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: colorFor(author) }} />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{author}</span>
            <span aria-hidden>·</span>
            <time className="flex-none whitespace-nowrap" dateTime={new Date(note.updatedAt).toISOString()}>
              {timeAgo(note.updatedAt)}
            </time>
          </>
        )}
      </footer>

      {/* dog-ear: the corner you pull to resize */}
      {mayEdit && (
        <div
          role="separator"
          aria-label="Resize note"
          onPointerDown={startResize}
          className="absolute -right-px -bottom-px size-4 cursor-nwse-resize rounded-br-control bg-[color-mix(in_srgb,var(--note)_55%,var(--surface))] opacity-70 transition-opacity [clip-path:polygon(100%_0,100%_100%,0_100%)] hover:opacity-100"
        />
      )}
    </div>
  )
})
