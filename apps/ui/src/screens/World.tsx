import { Link } from 'react-router-dom'
import type { Project } from '@/types/colony'
import { STATUS } from '@/design/status'
import { useStore, needsYou, projectAgents } from '@/store/store'
import { PlanLimitsPanel } from '@/components/hud/PlanLimitsPanel'
import { ActivityFeed } from '@/components/feed/ActivityFeed'
import { AlertItem } from '@/components/alerts/AlertItem'
import { KeyHint } from '@/components/ui/primitives'
import { Segments } from '@/components/ui/controls'
import { EmptyWorld } from '@/components/states/EmptyStates'
import { cx, usd } from '@/lib/util'

const HEALTH = {
  stable: { g: '✓', label: 'Stable', text: 'text-st-done', seg: 'bg-st-done' },
  strained: { g: '▲', label: 'Strained', text: 'text-st-error', seg: 'bg-st-error' },
  dormant: { g: '‖', label: 'Dormant', text: 'text-st-paused', seg: 'bg-st-paused' },
  down: { g: '✕', label: 'Down', text: 'text-st-error', seg: 'bg-st-error' },
}

export function BaseTile({ project }: { project: Project }) {
  const { state } = useStore()
  const agents = projectAgents(state, project)
  const hq = agents.find((a) => a.id === project.orchestratorId)
  const workers = agents.filter((a) => a !== hq)
  const alerts = state.alerts.filter((a) => a.projectId === project.id && !a.resolvedAt && a.severity !== 'heads_up').length
  const active = agents.filter((a) => ['running', 'editing', 'thinking', 'waiting'].includes(a.status)).length
  const share = agents.reduce((n, a) => n + a.sessionShare, 0)
  const latest = agents.find((a) => a.status === 'running') ?? agents.find((a) => a.status === 'error') ?? hq
  const h = HEALTH[project.health.label]
  return (
    <Link to={`/base/${project.key}`} className={cx('flex flex-col overflow-hidden rounded-xl border bg-surface text-ink no-underline hover:border-line-strong',
      alerts ? 'border-st-you/35' : 'border-line', project.health.label === 'dormant' && 'opacity-75')}>
      <div className="flex items-start justify-between gap-3 px-4 pb-1.5 pt-3.5">
        <div className="flex items-center gap-3">
          <KeyHint>{project.key}</KeyHint>
          <div><div className="font-display text-xl font-semibold leading-tight">{project.name}</div><div className="mt-0.5 text-xs text-ink-dim">{project.stack.join(' · ')}</div></div>
        </div>
        {alerts > 0 && <span className="inline-flex items-center gap-1.5 rounded-full border border-st-you/45 bg-st-you/12 px-2.5 py-1 text-xs font-semibold text-st-you"><span className="block h-2 w-2 rotate-45 bg-st-you" />{alerts} need you</span>}
      </div>
      <div className="relative mx-auto h-[150px] w-[320px]" aria-hidden="true">
        {workers.map((a, i) => {
          const ang = (-90 + (360 * (i + 0.5)) / Math.max(1, workers.length)) * Math.PI / 180
          const x = 160 + 124 * Math.cos(ang), y = 75 + 56 * Math.sin(ang)
          const s = STATUS[a.status]
          const live = ['running', 'editing', 'thinking'].includes(a.status)
          return (
            <span key={a.id}>
              <span className={cx('absolute h-0.5 origin-left', live ? cx('link-live', s.text) : 'bg-line')} style={{ left: 160, top: 75, width: Math.hypot(x - 160, y - 75), transform: `rotate(${Math.atan2(y - 75, x - 160)}rad)` }} />
              <span className={cx('absolute grid h-[30px] w-[30px] place-items-center rounded-[7px] border-2 bg-raised font-display text-[9px] font-bold', s.ring, a.status === 'waiting' && 'animate-attention')} style={{ left: x - 15, top: y - 15 }}>
                {a.role === 'researcher' ? 'RES' : a.role === 'devops' ? 'OPS' : a.role === 'custom' ? 'CUS' : a.role === 'frontend' ? 'FE' : a.role === 'backend' ? 'BE' : 'QA'}
                <span className="absolute -right-[7px] -top-[7px] grid h-3.5 min-w-3.5 place-items-center rounded-full font-mono text-[9px] text-ground" style={{ background: `var(--color-${s.token})` }}>{s.glyph}</span>
              </span>
            </span>
          )
        })}
        <span className="absolute grid h-[52px] w-[52px] place-items-center font-display text-[11px] font-bold [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]"
          style={{ left: 134, top: 49, background: hq ? `var(--color-${STATUS[hq.status].token})` : 'var(--color-line)' }}>
          <span className="absolute inset-0.5 grid place-items-center bg-raised [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">HQ</span>
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-4 pb-3.5 pt-2">
        <div className="flex items-center gap-2.5"><span className={cx('min-w-[94px] text-xs font-semibold', h.text)}>{h.g} {h.label}</span><Segments value={project.health.score} className={h.seg} /></div>
        <div className="truncate rounded-sm border border-line-soft bg-ground px-2.5 py-1.5 font-mono text-xs text-ink-soft">
          <span className={latest ? STATUS[latest.status].text : ''}>{latest?.callsign}</span> {latest?.currentAction ?? 'idle'}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-ink-muted">
          <span><b className="font-semibold text-ink">{active} / {agents.length}</b> at work</span>
          <span><b className="font-semibold text-ink">{Math.round(share * 100)}%</b> of session · {usd(project.spendTodayUsd)}</span>
          <span className={project.supabase.status === 'running' ? 'text-st-done' : 'text-ink-dim'}>{project.supabase.status === 'running' ? '● Supabase running' : project.supabase.status === 'none' ? '○ No Supabase' : `◌ Supabase ${project.supabase.status}`}</span>
        </div>
      </div>
    </Link>
  )
}

