import { Link, useParams } from 'react-router-dom'
import { QUEST_STATUS, ROLES, modelInfo } from '@/design/status'
import { useStore } from '@/store/store'
import { StatusBadge, ModelBadge, RoleTile, Button } from '@/components/ui/primitives'
import { Bar, inputCls } from '@/components/ui/controls'
import { DependencyChain } from '@/components/quest/DependencyChain'
import { QuestBrief } from '@/components/quest/QuestBrief'
import { QuestReviewAction, PullRequestRow } from '@/components/quest/QuestReview'
import { cx, usd } from '@/lib/util'
import { AcceptanceList } from '@/components/quest/AcceptanceList'

export function Quest() {
  const { id } = useParams()
  const { state, dispatch } = useStore()
  const quest = state.quests.find((q) => q.id === id)
  if (!quest) return <p className="p-8 text-ink-muted">Quest not found. <Link to="/">Back to World</Link></p>
  const project = state.projects.find((p) => p.id === quest.projectId)
  const agent = state.agents.find((a) => a.id === quest.assigneeId)
  const qs = QUEST_STATUS[quest.status]
  const done = quest.acceptance.filter((c) => c.done).length
  const name = (aid?: string) => state.agents.find((a) => a.id === aid)?.callsign ?? (aid === 'you' ? 'You' : aid ?? '—')

  return (
    <div className="flex flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-line-soft bg-hud px-6 py-3.5">
        <Link to={`/base/${project?.key ?? 1}`} className="text-[13px] text-ink-muted no-underline">← {project?.name}</Link>
        <div><div className={cx('text-[11px] uppercase tracking-[.14em]', qs.text)}>{qs.glyph} Quest · {qs.label}</div><h1 className="m-0 mt-0.5 font-display text-[26px] font-semibold">{quest.title}</h1></div>
        <span className="rounded-full border border-line px-2.5 py-1 text-xs capitalize text-ink-soft">Priority: {quest.priority}</span>
        <span className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-soft">Created by {name(quest.createdBy)}</span>
        <div className="flex-1" />
        <QuestReviewAction quest={quest} />
        <Button>⇄ Reassign</Button>
        <Button>Ask Orchestrator to split</Button>
        <Button variant="danger" onClick={() => void dispatch({ type: 'questStatus', id: quest.id, status: 'failed' })}>Cancel quest</Button>
      </header>
      <div className="flex flex-wrap">
        <main className="flex min-w-0 flex-[999_1_760px] flex-col gap-5 px-6.5 py-5.5">
          <section aria-label="Dependencies" className="rounded-xl border border-line-soft bg-well px-4.5 py-4">
            <div className="mb-3 flex items-center gap-2.5"><h2 className="text-section">Dependencies</h2><span className="text-xs text-ink-dim">unblocks {state.quests.filter((q) => q.dependsOn.includes(quest.id)).length} quests</span></div>
            <DependencyChain quest={quest} quests={state.quests.filter((q) => q.projectId === quest.projectId)} />
          </section>
          <div className="grid grid-cols-2 gap-5">
            <section className="rounded-xl border border-line bg-surface px-4.5 py-4">
              <h2 className="text-section mb-2.5">Brief</h2>
              <QuestBrief brief={quest.brief ?? ''} />
              {quest.why && <div className="text-xs leading-normal text-[#C9C0FA]"><b>Why (Orchestrator):</b> {quest.why}</div>}
            </section>
            <section className="rounded-xl border border-line bg-surface px-4.5 py-4">
              <AcceptanceList quest={quest} />
            </section>
          </div>
          <section className="rounded-xl border border-line-soft bg-well px-4.5 py-4">
            <h2 className="text-section mb-2.5">History</h2>
            {[['15:47', '›', 'text-st-run', name(quest.assigneeId), agent?.currentAction ?? 'working'],
              ['15:12', '⇢', 'text-st-think', 'Atlas-01', 'told the assignee to push migration 0042 first'],
              ['13:40', '◆', 'text-you', 'You', `set priority to ${quest.priority}`],
              ['13:31', '⇢', 'text-st-think', 'Atlas-01', `assigned to ${name(quest.assigneeId)}`],
              ['13:30', '○', 'text-ink-dim', name(quest.createdBy), 'created this quest from the project goal']].map(([t, g2, c, who, text]) => (
              <div key={t} className="flex items-start gap-3.5 py-1.5"><span className="w-11 shrink-0 pt-0.5 font-mono text-[11px] text-ink-dim">{t}</span><span className={cx('w-5 font-mono', c)}>{g2}</span><span className="text-[13px] leading-normal"><b className="font-semibold">{who}</b> <span className="text-ink-soft">{text}</span></span></div>
            ))}
          </section>
        </main>
        <aside className="flex min-w-0 max-w-[380px] flex-[1_1_320px] flex-col gap-4 border-l border-line-soft bg-well px-5 py-5.5">
          <section className="rounded-xl border border-line bg-surface p-3.5">
            <div className="text-label mb-2.5">Assigned</div>
            {agent ? (
              <button type="button" onClick={() => dispatch({ type: 'inspect', id: agent.id })} className="flex w-full items-center gap-3 text-left">
                <RoleTile role={agent.role} size={44} />
                <span className="flex-1"><b className="block font-display text-[17px] font-semibold">{agent.callsign}</b><StatusBadge status={agent.status} compact /></span>
                <ModelBadge model={agent.model} compact />
              </button>
            ) : <p className="m-0 text-[13px] text-ink-dim">Unassigned · the Orchestrator picks someone when dependencies clear.</p>}
            {agent && <div className="mt-2.5 text-xs text-ink-dim">{ROLES[agent.role].name} · {modelInfo(agent.model).name}</div>}
          </section>
          <section className="grid grid-cols-2 gap-3.5 rounded-xl border border-line bg-surface p-3.5">
            {[['Time on quest', '2h 17m', 'started 13:31'], ['Session used', agent ? `${Math.round(agent.sessionShare * 100)}%` : '—', "of today's window"], ['Spend', agent ? usd(agent.spendTodayUsd) : '—', 'this agent today'], ['Reward', `+${quest.xpReward} XP`, 'on merge']].map(([l, v, s]) => (
              <div key={l}><div className="text-label">{l}</div><div className="text-numeral mt-0.5 text-xl">{v}</div><div className="text-[11px] text-ink-dim">{s}</div></div>
            ))}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5 text-[13px]">
            <div className="text-label">Code</div>
            <div className="flex justify-between"><span className="font-mono text-xs">⎇ {quest.branch ?? '—'}</span></div>
            <PullRequestRow quest={quest} />
          </section>
          <label className="flex flex-col gap-1.5 text-xs text-ink-muted">Note to whoever works on this<textarea rows={3} placeholder="e.g. keep the API shape compatible with the mobile app" className={inputCls} /></label>
        </aside>
      </div>
    </div>
  )
}
