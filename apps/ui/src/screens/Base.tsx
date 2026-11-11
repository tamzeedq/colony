import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useStore, projectByKey, projectAgents, sessionShare } from '@/store/store'
import { STATUS } from '@/design/status'
import { BaseMap } from '@/components/base/BaseMap'
import { QuestBoard } from '@/components/base/QuestBoard'
import { ActivityFeed } from '@/components/feed/ActivityFeed'
import { Button } from '@/components/ui/primitives'
import { Bar, inputCls } from '@/components/ui/controls'
import { useMediaQuery, WIDE } from '@/hooks/useMediaQuery'
import { cx, usd } from '@/lib/util'
import type { Project } from '@/types/colony'

export function Base() {
  const { key } = useParams()
  const { state, dispatch } = useStore()
  const project = projectByKey(state, Number(key))
  const wide = useMediaQuery(WIDE)
  const [goal, setGoal] = useState(project?.goal ?? '')
  const [sent, setSent] = useState<'' | 'sending' | 'ok' | 'error'>('')
  if (!project) return <Navigate to="/" replace />
  const agents = projectAgents(state, project)
  const healthCls = project.health.label === 'stable' ? 'text-st-done' : project.health.label === 'dormant' ? 'text-st-paused' : 'text-st-error'

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line-soft px-6 py-3.5">
        <div className="flex gap-1">
          {state.projects.map((p) => {
            const alert = state.alerts.find((a) => a.projectId === p.id && !a.resolvedAt && a.severity !== 'heads_up')
            return (
              <Link key={p.id} to={`/base/${p.key}`} className={cx('rounded-sm px-2.5 py-1 font-mono text-xs no-underline', p.id === project.id ? 'bg-ink text-ground' : 'border border-line text-ink-muted')}>
                {p.key} {p.name} {alert && <span className={alert.severity === 'critical' ? 'text-st-error' : 'text-st-you'}>{alert.severity === 'critical' ? '✕' : '!'}</span>}
              </Link>
            )
          })}
        </div>
        <h1 className="m-0 font-display text-[26px] font-semibold">{project.name}</h1>
        <span className={cx('text-xs font-semibold', healthCls)}>{project.health.label === 'stable' ? '✓ Stable' : project.health.label === 'dormant' ? '‖ Dormant' : '▲ Strained'}</span>
        <span className="hidden text-xs text-ink-dim 2xl:inline">{project.stack.join(' · ')}{project.repoUrl ? ` · ${project.repoUrl.replace('https://', '')}` : ''}</span>
        <div className="flex-1" />
        <span className="text-xs text-ink-muted">This base: <b className="text-ink">{Math.round(sessionShare(state, project) * 100)}%</b> of session · <b className="text-ink">{usd(project.spendTodayUsd)}</b> today</span>
        <Link to={`/spawn?project=${project.key}`} className="rounded-md bg-ink px-3.5 py-2 text-[13px] font-semibold text-ground no-underline">+ Spawn agent</Link>
        <Button onClick={() => dispatch({ type: 'pause', ids: agents.filter((a) => a.status !== 'paused').map((a) => a.id) })}>‖ Pause base</Button>
      </div>

      <form className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-well px-6 py-3" onSubmit={(e) => { e.preventDefault(); setSent('sending'); void dispatch({ type: 'setGoal', projectId: project.id, goal }).then((ok) => setSent(ok ? 'ok' : 'error')) }}>
        <label htmlFor="goal" className="text-[11px] font-semibold uppercase tracking-[.14em] text-you">Project goal</label>
        <input id="goal" value={goal} onChange={(e) => { setGoal(e.target.value); setSent('') }} className={cx(inputCls, 'min-w-0 flex-[1_1_400px]')} />
        <Button variant="command" type="submit">Send to {state.agents.find((a) => a.id === project.orchestratorId)?.callsign ?? 'Orchestrator'} ↵</Button>
        <span className={cx('text-xs', sent === 'error' ? 'text-st-error' : 'text-ink-dim')}>{sent === 'ok' ? '✓ Sent · the Orchestrator will re-plan quests' : sent === 'sending' ? 'Sending…' : sent === 'error' ? '✕ Not sent' : 'The Orchestrator turns this into quests'}</span>
      </form>

      {wide ? (
        <div className="grid flex-1 grid-cols-[400px_minmax(0,1fr)_440px]">
          <aside className="border-r border-line-soft bg-well px-4.5 py-4"><QuestBoard project={project} layout="lanes" /></aside>
          <section className="flex min-w-0 flex-col"><BaseMap project={project} height={640} /><TeamStrip project={project} /></section>
          <RightRail project={project} />
        </div>
      ) : (
        <div className="flex flex-wrap">
          <div className="flex min-w-0 flex-[999_1_760px] flex-col">
            <div className="border-b border-line-soft"><BaseMap project={project} /></div>
            <div className="px-6 pb-6 pt-4.5"><QuestBoard project={project} /></div>
          </div>
          <RightRail project={project} />
        </div>
      )}
    </div>
  )
}

