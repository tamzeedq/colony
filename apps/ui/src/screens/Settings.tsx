import { useEffect, useState } from 'react'
import { NavLink, Navigate, useParams } from 'react-router-dom'
import { useStore } from '@/store/store'
import { Switch, Field, inputCls } from '@/components/ui/controls'
import { KeyHint, Button } from '@/components/ui/primitives'
import { cx, usd, ago } from '@/lib/util'
import { PROVIDER_IDS, providerHint, type Guards, type ProviderId, type ProviderStatus, type ProviderView } from '@/types/colony'
import { endpoints } from '@/api/endpoints'
import { meterTone } from '@/design/status'
import { errorMessage } from '@/api/client'

const SECTIONS = [
  { id: 'limits', g: '◷', label: 'Limits & budgets' }, { id: 'alerts', g: '♪', label: 'Alerts & sound' },
  { id: 'providers', g: '◈', label: 'Providers & keys' },
  { id: 'docker', g: '▣', label: 'Docker & host' }, { id: 'teams', g: '⬡', label: 'Team templates' },
  { id: 'roles', g: '☰', label: 'Role library' }, { id: 'keys', g: '⌨', label: 'Keyboard' },
]

export function Settings() {
  const { section = 'limits' } = useParams()
  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/settings/limits" replace />
  return (
    <div className="flex flex-wrap">
      <nav aria-label="Settings sections" className="flex min-w-0 max-w-[280px] flex-[1_1_240px] flex-col gap-0.5 border-r border-line-soft bg-well px-3.5 py-5.5">
        <div className="px-2.5 pb-3.5 font-display text-[22px] font-semibold">Settings</div>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-2.5 py-2 no-underline', isActive ? 'bg-raised font-semibold text-ink' : 'text-ink-muted hover:text-ink')}>
            {({ isActive }) => <><span className={cx('w-[18px] font-mono', isActive ? 'text-you' : 'text-ink-dim')}>{s.g}</span>{s.label}</>}
          </NavLink>
        ))}
        <div className="mt-auto px-2.5 py-3 text-xs leading-normal text-ink-dim">Settings file<br /><span className="font-mono text-ink-muted">~/.colony/config.toml</span></div>
      </nav>
      <main className="flex min-w-0 max-w-[1040px] flex-[999_1_720px] flex-col gap-5.5 px-8.5 pb-10 pt-6.5">
        {section === 'limits' && <Limits />}
        {section === 'alerts' && <AlertsSection />}
        {section === 'providers' && <Providers />}
        {section === 'docker' && <Docker />}
        {section === 'teams' && <Teams />}
        {section === 'roles' && <Roles />}
        {section === 'keys' && <Keys />}
      </main>
    </div>
  )
}

function Head({ title, sub }: { title: string; sub: string }) {
  return <div><h1 className="m-0 font-display text-[26px] font-semibold">{title}</h1><p className="mb-0 mt-1.5 text-ink-muted">{sub}</p></div>
}
const card = 'rounded-xl border border-line bg-surface px-5 py-4.5'

