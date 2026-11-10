// Maps Claude Code headless output (`claude -p --output-format stream-json --verbose`) onto
// the design's ActivityEvents. Pure apart from the mutable `ctx` you pass in, which tracks
// open tool calls so their results can be attached to the event that started them.
//
// Line shapes handled (anything else is ignored, never thrown):
//   {type:'system', subtype:'init', session_id, model, ...}            → status
//   {type:'assistant', message:{content:[thinking|text|tool_use]}}     → thought | message | tool | command | edit
//   {type:'user', message:{content:[tool_result]}, tool_use_result?}   → upsert of the matching command/edit/tool
//   {type:'result', subtype, is_error, usage, total_cost_usd, ...}     → status (+ usage via parseClaudeResult)
//
// Tool events get the deterministic id `${agentId}:${tool_use_id}`. When the tool_result
// arrives, the mapper emits the same id again with the final payload; consumers upsert by id.

import type { AgentStatus, ID, PlanUsage } from './domain'
import type { ActivityEvent, Usage } from './events'

export interface ClaudeStreamContext {
  agentId: ID
  projectId: ID
  now: () => Date
  newId: () => string
  /** Updated from `system/init` and `result` lines. */
  sessionId?: string
  model?: string
  /** Open tool calls by tool_use_id. */
  pending: Map<string, { event: ActivityEvent; startedAt: number }>
}

export function createClaudeStreamContext(opts: {
  agentId: ID
  projectId: ID
  now?: () => Date
  newId?: () => string
}): ClaudeStreamContext {
  let n = 0
  return {
    agentId: opts.agentId,
    projectId: opts.projectId,
    now: opts.now ?? (() => new Date()),
    newId: opts.newId ?? (() => `${opts.agentId}-${Date.now().toString(36)}-${(n++).toString(36)}`),
    pending: new Map(),
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const OUTPUT_TAIL_LINES = 20
const OUTPUT_TAIL_CHARS = 2000
const SUMMARY_CHARS = 200
const HUNK_LINES = 12

/** First non-empty line, trimmed and truncated: what a feed row shows. */
function summarize(text: string, max = SUMMARY_CHARS): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function tail(text: string): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  let out = lines.slice(-OUTPUT_TAIL_LINES).join('\n')
  if (out.length > OUTPUT_TAIL_CHARS) out = out.slice(-OUTPUT_TAIL_CHARS)
  return out
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.replace(/\n$/, '').split(/\r?\n/).length)

function hunk(oldStr: string, newStr: string): string {
  const minus = oldStr.length ? oldStr.replace(/\n$/, '').split(/\r?\n/).map((l) => `-${l}`) : []
  const plus = newStr.length ? newStr.replace(/\n$/, '').split(/\r?\n/).map((l) => `+${l}`) : []
  const all = [...minus, ...plus]
  return all.length > HUNK_LINES ? [...all.slice(0, HUNK_LINES), `… ${all.length - HUNK_LINES} more lines`].join('\n') : all.join('\n')
}

/** `mcp__colony__message_agent` → `message_agent`. */
const toolDisplayName = (name: string): string => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')

function toolTarget(input: Rec): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = str(input[key])
    if (v) return summarize(v, 120)
  }
  return undefined
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (isRec(b) && b.type === 'text' ? str(b.text) ?? '' : '')).filter(Boolean).join('\n')
  }
  return ''
}

const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bnode\s+(--\S+\s+)*--test\b|\bplaywright\s+test\b|\bgo\s+test\b|\bcargo\s+test\b/

