// Feedback round 1 (docs/feedback.md, local): QA-verified acceptance (#11), team check-ins (#8).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Project, Quest, RunnerMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { toAcceptance } from './quests'
import { ownedPaths, TeamCheckService, withinOwned } from './teamcheck'

const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'
interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; wsBase: string; dir: string }

async function setup(over: Partial<Config> = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-fb1-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, { dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'), oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, dir, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
}
async function teardown(c: Ctx) { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) }
async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, auth = `Bearer ${ADMIN}`) {
  const h: Record<string, string> = { authorization: auth }
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T }
}
async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
}
async function member(c: Ctx, projectId: string, role: string, status: 'idle' | 'running' = 'idle') {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const env = c.infra.agents.get(r.body.id)!.spec.env
  const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${env.COLONY_AGENT_TOKEN}` } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const texts: string[] = []
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'user_message') texts.push(m.text) })
  const send = (m: RunnerMessage) => ws.send(JSON.stringify(m))
  send({ type: 'hello', agentId: r.body.id, protocol: 1 })
  send({ type: 'status', agentId: r.body.id, status })
  await waitUntil(() => c.app.store.agents.get(r.body.id)!.agent.status === status)
  return { agent: r.body, token: env.COLONY_AGENT_TOKEN, ws, texts, send }
}
let rpcId = 1
async function call(c: Ctx, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await api<any>(c, 'POST', '/mcp', { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`)
  const text: string = r.body.result.content[0].text
  let json: any
  try { json = JSON.parse(text) } catch { /* text */ }
  return { text, isError: !!r.body.result.isError, json }
}

describe('acceptance criteria: who checks them', () => {
  test('toAcceptance reads objects and [human]/[agent] prefixes', () => {
    assert.deepEqual(toAcceptance('npm test passes'), { text: 'npm test passes', check: 'agent' })
    assert.deepEqual(toAcceptance('[human] the login screen looks right'), { text: 'the login screen looks right', check: 'human' })
    assert.deepEqual(toAcceptance({ text: 'feels fast', check: 'human' }), { text: 'feels fast', check: 'human' })
    assert.deepEqual(toAcceptance({ text: '[agent] lint passes' }), { text: 'lint passes', check: 'agent' })
  })

  test('create_task stores checks; the commander ticks human items; merge summary says what needs you', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const orch = await member(c, p.id, 'orchestrator')
      const r = await call(c, orch.token, 'create_task', {
        title: 'Sign-in screen', brief: 'Goal: sign in\n\n## Owns\n- src/app/(auth)/**',
        acceptance: ['typecheck passes', { text: 'screen matches the design', check: 'human' }, 'bad', { text: 1 }],
      })
      assert.ok(r.isError, 'object without text is refused')
      const ok = await call(c, orch.token, 'create_task', {
        title: 'Sign-in screen', brief: 'Goal: sign in', acceptance: ['typecheck passes', { text: 'screen matches the design', check: 'human' }],
      })
      const q: Quest = c.app.store.quests.get(ok.json.id)!
      assert.deepEqual(q.acceptance.map((a) => a.check), ['agent', 'human'])
      assert.match(ok.json.acceptance[1], /commander checks/)

      // A request with no agent criteria to verify is refused; commander tick works on any item.
      const tick = await api<Quest>(c, 'POST', `/api/quests/${q.id}/acceptance/1`, { done: true })
      assert.equal(tick.status, 200)
      assert.equal(tick.body.acceptance[1].verification?.by, 'you')
      assert.equal((await api(c, 'POST', `/api/quests/${q.id}/acceptance/9`, { done: true })).status, 400)
      assert.equal((await api(c, 'POST', `/api/quests/${q.id}/acceptance/0`, {})).status, 400)
      const untick = await api<Quest>(c, 'POST', `/api/quests/${q.id}/acceptance/1`, { done: false })
      assert.equal(untick.body.acceptance[1].done, false)

      // Worker completes; orchestrator overrides verification with a reason: summary lists both notes.
      const w = await member(c, p.id, 'frontend')
      c.app.quests.assign(q.id, w.agent.id, p.id)
      c.infra.setBranch(c.app.store.projects.get(p.id)!.slug, w.agent.branch!, { aheadOfMain: 1 })
      await c.app.quests.complete(q.id, c.app.store.agents.get(w.agent.id)!, 'done')
      const mr = await call(c, orch.token, 'request_merge', { quest_id: q.id, summary: 'Sign-in.', unverified_reason: 'CI image lacks tsc' })
      assert.equal(mr.isError, false, mr.text)
      assert.match(mr.json.mergeRequest.summary, /Unverified \(1\): CI image lacks tsc/)
      assert.match(mr.json.mergeRequest.summary, /Needs you: 1 criteria/)
    } finally { await teardown(c) }
  })

  test('a failed verification tells the orchestrator to send it back; re-verification resets results', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const orch = await member(c, p.id, 'orchestrator')
      const w = await member(c, p.id, 'backend')
      const qa = await member(c, p.id, 'qa')
      const q = c.app.quests.create(p.id, { title: 'API', acceptance: ['tests pass', '[human] docs read well'] }, orch.agent.id)
      c.app.quests.assign(q.id, w.agent.id, p.id)
      assert.equal((await call(c, orch.token, 'request_verification', { quest_id: q.id, agent_id: qa.agent.id })).isError, true, 'not in review yet')
      c.infra.setBranch(c.app.store.projects.get(p.id)!.slug, w.agent.branch!, { aheadOfMain: 1 })
      await c.app.quests.complete(q.id, c.app.store.agents.get(w.agent.id)!, 'done')
      await call(c, orch.token, 'request_verification', { quest_id: q.id, agent_id: qa.agent.id })
      const human = await call(c, qa.token, 'verify_acceptance', { quest_id: q.id, index: 1, result: 'pass', evidence: 'x' })
      assert.ok(human.isError && /commander/.test(human.text))
      await call(c, qa.token, 'verify_acceptance', { quest_id: q.id, index: 0, result: 'fail', evidence: 'npm test: 2 failed' })
      await waitUntil(() => orch.texts.some((t) => t.includes('FAILED') && t.includes('npm test: 2 failed')))
      const blocked = await call(c, orch.token, 'request_merge', { quest_id: q.id, summary: 's' })
      assert.ok(blocked.isError && /FAILED/.test(blocked.text))
      await call(c, orch.token, 'request_verification', { quest_id: q.id, agent_id: qa.agent.id })
      assert.equal(c.app.store.quests.get(q.id)!.acceptance[0].verification, undefined)
      assert.ok(c.app.store.recentEvents(80).some((e) => e.kind === 'test' && /criterion 0/.test(e.text)))
    } finally { await teardown(c) }
  })
})

