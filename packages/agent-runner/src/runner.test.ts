import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseRunnerMessage } from '@colony/shared'
import {
  baseEnv, makeSandbox, sleep, startControlPlane, startRunner, statuses,
  type ControlPlane, type Msg, type RunnerHandle, type Sandbox,
} from './test/harness'

interface Setup { cp: ControlPlane; sb: Sandbox; runner: RunnerHandle }

async function setup(t: TestContext, extraEnv: Record<string, string> = {}, sbOpts?: { withMain?: boolean }): Promise<Setup> {
  const cp = await startControlPlane()
  const sb = makeSandbox(sbOpts)
  const runner = startRunner(baseEnv(cp, sb, extraEnv))
  t.after(async () => {
    await runner.kill()
    await cp.close()
    await sleep(100)
    sb.cleanup()
  })
  return { cp, sb, runner }
}

const isStatus = (s: string) => (m: Msg) => m.type === 'status' && m.status === s
const ofType = (type: string) => (m: Msg) => m.type === type

async function ready(s: Setup): Promise<void> {
  await s.cp.waitFor(ofType('workspace'), 15_000, 'workspace')
  await s.cp.waitFor(isStatus('idle'), 10_000, 'idle')
}

test('hello, workspace and idle on boot; every message matches the protocol', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp, sb } = s
  assert.equal(cp.authHeaders[0], 'Bearer test-agent-token')
  assert.deepEqual(cp.messages[0], { type: 'hello', agentId: 'agent-1', protocol: 1 })
  assert.deepEqual(statuses(cp.messages), ['booting', 'idle'])
  const ws = cp.messages.find(ofType('workspace'))!
  assert.equal(ws.branch, 'agent/test-01')
  assert.match(ws.headSha, /^[0-9a-f]{40}$/)
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: sb.workspace }).toString().trim()
  assert.equal(branch, 'agent/test-01')
  // CLI started with the spec'd flags, the decoded prompt and no --resume
  for (let i = 0; i < 100 && sb.starts().length === 0; i++) await sleep(50)
  const [args] = sb.starts()
  assert.deepEqual(args!.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', 'claude-haiku-5-5'])
  assert.deepEqual(args!.slice(9), ['--append-system-prompt', 'You are a test agent.'])
  for (const m of cp.messages) assert.ok(parseRunnerMessage(m).ok, `invalid message ${JSON.stringify(m)}`)
})

test('user_message → events, status changes, result, per-turn usage and plan_usage', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp } = s
  cp.send({ type: 'user_message', text: 'first' })
  await cp.waitFor((m) => m.type === 'usage', 10_000, 'usage 1')
  cp.send({ type: 'user_message', text: 'second' })
  await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: second', 10_000, 'result 2')
  await sleep(100)

  const results = cp.messages.filter(ofType('result'))
  assert.equal(results.length, 2)
  assert.equal(results[0]!.subtype, 'success')
  assert.equal(results[0]!.isError, false)
  assert.match(results[0]!.sessionId, /^sess-/)
  assert.equal(results[1]!.totalCostUsd, 0.02) // cumulative as reported…
  const usage = cp.messages.filter(ofType('usage'))
  assert.equal(usage.length, 2)
  assert.deepEqual(usage.map((u) => u.costUsd), [0.01, 0.01]) // …but usage carries the per-turn delta
  assert.equal(usage[0]!.inputTokens, 10)
  assert.equal(usage[0]!.outputTokens, 20)
  assert.equal(usage[0]!.cacheReadTokens, 30)
  assert.equal(usage[0]!.cacheCreationTokens, 40)

  const plan = cp.messages.filter(ofType('plan_usage'))
  assert.equal(plan.length, 2)
  assert.equal(plan[0]!.usage.session.usedPct, 42)

  const events = cp.messages.filter(ofType('event')).map((m) => m.event)
  assert.ok(events.some((e) => e.kind === 'message' && e.message.body === 'echo: first'))
  const cmd = events.filter((e) => e.kind === 'command')
  assert.ok(cmd.some((e) => e.command.running === true))
  assert.ok(cmd.some((e) => e.command.running === false && e.command.exitCode === 0 && e.command.outputTail === 'hi'))

  const st = statuses(cp.messages)
  for (let i = 1; i < st.length; i++) assert.notEqual(st[i], st[i - 1], `duplicate status at ${i}: ${st.join(',')}`)
  assert.deepEqual(st.slice(0, 3), ['booting', 'idle', 'thinking'])
  assert.equal(st.at(-1), 'idle')
  for (const m of cp.messages) assert.ok(parseRunnerMessage(m).ok, `invalid message ${JSON.stringify(m)}`)
})