export function World() {
  const { state } = useStore()
  if (!state.projects.length) return <EmptyWorld />
  const working = state.agents.filter((a) => ['running', 'editing', 'thinking'].includes(a.status)).length
  const top = needsYou(state).slice(0, 4)
  return (
    <div className="flex flex-wrap">
      <main className="min-w-0 flex-[999_1_720px] px-7 pb-5 pt-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-label mb-1.5">Command overview · {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
            <h1 className="m-0 font-display text-[30px] font-semibold tracking-[.02em]">{state.projects.length} bases · {state.agents.length} agents · {working} at work</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/inbox" className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3.5 py-2 text-[13px] text-ink no-underline">Next alert <KeyHint>G A</KeyHint></Link>
            <Link to="/new" className="inline-flex items-center gap-2 rounded-md bg-you px-3.5 py-2 text-[13px] font-semibold text-you-ink no-underline">+ Found new base <KeyHint>N</KeyHint></Link>
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] gap-5 rounded-2xl border border-line-soft bg-well bg-[radial-gradient(var(--color-line-soft)_1px,transparent_1px)] bg-[length:22px_22px] p-5">
          {state.projects.map((p) => <BaseTile key={p.id} project={p} />)}
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-dim">
          <span><KeyHint>1</KeyHint>–<KeyHint>9</KeyHint> jump to base</span><span><KeyHint>G A</KeyHint> next alert</span>
          <span><KeyHint>⇧ Space</KeyHint> pause all</span><span><KeyHint>W</KeyHint> ambient</span><span><KeyHint>?</KeyHint> all shortcuts</span>
        </div>
      </main>
      <aside className="flex min-w-0 max-w-[420px] flex-[1_1_340px] flex-col gap-6 border-l border-line-soft bg-well px-5 py-6">
        <PlanLimitsPanel />
        <section>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-section">Needs you</h2><Link to="/inbox" className="text-xs no-underline">Open inbox →</Link></div>
          <div className="flex flex-col gap-2">{top.map((a) => <AlertItem key={a.id} alert={a} compact />)}{!top.length && <p className="text-sm text-ink-dim">Nothing needs you. ◇</p>}</div>
        </section>
        <ActivityFeed title="Colony feed" limit={8} />
      </aside>
    </div>
  )
}
