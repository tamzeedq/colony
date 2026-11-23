import type { KeyboardEvent, SyntheticEvent } from 'react'
import type { Agent } from '@/types/colony'
import { ROLES } from '@/design/status'
import { StatusBadge, ModelBadge } from '@/components/ui/primitives'
import { Bar } from '@/components/ui/controls'
import { AgentIcon } from '@/components/agent/AgentIcon'
import { useStore } from '@/store/store'
import { cx, usd, xpPct } from '@/lib/util'

const stop = (e: SyntheticEvent) => e.stopPropagation()

/** A roster card. The whole card opens the Inspector; the checkbox only selects. */
export function AgentCard({ agent, selected, onToggle }: { agent: Agent; selected?: boolean; onToggle?: () => void }) {
  const { state, dispatch } = useStore()
  const project = state.projects.find((p) => p.id === agent.projectId)
  const quest = state.quests.find((q) => q.id === agent.currentTaskId)
  const inspect = () => dispatch({ type: 'inspect', id: agent.id })
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect() }
  }
  const sub = `${ROLES[agent.role].name} · ${project?.name ?? ''}`
  const task = `${quest ? `${quest.title} — ` : ''}${agent.currentAction || 'No current task'}`
  return (
    <article role="button" tabIndex={0} aria-label={`Inspect ${agent.callsign}`} onClick={inspect} onKeyDown={onKey}
      className={cx('flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl border bg-surface p-3.5 transition-colors hover:bg-raised/60',
        selected ? 'border-you ring-1 ring-you' : agent.status === 'waiting' ? 'animate-attention border-st-you/45' : agent.status === 'error' ? 'border-st-error/50' : 'border-line hover:border-line-strong')}>
      <div className="flex items-start gap-3">
        <AgentIcon agent={agent} size={46} level={agent.level} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-display text-[17px] font-semibold" title={agent.callsign}>{agent.callsign}</span>
            {onToggle && (
              <input type="checkbox" checked={!!selected} onChange={onToggle} onClick={stop} onKeyDown={stop} aria-label={`Select ${agent.callsign}`}
                className="ml-auto h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-you)]" />
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-muted" title={sub}>{sub}</div>
        </div>
      </div>
      <div className="flex h-[22px] items-center gap-1.5 overflow-hidden"><StatusBadge status={agent.status} pausing={!!agent.pauseRequested} /><ModelBadge model={agent.model} /></div>
      <div className="line-clamp-2 h-[2.75em] break-words text-[13px] leading-[1.375]" title={task}>{task}</div>
      <div className="h-4 truncate font-mono text-[11px] text-ink-dim" title={agent.branch}>{agent.branch ? `⎇ ${agent.branch}` : ''}</div>
      <div className="grid grid-cols-3 gap-2.5 border-t border-line-soft pt-2.5">
        <div><div className="text-label">Context</div><div className="my-1"><Bar pct={agent.contextPct} className={agent.contextPct > 85 ? 'bg-st-error' : 'bg-ink-muted'} /></div><div className={cx('font-mono text-[11px]', agent.contextPct > 85 ? 'text-st-error' : 'text-ink-dim')}>{agent.contextPct}%</div></div>
        <div><div className="text-label">Spent</div><div className="text-numeral mt-1 text-[15px]">{usd(agent.spendTodayUsd)}</div><div className="font-mono text-[11px] text-ink-dim">{Math.round(agent.sessionShare * 100)}% session</div></div>
        <div><div className="text-label">Lv {agent.level} · XP</div><div className="my-1"><Bar pct={xpPct(agent.xp)} className="bg-ink-soft" /></div><div className="font-mono text-[11px] text-ink-dim">{agent.questsDone} quests</div></div>
      </div>
    </article>
  )
}
