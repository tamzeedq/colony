// App state + a tiny live simulation. Swap the simulation for your WebSocket/SSE stream:
// dispatch status changes, and push ActivityEvents through `emit` (they bypass React state
// so feeds can throttle them).
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { ActivityEvent, Agent, AgentStatus, Alert, Guards, ID, Project, Quest, Resources } from '@/types/colony'
import * as mock from '@/data/mock'

export interface Toast { id: ID; alertId?: ID; title: string; tone: 'critical' | 'needs_you' | 'done'; at: number }

export interface State {
  projects: Project[]
  agents: Agent[]
  quests: Quest[]
  alerts: Alert[]
  resources: Resources
  guards: Guards
  ui: { inspectAgentId?: ID; selected: ID[]; overlay: null | 'shortcuts' | 'palette'; muted: boolean; toasts: Toast[] }
}

export type Action =
  | { type: 'agentStatus'; id: ID; status: AgentStatus; action?: string }
  | { type: 'pause'; ids: ID[] } | { type: 'resume'; ids: ID[] } | { type: 'kill'; ids: ID[] } | { type: 'restart'; id: ID; memMb?: number }
  | { type: 'pauseAll' }
  | { type: 'takeControl'; id: ID } | { type: 'handBack'; id: ID }
  | { type: 'setModel'; id: ID; model: Agent['model'] }
  | { type: 'resolveAlert'; id: ID } | { type: 'addAlert'; alert: Alert }
  | { type: 'spawn'; agent: Agent } | { type: 'addProject'; project: Project; agents: Agent[] }
  | { type: 'setGoal'; projectId: ID; goal: string }
  | { type: 'questStatus'; id: ID; status: Quest['status'] } | { type: 'addQuest'; quest: Quest }
  | { type: 'merge'; questId: ID }
  | { type: 'guards'; patch: Partial<Guards> } | { type: 'cap'; projectId: ID; cap: number }
  | { type: 'downshift' }
  | { type: 'inspect'; id?: ID } | { type: 'select'; ids: ID[] } | { type: 'overlay'; overlay: State['ui']['overlay'] }
  | { type: 'mute'; muted?: boolean } | { type: 'toast'; toast: Toast } | { type: 'dismissToast'; id: ID }
  | { type: 'usageTick' }

const mapAgents = (s: State, ids: ID[], f: (a: Agent) => Agent): State =>
  ({ ...s, agents: s.agents.map((a) => (ids.includes(a.id) ? f(a) : a)) })

function reducer(s: State, a: Action): State {
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
    case 'resolveAlert': return { ...s, alerts: s.alerts.map((x) => (x.id === a.id ? { ...x, resolvedAt: new Date().toISOString() } : x)),
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
  }
}

type Listener = (e: ActivityEvent) => void

interface Ctx {
  state: State
  dispatch: (a: Action) => void
  subscribe: (fn: Listener) => () => void
  seedEvents: ActivityEvent[]
}

const StoreCtx = createContext<Ctx | null>(null)

export function StoreProvider({ children, simulate = true }: { children: ReactNode; simulate?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    projects: mock.projects, agents: mock.agents, quests: mock.quests, alerts: mock.alerts,
    resources: mock.resources, guards: mock.guards,
    ui: { selected: [], overlay: null, muted: false, toasts: [] },
  }))
  const listeners = useRef(new Set<Listener>())
  const stateRef = useRef(state)
  stateRef.current = state

  const subscribe = useMemo(() => (fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn) } }, [])
  const emit = (e: ActivityEvent) => listeners.current.forEach((fn) => fn(e))

  // Live simulation: a few events per second from working agents, usage creeping up.
  useEffect(() => {
    if (!simulate) return
    let n = 0
    const tick = setInterval(() => {
      const s = stateRef.current
      const live = s.agents.filter((x) => ['running', 'editing', 'thinking'].includes(x.status))
      if (!live.length) return
      const ag = live[Math.floor(Math.random() * live.length)]
      const lines = mock.SIM_LINES[ag.role] ?? mock.SIM_LINES.custom
      const l = lines[Math.floor(Math.random() * lines.length)]
      const e: ActivityEvent = { id: `sim-${Date.now()}-${n++}`, at: new Date().toISOString(), agentId: ag.id, projectId: ag.projectId, kind: l.kind, text: l.text }
      if (l.kind === 'command') {
        e.command = { cmd: l.text, running: Math.random() < 0.4, exitCode: 0, durationMs: 2000 + Math.random() * 9000 }
        dispatch({ type: 'agentStatus', id: ag.id, status: 'running', action: l.text })
      }
      if (l.kind === 'edit') dispatch({ type: 'agentStatus', id: ag.id, status: 'editing', action: l.text.split(' ')[0] })
      emit(e)
    }, 450)
    const usage = setInterval(() => dispatch({ type: 'usageTick' }), 5000)
    return () => { clearInterval(tick); clearInterval(usage) }
  }, [simulate])

  // Booting agents come online after a few seconds.
  useEffect(() => {
    const booting = state.agents.filter((a) => a.status === 'booting')
    if (!booting.length) return
    const t = setTimeout(() => booting.forEach((a) => {
      dispatch({ type: 'agentStatus', id: a.id, status: 'idle', action: 'Online · waiting for a quest' })
      dispatch({ type: 'toast', toast: { id: `joined-${a.id}`, title: `${a.callsign} joined and is ready`, tone: 'done', at: Date.now() } })
    }), 3500)
    return () => clearTimeout(t)
  }, [state.agents])

  const value = useMemo(() => ({ state, dispatch, subscribe, seedEvents: mock.events }), [state, subscribe])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore() {
  const c = useContext(StoreCtx)
  if (!c) throw new Error('useStore must be used inside <StoreProvider>')
  return c
}

/* ---------- selectors ---------- */
export const needsYou = (s: State) => s.alerts.filter((a) => !a.resolvedAt && a.severity !== 'heads_up')
export const agentById = (s: State, id?: ID) => s.agents.find((a) => a.id === id)
export const projectByKey = (s: State, key: number) => s.projects.find((p) => p.key === key)
export const projectAgents = (s: State, p: Project) => s.agents.filter((a) => a.projectId === p.id)
export const projectQuests = (s: State, p: Project) => s.quests.filter((q) => q.projectId === p.id)
export const sessionShare = (s: State, p: Project) => projectAgents(s, p).reduce((n, a) => n + a.sessionShare, 0)
