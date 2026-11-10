import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Alert, AlertKind } from '@/types/colony'
import { ALERT_SEVERITY } from '@/design/status'
import { useStore } from '@/store/store'
import { ago, cx } from '@/lib/util'

export const KIND: Record<AlertKind, { g: string; label: string; color: string; bar: string }> = {
  crash: { g: '✕', label: 'Critical · crash', color: 'text-st-error', bar: 'bg-st-error' },
  host_down: { g: '✕', label: 'Critical · host', color: 'text-st-error', bar: 'bg-st-error' },
  approval: { g: '!', label: 'Approval · merge', color: 'text-st-you', bar: 'bg-st-you' },
  question: { g: '?', label: 'Question', color: 'text-st-you', bar: 'bg-st-you' },
  loop: { g: '↻', label: 'Loop', color: 'text-st-blocked', bar: 'bg-st-blocked' },
  budget: { g: '$', label: 'Budget', color: 'text-st-blocked', bar: 'bg-st-blocked' },
  limit_pace: { g: '◷', label: 'Limit pace', color: 'text-st-blocked', bar: 'bg-st-blocked' },
}

/** One place that turns alert buttons into actions. */
export function useAlertAction() {
  const { state, dispatch } = useStore()
  const nav = useNavigate()
  return (alert: Alert, actionId: string) => {
    const agent = state.agents.find((a) => a.id === alert.agentId)
    const done = () => dispatch({ type: 'resolveAlert', id: alert.id })
    if (actionId.startsWith('reply:')) { if (agent) dispatch({ type: 'agentStatus', id: agent.id, status: 'editing', action: `Using: ${actionId.slice(6)}` }); return done() }
    switch (actionId) {
      case 'restart-6gb': if (agent) dispatch({ type: 'restart', id: agent.id, memMb: 6144 }); return done()
      case 'restart': if (agent) dispatch({ type: 'restart', id: agent.id }); return done()
      case 'reassign': nav(`/roster`); return done()
      case 'approve': { const q = state.quests.find((x) => x.status === 'in_review' && x.assigneeId === alert.agentId); if (q) dispatch({ type: 'merge', questId: q.id }); return done() }
      case 'review': { const q = state.quests.find((x) => x.status === 'in_review' && x.assigneeId === alert.agentId); nav(q?.prNumber ? `/review/${q.prNumber}` : '/inbox'); return }
      case 'take-control': if (agent) { dispatch({ type: 'takeControl', id: agent.id }); dispatch({ type: 'inspect', id: agent.id }) } return done()
      case 'nudge': if (agent) dispatch({ type: 'inspect', id: agent.id }); return
      case 'raise-cap': if (alert.projectId) dispatch({ type: 'cap', projectId: alert.projectId, cap: 15 }); return done()
      case 'pause-base': dispatch({ type: 'pause', ids: state.agents.filter((a) => a.projectId === alert.projectId).map((a) => a.id) }); return done()
      case 'downshift': dispatch({ type: 'downshift' }); return done()
      case 'pause-noncritical': dispatch({ type: 'pause', ids: state.agents.filter((a) => a.role === 'researcher' || a.role === 'qa').map((a) => a.id) }); return done()
      case 'inspect': if (agent) dispatch({ type: 'inspect', id: agent.id }); return
      default: return done()
    }
  }
}

export function AlertItem({ alert, compact = false }: { alert: Alert; compact?: boolean }) {
  const { state, dispatch } = useStore()
  const act = useAlertAction()
  const [reply, setReply] = useState('')
  const k = KIND[alert.kind]
  const sev = ALERT_SEVERITY[alert.severity]
  const agent = state.agents.find((a) => a.id === alert.agentId)
  const project = state.projects.find((p) => p.id === alert.projectId)
  const who = [agent?.callsign, project?.name].filter(Boolean).join(' · ')
  const row = alert.kind === 'loop' || alert.kind === 'budget' || alert.kind === 'limit_pace'

  return (
    <article id={alert.id} className={cx('flex gap-3.5 rounded-xl border bg-surface', compact ? 'p-3' : 'p-4', sev.border)}>
      <div className={cx('w-1 shrink-0 rounded-full', k.bar)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={cx('inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.1em]', k.color)}>
            <span className={cx('grid h-[18px] w-[18px] place-items-center rounded-xs text-[11px] text-ground', k.bar, alert.kind === 'approval' && 'animate-attention')}>{k.g}</span>{k.label}
          </span>
          {who && <span className="text-[13px] text-ink-muted">{who}</span>}
          <span className="ml-auto font-mono text-[11px] text-ink-dim">{ago(alert.at)} ago</span>
        </div>
        <div className={cx('my-2 leading-normal', compact ? 'text-[13px]' : row ? 'text-sm' : 'text-[15px] font-medium')}>{alert.title}</div>
        {alert.detail && !compact && (alert.kind === 'crash'
          ? <pre className="mb-3 whitespace-pre-wrap rounded-md border border-line-soft bg-[#07090C] px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-muted">{alert.detail}</pre>
          : <div className="mb-3 text-xs text-ink-muted">{alert.detail}</div>)}
        <div className="flex flex-wrap gap-2">
          {alert.actions.map((a) => (
            <button key={a.id} type="button" onClick={() => act(alert, a.id)}
              className={cx('rounded-md px-3 py-1.5 text-[13px]',
                a.actsAsYou && a.primary ? 'bg-you font-bold text-you-ink' : a.primary ? 'bg-ink font-semibold text-ground' : alert.kind === 'question' ? 'rounded-full border border-line bg-raised' : 'border border-line text-ink')}>
              {a.label}
            </button>
          ))}
          {agent && !compact && <button type="button" onClick={() => dispatch({ type: 'inspect', id: agent.id })} className="px-1.5 text-[13px] text-you">Inspect →</button>}
        </div>
        {alert.kind === 'question' && !compact && (
          <form className="mt-2.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (reply) act(alert, `reply:${reply}`) }}>
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Reply to ${agent?.callsign ?? 'agent'}…  (R)`} aria-label="Reply"
              className="flex-1 rounded-md border border-line bg-ground px-3 py-2 text-[13px]" />
            <button type="submit" className="rounded-md bg-ink px-3.5 text-[13px] font-semibold text-ground">Send</button>
          </form>
        )}
      </div>
    </article>
  )
}
