// Colony domain model — the data every screen in the design is drawn from.

export type ID = string
export type ISODate = string

export type ModelId = 'opus-5.5' | 'sonnet-5.5' | 'haiku-5.5' | 'fable-5.1'
export type RoleId = 'orchestrator' | 'frontend' | 'backend' | 'qa' | 'devops' | 'researcher' | 'custom'

export type AgentStatus =
  | 'idle' | 'thinking' | 'running' | 'editing'
  | 'waiting' /* on you */ | 'blocked' | 'error' | 'paused' | 'done'
  | 'booting' /* container starting — renders as dashed "run" */

export type Controller = 'agent' | 'you'

export interface Project {
  id: ID
  key: number                 // 1–9, keyboard slot
  name: string
  repoUrl?: string
  stack: string[]
  goal: string                // sent to the Orchestrator
  health: { score: number; label: 'stable' | 'strained' | 'dormant' | 'down' } // score 0–10
  supabase: { status: 'running' | 'stopped' | 'provisioning' | 'error' | 'none'; url?: string; studioUrl?: string; migration?: string }
  orchestratorId?: ID
  agentIds: ID[]
  spendTodayUsd: number
  dailyCapUsd: number
  sessionShare: number        // 0–1 share of the current plan session window used by this project
  unreadAlerts: number
}

export interface Agent {
  id: ID
  projectId: ID
  callsign: string            // "Vex-07"
  role: RoleId
  model: ModelId
  status: AgentStatus
  controller: Controller
  currentTaskId?: ID
  currentAction?: string      // "npm test -- streaks"
  branch?: string
  container: { name: string; cpuPct: number; memMb: number; memLimitMb: number; health: 'ok' | 'degraded' | 'down' }
  contextPct: number          // 0–100 of context window used
  tokensToday: number
  spendTodayUsd: number
  budgetCapUsd: number
  sessionShare: number        // 0–1
  uptimeSec: number
  level: number
  xp: number                  // within level, 0–100
  questsDone: number
  rolePrompt: string
  allowedTools: string[]
}

export type QuestStatus = 'backlog' | 'in_progress' | 'in_review' | 'done' | 'failed' | 'blocked'

export interface Quest {
  id: ID
  projectId: ID
  title: string
  brief: string
  why?: string                // Orchestrator's reasoning
  status: QuestStatus
  priority: 'low' | 'normal' | 'high'
  assigneeId?: ID
  createdBy: ID | 'you'
  branch?: string
  prNumber?: number
  dependsOn: ID[]
  acceptance: { text: string; done: boolean }[]
  xpReward: number
  createdAt: ISODate
}

export type ActivityKind = 'thought' | 'tool' | 'command' | 'edit' | 'test' | 'message' | 'handoff' | 'status' | 'quest_complete'

export interface ActivityEvent {
  id: ID
  at: ISODate
  agentId: ID
  projectId: ID
  kind: ActivityKind
  text: string
  // kind-specific payloads
  command?: { cmd: string; exitCode?: number; durationMs?: number; outputTail?: string; running?: boolean }
  edit?: { path: string; added: number; removed: number; hunk?: string }
  test?: { passed: number; failed: number; running: number; coveragePct?: number }
  message?: { to: ID; body: string }
  tool?: { name: string; target?: string }
}

export type AlertKind = 'crash' | 'host_down' | 'approval' | 'question' | 'loop' | 'budget' | 'limit_pace'
export type AlertSeverity = 'critical' | 'needs_you' | 'heads_up'

export interface Alert {
  id: ID
  at: ISODate
  kind: AlertKind
  severity: AlertSeverity     // critical → banner + toast; needs_you → toast; heads_up → HUD only
  projectId?: ID
  agentId?: ID
  title: string
  detail?: string
  actions: { id: string; label: string; primary?: boolean; actsAsYou?: boolean }[]
  resolvedAt?: ISODate
}

export interface PlanUsage {
  session: { usedPct: number; resetsAt: ISODate; ratePctPerHour: number }
  weekly: { usedPct: number; resetsAt: ISODate }
  syncedAt: ISODate
  source: 'connected' | 'unavailable'
}

export interface Resources {
  usage: PlanUsage
  spendTodayUsd: number
  dailyCapUsd: number
  spendMonthUsd: number
  containers: { running: number; max: number }
  host: { cpuPct: number; memUsedGb: number; memTotalGb: number; docker: 'running' | 'down' }
}

export interface Guards {
  warnAtPct: number           // default 70
  pauseWorkersAtPct: number   // default 90
  orchestratorReservePct: number // default 5
  weeklyWarnAtPct: number
  paceForecast: boolean
  autoDownshiftAtPct?: number // e.g. 85 → workers to haiku-5.5
  resumeAfterReset: boolean
}

/** Projected minutes until the session window is exhausted at the current rate. */
export function minutesToSessionLimit(u: PlanUsage): number | null {
  if (u.session.ratePctPerHour <= 0) return null
  return ((100 - u.session.usedPct) / u.session.ratePctPerHour) * 60
}
