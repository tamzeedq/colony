import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { Agent, ModelId, RoleId } from '@/types/colony'
import { modelInfo, modelList, ROLES } from '@/design/status'
import { useStore } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { EmptyWorld } from '@/components/states/EmptyStates'
import { Segments, Switch, Field, inputCls } from '@/components/ui/controls'
import { KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const DESC: Record<RoleId, string> = {
  orchestrator: 'Plans the base, writes quests, hands off work, reviews merges.',
  frontend: 'UI, components, styling, accessibility. Owns client bundles.',
  backend: 'APIs, SQL migrations, RLS, jobs. Writes tests first.',
  qa: 'Runs suites, writes E2E specs, gates PRs before merge.',
  devops: 'Containers, CI, preview deploys, env and secrets wiring.',
  researcher: 'Reads docs and code, compares options, writes short briefs.',
  custom: 'Start from a blank role prompt and your own tool list.',
}
const NOTE: Record<string, string> = {
  'opus-5.5': 'Deep reasoning for planning and gnarly bugs', 'sonnet-5.5': 'Balanced default for most workers',
  'haiku-5.5': 'Fast and cheap: QA runs, lookups, triage', 'fable-5.1': 'Top tier for the hardest work, highest usage',
}
const NAMES = ['Fen', 'Ivo', 'Nox', 'Pax', 'Rue', 'Sol', 'Tav', 'Wyn', 'Zed', 'Cal']
const callsign = () => `${NAMES[Math.floor(Math.random() * NAMES.length)]}-${String(Math.floor(10 + Math.random() * 89))}`

export function Spawn() {
  const { state, dispatch, mode } = useStore()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const project = state.projects.find((p) => p.key === Number(params.get('project') ?? 1)) ?? state.projects[0]
  const [role, setRole] = useState<RoleId>('frontend')
  const [model, setModel] = useState<ModelId>('sonnet-5.5')
  const [orch, setOrch] = useState(false)
  const [name, setName] = useState(callsign())
  const [cap, setCap] = useState(8)
  const [task, setTask] = useState('')
  const [tools, setTools] = useState<string[]>(['read', 'edit', 'bash', 'supabase'])
  const [customPrompt, setCustomPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!project) return mode === 'live' ? <EmptyWorld /> : null
  const orchName = state.agents.find((a) => a.id === project.orchestratorId)?.callsign ?? 'the Orchestrator'

  // Live: POST and go to the base; the new unit arrives over the stream (booting → idle).
  const spawnLive = async () => {
    setBusy(true); setError('')
    try {
      if (orch) {
        // The orchestrator chooses class and model and spawns with spawn_agent; the new unit
        // arrives over the stream once it does.
        await endpoints.requestWorker(project.id, { callsign: name.trim() || undefined, budgetCapUsd: cap > 0 ? cap : undefined, task: task.trim() || undefined })
        nav(`/base/${project.key}`)
        return
      }
      const agent = await endpoints.spawn(project.id, {
        role, model, callsign: name.trim() || undefined,
        task: task.trim() || undefined, budgetCapUsd: cap > 0 ? cap : undefined,
        rolePrompt: role === 'custom' && customPrompt.trim() ? customPrompt.trim() : undefined,
      })
      if (agent?.id) dispatch({ type: 'upsertAgent', agent })
      nav(`/base/${project.key}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const spawn = () => {
    if (mode === 'live') { void spawnLive(); return }
    const id = name.toLowerCase()
    const agent: Agent = {
      id, projectId: project.id, callsign: name, role: orch ? 'frontend' : role, model: orch ? 'sonnet-5.5' : model, status: 'booting', controller: 'agent',
      currentAction: 'Booting container…', branch: `agent/${id}/main`,
      provider: 'claude-subscription',
      container: { name: `${project.id.slice(2)}-${id}`, cpuPct: 5, memMb: 300, memLimitMb: 4096, health: 'ok' },
      contextPct: 0, tokensToday: 0, spendTodayUsd: 0, budgetCapUsd: cap, sessionShare: 0, uptimeSec: 0, level: 1, xp: 0, questsDone: 0,
      rolePrompt: role === 'custom' && customPrompt.trim() ? customPrompt.trim() : DESC[role], allowedTools: tools,
    }
    dispatch({ type: 'spawn', agent })
    nav(`/base/${project.key}`)
  }

  return (
    <div className="flex min-h-[calc(100vh-57px)] flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-line-soft bg-hud px-7 py-4">
        <Link to="/roster" className="text-[13px] text-ink-muted no-underline">← Roster</Link>
        <div>
          <div className="text-label">Recruit a unit into</div>
          <div className="font-display text-[22px] font-semibold">{project.name} <span className="font-sans text-[13px] font-normal text-ink-dim">· {project.agentIds.length} agents · host has room for {state.resources.containers.max - state.resources.containers.running} more containers</span></div>
        </div>
        <div className="flex-1" />
        <div className={cx('flex items-center gap-3 rounded-lg border px-3.5 py-2.5', orch ? 'border-st-think bg-st-think/12' : 'border-line bg-surface')}>
          <Switch on={orch} onChange={setOrch} label={`Let ${orchName} decide`} accent="bg-st-think" />
          <span><b className="block text-[13px]">Let {orchName} decide</b><span className="text-xs text-ink-muted">Orchestrator picks class, model and first quest</span></span>
        </div>
      </header>

      <div className="flex flex-1 flex-wrap">
        <section aria-label="Class" className={cx('min-w-0 flex-[1_1_400px] border-r border-line-soft px-6 py-5.5', orch && 'pointer-events-none opacity-40')}>
          <h2 className="text-section mb-1">1 · Class</h2>
          <p className="mb-3.5 mt-0 text-xs text-ink-dim">Role template = starting prompt, tools and quest types.</p>
          <div className="grid grid-cols-2 gap-2.5">
            {(Object.keys(ROLES) as RoleId[]).map((r) => (
              <button key={r} type="button" aria-pressed={role === r} onClick={() => setRole(r)}
                className={cx('flex flex-col gap-1.5 rounded-lg border p-3 text-left', role === r ? 'border-you bg-you/8 ring-1 ring-you' : 'border-line bg-surface')}>
                <span className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-md border border-line-strong bg-raised font-display text-[11px] font-bold text-ink-soft" style={{ backgroundImage: ROLES[r].texture }}>{ROLES[r].code}</span><b className="font-display text-[15px] font-semibold">{ROLES[r].name}</b></span>
                <span className="text-xs leading-normal text-ink-muted">{DESC[r]}</span>
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Preview" className="flex min-w-0 flex-[1_1_320px] flex-col items-center gap-3.5 border-r border-line-soft bg-well bg-[radial-gradient(#1A212A_1px,transparent_1px)] bg-[length:20px_20px] px-6 py-5.5">
          <div className="text-label self-start">Recruit preview</div>
          <div className="relative mt-2.5 grid h-[168px] w-[168px] place-items-center rounded-[28px] border-2 border-line-strong bg-raised" style={{ backgroundImage: orch ? undefined : ROLES[role].texture }}>
            <span className="font-display text-5xl font-bold text-ink-soft">{orch ? '?' : ROLES[role].code}</span>
            <span className="absolute -bottom-3 rounded-full border border-line-strong bg-ground px-3 py-0.5 font-display text-xs font-semibold">Lv 1</span>
          </div>
          <div className="mt-3.5 flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Callsign" className="w-[150px] border-b border-dashed border-line-strong bg-transparent p-1 text-center font-display text-[26px] font-semibold outline-none" />
            <button type="button" aria-label="Reroll callsign" onClick={() => setName(callsign())} className="h-9 w-9 rounded-md border border-line bg-surface text-ink-muted">↻</button>
          </div>
          <div className="text-[13px] text-ink-muted">{orch ? `Class and model chosen by ${orchName}` : `${ROLES[role].name} · ${modelInfo(model).name}`} · {project.name}</div>
          <div className="w-full max-w-[300px] rounded-lg border border-line bg-surface p-3 text-xs leading-[1.8] text-ink-muted">
            <div className="flex justify-between"><span>Container</span><b className="font-medium text-ink">{project.id.slice(2)}-{name.toLowerCase()} · 4 GB</b></div>
            <div className="flex justify-between"><span>Branch</span><b className="font-mono text-[11px] font-medium text-ink">agent/{name.toLowerCase()}/*</b></div>
            <div className="flex justify-between"><span>Reports to</span><b className="font-medium text-ink">{orchName}</b></div>
            <div className="flex justify-between"><span>Daily cap</span><b className="font-medium text-ink">${cap.toFixed(2)}</b></div>
          </div>
        </section>

        <section aria-label="Model and loadout" className="flex min-w-0 flex-[1_1_440px] flex-col gap-4.5 px-6 py-5.5">
          <div className={cx(orch && 'pointer-events-none opacity-40')}>
            <h2 className="text-section mb-3">2 · Model</h2>
            <div className="grid grid-cols-2 gap-2.5">
              {modelList().map((mi) => { const m = mi.id; return (
                <button key={m} type="button" aria-pressed={model === m} onClick={() => setModel(m)}
                  className={cx('rounded-lg border p-3 text-left', model === m ? 'border-you bg-you/8 ring-1 ring-you' : 'border-line bg-surface')}>
                  <span className="flex items-center justify-between"><b className="font-display text-[15px] font-semibold">{mi.name}</b><span className="font-mono text-[11px] text-ink-muted">{mi.pips}</span></span>
                  <span className="mb-2.5 mt-1 block text-[11px] text-ink-dim">{NOTE[m] ?? (mi.experimental ? 'Experimental · non-Claude model via the gateway' : mi.provider)}</span>
                  {([['Power', mi.power, 'bg-ink'], ['Speed', mi.speed, 'bg-ink-muted'], ['Usage eff.', mi.costEff, 'bg-ink-muted']] as const).map(([l, v, c]) => (
                    <span key={l} className="mt-1.5 flex items-center gap-2"><span className="w-16 text-[11px] text-ink-muted">{l}</span><Segments value={v} of={5} className={c} /></span>
                  ))}
                </button>
              ) })}
            </div>
          </div>
          <div>
            <h2 className="text-section mb-3">3 · Loadout</h2>
            <div className="mb-3 flex flex-wrap items-end gap-3.5">
              <Field label="Daily budget cap"><input value={`$${cap.toFixed(2)}`} onChange={(e) => setCap(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} className={cx(inputCls, 'w-28')} /></Field>
              <div className="flex gap-1.5">{[3, 8, 15].map((v) => <button key={v} type="button" onClick={() => setCap(v)} className={cx('rounded-full border px-2.5 py-1.5 text-xs', cap === v ? 'border-ink bg-ink text-ground' : 'border-line text-ink-soft')}>${v}</button>)}</div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-ink-soft">
              {[['read', 'Read / Edit'], ['bash', 'Bash in container'], ['supabase', 'Supabase CLI'], ['webfetch', 'Web fetch'], ['pr', 'Open PRs'], ['merge', 'Merge without approval']].map(([id, l]) => (
                <label key={id}><input type="checkbox" checked={tools.includes(id)} onChange={() => setTools((t) => t.includes(id) ? t.filter((x) => x !== id) : [...t, id])} className="accent-[var(--color-you)]" /> {l}</label>
              ))}
            </div>
          </div>
          {!orch && role === 'custom' && (
            <Field label="Role prompt (custom class)">
              <textarea rows={3} value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} placeholder="You are … for {project}. Own … Never push to main." className={cx(inputCls, 'font-mono text-xs leading-relaxed')} />
            </Field>
          )}
          <Field label="4 · Starting quest (optional)">
            <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder={`Leave empty and ${orchName} assigns one from the backlog`} className={inputCls} />
          </Field>
          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            {error
              ? <span role="alert" className="mr-auto text-xs text-st-error">✕ {error}</span>
              : <span className="mr-auto text-xs text-ink-dim">{orch && mode === 'live' ? `${orchName} picks the class and model, then spawns it` : 'Boots in ~20 s · 1 container · 4 GB'}</span>}
            <Link to="/roster" className="px-3.5 py-2.5 text-[13px] text-ink-muted no-underline">Cancel · Esc</Link>
            <button type="button" onClick={spawn} disabled={busy} className="inline-flex items-center gap-2.5 rounded-lg bg-you px-5 py-3 text-[15px] font-bold text-you-ink disabled:opacity-60">
              {busy ? (orch ? `Asking ${orchName}…` : `Spawning ${name}…`) : orch ? <>Ask {orchName} to recruit {name}</> : <>Spawn {name}</>} <KeyHint>↵</KeyHint>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
