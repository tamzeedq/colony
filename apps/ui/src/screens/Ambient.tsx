import { Link } from 'react-router-dom'
import { STATUS, meterTone } from '@/design/status'
import { useStore, needsYou } from '@/store/store'
import { useHotkeys } from '@/hooks/useHotkeys'
import { minutesToSessionLimit } from '@/types/colony'
import { cx, untilLabel, usd } from '@/lib/util'
import { Logo } from '@/components/hud/AppShell'

/** Glance-only wall view (W). Readable from across the room; no hover-only info. */
export function Ambient() {
  useHotkeys()
  const { state } = useStore()
  const n = needsYou(state)
  const u = state.resources.usage
  const mins = minutesToSessionLimit(u)
  const rings = [
    { l: 'Session', v: u.session.usedPct, sub: `resets in ${untilLabel(u.session.resetsAt)}`, state: mins != null ? `Runs out in ~${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m` : 'Steady', warn: state.guards.warnAtPct },
    { l: 'Weekly', v: u.weekly.usedPct, sub: `resets in ${untilLabel(u.weekly.resetsAt)}`, state: u.weekly.usedPct >= state.guards.weeklyWarnAtPct ? '▲ Watch the pace' : 'On pace', warn: state.guards.weeklyWarnAtPct },
    { l: 'Spend today', v: (state.resources.spendTodayUsd / state.resources.dailyCapUsd) * 100, sub: `${usd(state.resources.spendTodayUsd)} of ${usd(state.resources.dailyCapUsd)}`, state: 'Normal', warn: 80 },
  ]
  const done = state.quests.filter((q) => q.status === 'done').slice(-3)
  return (
    <div className="flex min-h-screen flex-col gap-9 bg-[#07090C] px-14 py-12 text-ink">
      <div className="flex items-center gap-5">
        <Logo />
        <span className="text-xl text-ink-dim">Ambient · {state.agents.filter((a) => ['running', 'editing', 'thinking'].includes(a.status)).length} of {state.agents.length} agents at work</span>
        <span className="ml-auto font-display text-[44px] font-semibold">{new Date().toTimeString().slice(0, 5)}</span>
      </div>
      <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-7">
        <Link to="/inbox" className={cx('flex flex-col justify-between rounded-3xl border-[3px] px-10 py-8 no-underline', n.length ? 'border-st-you bg-st-you/10 text-st-you' : 'border-line text-ink-dim')}>
          <div className="flex items-center gap-5">
            <span aria-hidden="true" className={cx('block h-14 w-14 rotate-45', n.length ? 'animate-attention bg-st-you' : 'border-2 border-line')} />
            <span className="font-display text-[140px] font-bold leading-none">{n.length}</span>
            <span className="font-display text-[40px] font-semibold leading-[1.05]">NEED<br />YOU</span>
          </div>
          <div className="text-2xl leading-snug text-[#F3E2C0]">{n.slice(0, 2).map((a) => <div key={a.id} className="truncate">{a.kind === 'crash' ? '✕' : '!'} {state.agents.find((x) => x.id === a.agentId)?.callsign ?? ''} {a.kind}</div>)}</div>
        </Link>
        {rings.map((r) => {
          const t = meterTone(r.v, r.warn)
          return (
            <div key={r.l} className="flex items-center gap-7 rounded-3xl border-2 border-line-soft bg-ground p-7">
              <div className="relative h-[170px] w-[170px] shrink-0 rounded-full" style={{ background: `conic-gradient(var(--color-${r.v >= r.warn ? 'st-blocked' : 'ink'}) 0 ${r.v}%, var(--color-line-soft) ${r.v}% 100%)` }}>
                <div className="absolute inset-[18px] grid place-items-center rounded-full bg-ground"><span className={cx('font-display text-5xl font-bold', t.text)}>{Math.round(r.v)}%</span></div>
              </div>
              <div><div className="text-xl uppercase tracking-[.14em] text-ink-muted">{r.l}</div><div className="mt-2.5 text-2xl leading-snug">{r.sub}</div><div className={cx('mt-2.5 text-xl font-semibold', t.text)}>{r.state}</div></div>
            </div>
          )
        })}
      </div>
      <div className="grid flex-1 grid-cols-4 gap-7">
        {state.projects.map((p) => {
          const ag = state.agents.filter((a) => a.projectId === p.id)
          const alert = state.alerts.find((a) => a.projectId === p.id && !a.resolvedAt && a.severity !== 'heads_up')
          const line = alert ? alert.title : ag.find((a) => a.status === 'running')?.currentAction ?? 'Quiet'
          return (
            <div key={p.id} className={cx('flex flex-col gap-5 rounded-3xl border-2 bg-ground p-7', alert ? (alert.severity === 'critical' ? 'border-st-error/60' : 'border-st-you/50') : 'border-line-soft', p.health.label === 'dormant' && 'opacity-60')}>
              <div className="flex items-baseline justify-between"><span className="font-display text-[44px] font-semibold">{p.name}</span><span className={cx('text-2xl font-semibold', p.health.label === 'stable' ? 'text-st-done' : p.health.label === 'dormant' ? 'text-st-paused' : 'text-st-error')}>{p.health.label === 'stable' ? '✓' : p.health.label === 'dormant' ? '‖' : '▲'}</span></div>
              <div className="flex flex-wrap gap-3">
                {ag.map((a) => <span key={a.id} title={a.callsign} className={cx('grid h-16 w-16 place-items-center rounded-2xl border-4 bg-raised font-mono text-3xl', STATUS[a.status].ring, STATUS[a.status].text, a.status === 'waiting' && 'animate-attention')}>{STATUS[a.status].glyph}</span>)}
              </div>
              <div className="mt-auto line-clamp-2 text-2xl leading-snug text-ink-soft">{line}</div>
              <div className="flex gap-6 text-xl text-ink-dim"><span>{Math.round(ag.reduce((x, a) => x + a.sessionShare, 0) * 100)}% of session</span><span>{usd(p.spendTodayUsd)}</span></div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-5 border-t-2 border-line-soft pt-5 text-[22px] text-ink-muted">
        <span className="h-3 w-3 animate-breathe rounded-full bg-st-done" />
        {done.map((q) => <span key={q.id}><b className="text-st-done">✓</b> {q.title}</span>)}
        <span className="ml-auto text-lg text-ink-dim">Press W to leave · readable at 4 m</span>
      </div>
    </div>
  )
}
