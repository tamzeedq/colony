import { useState } from 'react'
import { useStore } from '@/store/store'
import { inputCls } from '@/components/ui/controls'
import { cx, usd, ago } from '@/lib/util'
import type { Guards } from '@/types/colony'
import { endpoints } from '@/api/endpoints'
import { meterTone } from '@/design/status'
import { errorMessage } from '@/api/client'
import { Head, Row, Toggle, card } from './shared'

/** Team check-ins (feedback #8): how often orchestrators get a digest of their busy workers, plus "Check now". */
function TeamCheckRow({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const { state, mode } = useStore()
  const [note, setNote] = useState<Record<string, string>>({})
  const options = [0, 2, 5, 10, 15]
  const checkNow = async (projectId: string) => {
    setNote((n) => ({ ...n, [projectId]: 'Checking…' }))
    try {
      const r = await endpoints.teamCheck(projectId)
      setNote((n) => ({ ...n, [projectId]: r.sent ? '✓ Sent to the orchestrator' : `Not sent: ${r.reason ?? 'nothing to check'}` }))
    } catch (e) { setNote((n) => ({ ...n, [projectId]: `✕ ${errorMessage(e)}` })) }
  }
  return (
    <div className="flex flex-col gap-3 border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-[260px]"><span className="block font-medium">Team check-ins</span><span className="text-xs text-ink-dim">While workers are busy, each orchestrator gets a short digest of its team and acts on anyone stuck or off task. Skipped when nothing changed.</span></span>
        <div role="radiogroup" aria-label="Team check-in interval" className="flex gap-1.5">
          {options.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => onChange(m)}
              className={cx('rounded-full border px-2.5 py-1.5 text-xs', minutes === m ? 'border-ink bg-ink text-ground' : 'border-line text-ink-soft')}>{m === 0 ? 'Off' : `${m} min`}</button>
          ))}
        </div>
      </div>
      {mode === 'live' && state.projects.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {state.projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 text-[13px]">
              <span className="w-40 truncate">{p.name}</span>
              <button type="button" disabled={!p.orchestratorId || note[p.id] === 'Checking…'} onClick={() => void checkNow(p.id)}
                className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:border-line-strong disabled:opacity-50">Check now</button>
              <span className="text-xs text-ink-dim">{!p.orchestratorId ? 'No orchestrator' : note[p.id] ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Limits() {
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
        <TeamCheckRow minutes={g.teamCheckMinutes ?? 5} onChange={(m) => set({ teamCheckMinutes: m })} />
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