/** Best-effort pass/fail counts from common test runners' summaries. */
export function parseTestSummary(output: string): { passed: number; failed: number } | undefined {
  const pick = (re: RegExp): number | undefined => {
    const m = output.match(re)
    return m?.[1] !== undefined ? Number(m[1]) : undefined
  }
  // vitest: "Tests  1 failed | 12 passed (13)"; jest: "Tests:  1 failed, 12 passed, 13 total"
  const testsLine = output.split(/\r?\n/).reverse().find((l) => /^\s*Tests:?\s/.test(l))
  if (testsLine) {
    const passed = testsLine.match(/(\d+)\s+passed/)
    const failed = testsLine.match(/(\d+)\s+failed/)
    if (passed || failed) return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) }
  }
  // node --test (TAP): "# pass 5" / "# fail 0"; also "ℹ pass 5" in spec reporter
  const nodePass = pick(/^[#ℹ]\s*pass\s+(\d+)/m)
  const nodeFail = pick(/^[#ℹ]\s*fail\s+(\d+)/m)
  if (nodePass !== undefined || nodeFail !== undefined) return { passed: nodePass ?? 0, failed: nodeFail ?? 0 }
  // pytest: "==== 3 passed, 1 failed in 0.21s ===="
  const py = output.match(/=+\s*(.*\bin\s+[\d.]+s)\s*=+/)
  if (py?.[1]) {
    const passed = py[1].match(/(\d+)\s+passed/)
    const failed = py[1].match(/(\d+)\s+failed/)
    if (passed || failed) return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) }
  }
  return undefined
}

// ── mapping ─────────────────────────────────────────────────────────────────────

function base(ctx: ClaudeStreamContext, id: string, kind: ActivityEvent['kind'], text: string): ActivityEvent {
  return { id, at: ctx.now().toISOString(), agentId: ctx.agentId, projectId: ctx.projectId, kind, text }
}

function statusEvent(ctx: ClaudeStreamContext, status: AgentStatus, text: string): ActivityEvent {
  return { ...base(ctx, ctx.newId(), 'status', text), status }
}

function mapToolUse(ctx: ClaudeStreamContext, block: Rec): ActivityEvent | undefined {
  const toolUseId = str(block.id)
  const name = str(block.name)
  if (!name) return undefined
  const input = isRec(block.input) ? block.input : {}
  const id = toolUseId ? `${ctx.agentId}:${toolUseId}` : ctx.newId()
  let ev: ActivityEvent

  if (name === 'Bash') {
    const cmd = str(input.command) ?? ''
    ev = { ...base(ctx, id, 'command', str(input.description) ?? summarize(cmd)), command: { cmd, running: true } }
  } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const path = str(input.file_path) ?? ''
    let added = 0
    let removed = 0
    let h: string | undefined
    if (name === 'Write') {
      added = lineCount(str(input.content) ?? '')
    } else {
      const edits: Rec[] = name === 'MultiEdit'
        ? (Array.isArray(input.edits) ? input.edits.filter(isRec) : [])
        : [input]
      const hunks: string[] = []
      for (const e of edits) {
        const o = str(e.old_string) ?? ''
        const n = str(e.new_string) ?? ''
        removed += lineCount(o)
        added += lineCount(n)
        hunks.push(hunk(o, n))
      }
      h = hunks.filter(Boolean).join('\n') || undefined
    }
    const verb = name === 'Write' ? 'Wrote' : 'Edited'
    ev = { ...base(ctx, id, 'edit', `${verb} ${path}`), edit: { path, added, removed, ...(h ? { hunk: h } : {}) } }
  } else {
    const display = toolDisplayName(name)
    const target = toolTarget(input)
    ev = { ...base(ctx, id, 'tool', target ? `${display} ${target}` : display), tool: { name: display, ...(target ? { target } : {}) } }
  }

  if (toolUseId) ctx.pending.set(toolUseId, { event: ev, startedAt: ctx.now().getTime() })
  return ev
}

function mapToolResult(ctx: ClaudeStreamContext, block: Rec, toolUseResult: unknown): ActivityEvent | undefined {
  const toolUseId = str(block.tool_use_id)
  if (!toolUseId) return undefined
  const open = ctx.pending.get(toolUseId)
  if (!open) return undefined
  ctx.pending.delete(toolUseId)

  const isError = block.is_error === true
  let output = toolResultText(block.content)
  // Newer CLIs attach structured Bash output alongside the message.
  if (isRec(toolUseResult) && (typeof toolUseResult.stdout === 'string' || typeof toolUseResult.stderr === 'string')) {
    output = [str(toolUseResult.stdout), str(toolUseResult.stderr)].filter(Boolean).join('\n') || output
  }
  const prev = open.event
  const at = ctx.now().toISOString()

  if (prev.kind === 'command' && prev.command) {
    const exitMatch = toolResultText(block.content).match(/^Exit code (\d+)/m)
    const exitCode = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : isError ? 1 : 0
    const ev: ActivityEvent = {
      ...prev,
      at,
      command: {
        cmd: prev.command.cmd,
        exitCode,
        durationMs: Math.max(0, ctx.now().getTime() - open.startedAt),
        outputTail: tail(output),
        running: false,
      },
    }
    if (TEST_CMD.test(prev.command.cmd)) {
      const counts = parseTestSummary(output)
      if (counts) {
        ev.kind = 'test'
        ev.test = { ...counts, running: 0 }
        ev.text = `${counts.passed} passed, ${counts.failed} failed`
      }
    }
    return ev
  }

  if (!isError) return undefined // successful edits/tools need no update
  const reason = summarize(output, 160)
  return { ...prev, at, text: reason ? `${prev.text} failed: ${reason}` : `${prev.text} failed` }
}

/**
 * Convert one stream-json line (raw string or parsed object) into zero or more ActivityEvents.
 * Never throws; unknown or malformed input yields `[]`.
 */