describe('team check-ins', () => {
  test('ownedPaths and withinOwned', () => {
    const brief = 'Goal: auth\n\n## Owns\n- `src/lib/supabase.ts`\n- src/app/(auth)/**\n\n## Constraints\n- no keys\nOwns: package.json, README.md'
    assert.deepEqual(ownedPaths(brief).sort(), ['README.md', 'package.json', 'src/app/(auth)/**', 'src/lib/supabase.ts'].sort())
    assert.ok(withinOwned('src/app/(auth)/sign-in.tsx', ownedPaths(brief)))
    assert.ok(!withinOwned('src/screens/Budget.tsx', ownedPaths(brief)))
  })

  test('digests go out on the interval, skip unchanged, flag trouble, and can be forced or turned off', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const orch = await member(c, p.id, 'orchestrator')
      const w = await member(c, p.id, 'backend', 'running')
      const q = c.app.quests.create(p.id, { title: 'API', brief: 'Owns: api/' }, orch.agent.id)
      c.app.quests.assign(q.id, w.agent.id, p.id)
      let now = Date.now()
      const svc = new TeamCheckService(c.app.store, c.app.agents, c.infra, () => now)
      const before = orch.texts.length
      await svc.tick()
      await waitUntil(() => orch.texts.slice(before).some((t) => t.startsWith('[Colony] Team check') && t.includes(w.agent.callsign) && t.includes('"API"')))
      // Same situation 5 minutes later: skipped.
      now += 5 * 60_000
      assert.deepEqual((await svc.check(p.id, { force: false })).reason, 'nothing changed since the last check')
      // 25 minutes on the quest without a commit, plus an edit outside its area: flagged.
      c.app.store.addEvent({ id: 'ev-x', at: new Date(now).toISOString(), agentId: w.agent.id, projectId: p.id, kind: 'edit', text: 'web/x.tsx', edit: { path: 'web/x.tsx', added: 1, removed: 0 } })
      now += 25 * 60_000
      const r = await svc.check(p.id, { force: false })
      assert.equal(r.sent, true, r.reason)
      assert.match(r.digest!, /no commits pushed after \d+ min/)
      assert.match(r.digest!, /edited outside its quest's area: web\/x\.tsx/)
      // Forced via the API even when nothing changed; interval 0 turns ticks off.
      assert.equal((await api(c, 'POST', `/api/projects/${p.id}/team-check`)).status, 200)
      assert.equal((await api(c, 'PATCH', '/api/guards', { teamCheckMinutes: 0 })).status, 200)
      const n = orch.texts.length
      now += 60 * 60_000
      await svc.tick()
      await new Promise((res) => setTimeout(res, 50))
      assert.equal(orch.texts.length, n)
      assert.equal((await api(c, 'PATCH', '/api/guards', { teamCheckMinutes: 500 })).status, 400)
      // No busy workers: nothing to check.
      w.send({ type: 'status', agentId: w.agent.id, status: 'idle' })
      await waitUntil(() => c.app.store.agents.get(w.agent.id)!.agent.status === 'idle')
      c.app.store.setGuards({ teamCheckMinutes: 5 })
      assert.equal((await svc.check(p.id, { force: false })).reason, 'no busy workers')
    } finally { await teardown(c) }
  })
})

describe('worker requests keep the emblem from Spawn', () => {
  test('the orchestrator spawning the requested callsign gets the seed', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const orch = await member(c, p.id, 'orchestrator')
      assert.equal((await api(c, 'POST', `/api/projects/${p.id}/worker-requests`, { callsign: 'Fen-12', iconSeed: 'bad seed!' })).status, 400)
      assert.equal((await api(c, 'POST', `/api/projects/${p.id}/worker-requests`, { callsign: 'Fen-12', iconSeed: 'abc-123' })).status, 202)
      const s = await call(c, orch.token, 'spawn_agent', { role: 'frontend', callsign: 'Fen-12', model: 'haiku-5.5' })
      assert.equal(s.isError, false, s.text)
      assert.equal(c.app.store.agents.get(s.json.agent.id)!.agent.iconSeed, 'abc-123')
    } finally { await teardown(c) }
  })
})
