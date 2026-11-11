// Colony domain model — the data every screen in the design is drawn from.
//
// Ported from the design handoff (apps/ui/src/types/colony.ts). Names and fields are kept
// so the UI can switch to importing from `@colony/shared` unchanged, with the changes from
// docs/execution-plan.md §6: open `ModelId` + model registry, providers, `Agent.provider`,
// and merge approvals (§5.3).
//
// `ActivityKind` / `ActivityEvent` live in ./events.ts (zod schema + inferred type) because
// they are part of the wire protocol; they are re-exported from the package index.

export type ID = string
export type ISODate = string

// ── Models & providers ──────────────────────────────────────────────────────────

/** Registry id of a model, e.g. 'opus-5.5'. Open so models from added providers can appear. */
export type ModelId = string

export type ProviderId = 'claude-subscription' | 'anthropic-api' | 'openai' | 'google' | 'openrouter' | 'custom'

export const PROVIDER_IDS = ['claude-subscription', 'anthropic-api', 'openai', 'google', 'openrouter', 'custom'] as const satisfies readonly ProviderId[]

/**
 * How Colony reaches a provider:
 * - `subscription`: Claude Code CLI with the user's plan (CLAUDE_CODE_OAUTH_TOKEN).
 * - `anthropic`:    Claude Code CLI with an Anthropic API key.
 * - `gateway`:      Claude Code CLI with ANTHROPIC_BASE_URL pointed at the LiteLLM gateway
 *                   (OpenAI, Google, OpenRouter, custom OpenAI-compatible URLs).
 */
export type ProviderKind = 'subscription' | 'anthropic' | 'gateway'

export type ProviderStatus = 'connected' | 'untested' | 'error' | 'missing_key'

/** A configured provider as the UI sees it. Never contains the secret itself. */
export interface ProviderConfig {
  id: ProviderId
  label: string
  kind: ProviderKind
  baseUrl?: string            // custom OpenAI-compatible endpoint
  hasKey: boolean             // a key/token is stored (encrypted) in the control plane
  models: ModelId[]           // registry ids this provider serves
  status: ProviderStatus
}

/** Model registry entry. Models stay monochrome in the UI; tier is shown with pips. */
export interface ModelInfo {
  id: ModelId
  provider: ProviderId
  name: string                // "Opus 5.5"
  short: string               // "OPUS"
  pips: string                // "◆◆◆"
  power: number               // 1–5
  speed: number               // 1–5
  costEff: number             // 1–5
  cliModel: string            // value passed to `claude --model`
  experimental?: boolean      // non-Claude models driven through the gateway
}

/** The four Claude models are always present. Ids match the design's original `ModelId` union. */
export const BUILTIN_MODELS: readonly ModelInfo[] = [
  { id: 'fable-5.1',  provider: 'claude-subscription', name: 'Fable 5.1',  short: 'FAB',  pips: '◆◆◆◆', power: 5, speed: 2, costEff: 1, cliModel: 'claude-fable-5-1' },
  { id: 'opus-5.5',   provider: 'claude-subscription', name: 'Opus 5.5',   short: 'OPUS', pips: '◆◆◆',  power: 5, speed: 2, costEff: 2, cliModel: 'claude-opus-5-5' },
  { id: 'sonnet-5.5', provider: 'claude-subscription', name: 'Sonnet 5.5', short: 'SON',  pips: '◆◆',   power: 4, speed: 4, costEff: 4, cliModel: 'claude-sonnet-5-5' },
  { id: 'haiku-5.5',  provider: 'claude-subscription', name: 'Haiku 5.5',  short: 'HAI',  pips: '◆',    power: 2, speed: 5, costEff: 5, cliModel: 'claude-haiku-5-5' },
]

export const BUILTIN_MODEL_IDS = ['fable-5.1', 'opus-5.5', 'sonnet-5.5', 'haiku-5.5'] as const

/** Look a model up in a registry (defaults to the built-ins). */
export function findModel(id: ModelId, registry: readonly ModelInfo[] = BUILTIN_MODELS): ModelInfo | undefined {
  return registry.find((m) => m.id === id)
}

// ── Agents ──────────────────────────────────────────────────────────────────────

export type RoleId = 'orchestrator' | 'frontend' | 'backend' | 'qa' | 'devops' | 'researcher' | 'custom'

export const ROLE_IDS = ['orchestrator', 'frontend', 'backend', 'qa', 'devops', 'researcher', 'custom'] as const satisfies readonly RoleId[]

export type AgentStatus =
  | 'idle' | 'thinking' | 'running' | 'editing'
  | 'waiting' /* on you */ | 'blocked' | 'error' | 'paused' | 'done'
  | 'booting' /* container starting — renders as dashed "run" */

export const AGENT_STATUSES = [
  'idle', 'thinking', 'running', 'editing', 'waiting', 'blocked', 'error', 'paused', 'done', 'booting',
] as const satisfies readonly AgentStatus[]

export type Controller = 'agent' | 'you'

/** Dev Supabase stack of a project (docs/phase4.md). `url` / `dbUrl` are host URLs for the commander. */
export interface SupabaseInfo {
  status: 'running' | 'stopped' | 'provisioning' | 'error' | 'none'
  url?: string
  studioUrl?: string
  dbUrl?: string
  /** Latest applied migration version. */
  migration?: string
  /** Studio + pg_meta also run (more RAM). */
  studio?: boolean
  /** Stable port slot: ports 55300 + 10*slot … +9. */
  slot?: number
  error?: string
}

export interface SupabaseMigration { version: string; name: string }

/** GET /api/projects/:id/supabase */
export interface SupabaseDetails extends SupabaseInfo { migrations: SupabaseMigration[] }

export interface Project {
  id: ID
  key: number                 // 1–9, keyboard slot
  name: string
  repoUrl?: string
  stack: string[]
  goal: string                // sent to the Orchestrator
  health: { score: number; label: 'stable' | 'strained' | 'dormant' | 'down' } // score 0–10
  supabase: SupabaseInfo
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
  provider: ProviderId
  model: ModelId              // registry id, see ModelInfo
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

// ── Quests ──────────────────────────────────────────────────────────────────────

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

// ── Merge approvals ─────────────────────────────────────────────────────────────

export type MergeRequestStatus = 'pending' | 'approved' | 'changes_requested' | 'merged'

/**
 * A request to merge an agent branch into `main`. The Orchestrator can only *request*;
 * this raises an `approval` alert and opens Merge Review (/review/:pr).
 *
 * HARD RULE: merging to `main` requires `approvedBy === 'you'` (a recorded human approval,
 * with `approvedAt`). `merge_branch` must refuse otherwise. There is no setting to disable
 * this in v1. Use `canMergeToMain()` rather than re-implementing the check.
 */
export interface MergeRequest {
  id: ID
  projectId: ID
  branch: string
  prNumber?: number
  requestedBy: ID | 'you'     // usually the Orchestrator's agent id
  status: MergeRequestStatus
  approvedBy?: 'you'          // only a human can approve; agents can never set this
  approvedAt?: ISODate
  questId?: ID                // the quest this merge closes (Phase 3)
  summary?: string            // the requester's at-a-glance summary for the commander
}

/** The one check every merge path must pass. */
export function canMergeToMain(mr: MergeRequest): boolean {
  return mr.status === 'approved' && mr.approvedBy === 'you' && typeof mr.approvedAt === 'string' && mr.approvedAt.length > 0
}

// ── Alerts ──────────────────────────────────────────────────────────────────────

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

// ── Usage, resources, guards ────────────────────────────────────────────────────

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
