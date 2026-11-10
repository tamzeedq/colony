#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json` for runner tests.
// Shapes mirror what Claude Code 2.1.x really prints (see packages/shared/src/__fixtures__ and
// packages/agent-runner/README.md "Interrupt").
//
// Behaviour by user message text:
//   "crash"    → init, then exit 1 with a stderr line
//   "slow"     → init + a running Bash tool_use, then wait (interruptible)
//   "fixture"  → replay $FAKE_CLAUDE_FIXTURE line by line
//   anything   → init, text "echo: <text>", Bash tool_use + tool_result, rate_limit_event,
//                result (total_cost_usd cumulative +0.01 per turn)
// Env:
//   FAKE_CLAUDE_LOG               append one JSON line per notable action ({kind:'start',args} …)
//   FAKE_CLAUDE_EXIT_ON_START=1   exit 3 immediately
//   FAKE_CLAUDE_IGNORE_INTERRUPT=1  never answer interrupt control requests
// total_cost_usd is cumulative per session and carried across --resume (as the real CLI does).
// `--resume missing-session` reproduces the real CLI's "No conversation found" failure.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const logFile = process.env.FAKE_CLAUDE_LOG
const log = (o) => { if (logFile) appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...o }) + '\n') }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

log({ kind: 'start', args, cwd: process.cwd() })

if (process.env.FAKE_CLAUDE_EXIT_ON_START === '1') {
  process.stderr.write('fake claude: exiting on start\n')
  process.exit(3)
}

const resume = argVal('--resume')
if (resume === 'missing-session') {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`)
  out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, is_error: true, num_turns: 0, session_id: resume, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
  process.exit(1)
}

const sessionId = resume ?? `sess-${randomUUID()}`
const model = argVal('--model') ?? 'unknown'
// Like the real CLI, total_cost_usd is cumulative per session and survives --resume.
const sessionsFile = logFile ? `${logFile}.sessions.json` : undefined
const sessions = sessionsFile && existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, 'utf8')) : {}
let totalCost = sessions[sessionId] ?? 0
const saveCost = () => { if (sessionsFile) { sessions[sessionId] = totalCost; writeFileSync(sessionsFile, JSON.stringify(sessions)) } }
let turns = 0
let active = null // { toolUseId } while a "slow" turn runs

const init = () => out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model, tools: ['Bash'], permissionMode: 'bypassPermissions' })
const assistant = (content) => out({ type: 'assistant', message: { model, role: 'assistant', type: 'message', content }, session_id: sessionId })
const rateLimit = () => out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1794304800 }, seven_day: { utilization: 0.1, resetsAt: 1794358800 } } }, session_id: sessionId })
const result = (extra) => {
  turns++
  saveCost()
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: turns, duration_ms: 5, session_id: sessionId, total_cost_usd: totalCost, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, queued_turn_count: 0, ...extra })
}

function handleUser(text) {
  log({ kind: 'user', text })
  if (text === 'crash') {
    init()
    process.stderr.write('fake claude: simulated crash\n')
    process.exit(1)
  }
  if (text === 'fixture') {
    for (const line of readFileSync(process.env.FAKE_CLAUDE_FIXTURE, 'utf8').split(/\r?\n/)) if (line.trim()) process.stdout.write(line + '\n')
    return
  }
  init()
  if (text === 'slow') {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
    active = { toolUseId }
    assistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 100', description: 'Sleep a long time' } }])
    rateLimit()
    return
  }
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
  assistant([{ type: 'text', text: `echo: ${text}` }])
  assistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } }])
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hi', is_error: false }] }, session_id: sessionId })
  rateLimit()
  totalCost = Math.round((totalCost + 0.01) * 1e6) / 1e6
  result({ result: `echo: ${text}` })
}

function handleInterrupt(requestId) {
  log({ kind: 'interrupt', requestId })
  if (process.env.FAKE_CLAUDE_IGNORE_INTERRUPT === '1') return
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } })
  if (!active) return
  const { toolUseId } = active
  active = null
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: "The user doesn't want to proceed with this tool use.", is_error: true }] }, session_id: sessionId })
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, session_id: sessionId })
  totalCost = Math.round((totalCost + 0.001) * 1e6) / 1e6
  result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' })
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { process.stderr.write(`fake claude: bad json ${line}\n`); return }
  if (msg.type === 'user') {
    const c = msg.message?.content
    const text = typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    handleUser(text)
  } else if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    handleInterrupt(msg.request_id)
  }
}).on('close', () => {
  log({ kind: 'stdin-end' })
  setTimeout(() => process.exit(0), 20)
})
