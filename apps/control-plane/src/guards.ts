// Guards (docs/phase1.md): per-agent budget cap, project daily cap, and plan usage
// thresholds. Each alert fires once per scope (day / session window); dedupe keys live in kv.

import { minutesToSessionLimit } from '@colony/shared'
import type { AgentManager } from './agents'
import type { Store } from './store'

const PROJECT_WARN_FRACTION = 0.85

export class GuardService {
  constructor(private store: Store, private agents: AgentManager) {
    agents.hooks.afterUsage = (id) => this.checkAgentBudget(id)
    agents.hooks.afterPlanUsage = () => this.checkPlanUsage()
  }

  /** Returns true the first time a key is seen (and records it). */
  private once(key: string): boolean {
    const k = `guard:${key}`
    if (this.store.db.kvGet(k)) return false
    this.store.db.kvSet(k, new Date().toISOString())
    return true
  }

  checkAgentBudget(agentId: string) {
    const rec = this.store.agents.get(agentId)
    if (!rec) return
    const a = rec.agent
    const day = this.store.today()
    if (a.budgetCapUsd > 0 && a.spendTodayUsd >= a.budgetCapUsd && rec.internal.desired === 'run') {
      this.agents.pause(agentId, 'budget')
      if (this.once(`budget:${agentId}:${day}:${a.budgetCapUsd}`)) {
        this.store.raiseAlert({
          kind: 'budget', severity: 'needs_you', projectId: a.projectId, agentId,
          title: `${a.callsign} reached its $${a.budgetCapUsd.toFixed(2)} budget cap · paused`,
          detail: `Spent $${a.spendTodayUsd.toFixed(2)} today.`,
          actions: [{ id: 'raise-cap', label: 'Raise cap', primary: true }, { id: 'resume', label: 'Resume anyway', actsAsYou: true }, { id: 'dismiss', label: 'Dismiss' }],
        })
      }
    }
    this.checkProjectBudget(a.projectId)
  }

  checkProjectBudget(projectId: string) {
    const prec = this.store.projects.get(projectId)
    if (!prec) return
    const cap = prec.project.dailyCapUsd
    if (!(cap > 0)) return
    const spend = this.store.projectSpendToday(projectId)
    const day = this.store.today()
    const name = prec.project.name
    if (spend >= cap) {
      for (const rec of this.store.projectAgents(projectId)) {
        if (rec.internal.desired === 'run') this.agents.pause(rec.agent.id, 'project_budget')
      }
      if (this.once(`project_budget:${projectId}:${day}:${cap}`)) {
        this.store.raiseAlert({
          kind: 'budget', severity: 'needs_you', projectId,
          title: `${name} reached its $${cap.toFixed(2)} daily cap · agents paused`,
          actions: [{ id: 'raise-cap', label: 'Raise cap', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
        })
      }
    } else if (spend >= cap * PROJECT_WARN_FRACTION && this.once(`project_warn:${projectId}:${day}:${cap}`)) {
      this.store.raiseAlert({
        kind: 'budget', severity: 'needs_you', projectId,
        title: `${name} used ${Math.round((spend / cap) * 100)}% of its $${cap.toFixed(2)} daily cap · agents pause at 100%`,
        actions: [{ id: 'raise-cap', label: 'Raise cap', primary: true }, { id: 'pause-base', label: 'Pause base' }, { id: 'dismiss', label: 'Dismiss' }],
      })
    }
  }

  checkPlanUsage() {
    const u = this.store.usage
    if (u.source !== 'connected') return
    const g = this.store.guards
    const used = u.session.usedPct
    const win = u.session.resetsAt
    if (used >= g.pauseWorkersAtPct) {
      const paused: string[] = []
      for (const rec of this.store.agents.values()) {
        if (rec.agent.role === 'orchestrator') continue // orchestrators keep their reserve
        if (rec.internal.desired !== 'run') continue
        this.agents.pause(rec.agent.id, 'plan_usage')
        paused.push(rec.agent.callsign)
      }
      if (this.once(`plan_pause:${win}`)) {
        this.store.raiseAlert({
          kind: 'limit_pace', severity: 'critical',
          title: `Session ${Math.round(used)}% · workers paused at ${g.pauseWorkersAtPct}%`,
          detail: paused.length ? `Paused: ${paused.join(', ')}. Orchestrators keep running.` : undefined,
          actions: [{ id: 'resume-workers', label: 'Resume workers', actsAsYou: true }, { id: 'dismiss', label: 'Dismiss' }],
        })
      }
    } else if (used >= g.warnAtPct && this.once(`plan_warn:${win}`)) {
      const mins = minutesToSessionLimit(u)
      const pace = mins !== null ? ` · at this pace it runs out in ~${fmtMins(mins)}` : ''
      this.store.raiseAlert({
        kind: 'limit_pace', severity: 'heads_up',
        title: `Session ${Math.round(used)}%${pace}`,
        actions: [{ id: 'downshift', label: 'Downshift workers to Haiku', primary: true }, { id: 'pause-noncritical', label: 'Pause non-critical' }],
      })
    }
    if (u.weekly.usedPct >= g.weeklyWarnAtPct && this.once(`weekly_warn:${u.weekly.resetsAt}`)) {
      this.store.raiseAlert({
        kind: 'limit_pace', severity: 'heads_up',
        title: `Weekly limit ${Math.round(u.weekly.usedPct)}% used`,
        actions: [{ id: 'dismiss', label: 'Dismiss' }],
      })
    }
  }
}

function fmtMins(m: number) {
  const h = Math.floor(m / 60), mm = Math.round(m % 60)
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`
}
