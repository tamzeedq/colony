// Shared pieces of the Colony MCP tools: argument parsing, JSON-schema shorthands, views, and
// the context every role's tool set is built from.
import { ROLE_IDS, type ActivityEvent, type Quest } from '@colony/shared'
import type { AgentManager } from '../agents'
import type { InfraDriver } from '../infra/types'
import type { MergeService } from '../projects'
import type { AcceptanceInput, QuestService } from '../quests'
import type { AgentRecord, Store } from '../store'
import type { SupabaseService } from '../supabase'

export interface McpDeps {
  store: Store
  agents: AgentManager
  quests: QuestService
  merges: MergeService
  infra: InfraDriver
  /** Optional so older tests can build tools without it. */
  supabase?: SupabaseService
}

export type Args = Record<string, unknown>
export type Json = Record<string, unknown>

export interface Tool {
  name: string
  description: string
  inputSchema: Json
  roles: 'orchestrator' | 'worker' | 'all'
  run(a: Args, me: AgentRecord): Promise<unknown> | unknown
}

export class ToolError extends Error {}

// ── argument helpers ──────────────────────────────────────────────────────────

export function s(a: Args, k: string, req: true, max?: number): string
export function s(a: Args, k: string, req?: false, max?: number): string | undefined
export function s(a: Args, k: string, req = false, max = 20_000): string | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') {
    if (req) throw new ToolError(`'${k}' is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolError(`'${k}' must be a string`)
  const t = v.trim()
  if (req && !t) throw new ToolError(`'${k}' must not be empty`)
  if (t.length > max) throw new ToolError(`'${k}' is longer than ${max} characters`)
  return t
}
export function list(a: Args, k: string, max = 50): string[] | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`'${k}' must be an array of strings`)
  if (v.length > max) throw new ToolError(`'${k}' has more than ${max} items`)
  return (v as string[]).map((x) => x.trim()).filter(Boolean)
}
/** Acceptance criteria: strings ("[human] …" allowed) or { text, check: 'agent' | 'human' }. */
export function acceptanceList(a: Args, k: string, max = 20): AcceptanceInput[] | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new ToolError(`'${k}' must be an array`)
  if (v.length > max) throw new ToolError(`'${k}' has more than ${max} items`)
  return v.map((x, i) => {
    if (typeof x === 'string') return x
    if (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') {
      const check = (x as { check?: unknown }).check
      if (check !== undefined && check !== 'agent' && check !== 'human') throw new ToolError(`'${k}[${i}].check' must be "agent" or "human"`)
      return { text: (x as { text: string }).text, ...(check ? { check: check as 'agent' | 'human' } : {}) }
    }
    throw new ToolError(`'${k}[${i}]' must be a string or { text, check }`)
  }).filter((x) => (typeof x === 'string' ? x.trim() : x.text.trim()))
}
export const acceptanceSchema = {
  type: 'array',
  description: 'Objectively checkable criteria. Mark each with who can check it: check "agent" (a QA agent can verify it by running tests, typecheck, lint, a script, grep or a headless browser) or check "human" (needs the commander: visual/UX judgement, real accounts or devices, anything with no automatable check).',
  items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, check: { type: 'string', enum: ['agent', 'human'] } }, required: ['text'] }] },
}

export function n(a: Args, k: string, min = 0): number | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new ToolError(`'${k}' must be a number ≥ ${min}`)
  return v
}

export const str = { type: 'string' }
export const strArr = { type: 'array', items: { type: 'string' } }
export const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}\n… (clipped, ${t.length - max} more characters)` : t)

// ── views ─────────────────────────────────────────────────────────────────────

export function questView(q: Quest, store: Store) {
  return {
    id: q.id, title: q.title, status: q.status, priority: q.priority,
    assignee: q.assigneeId ? store.agents.get(q.assigneeId)?.agent.callsign ?? q.assigneeId : null,
    assigneeId: q.assigneeId ?? null, branch: q.branch ?? null, dependsOn: q.dependsOn,
    acceptance: q.acceptance.map((x, i) => {
      const v = x.verification
      const state = v ? `${v.result === 'pass' ? 'PASS' : 'FAIL'} by ${v.by === 'you' ? 'the commander' : store.agents.get(v.by)?.agent.callsign ?? v.by}` : x.claimed ? 'claimed by worker, not verified' : 'not verified'
      return `${i}. [${x.done ? 'x' : ' '}] ${x.text} (${(x.check ?? 'agent') === 'human' ? 'commander checks' : 'agent-checkable'}; ${state})`
    }),
    verifier: q.verifierId ? store.agents.get(q.verifierId)?.agent.callsign ?? q.verifierId : null,
    brief: q.brief,
  }
}

export function agentView(rec: AgentRecord, store: Store) {
  const a = store.toAgent(rec)
  return {
    id: a.id, callsign: a.callsign, role: a.role, model: a.model, status: a.status, controller: a.controller,
    currentQuest: a.currentTaskId ?? null, currentAction: a.currentAction ?? '', branch: a.branch ?? null,
    contextPct: a.contextPct, spendTodayUsd: Math.round(a.spendTodayUsd * 100) / 100, budgetCapUsd: a.budgetCapUsd,
    questsDone: a.questsDone, connected: store.connected.has(a.id),
  }
}

export function eventLine(e: ActivityEvent): string {
  const t = e.at.slice(11, 19)
  const extra = e.command?.exitCode !== undefined ? ` (exit ${e.command.exitCode})` : ''
  return `${t} ${e.kind}: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}${extra}`
}

// ── context ───────────────────────────────────────────────────────────────────

export const WORKER_ROLES = ROLE_IDS.filter((r) => r !== 'orchestrator')

export interface ToolContext extends McpDeps {
  /** An agent in the caller's project, by id or callsign. */
  peer(id: string, me: AgentRecord): AgentRecord
  /** The caller's project slug. */
  slug(me: AgentRecord): string
  askHuman(a: Args, me: AgentRecord): unknown
}

export function toolContext(d: McpDeps): ToolContext {
  const { store } = d
  const peer = (id: string, me: AgentRecord): AgentRecord => {
    const rec = store.agents.get(id) ?? [...store.agents.values()].find((r) => r.agent.callsign.toLowerCase() === id.toLowerCase())
    if (!rec || rec.agent.projectId !== me.agent.projectId) throw new ToolError(`no agent '${id}' in this project (use list_agents)`)
    return rec
  }
  const slug = (me: AgentRecord) => store.projects.get(me.agent.projectId)!.slug

  const askHuman = (a: Args, me: AgentRecord) => {
    const question = s(a, 'question', true, 2000)
    const options = (list(a, 'options', 6) ?? []).map((o) => o.slice(0, 80))
    const alert = store.raiseAlert({
      kind: 'question', severity: 'needs_you', projectId: me.agent.projectId, agentId: me.agent.id,
      title: `${me.agent.callsign}: ${question}`, detail: s(a, 'detail', false, 4000),
      actions: [...options.map((o) => ({ id: `reply:${o}`, label: o })), { id: 'dismiss', label: 'Dismiss' }],
    })
    store.patchAgent(me.agent.id, { status: 'waiting' })
    return { ok: true, alertId: alert.id, note: 'The commander has been asked. Their answer will arrive as a message; keep working on anything it does not block.' }
  }

  return { ...d, peer, slug, askHuman }
}
