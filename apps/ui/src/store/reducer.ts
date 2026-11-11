// State + reducer shared by both data modes. In live mode the reducer applies optimistic updates
// and stream messages (hydrate / patchAgent / upsertAlert / resources); see live.ts for the API side.
import type { Agent, AgentStatus, Alert, Guards, ID, MergeRequest, ModelInfo, Project, ProviderView, Quest, Resources, Snapshot } from '@/types/colony'
import { BUILTIN_MODELS } from '@/types/colony'

export interface Toast { id: ID; alertId?: ID; title: string; tone: 'critical' | 'needs_you' | 'done' | 'error'; at: number }

export interface State {
  projects: Project[]
  agents: Agent[]
  quests: Quest[]
  alerts: Alert[]
  resources: Resources
  guards: Guards
  mergeRequests: MergeRequest[]
  providers: ProviderView[]
  models: ModelInfo[]
  ui: { inspectAgentId?: ID; selected: ID[]; overlay: null | 'shortcuts' | 'palette'; muted: boolean; toasts: Toast[] }
}

export type Action =
  | { type: 'agentStatus'; id: ID; status: AgentStatus; action?: string }
  | { type: 'pause'; ids: ID[] } | { type: 'resume'; ids: ID[] } | { type: 'kill'; ids: ID[] } | { type: 'restart'; id: ID; memMb?: number }
  | { type: 'pauseAll' }
  | { type: 'takeControl'; id: ID } | { type: 'handBack'; id: ID; note?: string }
  | { type: 'setModel'; id: ID; model: Agent['model'] }
  | { type: 'configAgent'; id: ID; rolePrompt?: string; budgetCapUsd?: number }
  | { type: 'message'; id: ID; text: string }
  | { type: 'resolveAlert'; id: ID } | { type: 'addAlert'; alert: Alert }
  | { type: 'spawn'; agent: Agent } | { type: 'addProject'; project: Project; agents: Agent[] }
  | { type: 'setGoal'; projectId: ID; goal: string }
  | { type: 'questStatus'; id: ID; status: Quest['status'] } | { type: 'addQuest'; quest: Quest }
  | { type: 'merge'; questId: ID }
  | { type: 'approveMerge'; id: ID } | { type: 'requestChanges'; id: ID; note: string }
  | { type: 'guards'; patch: Partial<Guards> } | { type: 'cap'; projectId: ID; cap: number }
  | { type: 'downshift' }
  | { type: 'inspect'; id?: ID } | { type: 'select'; ids: ID[] } | { type: 'overlay'; overlay: State['ui']['overlay'] }
  | { type: 'mute'; muted?: boolean } | { type: 'toast'; toast: Toast } | { type: 'dismissToast'; id: ID }
  | { type: 'usageTick' }
  // stream / API results (live)
  | { type: 'hydrate'; snapshot: Snapshot; guards?: Guards }
  | { type: 'patchAgent'; id: ID; patch: Partial<Agent> }
  | { type: 'upsertAgent'; agent: Agent }
  | { type: 'upsertProject'; project: Project }
  | { type: 'upsertAlert'; alert: Alert }
  | { type: 'resources'; resources: Resources }
  | { type: 'upsertMergeRequest'; mergeRequest: MergeRequest }
  | { type: 'setGuards'; guards: Guards }
  | { type: 'setProviders'; providers: ProviderView[] }
  | { type: 'upsertProvider'; provider: ProviderView }

export const DEFAULT_GUARDS: Guards = { warnAtPct: 70, pauseWorkersAtPct: 90, orchestratorReservePct: 5, weeklyWarnAtPct: 70, paceForecast: true, autoDownshiftAtPct: 85, resumeAfterReset: false }

/** Placeholder until the first snapshot arrives (the app shows "Connecting…" meanwhile). */
export const EMPTY_RESOURCES: Resources = {
  usage: { session: { usedPct: 0, resetsAt: new Date().toISOString(), ratePctPerHour: 0 }, weekly: { usedPct: 0, resetsAt: new Date().toISOString() }, syncedAt: new Date().toISOString(), source: 'unavailable' },
  spendTodayUsd: 0, dailyCapUsd: 0, spendMonthUsd: 0,
  containers: { running: 0, max: 0 },
  host: { cpuPct: 0, memUsedGb: 0, memTotalGb: 0, docker: 'running' },
}

export const emptyUi = (): State['ui'] => ({ selected: [], overlay: null, muted: false, toasts: [] })

