import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ElementComment } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRole, roleName } from '../../shared/agents'
import { cn } from '@/lib/utils'
import { authClient } from '../lib/auth'
import { useCanEdit } from '../lib/role'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { MentionTextarea, mentionIds, type MentionTextareaHandle } from './MentionTextarea'
import { RoleMark } from './RoleMark'

/* The comment UI — pins, the composer, an open thread — is shared by the
   frames (element comments, FrameView) and the canvas itself (canvas
   comments, CanvasComments). It is not capped like other counter-scaled
   chrome: it is screen UI the user reads and types in, so it keeps its size
   at every zoom, the way Figma's comment pins do. */
export const PIN_SCALE = '[transform:translate(-50%,-50%)_scale(calc(1/var(--zoom,1)))]'

/** A thread's pin, coloured by its author and reflecting the newest agent
 *  request in the thread (💬 a note, ✦ an agent is on it, ! it failed). The
 *  open thread popover renders as its child, so it inherits the pin's
 *  counter-scale. `left`/`top` are in the parent's coordinate space: pixels,
 *  or a CSS length for a pin placed by a calc. An `orphan` is a frame comment
 *  whose element is gone (dashed, dimmed); `mentioned` rings the pin of a
 *  thread that just @mentioned you. */
export function CommentPin({
  thread,
  open,
  left,
  top,
  orphan = false,
  mentioned = false,
  onToggle,
  children,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: [ElementComment, ...ElementComment[]]
  open: boolean
  left: number | string
  top: number | string
  orphan?: boolean
  mentioned?: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  const [root] = thread
  const agentItem = [...thread].reverse().find((x) => x.forAgent && !x.resolvedAt)
  const working = agentItem?.claimedBy && !agentItem.failedAt
  return (
    <div
      className={cn(
        'pointer-events-auto absolute z-[4] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white animate-[chip-in_0.25s_ease]',
        PIN_SCALE,
        orphan && 'border-dashed border-ink-soft opacity-80',
        mentioned && 'animate-[mention-ring_1.4s_ease-out_infinite]',
        agentItem?.failedAt
          ? 'bg-accent-ink! font-extrabold shadow-[0_0_0_3px_rgba(208,52,31,0.2),var(--shadow-card)]'
          : 'shadow-card',
        working &&
          "after:absolute after:-inset-1.5 after:rounded-[inherit] after:border-2 after:border-current after:opacity-50 after:content-[''] after:[animation:stream-pulse_1.1s_ease-in-out_infinite]",
      )}
      style={{ left, top, background: colorFor(root.from) }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      title={`${orphan ? 'The element this was on changed\n' : ''}${root.from}: ${root.text}${thread.length > 1 ? ` (${thread.length - 1} replies)` : ''}`}
    >
      {agentItem?.failedAt ? '!' : working ? '✦' : '💬'}
      {open && children}
    </div>
  )
}

export function CommentComposer({
  canvasId,
  onSubmit,
  onCancel,
  initialText = '',
  placeholder,
}: {
  canvasId: string
  /** `mentions` are the account ids of the people @mentioned in the text */
  onSubmit: (text: string, mentions: string[]) => void
  onCancel: () => void
  initialText?: string
  placeholder?: string
}) {
  const [text, setText] = useState(initialText)
  const taRef = useRef<MentionTextareaHandle>(null)
  useEffect(() => taRef.current?.focus(), [])
  const myId = authClient.useSession().data?.user.id
  const guest = useStore((s) => s.guest)
  const mayEdit = useCanEdit()
  const send = () => text.trim() && onSubmit(text, mentionIds(text, taRef.current?.picked() ?? []))
  /* @mention a resident agent to route the comment to it; without one the
     comment is a note for the humans in the room */
  const mentioned = mayEdit ? mentionedRole(text) : undefined
  return (
    <div className="w-[240px] rounded-[10px] border border-line bg-surface p-2 shadow-pop animate-[chip-in_0.18s_ease]">
      <MentionTextarea
        ref={taRef}
        canvasId={canvasId}
        people={!guest}
        agents={mayEdit}
        myId={myId}
        className="min-h-[58px] md:text-[13px]"
        value={text}
        placeholder={placeholder ?? (guest ? 'Leave a comment…' : 'Leave a comment… @ to mention someone')}
        onChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          if (e.key === 'Escape') onCancel()
        }}
      />
      {mayEdit && !mentioned && (
        <div className="mb-2 flex flex-wrap gap-1">
          {AGENT_ROLES.map((role) => (
            <Button
              key={role.id}
              variant="ghost"
              size="pill"
              className="border-dashed px-2 text-[11px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
              title={`${role.name} — ${role.blurb}`}
              onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + `@${role.id} `)}
            >
              <RoleMark role={role} size={13} /> @{role.id}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {mentioned && (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            <RoleMark role={mentioned} size={13} />
            {mentioned.name} will pick this up
          </span>
        )}
        {guest && <span className="mr-auto text-[11px] text-ink-faint">Posting as a guest</span>}
        <Button variant="solid" size="pill" className="px-3.5 py-[5px] text-xs" disabled={!text.trim()} onClick={send}>
          Post
        </Button>
      </div>
    </div>
  )
}

/** Where an @agent request in the thread stands, or null for a human note. */
function agentStatus(c: ElementComment): string | null {
  const target = c.targetAgent ?? roleName(DEFAULT_ROLE_ID)
  if (c.failedAt) return `${target} stopped`
  if (c.resolvedAt) return c.forAgent ? `✓ ${c.resolvedBy ?? target}` : null
  if (c.claimedBy) return `✦ ${c.claimedBy} is on it`
  return c.forAgent ? `✦ waiting for ${target}` : null
}

export function CommentThread({
  thread,
  alignEnd = false,
  canvasId,
  canReply,
  canResolve,
  canRetry,
  onReply,
  onResolve,
  onRetry,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: ElementComment[]
  /** open towards the left: the pin sits at the frame's right edge */
  alignEnd?: boolean
  canvasId: string
  /** below comment the thread is read-only */
  canReply: boolean
  /** guests can reply but not close a thread */
  canResolve: boolean
  /** retrying a stopped agent request is an editor's call */
  canRetry: boolean
  /** rejects when the reply did not land — the draft is kept for a retry; `mentions` are account ids */
  onReply: (text: string, mentions: string[]) => Promise<unknown>
  onResolve: () => void
  onRetry: (commentId: string) => void
}) {
  const replyRef = useRef<MentionTextareaHandle>(null)
  const myId = authClient.useSession().data?.user.id
  const guest = useStore((s) => s.guest)
  const mayEdit = useCanEdit()
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  /* a long conversation opens (and grows) scrolled to its newest message */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.length])
  const send = () => {
    if (!reply.trim() || sending) return
    const submitted = reply
    setSending(true)
    setFailed(false)
    onReply(submitted, mentionIds(submitted, replyRef.current?.picked() ?? []))
      /* only clear what was sent — text typed meanwhile is a new draft */
      .then(() => setReply((current) => (current === submitted ? '' : current)))
      .catch(() => setFailed(true))
      .finally(() => setSending(false))
  }
  const mentioned = mayEdit ? mentionedRole(reply) : undefined
  return (
    <div
      className={cn(
        'absolute top-[calc(100%_+_8px)] w-[250px] cursor-default rounded-[10px] border border-line bg-surface p-2.5 text-left shadow-pop animate-[chip-in_0.18s_ease]',
        alignEnd ? 'right-0' : 'left-1/2 -translate-x-1/2',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={listRef} className="-mx-1 max-h-[240px] overflow-y-auto px-1">
        {thread.map((c, i) => {
          const status = agentStatus(c)
          return (
            <div key={c.id} className={cn(i > 0 && 'mt-2 border-t border-line-soft pt-2')}>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <b style={{ color: colorFor(c.from) }}>{c.from}</b>
                {status && <span className="whitespace-nowrap text-[11px] font-semibold text-brand">{status}</span>}
              </div>
              <div className="mt-1 break-words text-[13px] leading-[1.45] text-ink">{c.text}</div>
              {c.failedAt ? (
                <div className="mt-1 flex items-center gap-2 text-[11px] leading-[1.4] text-accent-ink">
                  <span>{c.failureReason ?? 'The agent did not finish.'}</span>
                  {canRetry && (
                    <Button
                      variant="danger-solid"
                      size="pill"
                      className="shrink-0 px-[9px] py-[3px] text-[11px]"
                      onClick={() => onRetry(c.id)}
                    >
                      ↻ Retry
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {canReply && (
        <MentionTextarea
          ref={replyRef}
          canvasId={canvasId}
          people={!guest}
          agents={mayEdit}
          myId={myId}
          className="mt-2 min-h-[38px] md:text-[13px]"
          value={reply}
          placeholder={mayEdit ? 'Reply… (@ to mention, @doop to ask the agent)' : 'Reply…'}
          onChange={setReply}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
      )}
      {failed && (
        <div className="mt-1 text-[11px] leading-[1.4] text-accent-ink">
          That reply did not go through — it may be resolved already. Try again.
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        {canResolve && (
          <Button
            variant="ghost"
            size="pill"
            className="px-2.5 text-ink-soft hover:border-ink-soft hover:bg-transparent hover:text-ink"
            onClick={onResolve}
          >
            ✓ Resolve
          </Button>
        )}
        {mentioned && (
          <span
            className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand"
            title={`${mentioned.name} will pick this up`}
          >
            <RoleMark role={mentioned} size={13} />
            <span className="truncate">{mentioned.name}</span>
          </span>
        )}
        {canReply && (
          <Button
            variant="solid"
            size="pill"
            className={cn('px-3 py-[4px] text-xs', !mentioned && 'ml-auto')}
            disabled={!reply.trim() || sending}
            onClick={send}
          >
            {sending ? 'Posting…' : 'Reply'}
          </Button>
        )}
      </div>
    </div>
  )
}
