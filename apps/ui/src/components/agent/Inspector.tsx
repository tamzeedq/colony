import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Agent, ModelId } from '@/types/colony'
import { ROLES, modelInfo, modelList } from '@/design/status'
import { useStore, agentById } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { TerminalSession } from '@/api/terminal'
import { useDiff, DiffFileButton, CompactDiff } from '@/components/review/DiffView'
import { diffTotals } from '@/lib/diff'
import { useThrottledStream } from '@/hooks/useThrottledStream'
import { StatusBadge, RoleTile, Button } from '@/components/ui/primitives'
import { Tabs, Segmented, Bar, inputCls } from '@/components/ui/controls'
import { FeedRow } from '@/components/feed/ActivityFeed'
import { cx, usd } from '@/lib/util'

type Tab = 'feed' | 'term' | 'changes' | 'task' | 'config'

// xterm.js is only needed once the Terminal tab opens.
const XTerm = lazy(() => import('./XTerm').then((m) => ({ default: m.XTerm })))

export function Inspector({ docked }: { docked: boolean }) {
  const { state, dispatch, mode } = useStore()
  const agent = agentById(state, state.ui.inspectAgentId)
  const [tab, setTab] = useState<Tab>('feed')
  useEffect(() => { setTab('feed') }, [agent?.id])
  // Live: one shell session per inspected agent, shared by the Terminal tab and the composer.
  const [session, setSession] = useState<TerminalSession | null>(null)
  const agentId = agent?.id
  useEffect(() => {
    if (mode !== 'live' || !agentId) return
    const s = new TerminalSession(agentId)
    setSession(s)
    return () => { s.close(); setSession(null) }
  }, [mode, agentId])
  if (!agent) return null
  const you = agent.controller === 'you'
  const close = () => dispatch({ type: 'inspect', id: undefined })
  return (
    <>
      {!docked && <div aria-hidden="true" onClick={close} className="fixed inset-0 z-40 bg-[rgb(5_7_10/.62)]" />}
      <aside aria-label={`Inspector — ${agent.callsign}`}
        className={cx('fixed bottom-0 right-0 z-50 flex w-full max-w-[940px] flex-col border-l-2 bg-ground shadow-drawer',
          docked ? 'top-[57px] max-w-[820px]' : 'top-0', you ? 'border-you' : 'border-line-soft')}>
        <ControlStrip agent={agent} />
        <Header agent={agent} onClose={close} />
        <Stats agent={agent} />
        <Controls agent={agent} />
        <Tabs className="px-5" value={tab} onChange={setTab} tabs={[
          { id: 'feed', label: 'Live feed', kbd: 'F' }, { id: 'term', label: 'Terminal' }, { id: 'changes', label: 'Changes' },
          { id: 'task', label: 'Task' }, { id: 'config', label: 'Config' }]} />
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {tab === 'feed' && <LiveFeed agent={agent} />}
          {tab === 'term' && (mode === 'live'
            ? session && <Suspense fallback={<p className="text-sm text-ink-dim">Loading terminal…</p>}><XTerm agent={agent} session={session} interactive={you} /></Suspense>
            : <Terminal agent={agent} />)}
          {tab === 'changes' && (mode === 'live' ? <LiveChanges agent={agent} /> : <Changes />)}
          {tab === 'task' && <TaskPane agent={agent} />}
          {tab === 'config' && <ConfigPane agent={agent} />}
        </div>
        <Composer agent={agent} session={session} />
      </aside>
    </>
  )
}

function ControlStrip({ agent }: { agent: Agent }) {
  const { dispatch } = useStore()
  if (agent.controller === 'you') return (
    <div className="flex flex-wrap items-center gap-3 bg-you px-5 py-2.5 text-you-ink">
      <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.1em]"><span className="block h-2.5 w-2.5 rotate-45 bg-you-ink" />You have control</span>
      <span className="text-[13px]">{agent.callsign} is paused and listening. Nothing runs until you send or hand back.</span>
      <button type="button" onClick={() => dispatch({ type: 'handBack', id: agent.id })} className="ml-auto rounded-md bg-you-ink px-4 py-2 text-[13px] font-bold text-you">Hand back to {agent.callsign} · T</button>
    </div>
  )
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-[#11161C] px-5 py-2.5">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.1em] text-st-run"><span className="h-2 w-2 animate-breathe rounded-full bg-st-run" />Agent in control</span>
      <span className="text-[13px] text-ink-muted">{agent.callsign} is working on its own. Watch, nudge, or take over.</span>
      <Button variant="command" kbd="T" className="ml-auto" onClick={() => dispatch({ type: 'takeControl', id: agent.id })}>◆ Take control</Button>
    </div>
  )
}

