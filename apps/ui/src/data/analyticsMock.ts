// Mock-mode numbers for Settings → Spend & usage, derived from the mock agents so they line
// up with the rest of the mock UI. Deterministic: same input, same chart.
import { findModel, modelCostWeight, type Agent, type Analytics, type AnalyticsDays, type Project, type Recommendation, type UsageTotals } from '@/types/colony'

interface Row { day: string; projectId: string; role: string; model: string; costUsd: number; tokens: number; questsDone: number; questsFailed: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Tokens per dollar, roughly inverse to price. */
const TOKENS_PER_USD: Record<string, number> = { 'fable-5.1': 40_000, 'opus-5.5': 100_000, 'sonnet-5.5': 200_000, 'haiku-5.5': 1_500_000 }

const empty = (): UsageTotals => ({ costUsd: 0, tokens: 0, questsDone: 0, questsFailed: 0, costPerQuestUsd: null })
function fin<T extends UsageTotals>(t: T): T {
  t.costUsd = round2(t.costUsd)
  t.costPerQuestUsd = t.questsDone ? round2(t.costUsd / t.questsDone) : null
  return t
}
function group<T extends UsageTotals>(rows: Row[], key: (r: Row) => string, make: (k: string) => T): T[] {
  const m = new Map<string, T>()
  for (const r of rows) {
    const k = key(r)
    const t = m.get(k) ?? make(k)
    m.set(k, t)
    t.costUsd += r.costUsd; t.tokens += r.tokens; t.questsDone += r.questsDone; t.questsFailed += r.questsFailed
  }
  return [...m.values()].map(fin).sort((a, b) => b.costUsd - a.costUsd)
}

export function mockAnalytics(days: AnalyticsDays, agents: Agent[], projects: Project[], now = new Date()): Analytics {
  const dayList = Array.from({ length: days }, (_, i) => dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i))))
  const rows: Row[] = []
  agents.forEach((a, ai) => {
    const base = a.spendTodayUsd || 0.6
    dayList.forEach((day, di) => {
      const weekend = new Date(`${day}T12:00:00`).getDay() % 6 === 0
      const wobble = 0.55 + ((ai * 7 + di * 13) % 10) / 12
      const costUsd = round2(base * wobble * (weekend ? 0.35 : 1))
      const questsDone = (ai + di) % (a.role === 'orchestrator' ? 99 : a.role === 'qa' ? 2 : 3) === 0 ? 1 : 0
      rows.push({
        day, projectId: a.projectId, role: a.role, model: a.model, costUsd,
        tokens: Math.round(costUsd * (TOKENS_PER_USD[a.model] ?? 150_000)),
        questsDone, questsFailed: a.status === 'error' && di === days - 1 ? 1 : 0,
      })
    })
  })

  const totals = fin(rows.reduce((t, r) => { t.costUsd += r.costUsd; t.tokens += r.tokens; t.questsDone += r.questsDone; t.questsFailed += r.questsFailed; return t }, empty()))
  const daily = dayList.map((day) => {
    const rs = rows.filter((r) => r.day === day)
    return { day, costUsd: round2(rs.reduce((n, r) => n + r.costUsd, 0)), tokens: rs.reduce((n, r) => n + r.tokens, 0), questsDone: rs.reduce((n, r) => n + r.questsDone, 0) }
  })
  const byProject = group(rows, (r) => r.projectId, (projectId) => ({ ...empty(), projectId, name: projects.find((p) => p.id === projectId)?.name ?? 'Removed base' }))
  const byRole = group(rows, (r) => r.role, (role) => ({ ...empty(), role: role as Agent['role'] }))
  const byModel = group(rows, (r) => r.model, (model) => ({ ...empty(), model, name: findModel(model)?.name ?? model }))

  // Same shape as the control plane's rules, on the mock numbers.
  const recommendations: Recommendation[] = []
  const perWeek = 7 / days
  const pair = (role: string, model: string) => fin(rows.filter((r) => r.role === role && r.model === model).reduce((t, r) => {
    t.costUsd += r.costUsd; t.tokens += r.tokens; t.questsDone += r.questsDone; t.questsFailed += r.questsFailed; return t
  }, empty()))
  const res = pair('frontend', 'sonnet-5.5')
  if (res.questsDone && !res.questsFailed) {
    const w = modelCostWeight('sonnet-5.5')! / modelCostWeight('haiku-5.5')!
    const s = round2(res.costUsd * perWeek * (1 - 1 / w))
    recommendations.push({
      id: 'downshift-frontend-sonnet-5.5', confidence: 'medium', savingsUsdPerWeek: s,
      title: `Frontend agents on Haiku 5.5 would save about $${s.toFixed(2)}/week`,
      detail: `Frontend agents on Sonnet 5.5 finished ${res.questsDone} quests with no failures for $${res.costUsd.toFixed(2)} ($${res.costPerQuestUsd?.toFixed(2)} per quest) in the last ${days} days. Haiku 5.5 costs about ${w}× less per token. This role writes production code, so try it on one agent first.`,
    })
  }
  const orc = pair('orchestrator', 'opus-5.5')
  if (orc.costUsd) {
    const s = round2(orc.costUsd * perWeek * 0.5)
    recommendations.push({
      id: 'orchestrator-opus-5.5', confidence: 'low', savingsUsdPerWeek: s,
      title: `Sonnet 5.5 may suffice for orchestrators (about $${s.toFixed(2)}/week)`,
      detail: `Orchestrators on Opus 5.5 averaged ${Math.round(orc.tokens / (days * 2) / 1000)}k tokens per active day, costing $${orc.costUsd.toFixed(2)} in the last ${days} days. Light planning loads usually run fine on Sonnet 5.5, about 2× cheaper per token.`,
    })
  }
  recommendations.sort((a, b) => (b.savingsUsdPerWeek ?? 0) - (a.savingsUsdPerWeek ?? 0))
  return { days, from: dayList[0], to: dayList[days - 1], totals, daily, byProject, byRole, byModel, recommendations }
}