function Limits() {
  const { state, dispatch } = useStore()
  const g = state.guards
  const u = state.resources.usage
  const set = (patch: Partial<Guards>) => dispatch({ type: 'guards', patch })
  const wk = meterTone(u.weekly.usedPct, g.weeklyWarnAtPct)
  const sliders: { k: keyof Guards; t: string; d: string }[] = [
    { k: 'warnAtPct', t: 'Warn at', d: 'HUD meter turns ▲ and a heads-up appears' },
    { k: 'pauseWorkersAtPct', t: 'Auto-pause workers at', d: 'Workers finish their current step, then pause' },
    { k: 'orchestratorReservePct', t: 'Orchestrator reserve', d: 'Kept back so leads can wrap up and leave notes' },
    { k: 'weeklyWarnAtPct', t: 'Weekly warn at', d: 'Also shows pace against days left' },
  ]
  return (
    <>
      <Head title="Limits & budgets" sub="Plan limits come first; dollar caps are a second fence. Guards act on every base." />
      <section className={cx(card, 'grid grid-cols-2 gap-4.5')}>
        <div className="col-span-2 flex flex-wrap items-center gap-3">
          <b>Plan usage source</b>
          <span className={cx('text-xs font-semibold', u.source === 'connected' ? 'text-st-done' : 'text-st-error')}>{u.source === 'connected' ? '● Connected' : '✕ Unavailable'}</span>
          <span className="text-xs text-ink-dim">synced {ago(u.syncedAt)} ago</span>
        </div>
        <div><div className="flex justify-between text-xs text-ink-muted"><span>Session window</span><span>{Math.round(u.session.usedPct)}%</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line-soft"><div className="h-full bg-ink" style={{ width: `${u.session.usedPct}%` }} /></div></div>
        <div><div className="flex justify-between text-xs text-ink-muted"><span>Weekly</span><span className={wk.text}>{wk.prefix}{Math.round(u.weekly.usedPct)}%</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line-soft"><div className={cx('h-full', wk.bar)} style={{ width: `${u.weekly.usedPct}%` }} /></div></div>
      </section>
      <section className={cx(card, 'flex flex-col gap-4')}>
        <b>Guards</b>
        {sliders.map((s) => (
          <label key={s.k} className="grid grid-cols-[260px_minmax(0,1fr)_64px] items-center gap-4">
            <span><span className="block font-medium">{s.t}</span><span className="text-xs text-ink-dim">{s.d}</span></span>
            <input type="range" min={0} max={100} value={g[s.k] as number} onChange={(e) => set({ [s.k]: Number(e.target.value) })} aria-label={s.t} className="accent-[var(--color-you)]" />
            <span className="text-numeral text-right text-[17px]">{g[s.k] as number}%</span>
          </label>
        ))}
        <div className="flex flex-col gap-3 border-t border-line-soft pt-3">
          <Toggle on={g.paceForecast} onChange={(v) => set({ paceForecast: v })} t="Pace forecast" d="Heads-up when the current rate would hit 100% before the window resets." />
          <Toggle on={g.autoDownshiftAtPct != null} onChange={(v) => set({ autoDownshiftAtPct: v ? 85 : undefined })} t="Auto-downshift at 85%" d="Move workers to Haiku 5.5. Orchestrators and anything mid-merge keep their model." />
          <Toggle on={g.resumeAfterReset} onChange={(v) => set({ resumeAfterReset: v })} t="Resume paused agents after reset" d="Otherwise they wait for you." />
        </div>
      </section>
      <section className={card}>
        <b>Daily dollar caps</b>
        <div className="mt-3 grid grid-cols-[1.4fr_1fr_1fr_1.2fr] text-[13px]">
          {['Base', 'Today', 'Cap', 'At 100%'].map((h) => <span key={h} className="text-label py-1.5">{h}</span>)}
          {state.projects.map((p) => (
            <Row key={p.id} cells={[<b key="n" className="font-medium">{p.name}</b>, <span key="t" className={p.spendTodayUsd / p.dailyCapUsd >= 0.8 ? 'text-st-blocked' : ''}>{usd(p.spendTodayUsd)}{p.spendTodayUsd / p.dailyCapUsd >= 0.8 ? ` · ${Math.round((p.spendTodayUsd / p.dailyCapUsd) * 100)}%` : ''}</span>,
              <input key="c" defaultValue={usd(p.dailyCapUsd)} onBlur={(e) => dispatch({ type: 'cap', projectId: p.id, cap: Number(e.target.value.replace(/[^0-9.]/g, '')) || p.dailyCapUsd })} aria-label={`Cap for ${p.name}`} className={cx(inputCls, 'w-24 px-2 py-1')} />,
              <span key="a" className="text-ink-muted">Pause workers</span>]} />
          ))}
        </div>
      </section>
    </>
  )
}

function Row({ cells }: { cells: React.ReactNode[] }) {
  return <>{cells.map((c, i) => <span key={i} className="flex items-center border-t border-line-soft py-2">{c}</span>)}</>
}

