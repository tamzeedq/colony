import type { Agent } from '@/types/colony'
import { ROLES } from '@/design/status'
import { StatusBadge, ModelBadge, RoleTile } from '@/components/ui/primitives'
import { Bar } from '@/components/ui/controls'
import { useStore } from '@/store/store'
import { cx, usd } from '@/lib/util'

export function AgentCard({ agent, selected, onToggle }: { agent: Agent; selected?: boolean; onToggle?: () => void }) {
  const { state, dispatch } = useStore()
  const project = state.projects.find((p) => p.id === agent.projectId)
  const quest = state.quests.find((q) => q.id === agent.currentTaskId)
  return (
    <article className={cx('flex flex-col gap-2.5 rounded-xl border bg-surface p-3.5',
      selected ? 'border-you ring-1 ring-you' : agent.status === 'waiting' ? 'animate-attention border-st-you/45' : agent.status === 'error' ? 'border-st-error/50' : 'border-line')}>
      <div className="flex items-start gap-3">
        <RoleTile role={agent.role} level={agent.level} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => dispatch({ type: 'inspect', id: agent.id })} className="font-display text-[17px] font-semibold hover:text-you">{agent.callsign}</button>
            {onToggle && <input type="checkbox" checked={!!selected} onChange={onToggle} aria-label={`Select ${agent.callsign}`} className="ml-auto h-4 w-4 accent-[var(--color-you)]" />}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{ROLES[agent.role].name} · {project?.name}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={agent.status} /><ModelBadge model={agent.model} /></div>
      <div className="min-h-9 text-[13px] leading-snug">{quest ? `${quest.title} — ` : ''}{agent.currentAction ?? 'No current task'}</div>
      {agent.branch && <div className="truncate font-mono text-[11px] text-ink-dim">⎇ {agent.branch}</div>}
      <div className="grid grid-cols-3 gap-2.5 border-t border-line-soft pt-2.5">
        <div><div className="text-label">Context</div><div className="my-1"><Bar pct={agent.contextPct} className={agent.contextPct > 85 ? 'bg-st-error' : 'bg-ink-muted'} /></div><div className={cx('font-mono text-[11px]', agent.contextPct > 85 ? 'text-st-error' : 'text-ink-dim')}>{agent.contextPct}%</div></div>
        <div><div className="text-label">Spent</div><div className="text-numeral mt-1 text-[15px]">{usd(agent.spendTodayUsd)}</div><div className="font-mono text-[11px] text-ink-dim">{Math.round(agent.sessionShare * 100)}% session</div></div>
        <div><div className="text-label">Lv {agent.level} · XP</div><div className="my-1"><Bar pct={agent.xp} className="bg-ink-soft" /></div><div className="font-mono text-[11px] text-ink-dim">{agent.questsDone} quests</div></div>
      </div>
    </article>
  )
}