const mapAgents = (s: State, ids: ID[], f: (a: Agent) => Agent): State =>
  ({ ...s, agents: s.agents.map((a) => (ids.includes(a.id) ? f(a) : a)) })

const upsert = <T extends { id: ID }>(list: T[], item: T, prepend = false): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? { ...x, ...item } : x)) : prepend ? [item, ...list] : [...list, item]

const linkAgent = (projects: Project[], agent: Agent) =>
  projects.map((p) => (p.id === agent.projectId && !p.agentIds.includes(agent.id) ? { ...p, agentIds: [...p.agentIds, agent.id] } : p))

const looksLikeAgent = (p: Partial<Agent>): p is Agent => !!(p.id && p.projectId && p.callsign && p.role && p.container)

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'agentStatus': return mapAgents(s, [a.id], (x) => ({ ...x, status: a.status, currentAction: a.action ?? x.currentAction }))
    case 'pause': return mapAgents(s, a.ids, (x) => (x.status === 'error' ? x : { ...x, status: 'paused' }))
    case 'pauseAll': return { ...s, agents: s.agents.map((x) => (x.status === 'error' ? x : { ...x, status: 'paused' })) }
    case 'resume': return mapAgents(s, a.ids, (x) => (x.status === 'paused' ? { ...x, status: 'idle', controller: 'agent' } : x))
    case 'kill': return {
      ...s, agents: s.agents.filter((x) => !a.ids.includes(x.id)),
      projects: s.projects.map((p) => ({ ...p, agentIds: p.agentIds.filter((id) => !a.ids.includes(id)) })),
      ui: { ...s.ui, selected: s.ui.selected.filter((id) => !a.ids.includes(id)), inspectAgentId: a.ids.includes(s.ui.inspectAgentId ?? '') ? undefined : s.ui.inspectAgentId },
    }
    case 'restart': return mapAgents(s, [a.id], (x) => ({ ...x, status: 'booting', contextPct: 0, currentAction: 'Booting container…',
      container: { ...x.container, health: 'ok', cpuPct: 5, memMb: 300, memLimitMb: a.memMb ?? x.container.memLimitMb } }))
    case 'takeControl': return mapAgents(s, [a.id], (x) => ({ ...x, controller: 'you', status: 'paused' }))
    case 'handBack': return mapAgents(s, [a.id], (x) => ({ ...x, controller: 'agent', status: 'running', currentAction: 'Resuming with your notes' }))
    case 'setModel': return mapAgents(s, [a.id], (x) => ({ ...x, model: a.model }))
    case 'configAgent': return mapAgents(s, [a.id], (x) => ({ ...x, rolePrompt: a.rolePrompt ?? x.rolePrompt, budgetCapUsd: a.budgetCapUsd ?? x.budgetCapUsd }))
    case 'message': return s
    case 'resolveAlert': return { ...s, alerts: s.alerts.map((x) => (x.id === a.id ? { ...x, resolvedAt: x.resolvedAt ?? new Date().toISOString() } : x)),
      ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.alertId !== a.id) } }
    case 'addAlert': return { ...s, alerts: [a.alert, ...s.alerts] }
    case 'spawn': return { ...s, agents: [...s.agents, a.agent],
      projects: s.projects.map((p) => (p.id === a.agent.projectId ? { ...p, agentIds: [...p.agentIds, a.agent.id] } : p)) }
    case 'addProject': return { ...s, projects: [...s.projects, a.project], agents: [...s.agents, ...a.agents] }
    case 'setGoal': return { ...s, projects: s.projects.map((p) => (p.id === a.projectId ? { ...p, goal: a.goal } : p)) }
    case 'questStatus': return { ...s, quests: s.quests.map((q) => (q.id === a.id ? { ...q, status: a.status } : q)) }
    case 'addQuest': return { ...s, quests: [...s.quests, a.quest] }
    case 'merge': {
      const q = s.quests.find((x) => x.id === a.questId)
      if (!q) return s
      const unblocked = s.quests.map((x) => (x.id === q.id ? { ...x, status: 'done' as const } : x))
      return {
        ...s, quests: unblocked,
        agents: s.agents.map((x) => (x.id === q.assigneeId ? { ...x, status: 'idle', currentAction: undefined, xp: Math.min(99, x.xp + 30), questsDone: x.questsDone + 1 } : x)),
        alerts: s.alerts.map((x) => (x.kind === 'approval' && x.agentId === q.assigneeId ? { ...x, resolvedAt: new Date().toISOString() } : x)),
      }
    }
    case 'approveMerge': return { ...s, mergeRequests: s.mergeRequests.map((m) => (m.id === a.id && m.status !== 'merged' ? { ...m, status: 'approved', approvedBy: 'you', approvedAt: new Date().toISOString() } : m)) }
    case 'requestChanges': return { ...s, mergeRequests: s.mergeRequests.map((m) => (m.id === a.id ? { ...m, status: 'changes_requested' } : m)) }
    case 'guards': return { ...s, guards: { ...s.guards, ...a.patch } }
    case 'cap': return { ...s, projects: s.projects.map((p) => (p.id === a.projectId ? { ...p, dailyCapUsd: a.cap } : p)) }
    case 'downshift': return { ...s, agents: s.agents.map((x) => (x.role !== 'orchestrator' && x.status !== 'waiting' ? { ...x, model: 'haiku-5.5' } : x)),
      resources: { ...s.resources, usage: { ...s.resources.usage, session: { ...s.resources.usage.session, ratePctPerHour: 12 } } } }
    case 'inspect': return { ...s, ui: { ...s.ui, inspectAgentId: a.id } }
    case 'select': return { ...s, ui: { ...s.ui, selected: a.ids } }
    case 'overlay': return { ...s, ui: { ...s.ui, overlay: a.overlay } }
    case 'mute': return { ...s, ui: { ...s.ui, muted: a.muted ?? !s.ui.muted } }
    case 'toast': return { ...s, ui: { ...s.ui, toasts: [...s.ui.toasts.filter((t) => t.id !== a.toast.id), a.toast].slice(-3) } }
    case 'dismissToast': return { ...s, ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== a.id) } }
    case 'usageTick': {
      const working = s.agents.filter((x) => ['running', 'editing', 'thinking'].includes(x.status)).length
      const u = s.resources.usage
      const used = Math.min(100, u.session.usedPct + working * 0.004)
      return { ...s, resources: { ...s.resources, usage: { ...u, session: { ...u.session, usedPct: used }, syncedAt: new Date().toISOString() },
        spendTodayUsd: s.resources.spendTodayUsd + working * 0.0008 } }
    }

    // ── live ──
    case 'hydrate': {
      const snap = a.snapshot
      const agentIds = new Set(snap.agents.map((x) => x.id))
      // Quests stay local until Phase 3: keep ones you added that the server doesn't know.
      const localQuests = s.quests.filter((q) => q.createdBy === 'you' && !snap.quests.some((x) => x.id === q.id))
      return {
        ...s,
        projects: snap.projects, agents: snap.agents, quests: [...snap.quests, ...localQuests], alerts: snap.alerts, resources: snap.resources,
        mergeRequests: snap.mergeRequests ?? s.mergeRequests,
        providers: snap.providers ?? s.providers,
        models: snap.models?.length ? snap.models : s.models,
        guards: a.guards ? { ...DEFAULT_GUARDS, ...a.guards } : s.guards,
        ui: { ...s.ui, selected: s.ui.selected.filter((id) => agentIds.has(id)), inspectAgentId: s.ui.inspectAgentId && agentIds.has(s.ui.inspectAgentId) ? s.ui.inspectAgentId : undefined },
      }
    }
    case 'patchAgent': {
      if (!s.agents.some((x) => x.id === a.id)) {
        const full = { ...a.patch, id: a.id }
        return looksLikeAgent(full) ? { ...s, agents: [...s.agents, full], projects: linkAgent(s.projects, full) } : s
      }
      return mapAgents(s, [a.id], (x) => ({ ...x, ...a.patch, id: x.id }))
    }
    case 'upsertAgent': return { ...s, agents: upsert(s.agents, a.agent), projects: linkAgent(s.projects, a.agent) }
    case 'upsertProject': return { ...s, projects: upsert(s.projects, a.project) }
    case 'upsertAlert': {
      const ui = a.alert.resolvedAt ? { ...s.ui, toasts: s.ui.toasts.filter((t) => t.alertId !== a.alert.id) } : s.ui
      return { ...s, alerts: upsert(s.alerts, a.alert), ui }
    }
    case 'resources': return { ...s, resources: a.resources }
    case 'upsertMergeRequest': return { ...s, mergeRequests: upsert(s.mergeRequests, a.mergeRequest) }
    case 'setGuards': return { ...s, guards: { ...DEFAULT_GUARDS, ...a.guards } }
    case 'setProviders': return { ...s, providers: a.providers }
    case 'upsertProvider': return { ...s, providers: upsert(s.providers, a.provider) }
  }
}

export const builtinModels = (): ModelInfo[] => [...BUILTIN_MODELS]
