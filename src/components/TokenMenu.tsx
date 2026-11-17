import { useState } from 'react'
import {
  effectiveValue,
  isTokenName,
  nextTokenName,
  normalizeTokenName,
  resolveToken,
  sortTokens,
  tokenLabel,
  type DesignToken,
  type TokenType,
} from '../../shared/designTokens'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { TOKEN_TYPE_LABEL, TokenSwatch } from './TokensPanel'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { BracesIcon, PlusIcon } from './ui/icons'
import type { FieldToken } from './ui/property-field'

/** What a field shows while bound: the token's name, and its colour for a swatch. */
export function fieldToken(
  token: DesignToken | undefined,
  tokens: readonly DesignToken[],
  theme: string | undefined,
  detach: () => void,
): FieldToken | undefined {
  if (!token) return undefined
  return {
    name: tokenLabel(token.name),
    ...(token.type === 'color'
      ? { swatch: resolveToken(tokens, token.name, theme) ?? effectiveValue(token, theme) }
      : {}),
    onDetach: detach,
  }
}

/** The trailing menu of a field: a popover listing the canvas's tokens of
 *  the field's types; its + opens a card beside it that makes a new token
 *  from the field's current value and binds the field to it. */
export function TokenMenu({
  canvasId,
  types,
  tokens,
  theme,
  literal,
  onPick,
  placement = 'inline',
}: {
  canvasId: string
  types: readonly TokenType[]
  tokens: readonly DesignToken[]
  /** the frame's theme: values and swatches are shown as that theme resolves them */
  theme?: string
  /** the field's current value, what a new token is made from; null when there is none */
  literal: string | null
  onPick: (name: string) => void
  /** `inline` sits inside a field and shows on hover; `beside` is a field-height box next to a select */
  placement?: 'inline' | 'beside'
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const type = types[0]!
  const options = sortTokens(tokens.filter((token) => types.includes(token.type)))
  const typed = normalizeTokenName(name)
  const canCreate = isTokenName(typed) && value.trim() !== '' && !busy

  function startCreating() {
    setValue(literal ?? '')
    setName(tokenLabel(nextTokenName(tokens, type)))
    setError(null)
    setCreating(true)
  }

  function close() {
    setOpen(false)
    setCreating(false)
  }

  async function create() {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const { results, tokens: next } = await api.createTokens(canvasId, [{ name: typed, type, value: value.trim() }])
      const [result] = results
      if (result?.result === 'error') throw new Error(result.message)
      /* the room will send the same list; applying it now shows the chip at once */
      const state = useStore.getState()
      if (state.canvas?.id === canvasId) state.setTokensLocal(next, state.canvas.tokenThemes ?? [])
      onPick(typed)
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : t('inspector.tokenCreateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const swatch = type === 'color' && /^(#|rgb|hsl|oklch|oklab|color\()/i.test(value.trim())
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setCreating(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('inspector.tokenPick')}
          title={t('inspector.tokenPick')}
          className={
            placement === 'beside'
              ? 'grid size-[26px] flex-none place-items-center rounded-[7px] bg-sub text-ink-faint hover:bg-paper-deep hover:text-ink data-[state=open]:bg-paper-deep data-[state=open]:text-ink'
              : 'grid size-5 flex-none place-items-center rounded-[5px] text-ink-faint opacity-0 transition-opacity hover:bg-paper-deep hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-paper-deep data-[state=open]:text-ink data-[state=open]:opacity-100'
          }
        >
          <BracesIcon size={placement === 'beside' ? 12 : 11} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-1.5">
        <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
          <span className="text-[11px] text-ink-faint">{t('inspector.tokenHeading')}</span>
          {literal !== null && (
            <Popover open={creating} onOpenChange={(next) => (next ? startCreating() : setCreating(false))}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('inspector.tokenCreate')}
                  title={t('inspector.tokenCreate')}
                  className="grid size-5 place-items-center rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink data-[state=open]:bg-paper-deep data-[state=open]:text-ink"
                >
                  <PlusIcon size={12} />
                </button>
              </PopoverTrigger>
              {/* beside the list, Figma's "create variable" sheet; a nested
                  popover so it stays inside the viewport like the list does */}
              <PopoverContent side="left" align="start" sideOffset={14} className="w-[220px] p-2.5">
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void create()
                  }}
                >
                  <span className="px-0.5 text-[11px] text-ink-faint">
                    {t('inspector.tokenNewTitle', { type: t(TOKEN_TYPE_LABEL[type]).toLowerCase() })}
                  </span>
                  <label className="flex h-7 items-center gap-1.5 rounded-[7px] bg-sub px-2 focus-within:bg-surface focus-within:shadow-elevation-1-focus">
                    <span className="w-10 flex-none text-[10.5px] text-ink-faint">{t('inspector.tokenName')}</span>
                    <input
                      aria-label={t('inspector.tokenNewName')}
                      autoFocus
                      className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
                      value={name}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="flex h-7 items-center gap-1.5 rounded-[7px] bg-sub px-2 focus-within:bg-surface focus-within:shadow-elevation-1-focus">
                    <span className="w-10 flex-none text-[10.5px] text-ink-faint">{t('inspector.tokenValue')}</span>
                    {swatch && (
                      <span
                        className="size-3 flex-none rounded-[3px] border border-line"
                        style={{ background: value }}
                      />
                    )}
                    <input
                      aria-label={t('inspector.tokenValue')}
                      className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
                      value={value}
                      disabled={busy}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  {error && <p className="px-0.5 text-[10.5px] text-accent-ink">{error}</p>}
                  <button
                    type="submit"
                    disabled={!canCreate}
                    className="h-7 rounded-[7px] bg-ink text-[11.5px] font-medium text-paper disabled:opacity-30"
                  >
                    {busy ? t('inspector.tokenCreating') : t('inspector.tokenCreateButton')}
                  </button>
                </form>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-[1.4] text-ink-faint">
            {literal === null ? t('inspector.tokenNone') : t('inspector.tokenNoneCreate')}
          </p>
        ) : (
          <div
            role="listbox"
            aria-label={t('inspector.tokenPick')}
            className="flex max-h-[220px] flex-col overflow-y-auto"
          >
            {options.map((token) => (
              <button
                key={token.name}
                type="button"
                role="option"
                aria-selected={false}
                className="flex h-7 items-center gap-2 rounded-[7px] px-2 text-left hover:bg-sub"
                onClick={() => {
                  onPick(token.name)
                  close()
                }}
              >
                <TokenSwatch token={token} tokens={tokens} size={12} theme={theme} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{tokenLabel(token.name)}</span>
                <span className="max-w-[40%] flex-none truncate font-mono text-[10.5px] text-ink-faint">
                  {effectiveValue(token, theme)}
                </span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
