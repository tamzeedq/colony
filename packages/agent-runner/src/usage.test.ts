import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnCost, type CostTracker } from './usage'

test('turnCost: cumulative delta per session, continuing across resume', () => {
  const t: CostTracker = { lastTotal: 0 }
  assert.equal(turnCost({ session_id: 's1', total_cost_usd: 0.03 }, t), 0.03)
  assert.equal(turnCost({ session_id: 's1', total_cost_usd: 0.0334 }, t), 0.0034)
  // resumed process: total continues from the session's previous value
  assert.equal(turnCost({ session_id: 's1', total_cost_usd: 0.0348 }, t), 0.0014)
  // a new session counts from zero
  assert.equal(turnCost({ session_id: 's2', total_cost_usd: 0.002 }, t), 0.002)
  // a total that went down is taken whole
  assert.equal(turnCost({ session_id: 's2', total_cost_usd: 0.001 }, t), 0.001)
  assert.equal(turnCost({ session_id: 's2' }, t), undefined)
})

test('turnCost: prefers model_usage_since_last_result', () => {
  const t: CostTracker = { lastTotal: 0, sessionId: 's1' }
  const cost = turnCost({
    session_id: 's1', total_cost_usd: 0.5,
    model_usage_since_last_result: { a: { costUSD: 0.001 }, b: { costUSD: 0.0002 } },
  }, t)
  assert.equal(cost, 0.0012)
  assert.equal(t.lastTotal, 0.5)
})