function Toggle({ on, onChange, t, d }: { on: boolean; onChange: (v: boolean) => void; t: string; d: string }) {
  return <div className="flex items-start gap-3"><Switch on={on} onChange={onChange} label={t} accent="bg-you" /><span><b className="font-medium">{t}</b><span className="block text-xs text-ink-dim">{d}</span></span></div>
}

function AlertsSection() {
  const { state, dispatch } = useStore()
  const rows = [
    ['✕', 'text-st-error', 'Agent crash', true, true, true, 'Two low knocks'], ['✕', 'text-st-error', 'Docker or host down', true, true, true, 'Two low knocks'],
    ['!', 'text-st-you', 'Merge approval', true, false, true, 'Rising chime'], ['?', 'text-st-you', 'Agent question', true, false, true, 'Rising chime'],
    ['↻', 'text-st-blocked', 'Stuck in a loop', true, false, false, 'Soft tick'], ['◷', 'text-st-blocked', 'Limit or budget pace', false, false, false, 'Soft tick'],
    ['✓', 'text-st-done', 'Quest complete', false, false, true, 'Bright two-note'],
  ] as const
  return (
    <>
      <Head title="Alerts & sound" sub="How loudly each kind of event interrupts you." />
      <section className={cx(card, 'grid grid-cols-[1.6fr_.6fr_.6fr_.6fr_1.4fr] items-center text-[13px]')}>
        {['Event', 'Toast', 'Banner', 'Sound', 'Cue'].map((h) => <span key={h} className="text-label py-2">{h}</span>)}
        {rows.map(([g, c, t, toast, banner, sound, cue]) => (
          <Row key={t} cells={[<span key="t"><b className={cx('font-mono', c)}>{g}</b> {t}</span>,
            <input key="1" type="checkbox" defaultChecked={toast} aria-label={`Toast for ${t}`} className="accent-[var(--color-you)]" />,
            <input key="2" type="checkbox" defaultChecked={banner} aria-label={`Banner for ${t}`} className="accent-[var(--color-you)]" />,
            <input key="3" type="checkbox" defaultChecked={sound} aria-label={`Sound for ${t}`} className="accent-[var(--color-you)]" />,
            <span key="4" className="text-ink-muted">{cue}</span>]} />
        ))}
      </section>
      <section className={cx(card, 'flex flex-col gap-3')}>
        <Toggle on={!state.ui.muted} onChange={(v) => dispatch({ type: 'mute', muted: !v })} t="Sounds on" d="Global mute is ⇧M from anywhere." />
        <Toggle on onChange={() => {}} t="Quiet while I'm in Take control" d="Toasts still appear; sounds wait." />
        <Toggle on onChange={() => {}} t="Quiet hours 22:00–07:00" d="Critical still plays." />
      </section>
    </>
  )
}

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

