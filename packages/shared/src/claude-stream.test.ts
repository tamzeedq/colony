import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createClaudeStreamContext,
  mapClaudeStreamLine,
  parseClaudeResult,
  parseTestSummary,
  ActivityEventSchema,
  parseRunnerMessage,
  parseRunnerCommand,
  inferAgentStatus,
  canMergeToMain,
  parseRateLimitEvent,
  findModel,
  BUILTIN_MODELS,
} from './index'

function ctx() {
  let t = Date.parse('2026-11-09T10:00:00.000Z')
  let n = 0
  const c = createClaudeStreamContext({
    agentId: 'vex-07',
    projectId: 'p1',
    now: () => new Date(t),
    newId: () => `id-${n++}`,
  })
  return { c, advance: (ms: number) => { t += ms } }
}

const assertValid = (events: unknown[]) => {
  for (const e of events) assert.ok(ActivityEventSchema.safeParse(e).success, `invalid event: ${JSON.stringify(e)}`)
}

test('system/init → status event and session tracking', () => {
  const { c } = ctx()
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5', tools: ['Bash'], cwd: '/work' })
  const out = mapClaudeStreamLine(line, c)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'status')
  assert.equal(out[0]!.status, 'thinking')
  assert.match(out[0]!.text, /claude-sonnet-5-5/)
  assert.equal(c.sessionId, 'sess-1')
  assertValid(out)
})

test('assistant thinking / text / generic tool_use', () => {
  const { c } = ctx()
  const out = mapClaudeStreamLine({
    type: 'assistant',
    session_id: 'sess-1',
    message: {
      id: 'msg_1', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The streak bug is probably timezone related.', signature: 'x' },
        { type: 'thinking', thinking: '', signature: 'redacted-ish' },
        { type: 'text', text: "I'll look at the streak calculator.\nThen run tests." },
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'src/streaks.ts' } },
        { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__colony__report_progress', input: { description: 'halfway' } },
      ],
    },
  }, c)
  assert.deepEqual(out.map((e) => e.kind), ['thought', 'message', 'tool', 'tool'])
  assert.equal(out[1]!.text, "I'll look at the streak calculator.")
  assert.deepEqual(out[1]!.message, { to: 'you', body: "I'll look at the streak calculator.\nThen run tests." })
  assert.deepEqual(out[2]!.tool, { name: 'Read', target: 'src/streaks.ts' })
  assert.equal(out[2]!.id, 'vex-07:toolu_read')
  assert.equal(out[3]!.tool!.name, 'report_progress')
  assertValid(out)
})

test('Bash tool_use → running command, tool_result upserts exit code + output tail', () => {
  const { c, advance } = ctx()
  const [start] = mapClaudeStreamLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la src', description: 'List sources' } }] },
  }, c)
  assert.equal(start!.kind, 'command')
  assert.deepEqual(start!.command, { cmd: 'ls -la src', running: true })
  assert.equal(start!.text, 'List sources')

  advance(1500)
  const long = Array.from({ length: 50 }, (_, i) => `file-${i}.ts`).join('\n')
  const [done] = mapClaudeStreamLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: long, is_error: false }] },
  }, c)
  assert.equal(done!.id, start!.id, 'same id → consumers upsert')
  assert.equal(done!.command!.running, false)
  assert.equal(done!.command!.exitCode, 0)
  assert.equal(done!.command!.durationMs, 1500)
  assert.equal(done!.command!.outputTail!.split('\n').length, 20)
  assert.ok(done!.command!.outputTail!.endsWith('file-49.ts'))
  assert.equal(c.pending.size, 0)
  assertValid([start, done])
})

test('failed Bash parses exit code; structured tool_use_result preferred', () => {
  const { c } = ctx()
  mapClaudeStreamLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } }] } }, c)
  const [done] = mapClaudeStreamLine({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'Exit code 2\nerror TS2322' }] }] },
    tool_use_result: { stdout: '', stderr: 'error TS2322: nope', interrupted: false },
  }, c)
  assert.equal(done!.command!.exitCode, 2)
  assert.equal(done!.command!.outputTail, 'error TS2322: nope')
})

test('test commands become kind "test" with counts', () => {
  const { c } = ctx()
  mapClaudeStreamLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test -- streaks' } }] } }, c)
  const [done] = mapClaudeStreamLine({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Exit code 1\n Test Files  1 failed (1)\n      Tests  2 failed | 14 passed (16)' }] },
  }, c)
  assert.equal(done!.kind, 'test')
  assert.deepEqual(done!.test, { passed: 14, failed: 2, running: 0 })
  assert.equal(done!.command!.exitCode, 1)
  assertValid([done])
})

test('Edit / MultiEdit / Write → edit with line counts and hunk', () => {
  const { c } = ctx()
  const out = mapClaudeStreamLine({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'const x = 1\n', new_string: 'const x = 2\nconst y = 3\n' } },
        { type: 'tool_use', id: 'e2', name: 'MultiEdit', input: { file_path: 'src/b.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: '' }] } },
        { type: 'tool_use', id: 'e3', name: 'Write', input: { file_path: 'src/c.ts', content: 'one\ntwo\nthree\n' } },
      ],
    },
  }, c)
  assert.deepEqual(out.map((e) => e.kind), ['edit', 'edit', 'edit'])
  assert.deepEqual(out[0]!.edit, { path: 'src/a.ts', added: 2, removed: 1, hunk: '-const x = 1\n+const x = 2\n+const y = 3' })
  assert.equal(out[1]!.edit!.added, 1)
  assert.equal(out[1]!.edit!.removed, 3)
  assert.deepEqual(out[2]!.edit, { path: 'src/c.ts', added: 3, removed: 0 })
  assert.equal(out[2]!.text, 'Wrote src/c.ts')
  assertValid(out)

  // successful edit result → no update; failed edit → upsert with reason
  assert.deepEqual(mapClaudeStreamLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } }, c), [])
  const [failed] = mapClaudeStreamLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e2', is_error: true, content: 'String to replace not found in file.' }] } }, c)
  assert.equal(failed!.id, out[1]!.id)
  assert.match(failed!.text, /failed: String to replace not found/)
})

