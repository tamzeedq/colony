import { useEffect, useState } from 'react'
import { useStore } from '@/store/store'
import { Field, inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'
import { PROVIDER_IDS, providerHint, type ProviderId, type ProviderStatus, type ProviderView } from '@/types/colony'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { Head, card } from './shared'

const PROVIDER_LABEL: Record<ProviderId, string> = {
  'claude-subscription': 'Claude subscription', 'anthropic-api': 'Anthropic API', openai: 'OpenAI',
  google: 'Google', openrouter: 'OpenRouter', custom: 'Custom (OpenAI-compatible)',
}
const PROVIDER_NOTE: Record<ProviderId, string> = {
  'claude-subscription': 'Built in. Claude Code with your plan (CLAUDE_CODE_OAUTH_TOKEN on the control plane).',
  'anthropic-api': 'Claude Code billed to an Anthropic API key.',
  openai: 'GPT models through the LiteLLM gateway.',
  google: 'Gemini models through the LiteLLM gateway.',
  openrouter: 'Any OpenRouter model through the gateway.',
  custom: 'Any OpenAI-compatible endpoint (vLLM, Ollama, LM Studio…).',
}
const PROVIDER_STATUS: Record<ProviderStatus, { label: string; cls: string }> = {
  connected: { label: '● Connected', cls: 'text-st-done' },
  untested: { label: '○ Untested', cls: 'text-st-idle' },
  error: { label: '✕ Error', cls: 'text-st-error' },
  missing_key: { label: '○ No key', cls: 'text-ink-dim' },
}

export function Providers() {
  const { state, dispatch, mode } = useStore()
  // Fresh list (with masked hints) when the section opens; the snapshot is the fallback.
  useEffect(() => {
    if (mode !== 'live') return
    endpoints.providers().then((r) => {
      const list = Array.isArray(r) ? r : r?.providers
      if (Array.isArray(list)) dispatch({ type: 'setProviders', providers: list })
    }, () => { /* older control plane: keep the snapshot's list */ })
  }, [mode, dispatch])
  const list: ProviderView[] = PROVIDER_IDS.map((id) => state.providers.find((p) => p.id === id)
    ?? { id, label: PROVIDER_LABEL[id], kind: id === 'claude-subscription' ? 'subscription' : id === 'anthropic-api' ? 'anthropic' : 'gateway', hasKey: false, models: [], status: 'missing_key' })
  return (
    <>
      <Head title="Providers & keys" sub="Where agents get their models. Keys are encrypted at rest on this machine and never sent back to the browser." />
      <div className="rounded-lg border border-st-blocked/40 bg-st-blocked/10 px-3.5 py-2.5 text-[13px] leading-normal">
        <b className="text-st-blocked">▲ Experimental:</b> non-Claude providers. This phase stores and tests keys; agents keep running on Claude until the gateway lands.
      </div>
      {list.map((p) => <ProviderCard key={p.id} provider={p} />)}
    </>
  )
}

function ProviderCard({ provider: p }: { provider: ProviderView }) {
  const { dispatch, mode } = useStore()
  const builtIn = p.id === 'claude-subscription'
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '')
  const [busy, setBusy] = useState<'' | 'save' | 'remove' | 'test'>('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setBaseUrl(p.baseUrl ?? '') }, [p.baseUrl])
  const st = builtIn
    ? (p.hasKey ? (p.status === 'error' ? PROVIDER_STATUS.error : PROVIDER_STATUS.connected) : { label: '✕ Token missing', cls: 'text-st-error' })
    : PROVIDER_STATUS[p.status] ?? PROVIDER_STATUS.untested
  const hint = providerHint(p)
  const dirty = !!key.trim() || (p.id === 'custom' && baseUrl.trim() !== (p.baseUrl ?? ''))

  const run = async (what: 'save' | 'remove' | 'test') => {
    setBusy(what); setNote(null)
    try {
      if (mode !== 'live') {
        // Mock: pretend.
        const next: ProviderView = what === 'remove' ? { ...p, hasKey: false, keyHint: undefined, status: 'missing_key' }
          : what === 'save' ? { ...p, hasKey: p.hasKey || !!key.trim(), keyHint: key.trim() ? `${key.trim().slice(0, 3)}…${key.trim().slice(-4)}` : p.keyHint, baseUrl: baseUrl.trim() || undefined, status: 'untested' }
          : { ...p, status: p.hasKey ? 'connected' : 'missing_key' }
        dispatch({ type: 'upsertProvider', provider: next })
        setNote({ ok: true, text: what === 'test' ? (p.hasKey ? 'Key works (mock)' : 'No key to test') : what === 'save' ? 'Saved (mock)' : 'Key removed (mock)' })
      } else if (what === 'save') {
        const body: { apiKey?: string; baseUrl?: string } = {}
        if (key.trim()) body.apiKey = key.trim()
        if (p.id === 'custom') body.baseUrl = baseUrl.trim()
        const r = await endpoints.putProvider(p.id, body)
        if (r?.id) dispatch({ type: 'upsertProvider', provider: r })
        setNote({ ok: true, text: 'Saved · encrypted on the control plane. Run Test to check it.' })
      } else if (what === 'remove') {
        const r = await endpoints.deleteProviderKey(p.id)
        dispatch({ type: 'upsertProvider', provider: r?.id ? r : { ...p, hasKey: false, keyHint: undefined, maskedKey: undefined, hint: undefined, status: 'missing_key' } })
        setNote({ ok: true, text: 'Key removed' })
      } else {
        const r = await endpoints.testProvider(p.id)
        const updated = r?.provider ?? (r?.id ? r : undefined)
        if (updated) dispatch({ type: 'upsertProvider', provider: updated })
        const ok = r?.ok ?? (updated ? updated.status === 'connected' : true)
        setNote({ ok, text: r?.message ?? r?.error ?? updated?.statusDetail ?? updated?.lastError ?? (ok ? 'Connection works' : 'Test failed') })
      }
      if (what === 'save') setKey('')
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy('')
    }
  }

  return (
    <section className={cx(card, 'flex flex-col gap-3')}>
      <div className="flex flex-wrap items-center gap-3">
        <b className="font-display text-[17px] font-semibold">{p.label || PROVIDER_LABEL[p.id]}</b>
        <span className="rounded-xs border border-line-strong px-1.5 font-mono text-[10px] text-ink-muted">{builtIn ? 'built in' : p.kind}</span>
        {!builtIn && p.kind === 'gateway' && <span className="text-[11px] font-semibold text-st-blocked">▲ Experimental</span>}
        <span className={cx('ml-auto text-xs font-semibold', st.cls)}>{st.label}</span>
      </div>
      {p.status === 'error' && p.statusDetail && !note && <div className="text-xs text-st-error">✕ {p.statusDetail}</div>}
      <p className="m-0 text-xs text-ink-dim">{PROVIDER_NOTE[p.id]}{p.models.length ? <> · <span className="font-mono">{p.models.join(' · ')}</span></> : null}</p>
      {!builtIn && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (dirty) void run('save') }}>
          {p.id === 'custom' && (
            <Field label="Base URL"><input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://host.docker.internal:11434/v1" className={cx(inputCls, 'w-72 font-mono text-[13px]')} /></Field>
          )}
          <Field label={p.hasKey ? 'Replace key' : 'API key'}>
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
              placeholder={p.hasKey ? `Stored · ${hint ?? '••••••••'}` : 'Paste key'} aria-label={`${p.label} API key`} className={cx(inputCls, 'w-72 font-mono text-[13px]')} />
          </Field>
          <Button variant="primary" type="submit" disabled={!dirty || !!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          {p.hasKey && <Button variant="danger" onClick={() => void run('remove')} disabled={!!busy}>{busy === 'remove' ? 'Removing…' : 'Remove key'}</Button>}
          <Button onClick={() => void run('test')} disabled={!!busy || (!p.hasKey && p.id !== 'custom')}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        </form>
      )}
      {builtIn && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-ink-muted">{p.hasKey ? 'Your plan’s OAuth token is configured on the control plane.' : 'Set CLAUDE_CODE_OAUTH_TOKEN for the control plane (run `claude setup-token`).'}</span>
          <Button className="ml-auto" onClick={() => void run('test')} disabled={!!busy || !p.hasKey}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        </div>
      )}
      {note && <div className={cx('text-xs', note.ok ? 'text-st-done' : 'text-st-error')}>{note.ok ? '✓' : '✕'} {note.text}</div>}
    </section>
  )
}
