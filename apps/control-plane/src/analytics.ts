// Cost analytics (docs/phase6.md §4): spend and quests per day, project, role and model from
// usage_daily, plus a few explainable "you could spend less" rules.
//
// usage_daily is keyed by (day, agent): role/model are the agent's at its last write that day,
// so an agent that switched model mid-day is counted under the newer model for that day.

import type { FastifyInstance } from 'fastify'
import {
  ANALYTICS_DAYS, findModel, modelCostWeight,
  type Analytics, type AnalyticsDays, type ModelUsage, type ProjectUsage, type Recommendation,
  type RecommendationConfidence, type RoleUsage, type UsageTotals,
} from '@colony/shared'
import type { Db } from './db'
import { badRequest } from './errors'
import { localDay, type Store } from './store'

/** Below either of these there is too little data to recommend anything. */
export const MIN_COST_USD = 1
export const MIN_QUESTS = 3

/** Rule A: a worker role/model pair qualifies with at least this many quests done, none failed,
 *  and at most this much spend per quest done. */
export const DOWNSHIFT_MIN_QUESTS = 3
export const DOWNSHIFT_MAX_COST_PER_QUEST = 1.5
/** Rule B: an orchestrator on Opus/Fable using fewer tokens than this per agent-day on average. */
export const ORCH_MAX_TOKENS_PER_DAY = 300_000
/** Recommendations saving less than this per week are noise. */
export const MIN_SAVINGS_PER_WEEK = 0.1

const WORKER_TARGET = 'haiku-5.5'
const ORCH_TARGET = 'sonnet-5.5'
const ORCH_HEAVY = new Set(['opus-5.5', 'fable-5.1'])
/** Roles that write production code: a cheaper model is a bigger gamble there. */
const CODE_ROLES = new Set(['frontend', 'backend', 'devops', 'custom'])

interface UsageRow {
  day: string; agentId: string; projectId: string; role: string; model: string
  costUsd: number; tokens: number; questsDone: number; questsFailed: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `$${n.toFixed(2)}`
const tokensLabel = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const ROLE_LABEL: Record<string, string> = {
  orchestrator: 'Orchestrator', frontend: 'Frontend', backend: 'Backend', qa: 'QA', devops: 'DevOps', researcher: 'Researcher', custom: 'Custom',
}
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r
const modelName = (m: string) => (m === 'unknown' ? 'Unknown' : findModel(m)?.name ?? m)

export function parseDays(raw: unknown): AnalyticsDays {
  if (raw === undefined || raw === '') return 7
  const n = Number(raw)
  if (!(ANALYTICS_DAYS as readonly number[]).includes(n) || String(raw).trim() !== String(n)) throw badRequest("'days' must be 7 or 30")
  return n as AnalyticsDays
}

function emptyTotals(): UsageTotals { return { costUsd: 0, tokens: 0, questsDone: 0, questsFailed: 0, costPerQuestUsd: null } }
function add(t: UsageTotals, r: UsageRow) {
  t.costUsd += r.costUsd; t.tokens += r.tokens; t.questsDone += r.questsDone; t.questsFailed += r.questsFailed
}
function finish<T extends UsageTotals>(t: T): T {
  t.costUsd = round2(t.costUsd)
  t.costPerQuestUsd = t.questsDone > 0 ? round2(t.costUsd / t.questsDone) : null
  return t
}
function groupBy<T extends UsageTotals>(rows: UsageRow[], key: (r: UsageRow) => string, make: (k: string) => T): T[] {
  const m = new Map<string, T>()
  for (const r of rows) {
    const k = key(r)
    let t = m.get(k)
    if (!t) m.set(k, (t = make(k)))
    add(t, r)
  }
  return [...m.values()].map(finish).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
}

const confidenceFor = (quests: number): RecommendationConfidence => (quests >= 10 ? 'high' : quests >= 5 ? 'medium' : 'low')
const capAt = (c: RecommendationConfidence, max: RecommendationConfidence): RecommendationConfidence => {
  const order: RecommendationConfidence[] = ['low', 'medium', 'high']
  return order[Math.min(order.indexOf(c), order.indexOf(max))]
}

/** The recommendation rules, on rows already limited to the window. */
export function recommend(rows: UsageRow[], days: number, totals: UsageTotals): { recommendations: Recommendation[]; note?: string } {
  if (totals.costUsd < MIN_COST_USD || totals.questsDone < MIN_QUESTS) {
    return {
      recommendations: [],
      note: `Not enough data for recommendations yet: ${money(totals.costUsd)} spent and ${totals.questsDone} quest${totals.questsDone === 1 ? '' : 's'} done in the last ${days} days (needs at least ${money(MIN_COST_USD)} and ${MIN_QUESTS} quests).`,
    }
  }
  const perWeek = 7 / days
  const out: Recommendation[] = []
  const pairs = groupBy(rows, (r) => `${r.role}\u0000${r.model}`, (k) => {
    const [role, model] = k.split('\u0000')
    return { ...emptyTotals(), role, model, agentDays: 0 }
  })
  for (const r of rows) {
    const p = pairs.find((x) => x.role === r.role && x.model === r.model)
    if (p) p.agentDays++
  }

  for (const p of pairs) {
    if (p.role === 'unknown' || p.model === 'unknown') continue
    const from = modelCostWeight(p.model)
    if (from === undefined) continue

    // (a) A worker role finishing cheap quests without failures on a pricier model → Haiku.
    if (p.role !== 'orchestrator') {
      const to = modelCostWeight(WORKER_TARGET)!
      if (from <= to) continue
      if (p.questsDone < DOWNSHIFT_MIN_QUESTS || p.questsFailed > 0) continue
      const cpq = p.costUsd / p.questsDone
      if (cpq > DOWNSHIFT_MAX_COST_PER_QUEST) continue
      const savings = round2(p.costUsd * perWeek * (1 - to / from))
      if (savings < MIN_SAVINGS_PER_WEEK) continue
      const conf = confidenceFor(p.questsDone)
      out.push({
        id: `downshift-${p.role}-${p.model}`,
        title: `${roleLabel(p.role)} agents on ${modelName(WORKER_TARGET)} would save about ${money(savings)}/week`,
        detail: `${roleLabel(p.role)} agents on ${modelName(p.model)} finished ${p.questsDone} quests with no failures for ${money(p.costUsd)} (${money(cpq)} per quest) in the last ${days} days. `
          + `${modelName(WORKER_TARGET)} costs about ${Math.round(from / to)}× less per token, so the same work would cost about ${money(p.costUsd * (to / from) * perWeek)}/week instead of ${money(p.costUsd * perWeek)}/week.`
          + (CODE_ROLES.has(p.role) ? ' This role writes production code, so try it on one agent first.' : ''),
        savingsUsdPerWeek: savings,
        confidence: CODE_ROLES.has(p.role) ? capAt(conf, 'medium') : conf,
      })
      continue
    }

    // (b) An orchestrator on Opus/Fable with light token volume → Sonnet may suffice.
    if (!ORCH_HEAVY.has(p.model) || p.agentDays === 0) continue
    const perDay = p.tokens / p.agentDays
    if (perDay >= ORCH_MAX_TOKENS_PER_DAY) continue
    const to = modelCostWeight(ORCH_TARGET)!
    const savings = round2(p.costUsd * perWeek * (1 - to / from))
    if (savings < MIN_SAVINGS_PER_WEEK) continue
    out.push({
      id: `orchestrator-${p.model}`,
      title: `${modelName(ORCH_TARGET)} may suffice for orchestrators (about ${money(savings)}/week)`,
      detail: `Orchestrators on ${modelName(p.model)} averaged ${tokensLabel(Math.round(perDay))} tokens per active day over ${p.agentDays} agent-day${p.agentDays === 1 ? '' : 's'} `
        + `(under ${tokensLabel(ORCH_MAX_TOKENS_PER_DAY)}), costing ${money(p.costUsd)} in the last ${days} days. Light planning loads usually run fine on ${modelName(ORCH_TARGET)}, `
        + `about ${Math.round(from / to)}× cheaper per token.`,
      savingsUsdPerWeek: savings,
      confidence: p.agentDays >= 5 ? 'medium' : 'low',
    })
  }
  out.sort((a, b) => (b.savingsUsdPerWeek ?? 0) - (a.savingsUsdPerWeek ?? 0))
  return out.length ? { recommendations: out } : { recommendations: [], note: `No savings found: nothing in the last ${days} days matched a rule.` }
}

export class AnalyticsService {
  constructor(private db: Db, private store: Store) {}

