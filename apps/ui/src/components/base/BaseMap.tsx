// The base view. Stations are HTML (crisp, clickable, accessible). The link lines here are
// CSS; swap them for a PixiJS layer when you want pulses, camera pan and zoom.
import type { Agent, Project } from '@/types/colony'
import { STATUS, ROLES, modelInfo } from '@/design/status'
import { useStore, projectAgents } from '@/store/store'
import { Bar } from '@/components/ui/controls'
import { cx } from '@/lib/util'

const W = 960, H = 520, CX = W / 2, CY = H / 2
const LIVE = new Set(['running', 'editing', 'thinking', 'booting'])

export function BaseMap({ project, height = 520 }: { project: Project; height?: number }) {
  const { state, dispatch } = useStore()
  const all = projectAgents(state, project)
  const hq = all.find((a) => a.id === project.orchestratorId) ?? all.find((a) => a.role === 'orchestrator')
  const workers = all.filter((a) => a !== hq)
  const pos = workers.map((a, i) => {
    const ang = (-90 + (360 * (i + 0.5)) / Math.max(1, workers.length)) * (Math.PI / 180)
    return { a, x: CX + 330 * Math.cos(ang), y: CY + 175 * Math.sin(ang) }
  })
  return (
    <section aria-label={`${project.name} base map`} className="relative overflow-hidden bg-well bg-[radial-gradient(var(--color-line-soft)_1px,transparent_1px)] bg-[length:22px_22px]" style={{ height }}>
      <div className="absolute left-1/2 top-1/2" style={{ width: W, height: H, marginLeft: -W / 2, marginTop: -H / 2 }}>
        {pos.map(({ a, x, y }) => {
          const dx = x - CX, dy = y - CY
          const s = STATUS[a.status]
          return (
            <div key={`l-${a.id}`} aria-hidden="true"
              className={cx('absolute h-0.5 origin-left', LIVE.has(a.status) ? cx('link-live', s.text) : 'bg-line')}
              style={{ left: CX, top: CY, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)` }} />
          )
        })}
        {hq && <HqCard agent={hq} x={CX} y={CY} questCount={state.quests.filter((q) => q.projectId === project.id && q.status !== 'done').length} />}
        {pos.map(({ a, x, y }) => <StationCard key={a.id} agent={a} x={x} y={y} onOpen={() => dispatch({ type: 'inspect', id: a.id })} selected={state.ui.inspectAgentId === a.id} />)}
        {!hq && (
          <div className="absolute grid h-[84px] w-[190px] place-items-center rounded-xl border-2 border-dashed border-line-strong font-display font-semibold text-ink-dim" style={{ left: CX - 95, top: CY - 42 }}>HQ is empty</div>
        )}
      </div>
      <div className="absolute left-4 top-3.5 flex flex-wrap gap-3 rounded-md border border-line-soft bg-well/85 px-2.5 py-1.5 text-[11px] text-ink-muted">
        <span><b className="text-st-run">›</b> running</span><span><b className="text-st-run">✎</b> editing</span><span><b className="text-st-think">⋯</b> thinking</span>
        <span><b className="text-st-you">!</b> needs you</span><span><b className="text-st-blocked">⊘</b> blocked</span><span><b className="text-st-error">✕</b> error</span><span>- - - live link</span>
      </div>
    </section>
  )
}

function HqCard({ agent, x, y, questCount }: { agent: Agent; x: number; y: number; questCount: number }) {
  const { dispatch } = useStore()
  const s = STATUS[agent.status]
  return (
    <button type="button" onClick={() => dispatch({ type: 'inspect', id: agent.id })}
      className="absolute w-[250px] rounded-2xl border-2 border-st-think bg-raised p-3.5 text-left shadow-raised" style={{ left: x - 125, top: y - 62 }}>
      <div className="flex items-center gap-2.5">
        <span className="grid h-[34px] w-[34px] place-items-center bg-st-think font-display text-[10px] font-bold text-ground [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">ORC</span>
        <div className="min-w-0 flex-1"><div className="whitespace-nowrap font-display text-[17px] font-bold leading-none">{agent.callsign}</div><div className="mt-1 text-[11px] text-ink-muted">Orchestrator · HQ</div></div>
        <span className="whitespace-nowrap rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">{modelInfo(agent.model).short} {modelInfo(agent.model).pips}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 text-xs font-semibold', s.badge)}>{s.glyph} {s.label}</span>
        <span className="text-[11px] text-ink-muted">{questCount} open quests</span>
      </div>
      <div className="mt-2 truncate text-[11px] text-ink-muted">{agent.currentAction}</div>
    </button>
  )
}

export function StationCard({ agent, x, y, onOpen, selected }: { agent: Agent; x: number; y: number; onOpen: () => void; selected?: boolean }) {
  const s = STATUS[agent.status]
  return (
    <button type="button" onClick={onOpen} title={`${agent.callsign} · ${s.label} · ${(agent.tokensToday / 1000).toFixed(0)}k tokens · CPU ${agent.container.cpuPct}%`}
      className={cx('absolute w-[196px] rounded-lg border border-t-[3px] bg-surface px-3 py-2.5 text-left transition-transform duration-[160ms] hover:-translate-y-0.5',
        s.ring, agent.status === 'waiting' && 'animate-attention', agent.status === 'booting' && 'border-dashed', selected ? 'ring-2 ring-you' : 'border-x-line border-b-line')}
      style={{ left: x - 98, top: y - 50 }}>
      <div className="flex items-center gap-2">
        <span className="grid h-[26px] w-[26px] place-items-center rounded-sm border border-line-strong bg-raised font-display text-[9px] font-bold text-ink-soft" style={{ backgroundImage: ROLES[agent.role].texture }}>{ROLES[agent.role].code}</span>
        <span className="flex-1 font-display text-[15px] font-semibold">{agent.callsign}</span>
        <span className="font-mono text-[10px] text-ink-muted">{modelInfo(agent.model).short} {modelInfo(agent.model).pips}</span>
      </div>
      <div className={cx('my-2 inline-flex items-center gap-1.5 rounded-full border px-2 text-xs font-semibold', s.badge)}>{s.glyph} {s.label}</div>
      <div className="truncate font-mono text-[11px] text-ink-soft">{agent.currentAction ?? '—'}</div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex-1"><Bar pct={agent.contextPct} className={agent.contextPct > 85 ? 'bg-st-error' : 'bg-ink-muted'} h="h-[3px]" /></span>
        <span className="font-mono text-[10px] text-ink-dim">ctx {agent.contextPct}%</span>
      </div>
    </button>
  )
}