function Header({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const project = state.projects.find((p) => p.id === agent.projectId)
  return (
    <div className="flex flex-wrap items-start gap-4 border-b border-line-soft px-5 py-4">
      <RoleTile role={agent.role} size={64} level={agent.level} />
      <div className="min-w-60 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 font-display text-[28px] font-semibold leading-none">{agent.callsign}</h1>
          <StatusBadge status={agent.status} />
        </div>
        <div className="mt-1.5 text-[13px] text-ink-muted">{ROLES[agent.role].name} · {project?.name}{agent.branch ? ` · ⎇ ${agent.branch}` : ''} · container {agent.container.name}</div>
      </div>
      <label className="flex flex-col gap-1 text-label">Model
        <select value={agent.model} onChange={(e) => dispatch({ type: 'setModel', id: agent.id, model: e.target.value as ModelId })}
          className="rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-xs normal-case tracking-normal text-ink">
          <ModelOptions current={agent.model} />
        </select>
      </label>
      <button type="button" onClick={onClose} aria-label="Close inspector" className="rounded-sm border border-line px-2.5 py-1 text-lg text-ink-muted">✕</button>
    </div>
  )
}

function ModelOptions({ current }: { current: ModelId }) {
  const list = modelList()
  return (
    <>
      {!list.some((m) => m.id === current) && <option value={current}>{modelInfo(current).name}</option>}
      {list.map((m) => <option key={m.id} value={m.id}>{m.name} {m.pips}{m.experimental ? ' · experimental' : ''}</option>)}
    </>
  )
}

function Stats({ agent }: { agent: Agent }) {
  const items = [
    { l: 'Context', v: `${agent.contextPct}%`, s: `${Math.round(agent.contextPct * 2)}k / 200k`, p: agent.contextPct, c: agent.contextPct > 85 ? 'bg-st-error' : 'bg-ink' },
    { l: 'Session share', v: `${Math.round(agent.sessionShare * 100)}%`, s: `${(agent.tokensToday / 1e6).toFixed(2)}M tokens`, p: agent.sessionShare * 100, c: 'bg-ink-muted' },
    { l: 'Spend', v: usd(agent.spendTodayUsd), s: `/ ${usd(agent.budgetCapUsd)} cap`, p: (agent.spendTodayUsd / agent.budgetCapUsd) * 100, c: 'bg-ink-muted' },
    { l: 'Uptime', v: `${Math.floor(agent.uptimeSec / 3600)}h ${Math.floor((agent.uptimeSec % 3600) / 60)}m`, s: '', p: 100, c: 'bg-line' },
    { l: 'Container', v: `${agent.container.cpuPct}%`, s: `CPU · ${(agent.container.memMb / 1024).toFixed(1)} / ${agent.container.memLimitMb / 1024} GB`, p: agent.container.cpuPct, c: 'bg-ink-muted' },
    { l: `Level ${agent.level}`, v: `${agent.questsDone}`, s: `quests · ${agent.xp}% to Lv ${agent.level + 1}`, p: agent.xp, c: 'bg-ink-soft' },
  ]
  return (
    <div className="grid grid-cols-3 gap-px border-b border-line-soft bg-line-soft md:grid-cols-6">
      {items.map((i) => (
        <div key={i.l} className="bg-ground px-3.5 py-2.5">
          <div className="text-label">{i.l}</div>
          <div className="text-numeral mt-0.5 text-[17px]">{i.v} <span className="font-sans text-[11px] font-normal text-ink-dim">{i.s}</span></div>
          <div className="mt-1"><Bar pct={i.p} className={i.c} h="h-[3px]" /></div>
        </div>
      ))}
    </div>
  )
}

function Controls({ agent }: { agent: Agent }) {
  const { dispatch } = useStore()
  const [confirmKill, setConfirmKill] = useState(false)
  const paused = agent.status === 'paused'
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-5 py-2.5">
      <Button kbd="Space" onClick={() => dispatch({ type: paused ? 'resume' : 'pause', ids: [agent.id] })}>{paused ? '▸ Resume' : '‖ Pause'}</Button>
      <Button onClick={() => dispatch({ type: 'restart', id: agent.id })}>↻ Restart</Button>
      {!confirmKill
        ? <Button variant="danger" onClick={() => setConfirmKill(true)}>✕ Kill</Button>
        : <span className="flex items-center gap-1.5 rounded-md border border-st-error/50 px-2 py-1 text-xs text-st-error">
            Kill {agent.callsign}? Branch is kept.
            <button type="button" onClick={() => dispatch({ type: 'kill', ids: [agent.id] })} className="rounded-xs bg-st-error px-2 py-0.5 font-semibold text-ground">Kill</button>
            <button type="button" onClick={() => setConfirmKill(false)} className="px-1 text-ink-soft">Cancel</button>
          </span>}
    </div>
  )
}

