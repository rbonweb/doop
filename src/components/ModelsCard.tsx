import { useEffect, useState } from 'react'
import { adminApi, ApiError, type AdminModels } from '../lib/api'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { cardVariants } from './ui/card'
import { Field } from './ui/field'
import { Input } from './ui/input'

type Key = 'agent' | 'distill'
type Check = { state: 'checking' } | { state: 'ok'; model: string } | { state: 'failed'; error: string }

const FIELDS: { key: Key; label: string; hint: string }[] = [
  {
    key: 'agent',
    label: 'Doop Agent model',
    hint: 'Designs on the canvas when a card or @mention runs on the server’s key, and describes uploaded backgrounds.',
  },
  {
    key: 'distill',
    label: 'Style-rule model',
    hint: 'Turns feedback into the short style rules Memory proposes. A small, fast model is enough.',
  },
]

/**
 * The models the server's own Anthropic key runs on, changed without a
 * restart (server/instanceSettings.ts). Test makes one small call with the
 * name as typed, so a typo shows up here rather than in a failed run.
 * Users' own connected accounts pick their models in Settings instead.
 */
export function ModelsCard() {
  const [models, setModels] = useState<AdminModels | null>(null)
  const [draft, setDraft] = useState<Record<Key, string>>({ agent: '', distill: '' })
  const [checks, setChecks] = useState<Partial<Record<Key, Check>>>({})
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  function show(next: AdminModels) {
    setModels(next)
    setDraft({ agent: next.agent.value, distill: next.distill.value })
  }

  useEffect(() => {
    adminApi.models().then(show, () => setNotice({ tone: 'error', text: 'The model settings could not be read.' }))
  }, [])

  async function test(key: Key) {
    setChecks((c) => ({ ...c, [key]: { state: 'checking' } }))
    try {
      const result = await adminApi.testModel(draft[key])
      setChecks((c) => ({
        ...c,
        [key]: result.ok ? { state: 'ok', model: result.model } : { state: 'failed', error: result.error },
      }))
    } catch (e) {
      const error = e instanceof ApiError && typeof e.body.error === 'string' ? e.body.error : 'The test failed.'
      setChecks((c) => ({ ...c, [key]: { state: 'failed', error } }))
    }
  }

  async function save(change: Partial<Record<Key, string>>) {
    setBusy(true)
    setNotice(null)
    try {
      show(await adminApi.setModels(change))
      setNotice({ tone: 'success', text: 'Saved. The next run uses it; nothing needs restarting.' })
    } catch (e) {
      const text = e instanceof ApiError && typeof e.body.error === 'string' ? e.body.error : 'Not saved.'
      setNotice({ tone: 'error', text })
    } finally {
      setBusy(false)
    }
  }

  if (!models) return notice ? <Callout tone="error">{notice.text}</Callout> : null
  const changed = draft.agent !== models.agent.value || draft.distill !== models.distill.value

  return (
    <div className={cn(cardVariants(), 'mt-4 flex flex-col gap-4 px-4 py-3.5')}>
      <div>
        <div className="font-display text-[14.5px] font-semibold">Models</div>
        <p className="mt-1 text-[12.5px] text-ink-faint">
          {models.serverKey
            ? `The server’s Anthropic key sends its calls to ${models.baseUrl ?? 'Anthropic (api.anthropic.com)'}.`
            : 'This server has no Anthropic key (ANTHROPIC_API_KEY), so these models are not used until one is set.'}
        </p>
      </div>
      {FIELDS.map(({ key, label, hint }) => {
        const check = checks[key]
        return (
          <Field key={key} label={label} labelVariant="form" hint={hint}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={draft[key]}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [key]: e.target.value }))
                  setChecks((c) => ({ ...c, [key]: undefined }))
                }}
                placeholder={models[key].default}
                aria-label={label}
                spellCheck={false}
                className="font-mono text-[13px] sm:flex-1"
              />
              <Button
                variant="ghost"
                size="md"
                disabled={!models.serverKey || !draft[key].trim() || check?.state === 'checking'}
                onClick={() => void test(key)}
              >
                {check?.state === 'checking' ? 'Testing…' : 'Test'}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">
              {check?.state === 'ok' && <span className="text-success-ink">Works: answered as {check.model}. </span>}
              {check?.state === 'failed' && <span className="text-accent-ink">Failed: {check.error} </span>}
              Default: <code className="font-mono">{models[key].default}</code>
              {models[key].value !== models[key].default && (
                <>
                  {' · '}
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0 py-0 text-xs"
                    disabled={busy}
                    onClick={() => void save({ [key]: '' })}
                  >
                    use the default
                  </Button>
                </>
              )}
            </p>
          </Field>
        )
      })}
      {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
      <div>
        <Button
          variant="primary"
          size="md"
          disabled={busy || !changed || !draft.agent.trim() || !draft.distill.trim()}
          onClick={() => void save({ agent: draft.agent, distill: draft.distill })}
        >
          {busy ? '…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