function TeamStrip({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  return (
    <div className="grid grid-cols-6 gap-px border-t border-line-soft bg-line-soft">
      {projectAgents(state, project).map((a) => {
        const s = STATUS[a.status]
        return (
          <button key={a.id} type="button" onClick={() => dispatch({ type: 'inspect', id: a.id })} className="bg-ground px-3.5 py-2.5 text-left">
            <div className="flex items-baseline justify-between"><b className="font-display text-sm font-semibold">{a.callsign}</b><span className={cx('text-xs font-semibold', s.text)}>{s.glyph}</span></div>
            <div className="mt-1 flex gap-2.5 text-[11px] text-ink-dim"><span>ctx {a.contextPct}%</span><span>{Math.round(a.sessionShare * 100)}% session</span></div>
            <div className="mt-1.5"><Bar pct={a.contextPct} h="h-[3px]" /></div>
          </button>
        )
      })}
    </div>
  )
}

function RightRail({ project }: { project: Project }) {
  const { state, mode } = useStore()
  const agents = projectAgents(state, project)
  const review = state.quests.find((q) => q.projectId === project.id && q.status === 'in_review')
  const branches = state.quests.filter((q) => q.projectId === project.id && q.branch && q.status !== 'done')
  // Live: merge requests waiting on you, and agent branches (quests come in Phase 3).
  const pendingMrs = mode === 'live' ? state.mergeRequests.filter((m) => m.projectId === project.id && m.status === 'pending') : []
  const agentBranches = mode === 'live'
    ? agents.filter((a) => a.branch && a.branch !== 'main' && !branches.some((q) => q.branch === a.branch))
    : []
  return (
    <aside className="flex min-w-0 max-w-[440px] flex-[1_1_360px] flex-col border-l border-line-soft bg-well">
      <div className="border-b border-line-soft px-5 py-4.5"><ActivityFeed filter={(e) => e.projectId === project.id} limit={9} /></div>
      <section aria-label="Infra" className="flex flex-col gap-3.5 px-5 py-4.5">
        <h2 className="text-section">Infra</h2>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-1.5 flex items-center gap-2"><span className="font-semibold">Supabase (dev)</span>
            <span className={cx('text-[11px] font-semibold', project.supabase.status === 'running' ? 'text-st-done' : 'text-ink-dim')}>{project.supabase.status === 'running' ? '● Running' : project.supabase.status === 'none' ? '○ Not provisioned' : project.supabase.status}</span></div>
          {project.supabase.url && <div className="font-mono text-xs text-ink-soft">{project.supabase.url}</div>}
          {project.supabase.migration && <div className="mt-1.5 text-xs text-ink-dim">migration {project.supabase.migration}</div>}
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 flex items-center"><span className="font-semibold">Containers</span><span className="ml-auto text-[11px] text-ink-dim">{agents.filter((a) => a.container.health !== 'down').length} running</span></div>
          {agents.map((a) => (
            <div key={a.id} className="flex items-center gap-2 py-0.5 text-xs">
              <span className={cx('w-3 font-mono', a.container.health === 'down' ? 'text-st-error' : 'text-st-done')}>{a.container.health === 'down' ? '✕' : '●'}</span>
              <span className="w-[100px] font-mono text-ink-soft">{a.id}</span>
              <span className="flex-1"><Bar pct={a.container.cpuPct} /></span>
              <span className="w-9 text-right font-mono text-ink-dim">{a.container.cpuPct}%</span>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 font-semibold">Branches</div>
          <div className="flex justify-between py-1 text-xs"><span className="font-mono text-ink-soft">main</span><span className="rounded-xs border border-st-done px-1.5 font-semibold text-st-done">Clean</span></div>
          {branches.map((q) => (
            <div key={q.id} className="flex items-center gap-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{q.branch}</span>
              {q.status === 'in_review'
                ? <Link to={`/review/${q.prNumber}`} className="rounded-xs border border-st-you px-1.5 font-semibold text-st-you no-underline">Review PR #{q.prNumber}</Link>
                : <span className={cx('rounded-xs border px-1.5 font-semibold', q.status === 'blocked' ? 'border-st-blocked text-st-blocked' : q.status === 'failed' ? 'border-st-error text-st-error' : 'border-st-run text-st-run')}>{q.status === 'blocked' ? 'Blocked' : q.status === 'failed' ? 'Failed' : 'Active'}</span>}
            </div>
          ))}
          {agentBranches.map((a) => {
            const mr = pendingMrs.find((m) => m.branch === a.branch)
            return (
              <div key={a.id} className="flex items-center gap-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{a.branch}</span>
                {mr
                  ? <Link to={`/review/${mr.id}`} className="rounded-xs border border-st-you px-1.5 font-semibold text-st-you no-underline">Review{mr.prNumber ? ` PR #${mr.prNumber}` : ''}</Link>
                  : <span className="rounded-xs border border-st-run px-1.5 font-semibold text-st-run">Active</span>}
              </div>
            )
          })}
        </div>
        {pendingMrs.map((m) => (
          <Link key={m.id} to={`/review/${m.id}`} className="rounded-md border border-st-you/45 bg-st-you/12 px-3 py-2 text-[13px] font-semibold text-st-you no-underline">! Review merge{m.prNumber ? ` PR #${m.prNumber}` : ''} · {m.branch} →</Link>
        ))}
        {review && <Link to={`/review/${review.prNumber}`} className="rounded-md border border-st-you/45 bg-st-you/12 px-3 py-2 text-[13px] font-semibold text-st-you no-underline">! Review PR #{review.prNumber} · {review.title} →</Link>}
      </section>
    </aside>
  )
}
