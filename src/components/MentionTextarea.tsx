import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { AGENT_ROLES } from '../../shared/agents'
import { api, type MentionPerson } from '../lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from './ui/avatar'
import { RoleMark } from './RoleMark'
import { Textarea } from './ui/textarea'

/* The comment box with an @ picker. Typing @ lists the people who can see this
   canvas and, for editors, the resident agents; picking a person writes
   "@Their Name" into the text and remembers who they are, so the comment can
   carry their account ids (the server checks each id can view the canvas and
   drops any that cannot). Agents keep their @id spelling. */

const PEOPLE_TTL_MS = 60_000
const peopleCache = new Map<string, { at: number; people: Promise<MentionPerson[]> }>()

/** Who the picker offers on a canvas; one fetch a minute, shared by every composer. */
export function loadMentionPeople(canvasId: string): Promise<MentionPerson[]> {
  const hit = peopleCache.get(canvasId)
  if (hit && Date.now() - hit.at < PEOPLE_TTL_MS) return hit.people
  const people = api.mentionPeople(canvasId).catch(() => [] as MentionPerson[])
  peopleCache.set(canvasId, { at: Date.now(), people })
  return people
}

/** The ids of picked people whose @name is still in the text, in order of appearance. */
export function mentionIds(text: string, picked: MentionPerson[]): string[] {
  const lower = text.toLowerCase()
  return picked
    .map((p) => ({ p, at: lower.indexOf(`@${p.name.toLowerCase()}`) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.p.userId)
}

type Option =
  | { kind: 'person'; key: string; label: string; person: MentionPerson }
  | { kind: 'agent'; key: string; label: string; roleId: string }

export interface MentionTextareaHandle {
  focus(): void
  /** the people picked so far (the caller filters them with mentionIds at send time) */
  picked(): MentionPerson[]
}

export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  {
    canvasId: string
    value: string
    onChange: (text: string) => void
    /** offer the people picker (needs an account that can comment) */
    people: boolean
    /** offer the resident agents (editors only) */
    agents: boolean
    myId?: string
    className?: string
    placeholder?: string
    onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  }
>(function MentionTextarea(
  { canvasId, value, onChange, people, agents, myId, className, placeholder, onKeyDown },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [directory, setDirectory] = useState<MentionPerson[]>([])
  const [picked, setPicked] = useState<MentionPerson[]>([])
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)

  useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus(), picked: () => picked }), [picked])

  useEffect(() => {
    if (!people) return
    let live = true
    void loadMentionPeople(canvasId).then((list) => live && setDirectory(list))
    return () => {
      live = false
    }
  }, [canvasId, people])

  /* the @word being typed right before the caret, if any */
  const trigger = useMemo(() => {
    const before = value.slice(0, caret)
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(before)
    return match ? { start: before.length - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null
  }, [value, caret])

  const options = useMemo<Option[]>(() => {
    if (!trigger || dismissed === trigger.start) return []
    const q = trigger.query
    const found: Option[] = []
    if (people) {
      for (const person of directory) {
        if (person.userId === myId) continue
        const words = person.name.toLowerCase().split(/\s+/)
        if (!q || person.name.toLowerCase().startsWith(q) || words.some((w) => w.startsWith(q))) {
          found.push({ kind: 'person', key: person.userId, label: person.name, person })
        }
      }
    }
    if (agents) {
      for (const role of AGENT_ROLES) {
        if (!q || role.id.startsWith(q) || role.name.toLowerCase().startsWith(q)) {
          found.push({ kind: 'agent', key: `agent:${role.id}`, label: role.name, roleId: role.id })
        }
      }
    }
    return found.slice(0, 6)
  }, [trigger, dismissed, people, agents, directory, myId])

  const open = options.length > 0
  const current = Math.min(active, Math.max(0, options.length - 1))

  function choose(option: Option) {
    if (!trigger) return
    const insert = option.kind === 'person' ? `@${option.person.name} ` : `@${option.roleId} `
    const next = value.slice(0, trigger.start) + insert + value.slice(caret)
    onChange(next)
    if (option.kind === 'person') {
      setPicked((list) => (list.some((p) => p.userId === option.person.userId) ? list : [...list, option.person]))
    }
    const at = trigger.start + insert.length
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  return (
    <div className="relative">
      <Textarea
        ref={taRef}
        variant="bare"
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart)
          setActive(0)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (open) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              setActive((current + step + options.length) % options.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              if (event.metaKey || event.ctrlKey) {
                onKeyDown?.(event)
                return
              }
              event.preventDefault()
              choose(options[current]!)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDismissed(trigger?.start ?? null)
              return
            }
          }
          onKeyDown?.(event)
        }}
      />
      {open && (
        <ul
          role="listbox"
          aria-label="Mention someone"
          className="absolute left-0 top-full z-10 mt-1 w-full overflow-hidden rounded-[10px] border border-line bg-surface p-1 shadow-pop animate-[chip-in_0.14s_ease]"
        >
          {options.map((option, index) => (
            <li key={option.key} role="option" aria-selected={index === current}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-ink',
                  index === current ? 'bg-paper-deep' : 'hover:bg-paper-deep',
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(option)
                }}
                onMouseEnter={() => setActive(index)}
              >
                {option.kind === 'person' ? (
                  <Avatar name={option.label} className="size-5 flex-none border-0 text-[10px]" />
                ) : (
                  <RoleMark role={AGENT_ROLES.find((r) => r.id === option.roleId)!} size={16} />
                )}
                <span className="min-w-0 flex-1 truncate font-semibold">{option.label}</span>
                <span className="flex-none text-[11px] text-ink-faint">
                  {option.kind === 'agent' ? `@${option.roleId} · agent` : 'person'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
