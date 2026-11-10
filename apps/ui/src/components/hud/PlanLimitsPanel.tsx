import { useStore } from '@/store/store'
import { minutesToSessionLimit } from '@/types/colony'
import { meterTone } from '@/design/status'
import { cx, untilLabel } from '@/lib/util'

export function PlanLimitsPanel() {
  const { state, dispatch } = useStore()
  const u = state.resources.usage
  if (u.source === 'unavailable') return null
  const mins = minutesToSessionLimit(u)
  const resetMins = (Date.parse(u.session.resetsAt) - Date.now()) / 60000
  const short = mins != null && mins < resetMins
  const fmt = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
  const shares = state.projects.map((p) => ({ name: p.name, share: state.agents.filter((a) => a.projectId === p.id).reduce((n, a) => n + a.sessionShare, 0) * 100 }))
    .filter((p) => p.share > 0)
  const colors = ['bg-st-run', 'bg-st-think', 'bg-st-paused', 'bg-st-done']
  const wk = meterTone(u.weekly.usedPct, state.guards.weeklyWarnAtPct)
  return (
    <section aria-label="Plan limits">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-section">Plan limits</h2>
        <span className="text-[11px] text-ink-dim">your plan · all bases</span>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-ink-muted">Session window</span>
            <span><b className="text-numeral text-lg">{Math.round(u.session.usedPct)}%</b> <span className="text-[11px] text-ink-dim">resets in {untilLabel(u.session.resetsAt)}</span></span>
          </div>
          <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-line-soft">
            <div className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${u.session.usedPct}%` }} />
          </div>
          <div className="mt-1.5 flex gap-[3px]">
            {shares.map((p, i) => <span key={p.name} className={cx('h-1 rounded-full', colors[i % 4])} style={{ flex: p.share }} />)}
            <span style={{ flex: Math.max(0, 100 - shares.reduce((n, p) => n + p.share, 0)) }} />
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-muted">
            {shares.map((p, i) => <span key={p.name}><span className={cx('mr-1 inline-block h-2 w-2 rounded-[2px]', colors[i % 4])} />{p.name} {Math.round(p.share)}%</span>)}
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-ink-muted">Weekly</span>
            <span><b className={cx('text-numeral text-lg', wk.text)}>{wk.prefix}{Math.round(u.weekly.usedPct)}%</b> <span className="text-[11px] text-ink-dim">resets in {untilLabel(u.weekly.resetsAt)}</span></span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line-soft"><div className={cx('h-full', wk.bar)} style={{ width: `${u.weekly.usedPct}%` }} /></div>
        </div>
        {mins != null && state.guards.paceForecast && (
          <div className={cx('rounded-md border px-2.5 py-2 text-xs leading-normal', short ? 'border-st-blocked/40 bg-st-blocked/10' : 'border-line bg-ground')}>
            At the current pace (~{Math.round(u.session.ratePctPerHour)}%/h) the session {short ? <>runs out in <b>~{fmt(mins)}</b>, {Math.round(resetMins - mins)} min before it resets.</> : <>lasts until the reset.</>}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => dispatch({ type: 'downshift' })} className="rounded-sm bg-ink px-2.5 py-1.5 text-xs font-semibold text-ground">Downshift workers to Haiku</button>
          <button type="button" onClick={() => dispatch({ type: 'pause', ids: state.agents.filter((a) => a.role === 'researcher' || a.role === 'qa').map((a) => a.id) })}
            className="rounded-sm border border-line px-2.5 py-1.5 text-xs text-ink-soft">Pause non-critical</button>
        </div>
        <p className="m-0 text-[11px] text-ink-dim">Guard: workers auto-pause at {state.guards.pauseWorkersAtPct}%; Orchestrators keep the last {state.guards.orchestratorReservePct}% to wrap up.</p>
      </div>
    </section>
  )
}