function LiveFeed({ agent }: { agent: Agent }) {
  const { subscribe, seedEvents, mode } = useStore()
  const { items, pending, hold, release, merge } = useThrottledStream(subscribe, { initial: seedEvents, filter: (e) => e.agentId === agent.id })
  const [backlog, setBacklog] = useState<string>(mode === 'live' ? 'loading' : 'ok')
  // Live: older events from the control plane, merged with what the stream delivers.
  useEffect(() => {
    if (mode !== 'live') return
    let live = true
    endpoints.agentEvents(agent.id, 200).then((evs) => { if (live) { merge(evs); setBacklog('ok') } }, (e) => { if (live) setBacklog(errorMessage(e)) })
    return () => { live = false }
  }, [mode, agent.id, merge])
  const demo = mode === 'mock' && agent.id === 'vex-07'
  return (
    <div className="flex flex-col gap-2.5" onMouseEnter={hold} onMouseLeave={release}>
      {demo && (
        <>
          <div className="flex gap-2.5">
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-sm bg-st-think/14 text-st-think">⋯</span>
            <p className="m-0 text-[13px] italic leading-relaxed text-[#C9C0FA]">The flaky test is timing-dependent: streak rollover uses the server's local midnight. I'll inject a clock instead of Date.now().</p>
          </div>
          <div className="ml-8 overflow-hidden rounded-md border border-line-soft bg-well font-mono text-xs leading-relaxed">
            <div className="flex justify-between border-b border-line-soft px-2.5 py-1.5"><span>src/lib/streaks.ts</span><span><span className="text-st-done">+18</span> <span className="text-st-error">−4</span></span></div>
            <div className="bg-st-error/10 px-2.5 text-diff-del">-   const today = startOfDay(Date.now())</div>
            <div className="bg-st-done/10 px-2.5 text-diff-add">+   const today = startOfDay(clock.now(), streak.tz)</div>
          </div>
        </>
      )}
      {items.slice().reverse().map((e) => <FeedRow key={e.id} e={e} who={agent.callsign} />)}
      {!items.length && !demo && <p className="text-sm text-ink-dim">{backlog === 'loading' ? 'Loading history…' : 'Waiting for activity…'}</p>}
      {backlog !== 'loading' && backlog !== 'ok' && <p className="text-xs text-st-error">✕ Couldn’t load older events · {backlog}</p>}
      {pending > 0 && <button type="button" onClick={release} className="sticky bottom-0 mx-auto rounded-full bg-st-run px-3.5 py-1.5 text-xs font-semibold text-ground">↓ {pending} new events · jump to live</button>}
    </div>
  )
}