  compute(days: AnalyticsDays, now = new Date()): Analytics {
    const dayList: string[] = []
    for (let i = days - 1; i >= 0; i--) dayList.push(localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
    const from = dayList[0], to = dayList[dayList.length - 1]
    const rows: UsageRow[] = this.db.all(
      `SELECT day, agent_id, project_id, role, model, cost_usd, tokens, quests_done, quests_failed
       FROM usage_daily WHERE day >= ? AND day <= ?`, from, to,
    ).map((r) => ({
      day: String(r.day), agentId: String(r.agent_id), projectId: String(r.project_id),
      role: (r.role as string | null) || 'unknown', model: (r.model as string | null) || 'unknown',
      costUsd: Number(r.cost_usd ?? 0), tokens: Number(r.tokens ?? 0),
      questsDone: Number(r.quests_done ?? 0), questsFailed: Number(r.quests_failed ?? 0),
    }))

    const totals = emptyTotals()
    for (const r of rows) add(totals, r)
    finish(totals)

    const byDay = new Map(dayList.map((d) => [d, { day: d, costUsd: 0, tokens: 0, questsDone: 0 }]))
    for (const r of rows) {
      const d = byDay.get(r.day)!
      d.costUsd += r.costUsd; d.tokens += r.tokens; d.questsDone += r.questsDone
    }
    const daily = [...byDay.values()].map((d) => ({ ...d, costUsd: round2(d.costUsd) }))

    const byProject: ProjectUsage[] = groupBy(rows, (r) => r.projectId, (projectId) => ({
      ...emptyTotals(), projectId, name: this.store.projects.get(projectId)?.project.name ?? 'Removed base',
    }))
    const byRole: RoleUsage[] = groupBy(rows, (r) => r.role, (role) => ({ ...emptyTotals(), role: role as RoleUsage['role'] }))
    const byModel: ModelUsage[] = groupBy(rows, (r) => r.model, (model) => ({ ...emptyTotals(), model, name: modelName(model) }))

    return { days, from, to, totals, daily, byProject, byRole, byModel, ...recommend(rows, days, totals) }
  }
}

export function registerAnalyticsRoutes(app: FastifyInstance, analytics: AnalyticsService) {
  app.get('/api/analytics', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return analytics.compute(parseDays(Array.isArray(q.days) ? q.days[0] : q.days))
  })
}
