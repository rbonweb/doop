import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '../lib/i18n'
import { MOD_KEY, isComposingEnter } from '../lib/keys'
import { richTextForField, richTextSubset, sameRichText, webAddress } from '../lib/richTextProp'
import { IconButton } from './ui/icon-button'
import { BoldIcon, ItalicIcon, LinkIcon, UnlinkIcon } from './ui/icons'
import { Input } from './ui/input'
import { PropertyBlock } from './ui/property-field'

/**
 * A rich-text prop: a small contenteditable under the prop's name, with bold and italic (⌘B, ⌘I), a link button that asks
 * for an http(s) address, a line break on Enter and plain-text paste. The value is sent when the field loses focus, as the
 * subset markup the server keeps (it sanitizes again, and what it kept is what the field shows after the save). Inline
 * editing on the canvas is separate and already works through the instance's reconcile.
 */
export function RichTextPropField({
  label,
  value,
  disabled,
  overridden,
  error,
  onCommit,
}: {
  label: string
  /** the stored (server-sanitized) value */
  value: string
  disabled: boolean
  overridden?: { label: string; onReset: () => void; disabled?: boolean }
  /** why the server's rules refused the last value */
  error?: string
  /** the subset markup of what was typed, when it differs from the stored value */
  onCommit: (html: string) => Promise<void> | void
}) {
  const t = useT()
  const editor = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const [linking, setLinking] = useState(false)
  const [address, setAddress] = useState('')
  const [problem, setProblem] = useState<string>()
  const [focused, setFocused] = useState(false)
  /* bumped when a save ends, so the field re-reads what is stored whether it was kept, changed or refused */
  const [settled, setSettled] = useState(0)
  /* the stored value a commit was made against: until it changes, the server has not answered and the typed text stays */
  const sentAgainst = useRef<string | null>(null)
  const sentHtml = useRef('')

  /* what the server kept replaces what was typed, unless the person is in the middle of typing */
  useEffect(() => {
    const el = editor.current
    if (!el || focused) return
    if (sentAgainst.current === value) return
    sentAgainst.current = null
    const shown = richTextForField(value)
    if (richTextSubset(el) !== shown) el.innerHTML = shown
  }, [value, focused, settled])

  const run = (command: string, argument?: string) => {
    editor.current?.focus()
    document.execCommand(command, false, argument)
  }

  const commit = () => {
    const el = editor.current
    if (!el) return
    const html = richTextSubset(el)
    if (sameRichText(html, value)) return
    /* the same text for the same stored value is already on its way (a cancel and a blur arrive together) */
    if (sentAgainst.current === value && sentHtml.current === html) return
    sentAgainst.current = value
    sentHtml.current = html
    void Promise.resolve(onCommit(html)).finally(() => {
      sentAgainst.current = null
      setSettled((count) => count + 1)
    })
  }

  const startLink = () => {
    const selection = window.getSelection()
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
    if (!range || range.collapsed || !editor.current?.contains(range.commonAncestorContainer)) {
      setProblem(t('componentFields.linkNeedsSelection'))
      return
    }
    savedRange.current = range.cloneRange()
    const inLink = (range.startContainer.parentElement ?? null)?.closest('a')
    setAddress(inLink?.getAttribute('href') ?? '')
    setProblem(undefined)
    setLinking(true)
  }

  const cancelLink = () => {
    setLinking(false)
    setProblem(undefined)
    commit()
  }

  const applyLink = () => {
    const href = webAddress(address)
    if (!href) {
      setProblem(t('componentFields.linkInvalid'))
      return
    }
    const range = savedRange.current
    editor.current?.focus()
    const selection = window.getSelection()
    if (range && selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    document.execCommand('createLink', false, href)
    setLinking(false)
    setProblem(undefined)
    commit()
  }

  return (
    <PropertyBlock label={label} overridden={overridden} error={problem ?? error}>
      <div
        data-slot="rich-text-prop"
        className="flex flex-col rounded-control bg-surface shadow-ring focus-within:shadow-ring-hover"
      >
        {!disabled && (
          <div className="flex items-center gap-0.5 border-b border-line-soft px-1 py-0.5">
            <IconButton
              size="sm"
              aria-label={t('componentFields.bold')}
              title={`${t('componentFields.bold')} (${MOD_KEY}B)`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run('bold')}
            >
              <BoldIcon size="rail" aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              aria-label={t('componentFields.italic')}
              title={`${t('componentFields.italic')} (${MOD_KEY}I)`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run('italic')}
            >
              <ItalicIcon size="rail" aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              aria-label={t('componentFields.link')}
              title={t('componentFields.link')}
              on={linking}
              onMouseDown={(event) => event.preventDefault()}
              onClick={startLink}
            >
              <LinkIcon size="rail" aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              aria-label={t('componentFields.removeLink')}
              title={t('componentFields.removeLink')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                run('unlink')
                commit()
              }}
            >
              <UnlinkIcon size="rail" aria-hidden />
            </IconButton>
          </div>
        )}
        {linking && (
          <form
            className="flex items-center gap-1 border-b border-line-soft p-1"
            onBlur={(event) => {
              /* leaving the form without applying is a cancel: what was typed is saved as it stands */
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelLink()
            }}
            onSubmit={(event) => {
              event.preventDefault()
              applyLink()
            }}
          >
            <Input
              autoFocus
              value={address}
              placeholder={t('componentFields.linkPlaceholder')}
              aria-label={t('componentFields.linkAria')}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.stopPropagation()
                cancelLink()
                editor.current?.focus()
              }}
            />
            <IconButton size="sm" type="submit" aria-label={t('componentFields.applyLink')}>
              <LinkIcon size="rail" aria-hidden />
            </IconButton>
          </form>
        )}
        <div
          ref={editor}
          role="textbox"
          aria-multiline="true"
          aria-label={t('componentFields.richAria', { name: label })}
          aria-disabled={disabled || undefined}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck
          className={cn(
            'min-h-[52px] px-2 py-1.5 font-sans text-copy text-ink outline-none',
            '[&_a]:text-brand [&_a]:underline',
            disabled && 'opacity-50',
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (!linking) commit()
          }}
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey
            const key = event.key.toLowerCase()
            if (mod && !event.altKey && !event.shiftKey && (key === 'b' || key === 'i')) {
              event.preventDefault()
              run(key === 'b' ? 'bold' : 'italic')
            } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !isComposingEnter(event)) {
              /* a line break, never a block the subset would have to flatten */
              event.preventDefault()
              run('insertLineBreak')
            }
          }}
          onPaste={(event) => {
            /* plain text only: pasted markup brings styles and elements the value does not hold */
            event.preventDefault()
            run('insertText', event.clipboardData.getData('text/plain'))
          }}
          onDrop={(event) => event.preventDefault()}
        />
      </div>
    </PropertyBlock>
  )
}