test('result → status + usage', () => {
  const { c } = ctx()
  const line = {
    type: 'result', subtype: 'success', is_error: false, duration_ms: 12345, num_turns: 4,
    result: 'Fixed the streak bug.', session_id: 'sess-9', total_cost_usd: 0.0421,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 },
  }
  const [ev] = mapClaudeStreamLine(line, c)
  assert.equal(ev!.kind, 'status')
  assert.equal(ev!.status, 'idle')
  assert.equal(ev!.text, 'Turn complete · 4 turns · 12.3s')
  assert.equal(c.sessionId, 'sess-9')

  const r = parseClaudeResult(JSON.stringify(line))!
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 9000, cacheCreationTokens: 500 })
  assert.equal(r.totalCostUsd, 0.0421)
  assert.equal(r.text, 'Fixed the streak bug.')

  const [err] = mapClaudeStreamLine({ type: 'result', subtype: 'error_max_turns', is_error: true }, c)
  assert.equal(err!.status, 'error')
  assert.match(err!.text, /error_max_turns/)
  assert.equal(parseClaudeResult({ type: 'assistant' }), undefined)
})

test('unknown and malformed input is ignored, never thrown', () => {
  const { c } = ctx()
  const junk: unknown[] = [
    null, undefined, 42, '', '   ', '{not json', '[]', [], 'null',
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'stream_event', event: {} },
    { type: 'assistant' },
    { type: 'assistant', message: { content: 'just a string' } },
    { type: 'assistant', message: { content: [null, 1, { type: 'image' }, { type: 'tool_use' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'never-opened', content: 'x' }] } },
    { type: 'result', usage: 'bogus' },
  ]
  for (const j of junk) assert.doesNotThrow(() => mapClaudeStreamLine(j, c))
  const results = junk.slice(0, -1).flatMap((j) => mapClaudeStreamLine(j, c))
  assert.deepEqual(results, [])
})

test('parseTestSummary handles jest, node --test and pytest', () => {
  assert.deepEqual(parseTestSummary('Tests:       1 failed, 12 passed, 13 total'), { passed: 12, failed: 1 })
  assert.deepEqual(parseTestSummary('# tests 5\n# pass 5\n# fail 0'), { passed: 5, failed: 0 })
  assert.deepEqual(parseTestSummary('===== 3 passed, 1 failed in 0.21s ====='), { passed: 3, failed: 1 })
  assert.equal(parseTestSummary('nothing here'), undefined)
})

test('wire protocol helpers', () => {
  assert.equal(parseRunnerMessage('{"type":"hello","agentId":"a1"}').ok, true)
  assert.equal(parseRunnerMessage({ type: 'usage', inputTokens: 1, outputTokens: 2, costUsd: 0.01 }).ok, true)
  assert.equal(parseRunnerMessage({ type: 'status', agentId: 'a1', status: 'running_command' }).ok, false)
  assert.equal(parseRunnerMessage('nope').ok, false)
  assert.equal(parseRunnerCommand({ type: 'set_model', model: 'haiku-5.5' }).ok, true)
  assert.equal(parseRunnerCommand({ type: 'reboot' }).ok, false)

  const { c } = ctx()
  const [cmd] = mapClaudeStreamLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } }, c)
  assert.equal(inferAgentStatus(cmd!), 'running')
})

test('domain helpers', () => {
  assert.equal(BUILTIN_MODELS.length, 4)
  assert.equal(findModel('opus-5.5')?.cliModel, 'claude-opus-5-5')
  assert.equal(findModel('gpt-x'), undefined)
  const mr = { id: 'm1', projectId: 'p1', branch: 'feat/x', requestedBy: 'orc-01', status: 'approved' as const }
  assert.equal(canMergeToMain(mr), false)
  assert.equal(canMergeToMain({ ...mr, approvedBy: 'you', approvedAt: '2026-11-09T10:00:00Z' }), true)
  assert.equal(canMergeToMain({ ...mr, status: 'pending', approvedBy: 'you', approvedAt: '2026-11-09T10:00:00Z' }), false)
})

test('real headless run: maps events and reads plan usage', async () => {
  const { readFileSync } = await import('node:fs')
  const lines = readFileSync(new URL('./__fixtures__/headless-run.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)
  const ctx = createClaudeStreamContext({ agentId: 'a1', projectId: 'p1' })
  const kinds = lines.flatMap((l) => mapClaudeStreamLine(l, ctx)).map((e) => e.kind)
  assert.ok(kinds.includes('edit') && kinds.includes('command') && kinds.includes('status'))
  const usage = lines.map((l) => parseRateLimitEvent(l)).find(Boolean)
  assert.ok(usage)
  assert.equal(usage.source, 'connected')
  assert.ok(usage.session.usedPct > 0 && usage.session.usedPct <= 100)
  assert.ok(Date.parse(usage.weekly.resetsAt) > 0)
})