function Terminal({ agent }: { agent: Agent }) {
  const you = agent.controller === 'you'
  const [lines, setLines] = useState<string[]>([
    `# shell inside ${agent.container.name} · /app`, '$ git log --oneline -3', 'a91f2c3 streaks: inject clock into rollover', '7be0d14 streaks: add API route + zod schema', '1c22e9a migration 0042: reading_streaks table',
  ])
  const [cmd, setCmd] = useState('')
  return (
    <div>
      <div className="min-h-[360px] rounded-lg border border-line-soft bg-[#05070A] p-4 font-mono text-[13px] leading-relaxed text-ink-soft">
        {lines.map((l, i) => <div key={i} className={l.startsWith('#') ? 'text-ink-dim' : l.startsWith('$') ? 'text-ink' : ''}>{l}</div>)}
        {you && (
          <form onSubmit={(e) => { e.preventDefault(); if (!cmd) return; setLines((x) => [...x, `$ ${cmd}`, `(mock) ran "${cmd}" in ${agent.container.name}`]); setCmd('') }} className="flex gap-2">
            <span className="text-st-done">{agent.id}@{agent.projectId.slice(2)}</span>$
            <input autoFocus value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Shell input" className="flex-1 bg-transparent font-mono text-ink outline-none" />
          </form>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-dim">{you ? `You are typing into the real shell. ${agent.callsign} sees this history when you hand back.` : 'Read-only while the agent is in control. Press T to take over and type here.'}</p>
    </div>
  )
}

function Changes() {
  const files = [['migrations/0042_reading_streaks.sql', 14, 0], ['src/lib/streaks.ts', 62, 9], ['src/lib/clock.ts', 21, 0], ['src/app/api/streaks/route.ts', 48, 4], ['src/lib/streaks.test.ts', 41, 9]] as const
  const [sel, setSel] = useState(0)
  return (
    <div className="flex flex-wrap gap-3.5">
      <div className="flex max-w-[260px] flex-[1_1_220px] flex-col gap-0.5">
        <div className="mb-1.5 text-xs text-ink-dim">vs main · {files.length} files · <span className="text-st-done">+186</span> <span className="text-st-error">−22</span></div>
        {files.map(([n, a, d], i) => (
          <button key={n} type="button" onClick={() => setSel(i)} className={cx('flex justify-between gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs', i === sel ? 'bg-raised' : 'hover:bg-surface')}>
            <span className="truncate">{n}</span><span className="shrink-0"><span className="text-st-done">+{a}</span> <span className="text-st-error">−{d}</span></span>
          </button>
        ))}
      </div>
      <pre className="m-0 min-w-0 flex-[3_1_380px] overflow-x-auto rounded-md border border-line-soft bg-well py-2.5 font-mono text-xs leading-[1.7]">
        <span className="block px-3 text-ink-dim">@@ {files[sel][0]}</span>
        {['create table reading_streaks (', '  user_id uuid references auth.users not null,', '  current int not null default 0,', '  longest int not null default 0,', '  last_read_on date,', "  tz text not null default 'UTC'", ');', 'alter table reading_streaks enable row level security;'].map((l) => (
          <span key={l} className="block bg-st-done/10 px-3 text-diff-add">+{l}</span>
        ))}
      </pre>
    </div>
  )
}

function LiveChanges({ agent }: { agent: Agent }) {
  const diff = useDiff(agent.projectId, agent.branch)
  const [sel, setSel] = useState(0)
  if (!agent.branch) return <p className="text-sm text-ink-dim">{agent.callsign} has no branch yet. Changes show here once its workspace is ready.</p>
  if (diff.status === 'loading' || diff.status === 'idle') return <p className="text-sm text-ink-dim">Loading diff of ⎇ {agent.branch} vs main…</p>
  if (diff.status === 'error') return (
    <p className="text-sm text-st-error">✕ Couldn’t load the diff · {diff.error} <button type="button" onClick={diff.reload} className="ml-2 rounded-sm border border-line px-2 py-0.5 text-xs text-ink">↻ Retry</button></p>
  )
  const files = diff.files
  const t = diffTotals(files)
  const cur = files[Math.min(sel, files.length - 1)]
  return (
    <div className="flex flex-wrap gap-3.5">
      <div className="flex max-w-[260px] flex-[1_1_220px] flex-col gap-0.5">
        <div className="mb-1.5 flex items-center gap-1 text-xs text-ink-dim">
          <span>vs main · {files.length} files · <span className="text-st-done">+{t.added}</span> <span className="text-st-error">−{t.removed}</span></span>
          <button type="button" onClick={diff.reload} aria-label="Reload diff" className="ml-auto px-1 text-ink-muted">↻</button>
        </div>
        {files.map((f, i) => <DiffFileButton key={f.path} file={f} selected={f === cur} onClick={() => setSel(i)} />)}
      </div>
      {cur
        ? <CompactDiff file={cur} />
        : <p className="m-0 flex-[3_1_380px] text-sm text-ink-dim">No changes on ⎇ {agent.branch} yet.</p>}
    </div>
  )
}

function TaskPane({ agent }: { agent: Agent }) {
  const { state } = useStore()
  const q = state.quests.find((x) => x.id === agent.currentTaskId)
  if (!q) return <p className="text-sm text-ink-dim">No quest assigned. The Orchestrator will hand one over, or create one from the base.</p>
  return (
    <div className="flex max-w-[640px] flex-col gap-3.5">
      <div><div className="text-[11px] uppercase tracking-[.12em] text-st-run">Quest · {q.status.replace('_', ' ')}</div><h2 className="mt-1 font-display text-[22px] font-semibold">{q.title}</h2></div>
      {q.why && <div className="rounded-lg border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed"><b className="text-[#C9C0FA]">Why:</b> {q.why}</div>}
      {q.acceptance.length > 0 && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          {q.acceptance.map((c) => <span key={c.text}><span className={c.done ? 'text-st-done' : 'text-ink-dim'}>{c.done ? '✓' : '○'}</span> {c.text}</span>)}
        </div>
      )}
      <Link to={`/quest/${q.id}`} className="text-[13px]">Open quest detail →</Link>
    </div>
  )
}

function ConfigPane({ agent }: { agent: Agent }) {
  const { dispatch, mode } = useStore()
  const [prompt, setPrompt] = useState(agent.rolePrompt)
  const [budget, setBudget] = useState(usd(agent.budgetCapUsd))
  const [model, setModel] = useState<ModelId>(agent.model)
  const [saved, setSaved] = useState<'' | 'saving' | 'ok' | 'error'>('')
  const save = async () => {
    if (mode !== 'live') { setSaved('ok'); return }
    setSaved('saving')
    const cap = Number(budget.replace(/[^0-9.]/g, ''))
    const oks = await Promise.all([
      dispatch({ type: 'configAgent', id: agent.id, rolePrompt: prompt.trim() ? prompt : undefined, budgetCapUsd: budget.trim() && Number.isFinite(cap) ? cap : undefined }),
      model !== agent.model ? dispatch({ type: 'setModel', id: agent.id, model }) : Promise.resolve(true),
    ])
    setSaved(oks.every(Boolean) ? 'ok' : 'error')
  }
  return (
    <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className="col-span-2 flex flex-col gap-1.5 text-xs text-ink-muted">Role prompt (system instructions)
        <textarea rows={6} value={prompt} onChange={(e) => { setPrompt(e.target.value); setSaved('') }} className={cx(inputCls, 'font-mono text-xs leading-relaxed')} />
      </label>
      <label className="flex flex-col gap-1.5 text-xs text-ink-muted">Budget cap per day<input value={budget} onChange={(e) => { setBudget(e.target.value); setSaved('') }} className={inputCls} /></label>
      {mode === 'live'
        ? <label className="flex flex-col gap-1.5 text-xs text-ink-muted">Model
            <select value={model} onChange={(e) => { setModel(e.target.value); setSaved('') }} className={cx(inputCls, 'font-mono text-xs')}><ModelOptions current={agent.model} /></select>
          </label>
        : <label className="flex flex-col gap-1.5 text-xs text-ink-muted">Auto-compact context at<input defaultValue="85%" className={inputCls} /></label>}
      <fieldset className="col-span-2 m-0 rounded-md border border-line px-3 py-2.5">
        <legend className="px-1 text-xs text-ink-muted">Allowed tools</legend>
        <div className="flex flex-wrap gap-3.5 text-[13px]">
          {['read', 'edit', 'bash', 'supabase', 'webfetch', 'push-main'].map((t) => (
            <label key={t}><input type="checkbox" defaultChecked={agent.allowedTools.includes(t)} className="accent-[var(--color-you)]" /> {t}</label>
          ))}
        </div>
      </fieldset>
      <div className="col-span-2 flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={saved === 'saving'}>{saved === 'saving' ? 'Saving…' : 'Save config'}</Button>
        {saved === 'ok' && <span className="text-xs text-st-done">✓ Saved · applies on next step</span>}
        {saved === 'error' && <span className="text-xs text-st-error">✕ Not saved</span>}
      </div>
    </form>
  )
}

function Composer({ agent, session }: { agent: Agent; session: TerminalSession | null }) {
  const { dispatch, mode: dataMode } = useStore()
  const you = agent.controller === 'you'
  const [mode, setMode] = useState<'chat' | 'shell'>('chat')
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const submit = () => {
    if (!text) return
    setSent(you && mode === 'shell' ? `$ ${text}` : text)
    setText('')
    if (dataMode !== 'live') return
    if (you && mode === 'shell') session?.send(text + '\r')
    else void dispatch({ type: 'message', id: agent.id, text })
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit() }}
      className={cx('border-t border-line-soft px-5 pb-4 pt-3', you ? 'bg-you/6' : 'bg-well')}>
      {you && <div className="mb-2"><Segmented label="Input mode" value={mode} onChange={setMode} options={[{ id: 'chat', label: `Chat with ${agent.callsign}` }, { id: 'shell', label: 'Type into its shell' }]} /></div>}
      {sent && <div className="mb-2 text-xs text-ink-muted">{you ? 'You →' : 'Nudged:'} <span className="text-ink">{sent}</span></div>}
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label={you ? `Message ${agent.callsign}` : `Nudge ${agent.callsign}`}
          placeholder={you ? `Tell ${agent.callsign} exactly what to do next… (it stays paused until you hand back)` : `Nudge ${agent.callsign} — it reads this between steps and keeps working`}
          className={cx(inputCls, 'flex-1', you && 'border-you')} />
        <Button variant={you ? 'command' : 'secondary'} type="submit">{you ? 'Send ↵' : 'Nudge ↵'}</Button>
      </div>
    </form>
  )
}