test('replays the recorded CLI fixture into events and usage', async (t) => {
  const s = await setup(t)
  await ready(s)
  s.cp.send({ type: 'user_message', text: 'fixture' })
  const usage = await s.cp.waitFor(ofType('usage'), 10_000, 'usage')
  assert.equal(usage.costUsd, 0.0105104)
  const kinds = s.cp.messages.filter(ofType('event')).map((m) => m.event.kind)
  assert.ok(kinds.includes('edit') && kinds.includes('command') && kinds.includes('message'), kinds.join(','))
  assert.ok(s.cp.messages.some(ofType('plan_usage')))
})

test('pause interrupts and queues messages; resume flushes the queue', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp, sb } = s
  cp.send({ type: 'user_message', text: 'slow' })
  await cp.waitFor((m) => m.type === 'event' && m.event.kind === 'command' && m.event.command.running, 10_000, 'running command')
  cp.send({ type: 'pause' })
  await cp.waitFor(isStatus('paused'), 5000, 'paused')
  // the interrupted turn's result arrives but the status stays paused
  await cp.waitFor((m) => m.type === 'result' && m.subtype === 'error_during_execution', 5000, 'interrupted result')
  assert.ok(sb.fakeEvents().some((e) => e.kind === 'interrupt'), 'fake received a control_request interrupt')
  const interruptedStatusEvent = cp.messages.filter(ofType('event')).map((m) => m.event).find((e) => e.kind === 'status' && /Interrupted/.test(e.text))
  assert.equal(interruptedStatusEvent?.status, 'paused')

  const mark = cp.messages.length
  cp.send({ type: 'user_message', text: 'queued-1' })
  cp.send({ type: 'user_message', text: 'queued-2' })
  await sleep(600)
  assert.equal(cp.since(mark, ofType('result')).length, 0, 'nothing runs while paused')
  assert.ok(!sb.fakeEvents().some((e) => e.kind === 'user' && e.text.startsWith('queued')), 'nothing written to claude while paused')
  assert.deepEqual(statuses(cp.messages).slice(-1), ['paused'])

  cp.send({ type: 'resume' })
  await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: queued-2', 10_000, 'queued-2 result')
  const after = statuses(cp.since(mark))
  assert.equal(after[0], 'idle')
  assert.deepEqual(sb.fakeEvents().filter((e) => e.kind === 'user').map((e) => e.text), ['slow', 'queued-1', 'queued-2'])
})

test('set_model restarts the CLI with --resume <session> and the mapped model', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp, sb } = s
  cp.send({ type: 'user_message', text: 'hello' })
  const r = await cp.waitFor(ofType('result'), 10_000, 'result')
  cp.send({ type: 'set_model', model: 'sonnet-5.5' })
  const deadline = Date.now() + 10_000
  while (sb.starts().length < 2 && Date.now() < deadline) await sleep(50)
  const starts = sb.starts()
  assert.equal(starts.length, 2)
  const args = starts[1]!
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.equal(args[args.indexOf('--resume') + 1], r.sessionId)
  assert.ok(sb.fakeEvents().some((e) => e.kind === 'stdin-end'), 'old CLI got stdin closed')
  // the new process works and reuses the session
  cp.send({ type: 'user_message', text: 'after' })
  const r2 = await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: after', 10_000, 'result after restart')
  await cp.waitFor((m) => m.type === 'usage' && cp.messages.indexOf(m) > cp.messages.indexOf(r2), 5000, 'usage after restart')
  assert.equal(r2.sessionId, r.sessionId)
  assert.ok(!cp.messages.some(ofType('error')), 'a deliberate restart is not an error')
  // usage delta restarts with the new process' cumulative cost
  assert.deepEqual(cp.messages.filter(ofType('usage')).map((u) => u.costUsd), [0.01, 0.01])
})

test('unexpected CLI exit: error, restart with --resume, keeps working', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp, sb } = s
  cp.send({ type: 'user_message', text: 'hello' })
  const r = await cp.waitFor(ofType('result'), 10_000, 'result')
  cp.send({ type: 'user_message', text: 'crash' })
  const err = await cp.waitFor(ofType('error'), 10_000, 'error')
  assert.match(err.message, /claude exited unexpectedly \(code 1\).*simulated crash/)
  assert.notEqual(err.fatal, true)
  const deadline = Date.now() + 10_000
  while (sb.starts().length < 2 && Date.now() < deadline) await sleep(50)
  const args = sb.starts()[1]!
  assert.equal(args[args.indexOf('--resume') + 1], r.sessionId)
  await cp.waitFor((m) => m.type === 'status' && m.status === 'idle' && cp.messages.indexOf(m) > cp.messages.indexOf(err), 5000, 'idle after restart')
  cp.send({ type: 'user_message', text: 'again' })
  await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: again', 10_000, 'result after crash')
})