function Providers() {
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

function Docker() {
  const { state, mode } = useStore()
  const f = [['Default image', 'colony/agent:node22', 'Per-base override in base settings'], ['Max containers', String(state.resources.containers.max), 'Fits your host RAM at 4 GB each'],
    ['Memory per agent', '4 GB', 'Restart with more from a crash alert'], ['CPU per agent', '2 cores', 'Soft limit (cpu-shares)'], ['Worktrees folder', '~/colony/worktrees', 'One git worktree per agent'], ['Supabase CLI', 'supabase', 'Used to provision dev backends']]
  return (
    <>
      <Head title="Docker & host" sub="Where agents run and how big each container can get." />
      <section className={cx(card, 'grid grid-cols-2 gap-4')}>
        <div className="col-span-2 flex items-center gap-3"><b>Docker daemon</b><span className={cx('text-xs font-semibold', state.resources.host.docker === 'running' ? 'text-st-done' : 'text-st-error')}>{state.resources.host.docker === 'running' ? '● Running' : '✕ Down'}</span><span className="font-mono text-xs text-ink-muted">unix:///var/run/docker.sock</span></div>
        {f.map(([l, v, h]) => <Field key={l} label={l} hint={h}><input defaultValue={v} readOnly={mode === 'live'} className={cx(inputCls, 'font-mono text-[13px]', mode === 'live' && 'text-ink-muted')} /></Field>)}
        {mode === 'live' && <p className="col-span-2 m-0 text-xs text-ink-dim">Read-only here; the control plane's config sets these.</p>}
      </section>
    </>
  )
}

function Teams() {
  const t = [['Solo HQ', 'ORC · Opus 5.5', '~1 container'], ['HQ + 2 workers', 'ORC · Opus 5.5\nFE  · Sonnet 5.5\nBE  · Sonnet 5.5', 'Default · 3 containers'],
    ['Full squad', 'ORC · Opus 5.5\nFE  · Sonnet 5.5\nBE  · Sonnet 5.5\nQA  · Haiku 5.5\nOPS · Sonnet 5.5', '5 containers'], ['Research spike', 'ORC · Opus 5.5\nRES · Haiku 5.5 ×2', 'Read-only tools'], ['Bug bash', 'ORC · Sonnet 5.5\nQA  · Haiku 5.5 ×3', 'Opens issues, no merges']]
  return (
    <>
      <Head title="Team templates" sub="Starting squads offered when you found a base." />
      <div className="grid grid-cols-3 gap-3">
        {t.map(([n, u, c]) => (
          <div key={n} className={cx('flex flex-col gap-2.5 rounded-xl border bg-surface p-4', c.startsWith('Default') ? 'border-you' : 'border-line')}>
            <b className="font-display text-[17px] font-semibold">{n}</b>
            <pre className="m-0 whitespace-pre-line font-mono text-xs text-ink-soft">{u}</pre>
            <span className="text-xs text-ink-dim">{c}</span>
            <div className="flex gap-1.5"><Button variant="ghost">Edit</Button><Button variant="ghost">Duplicate</Button></div>
          </div>
        ))}
        <button type="button" className="min-h-40 rounded-xl border border-dashed border-line-strong text-ink-muted">+ New template</button>
      </div>
    </>
  )
}

function Roles() {
  const { state } = useStore()
  const roles = Array.from(new Set(state.agents.map((a) => a.role)))
  const sample = state.agents.find((a) => a.role === 'backend')
  return (
    <>
      <Head title="Role library" sub="Reusable role prompts. Agents copy one when spawned; editing here never changes running agents." />
      <div className="flex flex-wrap gap-4">
        <div className="flex max-w-[280px] flex-[1_1_240px] flex-col gap-1">
          {roles.map((r) => <div key={r} className={cx('rounded-md border px-2.5 py-2 capitalize', r === 'backend' ? 'border-you bg-raised' : 'border-transparent')}>{r} <span className="text-xs text-ink-dim">· {state.agents.filter((a) => a.role === r).length} agents</span></div>)}
        </div>
        <div className={cx(card, 'flex min-w-0 flex-[3_1_420px] flex-col gap-3')}>
          <b className="font-display text-lg font-semibold">Backend</b>
          <Field label="Role prompt"><textarea rows={8} defaultValue={sample?.rolePrompt} className={cx(inputCls, 'font-mono text-xs leading-relaxed')} /></Field>
          <div className="text-xs text-ink-dim">Variables: {'{project} {stack} {goal} {orchestrator}'}</div>
        </div>
      </div>
    </>
  )
}

function Keys() {
  const k = [['Jump to base', '1 – 9'], ['World', '0'], ['Roster', 'R'], ['Inbox', 'G I'], ['Next alert', 'G A'], ['Spawn agent', 'S'], ['Found base', 'N'], ['Pause selected', 'Space'], ['Pause everything', '⇧ Space'], ['Take control', 'T'], ['Ambient wall mode', 'W'], ['Command palette', '⌘ K']]
  return (
    <>
      <Head title="Keyboard" sub="Click a key to rebind it (stored in config.toml)." />
      <section className={cx(card, 'grid grid-cols-2 gap-x-7')}>
        {k.map(([l, key]) => <div key={l} className="flex items-center justify-between border-b border-line-soft py-2"><span>{l}</span><button type="button"><KeyHint>{key}</KeyHint></button></div>)}
      </section>
    </>
  )
}