export function mapClaudeStreamLine(line: unknown, ctx: ClaudeStreamContext): ActivityEvent[] {
  try {
    let msg = line
    if (typeof line === 'string') {
      if (!line.trim()) return []
      msg = JSON.parse(line)
    }
    if (!isRec(msg)) return []

    switch (msg.type) {
      case 'system': {
        if (msg.subtype !== 'init') return []
        ctx.sessionId = str(msg.session_id) ?? ctx.sessionId
        ctx.model = str(msg.model) ?? ctx.model
        return [statusEvent(ctx, 'thinking', ctx.model ? `Session started · ${ctx.model}` : 'Session started')]
      }

      case 'assistant': {
        const content = isRec(msg.message) ? msg.message.content : undefined
        if (!Array.isArray(content)) return []
        const out: ActivityEvent[] = []
        for (const block of content) {
          if (!isRec(block)) continue
          if (block.type === 'thinking') {
            const t = str(block.thinking)?.trim()
            if (t) out.push(base(ctx, ctx.newId(), 'thought', t))
          } else if (block.type === 'text') {
            // Assistant prose in headless mode is addressed to the human driving the agent.
            const t = str(block.text)?.trim()
            if (t) out.push({ ...base(ctx, ctx.newId(), 'message', summarize(t)), message: { to: 'you', body: t } })
          } else if (block.type === 'tool_use') {
            const ev = mapToolUse(ctx, block)
            if (ev) out.push(ev)
          }
        }
        return out
      }

      case 'user': {
        const content = isRec(msg.message) ? msg.message.content : undefined
        if (!Array.isArray(content)) return []
        const out: ActivityEvent[] = []
        for (const block of content) {
          if (isRec(block) && block.type === 'tool_result') {
            const ev = mapToolResult(ctx, block, msg.tool_use_result)
            if (ev) out.push(ev)
          }
        }
        return out
      }

      case 'result': {
        const r = parseClaudeResult(msg)
        if (!r) return []
        if (r.sessionId) ctx.sessionId = r.sessionId
        const bits = [
          r.numTurns !== undefined ? `${r.numTurns} turn${r.numTurns === 1 ? '' : 's'}` : undefined,
          r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : undefined,
        ].filter(Boolean)
        const head = r.isError ? `Turn failed (${r.subtype})` : 'Turn complete'
        return [statusEvent(ctx, r.isError ? 'error' : 'idle', [head, ...bits].join(' · '))]
      }

      default:
        return []
    }
  } catch {
    return []
  }
}

export interface ClaudeResult {
  subtype: string
  isError: boolean
  sessionId?: string
  text?: string
  durationMs?: number
  numTurns?: number
  /** `total_cost_usd` as reported (cumulative for the CLI session); diff it to get a per-turn cost. */
  totalCostUsd?: number
  usage: Usage
}

/** Extract the result + token usage from a `result` line, or `undefined` for any other line. */
export function parseClaudeResult(line: unknown): ClaudeResult | undefined {
  try {
    const msg = typeof line === 'string' ? JSON.parse(line) : line
    if (!isRec(msg) || msg.type !== 'result') return undefined
    const u = isRec(msg.usage) ? msg.usage : {}
    const usage: Usage = {
      inputTokens: num(u.input_tokens) ?? 0,
      outputTokens: num(u.output_tokens) ?? 0,
    }
    const cacheRead = num(u.cache_read_input_tokens)
    const cacheCreation = num(u.cache_creation_input_tokens)
    if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
    if (cacheCreation !== undefined) usage.cacheCreationTokens = cacheCreation
    const subtype = str(msg.subtype) ?? 'unknown'
    const r: ClaudeResult = { subtype, isError: msg.is_error === true || subtype.startsWith('error'), usage }
    const sessionId = str(msg.session_id); if (sessionId) r.sessionId = sessionId
    const text = str(msg.result); if (text !== undefined) r.text = text
    const durationMs = num(msg.duration_ms); if (durationMs !== undefined) r.durationMs = durationMs
    const numTurns = num(msg.num_turns); if (numTurns !== undefined) r.numTurns = numTurns
    const cost = num(msg.total_cost_usd); if (cost !== undefined) r.totalCostUsd = cost
    return r
  } catch {
    return undefined
  }
}

/**
 * Claude Code emits `rate_limit_event` lines carrying the subscription's 5-hour
 * and 7-day utilization. Returns a PlanUsage snapshot (rate is left at 0: the
 * control plane derives it from successive snapshots), or undefined.
 */
export function parseRateLimitEvent(line: unknown, now: Date = new Date()): PlanUsage | undefined {
  try {
    const ev = (typeof line === 'string' ? JSON.parse(line) : line) as any
    if (!ev || ev.type !== 'rate_limit_event') return undefined
    const w = ev.rate_limit_info?.unifiedWindows
    const five = w?.five_hour, seven = w?.seven_day
    if (!five && !seven) return undefined
    const iso = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : now.toISOString())
    const pct = (u: unknown) => (typeof u === 'number' ? Math.round(u * 1000) / 10 : 0)
    return {
      session: { usedPct: pct(five?.utilization), resetsAt: iso(five?.resetsAt), ratePctPerHour: 0 },
      weekly: { usedPct: pct(seven?.utilization), resetsAt: iso(seven?.resetsAt) },
      syncedAt: now.toISOString(),
      source: 'connected',
    }
  } catch {
    return undefined
  }
}
