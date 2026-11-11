// Cost analytics wire types (docs/phase6.md §4): GET /api/analytics?days=7|30.

import type { ID, ModelId, RoleId } from './domain'

export type AnalyticsDays = 7 | 30
export const ANALYTICS_DAYS = [7, 30] as const satisfies readonly AnalyticsDays[]

/** Totals for one slice of usage. `costPerQuestUsd` is null when no quest was finished. */
export interface UsageTotals {
  costUsd: number
  tokens: number
  questsDone: number
  questsFailed: number
  costPerQuestUsd: number | null
}

export interface AnalyticsDay { day: string; costUsd: number; tokens: number; questsDone: number }

export interface ProjectUsage extends UsageTotals { projectId: ID; name: string }
/** `role` / `model` are 'unknown' for usage recorded before they were tracked. */
export interface RoleUsage extends UsageTotals { role: RoleId | 'unknown' }
export interface ModelUsage extends UsageTotals { model: ModelId | 'unknown'; name: string }

export type RecommendationConfidence = 'low' | 'medium' | 'high'

export interface Recommendation {
  id: string
  title: string
  /** States the numbers the rule used. */
  detail: string
  savingsUsdPerWeek?: number
  confidence: RecommendationConfidence
}

export interface Analytics {
  days: AnalyticsDays
  /** Local YYYY-MM-DD, inclusive. */
  from: string
  to: string
  totals: UsageTotals
  daily: AnalyticsDay[]
  byProject: ProjectUsage[]
  byRole: RoleUsage[]
  byModel: ModelUsage[]
  recommendations: Recommendation[]
  /** Why `recommendations` is empty, when it is. */
  note?: string
}

/**
 * Relative per-token price of each built-in model, used to estimate savings from switching
 * models. The registry has no prices, so they live here. Ratios follow Anthropic's list prices
 * (input and output scale together): Fable 5.1 $10/$50, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10,
 * Haiku 5.5 $0.10/$0.50 per million tokens. Update with the price list.
 */
export const MODEL_COST_WEIGHT: Readonly<Record<string, number>> = {
  'fable-5.1': 100,
  'opus-5.5': 40,
  'sonnet-5.5': 20,
  'haiku-5.5': 1,
}

/** Relative price of a model, or undefined when we don't know it (no estimate is made). */
export function modelCostWeight(id: ModelId): number | undefined {
  return MODEL_COST_WEIGHT[id]
}