test('gives up after 3 crashes in 5 minutes', async (t) => {
  const s = await setup(t, { FAKE_CLAUDE_EXIT_ON_START: '1' })
  const { cp, sb } = s
  const fatal = await cp.waitFor((m) => m.type === 'error' && m.fatal === true, 15_000, 'fatal error')
  assert.match(fatal.message, /3 crashes in 5 minutes/)
  await cp.waitFor(isStatus('error'), 2000, 'error status')
  await sleep(800)
  assert.equal(sb.starts().length, 3)
  assert.equal(cp.messages.filter(ofType('error')).length, 3)
})

test('unknown --resume session falls back to a fresh session without losing queued messages', async (t) => {
  const s = await setup(t, { COLONY_SESSION_ID: 'missing-session' })
  const { cp, sb } = s
  assert.deepEqual((await cp.waitFor(ofType('hello'))).sessionId, 'missing-session')
  await cp.waitFor(ofType('workspace'), 15_000, 'workspace')
  cp.send({ type: 'user_message', text: 'hi' })
  const r = await cp.waitFor(ofType('result'), 10_000, 'result')
  assert.match(r.sessionId, /^sess-/)
  const err = cp.messages.find(ofType('error'))!
  assert.match(err.message, /session missing-session not found/)
  const starts = sb.starts()
  assert.ok(starts[0]!.includes('--resume'))
  assert.ok(!starts.at(-1)!.includes('--resume'))
  assert.equal(cp.messages.filter(ofType('result')).length, 1, 'startup-failure result is not forwarded')
})

test('interrupt falls back to SIGINT when the CLI does not acknowledge, then resumes', async (t) => {
  const s = await setup(t, { FAKE_CLAUDE_IGNORE_INTERRUPT: '1', COLONY_INTERRUPT_TIMEOUT_MS: '300' })
  await ready(s)
  const { cp, sb } = s
  cp.send({ type: 'user_message', text: 'slow' })
  const r = await cp.waitFor((m) => m.type === 'event' && m.event.kind === 'command' && m.event.command.running, 10_000, 'running')
  cp.send({ type: 'interrupt' })
  const deadline = Date.now() + 10_000
  while (sb.starts().length < 2 && Date.now() < deadline) await sleep(50)
  assert.equal(sb.starts().length, 2)
  assert.ok(sb.starts()[1]!.includes('--resume'))
  // the dangling command is closed out, no crash error is reported
  await cp.waitFor((m) => m.type === 'event' && m.event.id === r.event.id && m.event.command.running === false, 5000, 'command closed')
  assert.ok(!cp.messages.some(ofType('error')))
  cp.send({ type: 'user_message', text: 'after' })
  await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: after', 10_000, 'result after interrupt')
})

test('reconnects with a fresh hello and flushes buffered messages', async (t) => {
  const s = await setup(t)
  await ready(s)
  const { cp } = s
  cp.dropClients()
  await sleep(50)
  const deadline = Date.now() + 10_000
  while (cp.connections < 2 && Date.now() < deadline) await sleep(50)
  await cp.waitFor((m) => m.type === 'hello' && cp.messages.indexOf(m) > 0, 5000, 'second hello')
  cp.send({ type: 'user_message', text: 'after reconnect' })
  await cp.waitFor((m) => m.type === 'result' && m.text === 'echo: after reconnect', 10_000, 'result')
})

test('shutdown closes claude stdin and exits 0', async (t) => {
  const s = await setup(t)
  await ready(s)
  s.cp.send({ type: 'shutdown' })
  const code = await Promise.race([s.runner.exited, sleep(10_000).then(() => 'timeout')])
  assert.equal(code, 0, s.runner.stderr())
  assert.ok(s.sb.fakeEvents().some((e) => e.kind === 'stdin-end'))
})

test('creates the branch in an empty origin (no main yet)', async (t) => {
  const s = await setup(t, {}, { withMain: false })
  const ws = await s.cp.waitFor(ofType('workspace'), 15_000, 'workspace')
  assert.equal(ws.branch, 'agent/test-01')
  assert.equal(ws.headSha, undefined)
  await s.cp.waitFor(isStatus('idle'))
})
