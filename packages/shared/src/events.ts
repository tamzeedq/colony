// Colony wire protocol: zod schemas + inferred types for every message that crosses a socket.
//
//   agent-runner  ──RunnerMessage──▶  control plane  ──UiStreamMessage──▶  UI
//   agent-runner  ◀─RunnerCommand───  control plane
//
// All messages are JSON objects discriminated by `type`. Validate at every boundary with
// the `parse*` helpers; they never throw.
//
// ActivityEvent upsert rule: an event whose `id` was already seen REPLACES the earlier one.
// This is how a running command later gains its exit code / output tail, and how an edit is
// marked failed, without inventing extra event kinds.

import { z } from 'zod'
import { AGENT_STATUSES } from './domain'
import type { Agent, Alert, Project, Quest, Resources, MergeRequest, ProviderConfig, ModelInfo, PlanUsage } from './domain'

export const PROTOCOL_VERSION = 1

// ── Activity events (design names, end to end) ─────────────────────────────────

export const ACTIVITY_KINDS = [
  'thought', 'tool', 'command', 'edit', 'test', 'message', 'handoff', 'status', 'quest_complete',
] as const

export const ActivityKindSchema = z.enum(ACTIVITY_KINDS)
export type ActivityKind = z.infer<typeof ActivityKindSchema>

export const AgentStatusSchema = z.enum(AGENT_STATUSES)

export const ActivityEventSchema = z.object({
  id: z.string(),
  at: z.string(),             // ISODate
  agentId: z.string(),
  projectId: z.string(),
  kind: ActivityKindSchema,
  text: z.string(),
  // kind-specific payloads
  command: z.object({
    cmd: z.string(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().optional(),
    outputTail: z.string().optional(),
    running: z.boolean().optional(),
  }).optional(),
  edit: z.object({
    path: z.string(),
    added: z.number(),
    removed: z.number(),
    hunk: z.string().optional(),
  }).optional(),
  test: z.object({
    passed: z.number(),
    failed: z.number(),
    running: z.number(),
    coveragePct: z.number().optional(),
  }).optional(),
  message: z.object({ to: z.string(), body: z.string() }).optional(),
  tool: z.object({ name: z.string(), target: z.string().optional() }).optional(),
  /** New status carried by `kind: 'status'` events (addition to the design's shape). */
  status: AgentStatusSchema.optional(),
})
export type ActivityEvent = z.infer<typeof ActivityEventSchema>

// ── Runner → control plane ─────────────────────────────────────────────────────

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  /** Cost of this turn in USD (a delta, not a running total). Absent on subscription if unknown. */
  costUsd: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const RunnerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), agentId: z.string(), sessionId: z.string().optional(), protocol: z.number().int().optional() }),
  z.object({ type: z.literal('event'), event: ActivityEventSchema }),
  z.object({ type: z.literal('status'), agentId: z.string(), status: AgentStatusSchema }),
  UsageSchema.extend({ type: z.literal('usage') }),
  z.object({
    type: z.literal('result'),
    sessionId: z.string().optional(),
    subtype: z.string(),      // 'success' | 'error_max_turns' | 'error_during_execution' | …
    isError: z.boolean(),
    text: z.string().optional(),
    durationMs: z.number().optional(),
    numTurns: z.number().optional(),
    totalCostUsd: z.number().optional(), // as reported by Claude Code (cumulative for the session)
  }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean().optional() }),
  /** Subscription usage snapshot read from Claude Code's rate_limit_event (see parseRateLimitEvent). */
  z.object({ type: z.literal('plan_usage'), usage: z.custom<PlanUsage>((v) => typeof v === 'object' && v !== null) }),
  /** Workspace ready: cloned and on its branch. */
  z.object({ type: z.literal('workspace'), branch: z.string(), headSha: z.string().optional() }),
])
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>

// ── Control plane → runner ─────────────────────────────────────────────────────

export const RunnerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), text: z.string() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('set_model'), model: z.string() }), // registry ModelId; runner maps to cliModel
  z.object({ type: z.literal('shutdown') }),
])
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>

// ── Control plane → UI ─────────────────────────────────────────────────────────
// The control plane is trusted by the UI, so domain objects are only checked to be objects;
// their shape is the TypeScript interface from ./domain. ActivityEvent is fully validated.

const obj = <T>() => z.custom<T>((v) => typeof v === 'object' && v !== null && !Array.isArray(v))

export const SnapshotSchema = z.object({
  projects: z.array(obj<Project>()),
  agents: z.array(obj<Agent>()),
  quests: z.array(obj<Quest>()),
  alerts: z.array(obj<Alert>()),
  resources: obj<Resources>(),
  events: z.array(ActivityEventSchema).optional(),   // recent backlog
  mergeRequests: z.array(obj<MergeRequest>()).optional(),
  providers: z.array(obj<ProviderConfig>()).optional(),
  models: z.array(obj<ModelInfo>()).optional(),       // full registry (built-ins + added)
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const UiStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: SnapshotSchema, protocol: z.number().int().optional() }),
  /** Partial update of one agent; `patch` is merged into the stored Agent. */
  z.object({ type: z.literal('agent_delta'), agentId: z.string(), patch: obj<Partial<Agent>>() }),
  z.object({ type: z.literal('event'), event: ActivityEventSchema }),
  /** New or updated alert (upsert by id; `resolvedAt` set means resolved). */
  z.object({ type: z.literal('alert'), alert: obj<Alert>() }),
  z.object({ type: z.literal('resources'), resources: obj<Resources>() }),
])
export type UiStreamMessage = z.infer<typeof UiStreamMessageSchema>

// ── Parse helpers (never throw) ────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch (e) { return { ok: false, error: `invalid JSON: ${(e as Error).message}` } }
  }
  const r = schema.safeParse(data)
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message }
}

/** Accepts a JSON string or an already-parsed value. */
export const parseRunnerMessage = (raw: unknown) => parseWith(RunnerMessageSchema, raw)
export const parseRunnerCommand = (raw: unknown) => parseWith(RunnerCommandSchema, raw)
export const parseUiStreamMessage = (raw: unknown) => parseWith(UiStreamMessageSchema, raw)
export const parseActivityEvent = (raw: unknown) => parseWith(ActivityEventSchema, raw)

/** Status an agent is in while an activity event is current (for runner `status` messages). */
export function inferAgentStatus(ev: ActivityEvent): (typeof AGENT_STATUSES)[number] | undefined {
  switch (ev.kind) {
    case 'status': return ev.status
    case 'command':
    case 'test': return ev.command?.running ? 'running' : 'thinking'
    case 'edit': return 'editing'
    case 'thought':
    case 'tool':
    case 'message': return 'thinking'
    default: return undefined
  }
}
