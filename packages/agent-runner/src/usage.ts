// Per-turn cost for `usage.costUsd`.
//
// Claude Code reports `total_cost_usd` cumulatively for the *session*: verified against the real
// CLI, a process started with `--resume` continues from the session's previous total rather than
// restarting at 0. Newer CLIs also attach `model_usage_since_last_result: {<model>: {costUSD}}`,
// which is exactly this turn's cost; prefer it when present.

export interface CostTracker {
  sessionId?: string
  lastTotal: number
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const round = (n: number) => Math.round(n * 1e10) / 1e10

/** Returns this result's cost (or undefined if unknown) and updates `tracker`. */
export function turnCost(result: Record<string, unknown>, tracker: CostTracker): number | undefined {
  const total = num(result.total_cost_usd)
  const sessionId = typeof result.session_id === 'string' ? result.session_id : undefined
  if (sessionId && sessionId !== tracker.sessionId) {
    tracker.sessionId = sessionId
    tracker.lastTotal = 0 // a different session counts from zero
  }

  let cost: number | undefined
  const since = result.model_usage_since_last_result
  if (since && typeof since === 'object') {
    let sum = 0
    let any = false
    for (const m of Object.values(since as Record<string, unknown>)) {
      const c = m && typeof m === 'object' ? num((m as Record<string, unknown>).costUSD) : undefined
      if (c !== undefined) { sum += c; any = true }
    }
    if (any) cost = round(sum)
  }
  if (cost === undefined && total !== undefined) {
    // A total below the last one means the CLI restarted its count: the whole total is this turn.
    cost = round(total >= tracker.lastTotal ? total - tracker.lastTotal : total)
  }
  if (total !== undefined) tracker.lastTotal = total
  return cost
}
